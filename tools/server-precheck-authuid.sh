#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-precheck-authuid.sh · 只读探查 auth.uid() 实现
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件注释不写出）。
# 目的：确认应用 0054 后如何在库内以指定 owner 真实调用 honey_balance()。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

echo "【auth.uid() 定义】"
PSQL_SU "SELECT pg_get_functiondef('auth.uid()'::regprocedure);" 2>&1 | sed 's/^/  /'

echo "【honey_balance 当前权限】"
PSQL_SU "SELECT grantee||'='||string_agg(privilege_type,',') FROM information_schema.routine_privileges WHERE routine_name='honey_balance' GROUP BY grantee;" 2>&1 | sed 's/^/  /'

echo "【试：SET claim 后调用当前旧函数（应得旧口径值）】"
OWNER=$(PSQL_SU "SELECT owner_id FROM public.app_users WHERE ident_masked='186****4399' LIMIT 1;")
PSQL_SU "SET request.jwt.claim.sub='$OWNER'; SELECT honey_balance();" 2>&1 | sed 's/^/  /'

echo "【schema_migrations 列结构】（确认 0054 追踪 INSERT 的列齐全）"
PSQL_SU "SELECT column_name||' '||data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' ORDER BY ordinal_position;" 2>&1 | sed 's/^/  /'

echo "【schema_migrations 唯一约束】（确认 ON CONFLICT (version,name) 可用）"
PSQL_SU "SELECT conname||': '||pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.schema_migrations'::regclass AND contype IN ('u','p');" 2>&1 | sed 's/^/  /'

echo "【是否已存在 0054 行】"
PSQL_SU "SELECT version||'|'||name||'|'||status FROM public.schema_migrations WHERE version='0054';" 2>&1 | sed 's/^/  /'
