#!/usr/bin/env bash
# 只读勘察：为创建 dbee_admin 只读角色做准备
# ① SECURITY DEFINER 函数（只读角色的潜在写口子）② 客户端来源 IP ③ pg_hba 全文 ④ 现有角色/成员关系
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ ① public schema 下 SECURITY DEFINER 函数（只读角色须防的写口子）══════════"
SUDO -u postgres psql -d dbee -c "
SELECT p.proname AS func,
       pg_get_function_identity_arguments(p.oid) AS args,
       r.rolname AS owner,
       p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, p.proname;" 2>/dev/null

echo "--- 其中 SECURITY DEFINER = true 的（重点）---"
SUDO -u postgres psql -d dbee -tAc "
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef
ORDER BY p.proname;" 2>/dev/null

echo
echo "══════════ ② 当前/历史客户端连接来源 IP（判断 pgAdmin 从哪连）══════════"
echo "--- pg_stat_activity 现有非本机连接 ---"
SUDO -u postgres psql -d dbee -c "
SELECT usename, client_addr, client_hostname, state, backend_start
FROM pg_stat_activity
WHERE client_addr IS NOT NULL AND client_addr <> '127.0.0.1'
ORDER BY backend_start DESC LIMIT 20;" 2>/dev/null
echo "--- 服务器自身公网 IP（对照用）---"
curl -s -m 10 https://api.ipify.org || echo "(取不到)"
echo

echo
echo "══════════ ③ pg_hba.conf 全文（决定加哪些放行行）══════════"
SUDO grep -vE '^\s*#|^\s*$' /etc/postgresql/*/main/pg_hba.conf 2>/dev/null

echo
echo "══════════ ④ 现有角色与成员关系 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
FROM pg_roles
WHERE rolname NOT LIKE 'pg\_%'
ORDER BY rolname;" 2>/dev/null
echo "--- dbee_admin 是否已存在 ---"
SUDO -u postgres psql -d dbee -tAc "SELECT count(*) FROM pg_roles WHERE rolname='dbee_admin';" 2>/dev/null

echo
echo "══════════ ⑤ PG 版本 + 配置文件路径 ══════════"
SUDO -u postgres psql -d dbee -tAc "SHOW server_version;" 2>/dev/null
SUDO -u postgres psql -d dbee -tAc "SHOW hba_file;" 2>/dev/null
echo "--- public schema 表数量（GRANT SELECT 覆盖面）---"
SUDO -u postgres psql -d dbee -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public';" 2>/dev/null
echo "--- public schema 序列数量 ---"
SUDO -u postgres psql -d dbee -tAc "SELECT count(*) FROM information_schema.sequences WHERE sequence_schema='public';" 2>/dev/null

echo
echo "═══ 结束 ═══"
