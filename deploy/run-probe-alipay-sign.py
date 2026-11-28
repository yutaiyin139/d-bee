"""上传只读验签探测到生产机执行，然后删除。不改 gateway.env，不重启。"""
from __future__ import annotations

import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(REPO, "deploy", "probe-alipay-sign.mjs")
REMOTE = "/tmp/dbee-probe-alipay-sign.mjs"


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
    if not src or not os.path.isfile(src) or not os.path.isfile(LOCAL):
        print("[x] 缺少凭据文件或探测脚本")
        return 2
    dot = load_dotenv(src)
    host = dot.get("DBEE_HOST", "")
    user = dot.get("DBEE_SSH_USER") or "ubuntu"
    pwd = dot.get("SSH_PWD", "")
    if not host or not pwd:
        print("[x] 缺连接信息")
        return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}")
        return 1

    def sh(cmd: str, timeout: int = 40) -> tuple[int, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        code = o.channel.recv_exit_status()
        return code, (out + err).strip()

    try:
        sftp = cli.open_sftp()
        sftp.put(LOCAL, REMOTE)
        sftp.close()
        code, out = sh(f"sudo -n /usr/local/bin/node {REMOTE}")
        print(out)
        sh(f"rm -f {REMOTE}")
        sql = r"""
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "
SELECT 'tail=' || right(order_no, 4)
    || ' cents=' || amount_cents
    || ' status=' || status
    || ' provider=' || provider
    || ' at=' || to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI:SS')
  FROM payment_orders
 WHERE provider = 'alipay'
   AND created_at > now() - interval '6 hours'
 ORDER BY created_at DESC
 LIMIT 8;"
"""
        _c, orders = sh(sql)
        print(orders or "(no alipay orders in 6h)")
        return 0 if code == 0 else 1
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
