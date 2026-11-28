"""只读核对最近一笔小程序虚拟支付。不打印用户 id、openid、完整单号和推送正文。"""
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
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "
SELECT 'order tail=' || right(order_no, 4)
    || ' product=' || product_id
    || ' plan=' || plan
    || ' months=' || coalesce(months::text, '')
    || ' cents=' || amount_cents
    || ' status=' || status
    || ' provider=' || provider
    || ' at=' || to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'HH24:MI:SS')
    || ' upd=' || to_char(updated_at AT TIME ZONE 'Asia/Shanghai', 'HH24:MI:SS')
  FROM public.payment_orders
 WHERE provider = 'wechat_xpay'
   AND created_at > now() - interval '3 hours'
 ORDER BY created_at DESC
 LIMIT 5;
"
sudo -n -u postgres psql -d dbee -tA -c "
SELECT 'txn tail=' || right(out_trade_no, 4)
    || ' product=' || product_id
    || ' plan=' || plan
    || ' orig=' || coalesce(orig_price_cents::text, '')
    || ' actual=' || coalesce(actual_price_cents::text, '')
    || ' qty=' || quantity
    || ' channel=' || channel
    || ' env=' || coalesce(env::text, '')
    || ' revoked=' || revoked::text
    || ' at=' || to_char(settled_at AT TIME ZONE 'Asia/Shanghai', 'HH24:MI:SS')
  FROM public.xpay_transactions
 WHERE settled_at > now() - interval '3 hours'
 ORDER BY settled_at DESC
 LIMIT 5;
"
sudo -n -u postgres psql -d dbee -tA -c "
SELECT 'entitlement plan=' || e.plan
    || ' until=' || coalesce(to_char(e.pro_until AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI'), 'null')
    || ' source=' || coalesce(e.source, '')
  FROM public.entitlements e
  JOIN public.payment_orders o ON o.owner_id = e.owner_id
 WHERE o.provider = 'wechat_xpay'
   AND o.status = 'paid'
   AND o.created_at > now() - interval '3 hours'
 ORDER BY o.updated_at DESC
 LIMIT 1;
"
sudo -n -u postgres psql -d dbee -tA -c "
SELECT 'notify event=' || coalesce(event, '')
    || ' processed=' || processed::text
    || ' error=' || coalesce(error, '')
    || ' tail=' || right(coalesce(out_trade_no, ''), 4)
    || ' at=' || to_char(received_at AT TIME ZONE 'Asia/Shanghai', 'HH24:MI:SS')
  FROM public.xpay_notifications
 WHERE received_at > now() - interval '3 hours'
 ORDER BY received_at DESC
 LIMIT 8;
"
echo "=== logs ==="
sudo -n journalctl -u dbee-gateway --since "2026-11-24 21:55:00" --no-pager \
  | grep -E "xpay" \
  | sed -E "s/owner=[^ ]+/owner=REDACTED/g; s/out_trade_no=[^ ]+/out_trade_no=REDACTED/g; s/order=[^ ]+/order=REDACTED/g; s/ip=[^ ]+/ip=REDACTED/g" \
  | tail -n 40
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
            print(err[:500])
        return o.channel.recv_exit_status()
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
