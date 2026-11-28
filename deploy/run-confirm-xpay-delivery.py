"""把发货确认脚本送到生产机执行，执行后删除。不打印密钥和完整单号。"""
from __future__ import annotations

import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(REPO, "deploy", "confirm-xpay-delivery.mjs")
CONFIRM = "--confirm" in sys.argv


def arg_value(flag: str) -> str:
    if flag not in sys.argv:
        return ""
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv):
        return ""
    return sys.argv[i + 1]


def load_dotenv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main() -> int:
    src = arg_value("--from")
    dot = load_dotenv(src)
    host = dot.get("DBEE_HOST", "")
    user = dot.get("DBEE_SSH_USER") or "ubuntu"
    pwd = dot.get("SSH_PWD", "")
    if not host or not pwd or not os.path.isfile(LOCAL):
        print("[x] 缺连接信息或脚本")
        return 2
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    try:
        remote = "/tmp/dbee-confirm-xpay-delivery.mjs"
        sftp = cli.open_sftp()
        sftp.put(LOCAL, remote)
        sftp.close()
        _i, o, e = cli.exec_command(
            "chmod 600 {remote} && sudo -n /usr/local/bin/node {remote}{flag}; rc=$?; rm -f {remote}; exit $rc".format(
                remote=remote, flag=" --confirm" if CONFIRM else ""
            ),
            timeout=60,
        )
        print(o.read().decode("utf-8", "replace"))
        err = e.read().decode("utf-8", "replace").strip()
        if err:
            print(err[:400])
        return o.channel.recv_exit_status()
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
