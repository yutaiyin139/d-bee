#!/usr/bin/env bash
# 只读：诊断「pgAdmin 看到 dbee 库表全空」的根因
# 排查维度：①有哪些库 ②dbee 库真实行数 ③RLS 是否开启 ④dbee_app 角色权限/BYPASSRLS
#          ⑤以 dbee_app 身份实际查询能否看到行（复现用户视角）⑥表 owner
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ ① 服务器上有哪些数据库（确认 pgAdmin 是否连错库）══════════"
SUDO -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname;"

echo
echo "══════════ ② dbee 库 public schema 各表真实行数（superuser 视角，不受 RLS 影响）══════════"
SUDO -u postgres psql -d dbee -c "
SELECT schemaname, relname AS table_name, n_live_tup AS approx_rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC, relname;"

echo "--- 关键表精确 count（superuser）---"
SUDO -u postgres psql -d dbee -c "
SELECT 'profiles' t, count(*) FROM profiles
UNION ALL SELECT 'app_users', count(*) FROM app_users
UNION ALL SELECT 'meal_entries', count(*) FROM meal_entries;"

echo
echo "══════════ ③ RLS 行级安全是否开启（这是 pgAdmin 空表最常见原因）══════════"
SUDO -u postgres psql -d dbee -c "
SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relkind='r' AND relnamespace='public'::regnamespace
ORDER BY relrowsecurity DESC, relname;"

echo "--- 已定义的 RLS 策略 ---"
SUDO -u postgres psql -d dbee -c "
SELECT tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname='public'
ORDER BY tablename;" 2>/dev/null | head -40

echo
echo "══════════ ④ 角色清单与 BYPASSRLS 属性（dbee_app 能否绕过 RLS）══════════"
SUDO -u postgres psql -d dbee -c "
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('postgres','dbee_app') OR rolname LIKE 'dbee%' OR rolname LIKE 'authenticator%' OR rolname LIKE 'anon%'
ORDER BY rolname;"

echo
echo "══════════ ⑤ 复现用户视角：以 dbee_app 身份查询，看能否看到行 ══════════"
echo "--- dbee_app 查 profiles（若返回 0 而 superuser 有行 => RLS 拦截）---"
SUDO -u postgres psql -d dbee -c "
SET ROLE dbee_app;
SELECT current_user AS whoami, count(*) AS visible_rows FROM profiles;" 2>&1

echo
echo "══════════ ⑥ 表 owner 与 dbee_app 的表级权限 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT tableowner, tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LIMIT 20;"
echo "--- dbee_app 对 profiles 的权限 ---"
SUDO -u postgres psql -d dbee -c "
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_name='profiles' ORDER BY grantee, privilege_type;"

echo
echo "══════════ ⑦ 网络监听面（pgAdmin 从公网连的可达性）══════════"
SUDO ss -ltnp 2>/dev/null | grep -E ':5432' || echo "(5432 未监听或无权限看进程)"
echo "--- listen_addresses / port ---"
SUDO -u postgres psql -tAc "SHOW listen_addresses; SHOW port;" 2>/dev/null
echo "--- pg_hba.conf 放行规则（决定谁能连、用什么角色）---"
SUDO grep -vE '^\s*#|^\s*$' /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | head -20

echo
echo "═══ 结束 ═══"
