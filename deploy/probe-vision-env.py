"""【纯只读】勘察生产网关 /etc/dbee/gateway.env 的视觉配置基线。

为什么先勘察再动手：
  gateway.env.template ≠ 生产实际文件。模板里 LLM_VISION_MODEL 是空、
  LLM_MODEL_VISION=qwen3.8-max-0902、工作空间是旧的 ws-myumgi46hdb6mu3z；
  但生产文件可能已被历次手工配置改过（63c0a71 部署期就手工配过 Qwen 键）。
  不看基线就改 = 盲改，且部署后无法断言「只动了该动的键」。

安全口径（沿用 fetch-llm-secrets.py）：
  · env 文件 0640 root:dbee，ubuntu 无直读权限 → sudo -S，密码走 stdin
    （不进命令行：防特殊字符破引号 + 不留 ps 痕迹 + 不落 shell history）
  · 明文只在内存流转，**stdout 绝不 print 任何密钥/密码/万能码明文**
  · 敏感键只输出 sha256 前 8 位 + 长度，足以做「改前改后是否被动过」的断言
  · 本脚本**不写任何本地文件、不改任何远端文件**

用法：
  python deploy/probe-vision-env.py

凭据全部从项目根 .env 读取，不在命令行传（密码含 @ 等特殊字符，写进命令行
易破引号且留 ps 痕迹）。身份默认用 USER/SSH_PWD（ubuntu）—— 已实测该身份
sudo -n 免密可用；DBEE_USER/DBEE_PWD（dbee_app）实测 SSH 认证失败。
"""
from __future__ import annotations

import hashlib
import os
import re
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_dotenv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_DOT = _load_dotenv(os.path.join(REPO, ".env"))
HOST = _DOT.get("DBEE_HOST") or os.environ.get("DBEE_HOST", "")
# 默认走 ubuntu（sudo -n 免密已验证）；可用环境变量覆盖
USER = os.environ.get("DBEE_SSH_USER") or _DOT.get("USER", "ubuntu")
PWD = os.environ.get("DBEE_SSH_PWD") or _DOT.get("SSH_PWD", "")
if not HOST or not PWD:
    print("[x] .env 缺 DBEE_HOST 或 SSH_PWD")
    sys.exit(2)
ENV_FILE = "/etc/dbee/gateway.env"

# 视觉链路：这次要改的目标（非机密的可直接显示值，机密的显示指纹）
VISION_KEYS = [
    "LLM_VISION_BASE_URL",   # 工作空间端点（非机密，显示值）
    "LLM_MODEL_VISION",      # 生产实际生效的模型名（模板中 LLM_VISION_MODEL 为空 → 靠它兜底）
    "LLM_VISION_MODEL",      # 优先级更高的模型名（生产多为空）
    "LLM_VISION_API_KEY",    # 🔴 机密：只显示指纹
    "LLM_IMAGE_DETAIL",
    "LLM_VISION_ENABLE_THINKING",
]
# 文本链路：作为对照，确认改动不会波及
TEXT_KEYS = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL_TEXT", "LLM_API_KEY"]
# 🔴 红线保护键：deploy-gateway.sh 的 load_secret 缺失时会 rand_hex 重置这些，
#    导致全站 ident_hash 永久失效。这里取指纹，部署后必须逐个断言未变。
GUARD_KEYS = ["IDENT_PEPPER", "JWT_SECRET", "PUBLISHABLE_KEY",
              "SMTP_PASS", "SMS_MASTER_CODE", "DEMO_CODE", "DEMO_PHONE"]

SECRET_KEYS = {"LLM_VISION_API_KEY", "LLM_API_KEY"} | set(GUARD_KEYS)


def fp(v: str) -> str:
    """敏感值指纹：只给 sha256 前 8 位 + 长度，不可逆推原文。"""
    if not v:
        return "<空>"
    return f"sha256:{hashlib.sha256(v.encode()).hexdigest()[:8]} len={len(v)}"


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"连接 {USER}@{HOST} …")
    c.connect(HOST, username=USER, password=PWD, timeout=30,
              banner_timeout=30, auth_timeout=30)
    try:
        _in, out, err = c.exec_command(
            f"sudo -S -p '' cat {ENV_FILE}", timeout=30)
        _in.write(PWD + "\n")
        _in.flush()
        body = out.read().decode("utf-8", "replace")
        code = out.channel.recv_exit_status()
        if code != 0:
            print(f"[x] 远端读取失败 exit={code}: "
                  f"{err.read().decode('utf-8', 'replace')[:200]}")
            return 1
    finally:
        c.close()

    kv: dict[str, str] = {}
    for line in body.splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m:
            kv[m.group(1)] = m.group(2).strip()

    print(f"\n═══ 生产 {ENV_FILE}（共 {len(kv)} 个键，{len(body)} 字节）═══")
    print(f"整文件 sha256 = {hashlib.sha256(body.encode()).hexdigest()[:16]}")

    # 非视觉部分的指纹：手术式脚本部署后要断言它与改前一致
    nonvision = "\n".join(
        ln for ln in body.splitlines()
        if not any(ln.strip().startswith(k + "=") for k in VISION_KEYS)
    )
    print(f"非视觉部分 sha256 = {hashlib.sha256(nonvision.encode()).hexdigest()[:16]}"
          f"  ← 部署后必须与此一致")

    def show(title: str, keys: list[str]) -> None:
        print(f"\n── {title} ──")
        for k in keys:
            if k not in kv:
                print(f"  {k:32s} = <键不存在>")
                continue
            v = kv[k]
            shown = fp(v) if k in SECRET_KEYS else (v or "<空>")
            print(f"  {k:32s} = {shown}")

    show("视觉链路（本次要改的目标）", VISION_KEYS)
    show("文本链路（对照，不应被波及）", TEXT_KEYS)
    show("🔴 红线保护键（部署后必须逐个断言指纹未变）", GUARD_KEYS)

    # 服务与探活：改配置前确认网关本身是健康的，否则改完出问题无法归因
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=30,
              banner_timeout=30, auth_timeout=30)
    try:
        print("\n── 网关服务状态 ──")
        for cmd, label in [
            ("systemctl is-active dbee-gateway", "is-active"),
            ("systemctl show dbee-gateway -p ActiveEnterTimestamp --value", "启动于"),
            ("curl -sS -m 10 -o /dev/null -w '%{http_code}' "
             "http://127.0.0.1:8080/.cloud/healthz", "healthz HTTP"),
        ]:
            _i, o, _e = c.exec_command(cmd, timeout=30)
            print(f"  {label:14s} = {o.read().decode('utf-8', 'replace').strip()}")
            o.channel.recv_exit_status()
        # EnvironmentFile 路径确认：改错文件等于白改
        _i, o, _e = c.exec_command(
            "sudo -S -p '' systemctl cat dbee-gateway 2>/dev/null "
            "| grep -E '^(EnvironmentFile|ExecStart)='", timeout=30)
        _i.write(PWD + "\n")
        _i.flush()
        print("  unit 配置：")
        for ln in o.read().decode("utf-8", "replace").strip().splitlines():
            print(f"    {ln}")
        o.channel.recv_exit_status()
    finally:
        c.close()

    print("\n═══ 勘察结束（未修改任何数据）═══")
    return 0


if __name__ == "__main__":
    sys.exit(main())
