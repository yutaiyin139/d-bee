#!/usr/bin/env bash
# diag-redeem-constraints.sh · 只读：核对 0048 将要改动的约束/索引真实名称
# 动机：0048:97 写死 `DROP CONSTRAINT IF EXISTS redeem_codes_code_key`。若实际约束名
#       不是这个，IF EXISTS 会静默 no-op —— 迁移「成功」但 code 列仍带 UNIQUE。
#       本脚本先确认真名，避免「文档说生效 ≠ 库里生效」（0016/0026/0027 同类病根）。
# 本脚本零写入（无 INSERT/UPDATE/DDL/事务）。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }

echo "=== A) redeem_codes 上的表约束（conname / contype）==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select c.conname, case c.contype when 'p' then 'PRIMARY KEY' when 'u' then 'UNIQUE'
       when 'c' then 'CHECK' when 'f' then 'FK' else c.contype::text end,
       pg_get_constraintdef(c.oid)
from pg_constraint c join pg_class t on t.oid=c.conrelid
join pg_namespace n on n.oid=t.relnamespace
where n.nspname='public' and t.relname='redeem_codes' order by c.contype, c.conname"

echo "=== B) redeem_codes 上的索引（indexname / 定义）==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='redeem_codes' order by indexname"

echo "=== C) 0048 目标约束名是否存在（true 才能被 DROP CONSTRAINT 命中）==="
SUDO -u postgres psql -d dbee -tA -c "
select 'redeem_codes_code_key存在=' || exists(
  select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
  join pg_namespace n on n.oid=t.relnamespace
  where n.nspname='public' and t.relname='redeem_codes' and c.conname='redeem_codes_code_key')"

echo "=== D) code 列当前 NOT NULL / 是否可置空（0048:95 会 DROP NOT NULL）==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select column_name, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='redeem_codes' and column_name in ('code','code_hash','expires_at')
order by column_name"

echo "=== E) 谁在用 redeem_codes（RLS/授权现状，确认只有 postgres 能写）==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select coalesce(grantee,'<none>') as grantee, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.role_table_grants
where table_schema='public' and table_name='redeem_codes' group by grantee order by grantee"
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select 'RLS启用='||relrowsecurity||' RLS强制='||relforcerowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='redeem_codes'"

echo "=== F) pgcrypto 可装性（superuser 身份 + 扩展可用清单）==="
SUDO -u postgres psql -d dbee -tA -c "
select 'current_user='||current_user||' is_superuser='||usesuper
from pg_user where usename=current_user"
SUDO -u postgres psql -d dbee -tA -c "
select 'pgcrypto可安装=' || (select count(*)>0 from pg_available_extensions where name='pgcrypto')"

echo "=== G) 服务器本地是否已有 0048 文件（判断能否直接 psql -f）==="
ls -la /opt/dbee/db/migrations/ 2>/dev/null | tail -6 || echo "(/opt/dbee/db/migrations 不存在)"
find / -maxdepth 6 -name '0048-redeem-code-hardening.sql' -not -path '*/proc/*' 2>/dev/null | head -3 || true
echo "(空 = 服务器上没有 0048，必须先上传)"

echo "=== DIAG CONSTRAINTS DONE (read-only) ==="
exit 0
