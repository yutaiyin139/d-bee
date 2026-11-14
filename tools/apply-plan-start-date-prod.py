"""应用 0050 方案起始日迁移到生产库（SSH 上传 + sudo psql 执行 + 只读实证）。

沿用 tools/apply-account-deletion-prod.py 的通道与权限纪律：
  - 凭据只从 .env 的 IP/USER/SSH_PWD 读取，绝不回显、绝不进命令行参数；
  - /tmp/dbee-mig 必须 755、SQL 与脚本 644（postgres 身份才读得到）；
  - 上传统一 LF，含 CR 直接拒绝；
  - 服务器端脚本不删文件、不造测试账号、不签 JWT，只做备份→应用→复跑→探针。

用法（项目根目录）：python tools/apply-plan-start-date-prod.py
"""
import os
import re
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
MIG_DIR = "/tmp/dbee-mig"


def load_env():
    kv = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        kv[k.strip()] = v.strip().strip('"').strip("'")
    return kv


def main():
    env = load_env()
    host = env.get("IP") or env.get("DBEE_HOST")
    user = env.get("USER")
    pwd = env.get("SSH_PWD")
    if not (host and user and pwd):
        print("FAIL: .env 缺 IP/USER/SSH_PWD")
        return 2

    sql_path = ROOT / "db" / "migrations" / "0050-plan-start-date.sql"
    sh_path = ROOT / "tools" / "server-apply-0050.sh"
    for p in (sql_path, sh_path):
        if not p.is_file():
            print(f"FAIL: 缺文件 {p}")
            return 2

    payloads = {}
    for name, path in (
        ("0050-plan-start-date.sql", sql_path),
        ("server-apply-0050.sh", sh_path),
    ):
        data = path.read_bytes().replace(b"\r\n", b"\n")
        if b"\r" in data:
            print(f"FAIL: {name} 含 CR 字符，拒绝上传")
            return 2
        payloads[name] = data

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30)
    try:
        _, out, _ = cli.exec_command(
            f"mkdir -p {MIG_DIR} && chmod 755 {MIG_DIR} && echo ok", timeout=30
        )
        if out.read().decode().strip() != "ok":
            print(f"FAIL: 无法创建 {MIG_DIR}")
            return 2

        sftp = cli.open_sftp()
        for name, data in payloads.items():
            remote = f"{MIG_DIR}/{name}"
            with sftp.open(remote, "wb") as fh:
                fh.write(data)
            sftp.chmod(remote, 0o644)
        sftp.close()
        print("OK  已上传 0050 SQL + 服务器端应用脚本（LF，权限 644）\n")

        cmd = f"cd {MIG_DIR} && bash server-apply-0050.sh"
        _, out, err = cli.exec_command(cmd, timeout=420)
        text = out.read().decode("utf-8", errors="replace")
        etext = err.read().decode("utf-8", errors="replace")
        code = out.channel.recv_exit_status()
        text = re.sub(
            r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}",
            "<jwt-redacted>", text,
        )
        text = re.sub(r"wbpk_[A-Za-z0-9_]{10,}", "<access-key-redacted>", text)
        print(text.strip())
        if etext.strip():
            print("\n[stderr 摘要]", etext.strip()[:400])
        print(f"\n远端退出码: {code}")
        if code == 0 and "FAIL=0" in text:
            print("OK  0050 生产应用 + 只读实证全部通过")
            return 0
        print("FAIL: 0050 应用或实证未通过，详见上方输出")
        return 1
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
