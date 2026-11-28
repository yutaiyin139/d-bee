"""把 0057 应用到生产库：只给 dbee_app 补 payment_orders 的 SELECT policy。

不跑 deploy-gateway.sh，不改 gateway.env，不重启网关。
日志只打印行数和策略名，不打印订单号或用户 id。

用法：
  python deploy/apply-0057-payment-orders-rls.py --from <本地.env>
  python deploy/apply-0057-payment-orders-rls.py --from <本地.env> --apply
"""
from __future__ import annotations

import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_NAME = "0057-payment-orders-gateway-select.sql"
SQL_LOCAL = os.path.join(REPO, "db", "migrations", SQL_NAME)
REMOTE_DIR = "/opt/dbee-db"
APPLY = "--apply" in sys.argv


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
    if not os.path.isfile(src):
        print(f"[x] 找不到凭据文件")
        return 2
    if not os.path.isfile(SQL_LOCAL):
        print(f"[x] 找不到 {SQL_NAME}")
        return 2
    dot = load_dotenv(src)
    host = (dot.get("DBEE_HOST") or "").strip()
    user = (dot.get("DBEE_SSH_USER") or "ubuntu").strip()
    pwd = (dot.get("SSH_PWD") or "").strip()
    if not host or not pwd:
        print("[x] 凭据文件缺 DBEE_HOST 或 SSH_PWD")
        return 2

    print("═══ ⓪ 本地 ═══")
    print(f"  模式 = {'APPLY（会改生产库）' if APPLY else 'DRY-RUN（不改生产库）'}")
    print(f"  SQL = {SQL_NAME}")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}")
        return 1

    def sh(cmd: str, timeout: int = 90) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        return o.channel.recv_exit_status(), out, err

    probe = r"""
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -F' | ' -c "
SELECT 'bypass=' || rolbypassrls::text FROM pg_roles WHERE rolname='dbee_app';
" -c "
SELECT 'force=' || c.relforcerowsecurity::text || ' rls=' || c.relrowsecurity::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='payment_orders';
" -c "
SELECT 'policy=' || coalesce(string_agg(pol.polname, ','), '<none>')
  FROM pg_policy pol
  JOIN pg_class c ON c.oid=pol.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='payment_orders';
" -c "
SELECT 'postgres_today=' || count(*)::text
  FROM public.payment_orders
 WHERE provider='alipay' AND created_at > now() - interval '2 days';
" -c "
SET ROLE dbee_app;
SELECT 'dbee_app_today=' || count(*)::text
  FROM public.payment_orders
 WHERE provider='alipay' AND created_at > now() - interval '2 days';
RESET ROLE;
"
"""

    try:
        print("\n═══ ① 改前探测 ═══")
        rc, out, err = sh(probe)
        print(out.strip() or err.strip() or f"rc={rc}")
        if rc != 0:
            print("[x] 探测失败，未改库")
            return 3
        if not APPLY:
            print("\nDRY-RUN 结束，生产库未改。确认后加 --apply。")
            return 0

        print("\n═══ ② 上传并执行 ═══")
        rc, home, _ = sh("echo $HOME")
        home = home.strip() or "/home/ubuntu"
        stage = f"{home}/dbee-0057"
        sh(f"rm -rf '{stage}' && mkdir -p '{stage}' && chmod 700 '{stage}'")
        sftp = cli.open_sftp()
        sftp.put(SQL_LOCAL, f"{stage}/{SQL_NAME}")
        sftp.close()
        rc, out, err = sh(
            f"sudo -n install -d -m 0755 {REMOTE_DIR} && "
            f"sudo -n cp '{stage}/{SQL_NAME}' {REMOTE_DIR}/{SQL_NAME} && "
            f"sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f {REMOTE_DIR}/{SQL_NAME}"
        )
        print(out.strip())
        if err.strip():
            print(err.strip())
        if rc != 0:
            print("[x] psql 失败")
            return 3

        print("\n═══ ③ 改后探测 ═══")
        rc, out, err = sh(probe)
        print(out.strip() or err.strip() or f"rc={rc}")
        if "policy=payment_orders_gateway_select" not in out.replace(" ", ""):
            # 输出带空格，用宽松判断
            if "payment_orders_gateway_select" not in out:
                print("[x] 策略未出现")
                return 3
        print("策略已在库内。不用重装 App，重新点一次支付宝即可。")
        return 0 if rc == 0 else 3
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
