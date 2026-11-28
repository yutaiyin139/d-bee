"""把 0059 应用到生产库：积分扣减按发生时间摊销。

不跑 deploy-gateway.sh，不改 gateway.env，不重启网关。
探测事务会回滚，不留下合成流水。日志只打印余额数字和迁移号。

用法：
  python deploy/apply-0059-honey-spend-time.py --from <本地.env>
  python deploy/apply-0059-honey-spend-time.py --from <本地.env> --apply
"""
from __future__ import annotations

import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_NAME = "0059-honey-balance-spend-time.sql"
SQL_LOCAL = os.path.join(REPO, "db", "migrations", SQL_NAME)
REMOTE_DIR = "/tmp/dbee-mig"
APPLY = "--apply" in sys.argv

PROBE = r"""
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "SELECT 'BEFORE_LEDGER=' || count(*) FROM honey_ledger;"
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f - <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"probe-0059-spend-time","role":"authenticated"}', true);
INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at, created_at) VALUES
  ('probe-0059-spend-time', 150, 'newbie', 'probe-0059-a', now() - interval '10 days', now() - interval '40 days'),
  ('probe-0059-spend-time', -100, 'redeem', NULL, NULL, now() - interval '20 days'),
  ('probe-0059-spend-time', -150, 'expire', 'probe-0059-exp', NULL, now() - interval '9 days'),
  ('probe-0059-spend-time', 80, 'checkin_meal', 'probe-0059-b', now() + interval '200 days', now() - interval '5 days');
SELECT 'bal_before ' || (public.honey_balance()->>'balance');
SELECT 'redeemed ' || public.redeem_honey('ai1Scan');
SELECT 'bal_after ' || (public.honey_balance()->>'balance');
ROLLBACK;
SQL
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "SELECT (pg_get_functiondef('public.honey_balance()'::regprocedure) LIKE '%v_spend_at%')::text || '|' || (pg_get_functiondef('public.honey_balance()'::regprocedure) LIKE '%SUM(amount)%')::text;"
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "SELECT 'AFTER_LEDGER=' || count(*) FROM honey_ledger;"
sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA -c "SELECT 'MIG=' || version FROM schema_migrations WHERE version IN ('0058','0059') ORDER BY version;"
"""


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
        print("[x] 找不到凭据文件")
        return 2
    if not os.path.isfile(SQL_LOCAL):
        print(f"[x] 找不到 {SQL_NAME}")
        return 2
    dot = load_dotenv(src)
    host = (dot.get("IP") or dot.get("DBEE_HOST") or "").strip()
    user = (dot.get("USER") or dot.get("DBEE_SSH_USER") or "ubuntu").strip()
    if user == "dbee_app":
        user = "ubuntu"
    pwd = (dot.get("SSH_PWD") or "").strip()
    if not host or not pwd:
        print("[x] 凭据文件缺主机或 SSH_PWD")
        return 2

    print("═══ ⓪ 本地 ═══")
    print(f"  模式 = {'APPLY（会改生产函数）' if APPLY else 'DRY-RUN（不改生产库）'}")
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

    try:
        if not APPLY:
            print("\nDRY-RUN 结束，生产库未改。确认后加 --apply。")
            return 0

        print("\n═══ ① 上传并执行 ═══")
        sh(f"rm -rf '{REMOTE_DIR}' && mkdir -p '{REMOTE_DIR}' && chmod 700 '{REMOTE_DIR}'")
        sftp = cli.open_sftp()
        sftp.put(SQL_LOCAL, f"{REMOTE_DIR}/{SQL_NAME}")
        sftp.close()
        rc, out, err = sh(
            f"sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f - < '{REMOTE_DIR}/{SQL_NAME}'"
        )
        print(out.strip())
        if err.strip():
            print(err.strip())
        if rc != 0:
            print("[x] psql 失败")
            return 3

        print("\n═══ ② 回滚探测 ═══")
        rc, out, err = sh(PROBE, timeout=120)
        print(out.strip())
        if err.strip():
            print(err.strip())
        sh(f"rm -rf '{REMOTE_DIR}'")
        if rc != 0:
            print("[x] 探测失败")
            return 3
        if "bal_before 80" not in out or "redeemed t" not in out or "bal_after 30" not in out:
            print("[x] 兑换后余额不是 30")
            return 3
        if "AFTER_LEDGER=" not in out:
            print("[x] 没有流水计数")
            return 3
        before = ""
        after = ""
        for line in out.splitlines():
            if line.startswith("BEFORE_LEDGER="):
                before = line.split("=", 1)[1].strip()
            if line.startswith("AFTER_LEDGER="):
                after = line.split("=", 1)[1].strip()
        if not before or before != after:
            print("[x] 回滚后流水行数变了")
            return 3
        print("兑换后余额降到 30，探测已回滚，流水行数未变。")
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
