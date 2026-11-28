"""只读：生产上 session_key 是否能落库。不打印密钥、openid、IP。"""
from __future__ import annotations

import sys

import paramiko


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


PROBE = r"""
echo "=== code ==="
if sudo -n grep -q "saveSessionKey" /opt/dbee-gateway/lib/auth.mjs; then echo saveSessionKey=yes; else echo saveSessionKey=no; fi
echo "=== db ==="
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "SELECT 'cols=' || count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' AND column_name IN ('wechat_session_key_enc','wechat_session_key_at','wechat_appid');"
sudo -n -u postgres psql -d dbee -tA -c "SELECT 'have_key=' || count(*) FROM public.app_users WHERE wechat_session_key_enc IS NOT NULL;"
sudo -n -u postgres psql -d dbee -tA -c "SELECT 'recent_6h=' || count(*) FROM public.app_users WHERE wechat_session_key_at > now() - interval '6 hours';"
sudo -n -u postgres psql -d dbee -tA -c "SELECT 'wechat_users=' || count(*) FROM public.app_users WHERE ident_kind='wechat';"
echo "=== logs ==="
sudo -n journalctl -u dbee-gateway --since "6 hours ago" --no-pager | grep -E "session_key|微信登录" | sed -E "s/owner=[^ ]+/owner=REDACTED/g; s/ip=[^ ]+/ip=REDACTED/g" | tail -n 40
echo "=== files ==="
sudo -n grep -c saveSessionKey /opt/dbee-gateway/lib/auth.mjs || true
"""


def main() -> int:
    src = arg_value("--from")
    dot = load_dotenv(src)
    host = dot.get("DBEE_HOST", "")
    user = dot.get("DBEE_SSH_USER") or "ubuntu"
    pwd = dot.get("SSH_PWD", "")
    if not host or not pwd:
        print("[x] 缺连接信息")
        return 2
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    try:
        _i, o, e = cli.exec_command(PROBE, timeout=60)
        print(o.read().decode("utf-8", "replace"))
        err = e.read().decode("utf-8", "replace").strip()
        if err:
            print(err[:400])
        return o.channel.recv_exit_status()
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
