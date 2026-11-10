#!/usr/bin/env bash
# diag-redeem-readiness.sh · 只读诊断：兑换码发码链路是否就绪
# 结论用途：回答「现在能不能发码 / 还差什么」。本脚本 **零写入**（无 INSERT/UPDATE/DDL）。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }

echo "=== 1) 迁移水位（schema_migrations 最大 5 条）==="
SUDO -u postgres psql -d dbee -tA -c "select version from schema_migrations order by version desc limit 5"

echo "=== 2) redeem_codes 列清单 ==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "select column_name, data_type, is_nullable from information_schema.columns where table_name='redeem_codes' order by ordinal_position"

echo "=== 3) 0048 三件套是否到位 ==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select 'code_hash列=' || exists(select 1 from information_schema.columns where table_name='redeem_codes' and column_name='code_hash')
union all select 'expires_at列=' || exists(select 1 from information_schema.columns where table_name='redeem_codes' and column_name='expires_at')
union all select 'redeem_attempts表=' || (select count(*)>0 from information_schema.tables where table_name='redeem_attempts')
union all select 'pgcrypto扩展=' || (select count(*)>0 from pg_extension where extname='pgcrypto')
union all select '明文code列仍在=' || exists(select 1 from information_schema.columns where table_name='redeem_codes' and column_name='code')"

echo "=== 4) 存量码盘点（不打印明文，只看数量与形态）==="
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select 'total=' || count(*) || ' unused=' || count(*) filter (where used_by is null)
       || ' used=' || count(*) filter (where used_by is not null)
       || ' code明文非空=' || count(*) filter (where code is not null)
from redeem_codes"
SUDO -u postgres psql -d dbee -tA -F' | ' -c "select 'plan='||plan||' months='||coalesce(months::text,'NULL')||' 长度='||length(code)||' 含连字符='||(code like '%-%')||' note='||coalesce(note,'<null>') from redeem_codes order by created_at"

echo "=== 5) redeem_by_code 是否已改为哈希匹配（只看函数体是否含 code_hash / digest）==="
SUDO -u postgres psql -d dbee -tA -c "
select 'prosrc含code_hash=' || (position('code_hash' in coalesce(pg_get_functiondef(p.oid),'')) > 0)
       || ' 含digest=' || (position('digest' in coalesce(pg_get_functiondef(p.oid),'')) > 0)
       || ' 含expires=' || (position('expires_at' in coalesce(pg_get_functiondef(p.oid),'')) > 0)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='redeem_by_code' limit 1"

echo "=== 6) 网关是否暴露 redeem 路由（预期：无，只能走 postgres）==="
SUDO grep -rIl "redeem" /opt/dbee/server 2>/dev/null | head -10 || echo "(server 目录无 redeem 命中)"

echo "=== DIAG DONE (read-only) ==="
exit 0
