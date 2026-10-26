#!/usr/bin/env bash
# 只读：核查 SECURITY DEFINER 函数的 proacl——哪些仍对 PUBLIC 开放 EXECUTE
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ SECURITY DEFINER 函数的 EXECUTE 权限明细 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS func,
       COALESCE(array_to_string(p.proacl, ' | '), '(默认=PUBLIC 可执行)') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef
ORDER BY p.proname;" 2>/dev/null

echo
echo "══════════ 结论行：proacl 为 NULL（= PUBLIC 仍可执行）的 SECURITY DEFINER 函数 ══════════"
SUDO -u postgres psql -d dbee -tAc "
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND p.proacl IS NULL
ORDER BY p.proname;" 2>/dev/null

echo
echo "══════════ acl 中含 '=X/'（PUBLIC 显式保留 EXECUTE）的 ══════════"
SUDO -u postgres psql -d dbee -tAc "
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef
  AND array_to_string(p.proacl,',') LIKE '%=X/%'
ORDER BY p.proname;" 2>/dev/null

echo "═══ 结束 ═══"
