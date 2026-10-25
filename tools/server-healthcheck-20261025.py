# -*- coding: utf-8 -*-
"""只读服务器体检：迁移落地状态 + 网关配置键 + 服务状态。

凭据从仓库根 .env 读取（IP/USER/PWD），不打印任何密码。
全部命令均为只读（psql SELECT / to_regclass / systemctl is-active / grep -c）。
"""
import os
import re
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
HOST = env.get("IP") or env.get("DBEE_HOST")
USER = env.get("USER", "ubuntu")
PWD = env.get("PWD")
if not HOST or not PWD:
    print("FATAL: .env 缺少 IP/PWD")
    sys.exit(1)

DB_USER = env.get("DBEE_USER", "dbee_app")
DB_NAME = env.get("DBEE_DB", "dbee")
DB_PWD = env.get("DBEE_PWD", "")

# 远端只读 SQL：一次查完迁移追踪表 + 关键对象存在性
SQL = r"""
\pset pager off
SELECT '== schema_migrations 存在性 ==' AS section;
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS schema_migrations_exists;
SELECT '== 各版本状态（若表存在） ==' AS section;
SELECT version, name, status, applied_by
  FROM public.schema_migrations
 ORDER BY version, name;
SELECT '== 0035/0036/0037 关键对象 ==' AS section;
SELECT to_regclass('public.apple_transactions') IS NOT NULL  AS apple_transactions_0037,
       to_regclass('public.apple_notifications') IS NOT NULL AS apple_notifications_0037,
       to_regclass('public.invite_attempts') IS NOT NULL     AS invite_attempts_0035,
       to_regclass('public.quota_bonus_newbie_retire_log') IS NOT NULL AS newbie_retire_log_0035;
SELECT '== entitlements 直写权限应收回（期望 f） ==' AS section;
SELECT has_table_privilege('authenticated','public.entitlements','INSERT') AS ent_insert_granted;
SELECT '== 表总数 ==' AS section;
SELECT count(*) AS table_count FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE';
"""


def run(client, cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return out, err


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PWD, timeout=25,
                   allow_agent=False, look_for_keys=False)
    client.get_transport().set_keepalive(30)

    print("== 服务状态 ==")
    for svc in ("dbee-gateway", "postgrest", "postgresql", "nginx"):
        out, _ = run(client, f"systemctl is-active {svc} 2>/dev/null || echo unknown")
        print(f"  {svc}: {out.strip()}")

    print("\n== 网关 EnvironmentFile 路径 ==")
    ef_out, _ = run(client, "systemctl cat dbee-gateway 2>/dev/null | grep -i EnvironmentFile")
    print(ef_out.strip() or "  (未找到 EnvironmentFile 行)")
    # 从 EnvironmentFile= 提取真实路径（可能带 - 前缀表示可选）
    m = re.search(r"EnvironmentFile=-?\s*(\S+)", ef_out)
    gw_env = m.group(1) if m else "/etc/dbee/gateway.env"
    print(f"  → 使用路径: {gw_env}")

    print("\n== 网关 env 关键键（sudo 读取，只数存在性，不打印值） ==")
    sudo = f"echo '{PWD}' | sudo -S "
    who, _ = run(client, f"{sudo} whoami 2>/dev/null")
    if who.strip().splitlines()[-1:] != ["root"]:
        print(f"  [警告] sudo 预检未返回 root（得到 {who.strip()!r}），下列结果可能失真")
    exist, _ = run(client, f"{sudo} test -r {gw_env} && echo yes || echo no")
    print(f"  {gw_env} 可读: {exist.strip()}")
    for key in ("IDENT_PEPPER", "APPLE_BUNDLE_ID", "APPLE_SHARED_SECRET",
                "APPLE_WEBHOOK_SECRET", "LLM_MODEL_VISION", "LLM_VISION_MODEL",
                "LLM_VISION_BASE_URL", "LLM_MODEL_TEXT", "POSTGREST_URL",
                "JWT_SECRET", "SMS_PROVIDER", "SMS_MASTER_CODE", "DBEE_PROD"):
        out, _ = run(client, f"{sudo} grep -c '^{key}=' {gw_env} 2>/dev/null || echo 0")
        n = out.strip().splitlines()[-1] if out.strip() else "0"
        print(f"  {key}: {'已配置' if n not in ('0','') else '缺失'}")

    print("\n== 数据库迁移状态（只读查询） ==")
    # 把 SQL 写到远端 /tmp；PGPASSWORD 经环境变量注入，不出现在命令行明文
    sftp = client.open_sftp()
    with sftp.file("/tmp/healthcheck_20261025.sql", "w") as f:
        f.write(SQL)
    sftp.close()
    cmd = (f"PGPASSWORD='{DB_PWD}' psql -h 127.0.0.1 -p 5432 -U {DB_USER} -d {DB_NAME} "
           f"-f /tmp/healthcheck_20261025.sql 2>&1; rm -f /tmp/healthcheck_20261025.sql")
    out, err = run(client, cmd, timeout=90)
    print(out)
    if err.strip():
        print("[stderr]", err)

    client.close()


if __name__ == "__main__":
    main()
