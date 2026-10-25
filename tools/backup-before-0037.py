# -*- coding: utf-8 -*-
"""0037 迁移前备份：pg_dump -Fc 到服务器 /opt/dbee-db/backups/。

只读安全操作（不改库）。凭据从仓库根 .env 读取（IP/USER/PWD），不打印密码。
与 10-23 阶段 1 迁移的既定惯例一致（先备份再迁移）。
"""
import os
import sys

import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    env = {}
    with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


env = load_env()
HOST = env.get("IP")
USER = env.get("USER", "ubuntu")
PWD = env.get("PWD")
if not HOST or not PWD:
    print("FATAL: .env 缺少 IP/PWD")
    sys.exit(1)

TS = sys.argv[1] if len(sys.argv) > 1 else "20261025-1125"
BACKUP = f"/opt/dbee-db/backups/dbee-pre-0037-{TS}.dump"


def run(client, cmd, timeout=300):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    return (stdout.read().decode("utf-8", "replace"),
            stderr.read().decode("utf-8", "replace"))


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PWD, timeout=25,
                   allow_agent=False, look_for_keys=False)
    client.get_transport().set_keepalive(30)
    sudo = f"echo '{PWD}' | sudo -S "

    # 1) 确认备份目录存在
    out, _ = run(client, f"{sudo} mkdir -p /opt/dbee-db/backups && echo ok")
    print("mkdir:", out.strip())

    # 2) pg_dump -Fc（自定义压缩格式，可用 pg_restore 恢复）
    out, err = run(client, f"{sudo} -u postgres pg_dump -d dbee -F c -f {BACKUP}",
                   timeout=600)
    if out.strip() or err.strip():
        print("[dump stdout]", out.strip())
        print("[dump stderr]", err.strip()[-500:])

    # 3) 验证备份文件：存在 + 大小 + TOC 可读 + sha256
    out, _ = run(client, f"{sudo} ls -l {BACKUP} && {sudo} sha256sum {BACKUP}")
    print("文件:", out.strip())
    out, _ = run(client, f"{sudo} -u postgres pg_restore -l {BACKUP} | wc -l")
    print("TOC 条目数:", out.strip())

    # 4) 保留策略：只列出现有备份（不删除任何东西）
    out, _ = run(client, f"{sudo} ls -lht /opt/dbee-db/backups/ | head -8")
    print("现有备份:\n" + out.strip())

    client.close()


if __name__ == "__main__":
    main()
