#!/usr/bin/env bash
# 只读：对比自建库与云库的 0039 闸门函数版本（函数体长度 + 关键特征）。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }
Q="select p.proname,
  length(pg_get_functiondef(p.oid)) as def_len,
  (pg_get_functiondef(p.oid) ~ 'advisory') as advisory_lock,
  (pg_get_functiondef(p.oid) ~ 'meal_entries|water_logs|exercise_logs') as verifies_facts,
  (pg_get_functiondef(p.oid) ~ 'p_limit') as trusts_client_limit,
  (pg_get_functiondef(p.oid) ~ '0039|_lb_compute_streak') as has_0039_marker
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('grant_honey','grant_photo_bonus','consume_ai_quota','consume_photo_quota','redeem_honey','settle_apple_receipt','revoke_apple_entitlement','log_apple_notification')
order by 1"
echo "══════════ 自建库（dbee @ 150.158.51.106）══════════"
SUDO -u postgres psql -d dbee -A -F' | ' -c "$Q" 2>/dev/null
echo
echo "══════════ 自建库涉权益表写权限（authenticated/anon 应只有 SELECT）══════════"
SUDO -u postgres psql -d dbee -A -F' | ' -c "select grantee, table_name, privilege_type from information_schema.role_table_grants where grantee in ('authenticated','anon') and table_name in ('honey_ledger','entitlements','ai_usage','badges','payment_orders','apple_transactions') order by 2,3,1" 2>/dev/null
echo
echo "══════════ 自建库 schema_migrations 是否记录 0039/0040 ══════════"
SUDO -u postgres psql -d dbee -A -F' | ' -c "select name, applied_at from schema_migrations where name like '00%' order by name desc limit 8" 2>/dev/null || echo "  <无 schema_migrations 表>"
echo "══════════ 结束 ══════════"
