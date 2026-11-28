"""给生产 gateway.env 里的两把支付宝 PEM 加上双引号，让 systemd 把 \\n 还原成换行。

不重写密钥正文，不跑 deploy-gateway.sh。失败则从备份还原并重启。
日志只打印长度、指纹和签名是否成功。
"""
from __future__ import annotations

import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPLY = "--apply" in sys.argv
REMOTE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fix-alipay-pem-quoting.remote.py")


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
    src = arg_value("--from") or os.path.join(REPO, ".env")
    dot = load_dotenv(src)
    host = (dot.get("DBEE_HOST") or "").strip()
    user = (dot.get("DBEE_SSH_USER") or dot.get("USER") or "ubuntu").strip()
    pwd = (dot.get("SSH_PWD") or "").strip()
    if not host or not pwd:
        print("[x] 缺 SSH 凭据")
        return 2
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}")
        return 1
    try:
        _i, home_out, _e = cli.exec_command("echo $HOME")
        home = home_out.read().decode().strip() or "/home/ubuntu"
        remote_py = f"{home}/fix-alipay-pem-quoting.remote.py"
        sftp = cli.open_sftp()
        sftp.put(REMOTE, remote_py)
        sftp.close()
        mode = "apply" if APPLY else "dry"
        cmd = f"sudo -n python3 {remote_py} {mode}"
        _i, o, e = cli.exec_command(cmd, timeout=120)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        print(out)
        if err.strip():
            print(err)
        return o.channel.recv_exit_status()
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
