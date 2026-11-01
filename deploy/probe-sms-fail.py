#!/usr/bin/env python3
"""只读探针：定位「13911111170 收不到验证码」的服务端真实原因。

安全约束（遵 MEMORY.md 铁律）：
  · 绝不 cat/grep 任何脚本或 env 正文；凭据只报「存在性 + 长度 + sha8」
  · 只读日志与配置摘要，不做任何写操作、不重启服务
  · 手机号一律以掩码形式匹配与输出（139****1170），不落完整号码
  · 明文密码只从本地 .env 读取，不写入本文件、不打印

用法：python deploy/probe-sms-fail.py
"""

from __future__ import annotations

import hashlib
import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")

# 掩码（server/lib/identity.mjs maskPhone：前3 + **** + 后4）
TARGET_MASK = "139****1170"  # 13911111170（移动，失败）
OK_MASK = "186****4399"      # 18611114399（联通，成功）


def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(ENV_PATH):
        return out
    with open(ENV_PATH, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def sha8(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()[:8]


def main() -> int:
    env = load_env()
    host = env.get("DBEE_HOST") or env.get("SSH_HOST") or ""
    user = env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD") or ""

    if not host or not pwd:
        print("❌ .env 缺 DBEE_HOST / USER / SSH_PWD，无法连接")
        return 2
    # 只报指纹，不报值
    print(f"目标: {user}@{host}  SSH_PWD sha8={sha8(pwd)} len={len(pwd)}\n")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=25, banner_timeout=25, auth_timeout=25)
    except Exception as exc:  # noqa: BLE001
        print(f"❌ SSH 连接失败: {type(exc).__name__}: {exc}")
        return 3
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def run(title: str, cmd: str, limit: int = 40) -> None:
        print(f"───── {title} ─────")
        _, so, se = cli.exec_command(cmd, timeout=60)
        out = so.read().decode("utf-8", "replace").strip()
        err = se.read().decode("utf-8", "replace").strip()
        if out:
            for line in out.splitlines()[:limit]:
                print("  " + line)
        if err:
            for line in err.splitlines()[:5]:
                print("  [stderr] " + line)
        if not out and not err:
            print("  (无输出)")
        print()

    # 1) 网关服务状态 + 短信 provider 生效值（只取键名与非敏感值）
    run(
        "网关服务状态",
        "systemctl is-active dbee-gateway 2>&1; "
        "systemctl show dbee-gateway -p ActiveState,SubState,NRestarts --no-pager 2>&1",
    )

    # 2) 短信 provider / 签名 / 模板 —— 只报存在性与长度，不报值
    run(
        "短信配置（只报存在性+长度+sha8，不报值）",
        "sudo -n sh -c 'for k in SMS_PROVIDER SMS_SIGN_NAME SMS_ALIYUN_ACCESS_KEY_ID "
        "SMS_ALIYUN_ACCESS_KEY_SECRET SMS_ALIYUN_TEMPLATE_CODE SMS_MASTER_CODE DBEE_PROD; do "
        "v=$(grep -E \"^${k}=\" /etc/dbee/gateway.env 2>/dev/null | head -1 | cut -d= -f2-); "
        "if [ -n \"$v\" ]; then echo \"$k 已配置 len=${#v} sha8=$(printf %s \"$v\" | sha256sum | cut -c1-8)\"; "
        "else echo \"$k (未设置)\"; fi; done' 2>&1",
    )

    # 3) 🔴 决定性证据：日志里该掩码号的发送记录与阿里云返回码
    run(
        f"日志：{TARGET_MASK}（移动·失败）的短信记录",
        f"sudo -n sh -c 'journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        f"| grep -F \"{TARGET_MASK}\" | tail -25' 2>&1",
    )
    run(
        f"对照：{OK_MASK}（联通·成功）的短信记录",
        f"sudo -n sh -c 'journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        f"| grep -F \"{OK_MASK}\" | tail -15' 2>&1",
    )

    # 4) 阿里云返回码汇总（限频/签名/模板/余额）
    run(
        "近 6 小时阿里云返回码汇总",
        "sudo -n sh -c 'journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        "| grep -oE \"Code=[A-Za-z._]+\" | sort | uniq -c | sort -rn | head -15' 2>&1",
    )
    run(
        "近 6 小时 SMS 错误行（掩码化输出）",
        "sudo -n sh -c 'journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        "| grep -E \"\\[SMS\\]\" | tail -25' 2>&1",
    )

    # 5) 限流命中（429 rate_limited）与发码总量
    run(
        "近 6 小时 429/rate_limited 与发码计数",
        "sudo -n sh -c 'journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        "| grep -cE \"rate_limited|发送过于频繁\"; "
        "echo \"--- 发码成功/失败计数 ---\"; "
        "journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        "| grep -cE \"\\[SMS\\] aliyun 已发送\"; "
        "journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        "| grep -cE \"\\[SMS\\] aliyun 发送失败|\\[SMS\\] aliyun 请求异常\"' 2>&1",
    )

    # 6) LLM 视觉链路耗时（对应「识别超 1 分钟」）
    run(
        "近 6 小时 LLM 耗时/超时记录",
        "sudo -n sh -c 'journalctl -u dbee-gateway --since \"6 hours ago\" --no-pager 2>/dev/null "
        "| grep -E \"LLM|llm|vision|超时|timeout|took|ms\" | tail -20' 2>&1",
    )

    cli.close()
    print("探针结束（全程只读，未做任何写操作）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
