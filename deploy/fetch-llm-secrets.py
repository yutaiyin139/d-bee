"""从生产 /etc/dbee/gateway.env 回收 LLM 密钥到本地 .secrets.local。

为什么需要：gateway.env.template 的 LLM_VISION_* 三键为空，而生产 env 已配好
Qwen 视觉键（63c0a71 部署期手工配置）。deploy-gateway.sh 用模板整体覆盖生产
env —— 不先把这三键回填进部署链路，部署即打断拍照识别。

安全口径：
  · 明文只在内存与本脚本进程内流转，**绝不 print**；stdout 只输出掩码摘要。
  · 落盘位置 deploy/gateway/.secrets.local（被 .gitignore 的 *.local 覆盖）。
  · 远端读取走 sudo cat（env 文件 0640 root:dbee，ubuntu 无直读权限）。

用法：
  DBEE_HOST=<服务器IP> DBEE_USER=ubuntu DBEE_PWD=<SSH密码> \
    python deploy/fetch-llm-secrets.py
"""
import os
import re
import sys

import paramiko

HOST = os.environ["DBEE_HOST"]
USER = os.environ["DBEE_USER"]
PWD = os.environ["DBEE_PWD"]

SECRETS = os.path.join(os.path.dirname(__file__), "gateway", ".secrets.local")
KEYS = ["LLM_API_KEY", "LLM_VISION_BASE_URL", "LLM_VISION_API_KEY", "LLM_VISION_MODEL"]


def mask(v: str) -> str:
    if not v:
        return "<空>"
    if len(v) <= 10:
        return v[:2] + "***"
    return f"{v[:6]}…{v[-4:]}(len={len(v)})"


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=30,
              banner_timeout=30, auth_timeout=30)
    try:
        cmd = "sudo -S -p '' cat /etc/dbee/gateway.env"
        _in, out, err = c.exec_command(cmd, timeout=30)
        # 密码走 stdin，不进命令行（防特殊字符破坏引号 + 不留 ps 痕迹）
        _in.write(PWD + "\n")
        _in.flush()
        body = out.read().decode("utf-8", "replace")
        code = out.channel.recv_exit_status()
        if code != 0:
            print(f"!! 远端读取失败 exit={code}: {err.read().decode('utf-8', 'replace')[:200]}")
            return 1
    finally:
        c.close()

    found = {}
    for line in body.splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m and m.group(1) in KEYS:
            found[m.group(1)] = m.group(2).strip()

    missing = [k for k in KEYS if k not in found]
    if missing:
        print(f"!! 生产 env 缺少键: {missing}（请人工确认）")
        # 缺键不致命：继续写入已找到的，缺的由部署方补
    for k in KEYS:
        print(f"  {k} = {mask(found.get(k, ''))}")

    # 合并进 .secrets.local：保留既有的 JWT_SECRET 等，KEYS 内的键覆盖/追加
    existing = {}
    order = []
    if os.path.isfile(SECRETS):
        with open(SECRETS, "r", encoding="utf-8") as f:
            for line in f.read().splitlines():
                if line.startswith("#") or not line.strip():
                    continue
                m = re.match(r"^([A-Z_]+)=(.*)$", line)
                if m:
                    if m.group(1) not in existing:
                        order.append(m.group(1))
                    existing[m.group(1)] = m.group(2)
    for k in KEYS:
        if k in found and found[k]:
            if k not in existing:
                order.append(k)
            existing[k] = found[k]

    fd = os.open(SECRETS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write("# D-Bee 网关密钥 · 不入库（*.local 已被 .gitignore 覆盖）\n")
        f.write("# LLM_* 由 deploy/fetch-llm-secrets.py 从生产 env 回收\n")
        for k in order:
            f.write(f"{k}={existing[k]}\n")
    print(f"[写入] {SECRETS}（0600，含 {len(order)} 键）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
