#!/usr/bin/env bash
# 只读：查 auth.uid() 实现 + 验证「设置 GUC 后 dbee_app 能否看到行」
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ auth.uid() 函数定义 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT pg_get_functiondef(oid) FROM pg_proc
WHERE pronamespace='auth'::regnamespace AND proname='uid';" 2>/dev/null

echo
echo "══════════ auth schema 里有哪些函数/视图 ══════════"
SUDO -u postgres psql -d dbee -tAc "
SELECT proname FROM pg_proc WHERE pronamespace='auth'::regnamespace ORDER BY proname;" 2>/dev/null

echo
echo "══════════ 验证：dbee_app 设置 request.jwt.claims 后能否看到对应 owner 的行 ══════════"
echo "--- 先取一个真实 owner_id ---"
OWNER=$(SUDO -u postgres psql -d dbee -tAc "SELECT owner_id FROM profiles LIMIT 1;" 2>/dev/null)
echo "    样本 owner_id = $OWNER"
echo "--- dbee_app 设置该 owner 的 JWT claim 后查询 profiles ---"
SUDO -u postgres psql -d dbee -c "
SET ROLE dbee_app;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', true);
SELECT current_user AS whoami, auth.uid() AS uid, count(*) AS visible_rows FROM profiles;" 2>&1

echo
echo "══════════ app_users 的强制 RLS 策略（dbee_app 应可见）══════════"
SUDO -u postgres psql -d dbee -c "
SET ROLE dbee_app;
SELECT count(*) AS app_users_visible FROM app_users;" 2>&1

echo
echo "═══ 结束 ═══"
