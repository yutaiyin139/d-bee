"""应用 0055 补分订正到生产库（SSH 上传 + sudo psql + 生产实测）。

沿用 apply-honey-fefo-prod.py 的通道与权限纪律：
  - 凭据只从 .env 的 IP/USER/SSH_PWD 读取，绝不回显、绝不进命令行参数；
  - /tmp/dbee-mig 755、SQL 与脚本 644（postgres 身份可读）；
  - 上传统一 LF，含 CR 拒绝；
  - 服务端脚本只做 备份→精确UPDATE一行→三方对账→幂等复跑→回归守卫，
    不碰网关/nginx/postgrest、不增删行、不动其余账户。

用法（项目根目录）：python tools/apply-honey-backfill-prod.py
"""
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

    sql_path = ROOT / "db" / "migrations" / "0055-honey-expire-backfill.sql"
    sh_path = ROOT / "tools" / "server-apply-0055.sh"
    for p in (sql_path, sh_path):
        if not p.is_file():
            print(f"FAIL: 缺文件 {p}")
            return 2

    payloads = {}
    for name, path in (
        ("0055-honey-expire-backfill.sql", sql_path),
        ("server-apply-0055.sh", sh_path),
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
        print("OK  已上传 0055 SQL + 应用脚本（LF，权限 644）\n")

        cmd = f"cd {MIG_DIR} && bash server-apply-0055.sh"
        _, out, err = cli.exec_command(cmd, timeout=300)
        text = out.read().decode("utf-8", errors="replace")
        etext = err.read().decode("utf-8", errors="replace")
        code = out.channel.recv_exit_status()
        print(text.strip())
        if etext.strip():
            print("\n[stderr 摘要]", etext.strip()[:400])
        print(f"\n远端退出码: {code}")
        if code == 0 and "FAIL=0" in text:
            print("OK  0055 生产补分订正 + 实测全部通过")
            return 0
        print("FAIL: 0055 应用或实测未通过，详见上方输出")
        return 1
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
