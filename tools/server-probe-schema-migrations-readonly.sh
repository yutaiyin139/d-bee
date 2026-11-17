#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-schema-migrations-readonly.sh · 【纯只读】核实追踪表结构
#
# 背景：0053 是全仓唯一缺 schema_migrations 登记 + NOTIFY + BEGIN/COMMIT 的迁移
#   （实测 0045/0048~0052/0054/0055 均有，仅 0053 三项全缺）→ 补齐前必须按铁律
#   「写 SQL 前必核 information_schema.columns 列名」确认真实列与唯一约束，
#   否则 INSERT 会因列名/约束不符而失败（历史踩坑：误写 `id` 而非 `version`）。
# 🔴 零写入：只 SELECT / information_schema 查询。绝不 restart/reload/deploy。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

echo "【1】schema_migrations 真实列（名称 / 类型 / 是否可空 / 默认值）"
Q "SELECT column_name||' | '||data_type||' | nullable='||is_nullable||' | default='||coalesce(column_default,'(none)')
   FROM information_schema.columns
   WHERE table_schema='public' AND table_name='schema_migrations'
   ORDER BY ordinal_position;" 2>&1 | sed 's/^/  /'

echo ""
echo "【2】唯一约束 / 索引（决定 ON CONFLICT 目标列）"
Q "SELECT conname||' | '||pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid='public.schema_migrations'::regclass;" 2>&1 | sed 's/^/  /'
Q "SELECT indexname||' | '||indexdef FROM pg_indexes
   WHERE schemaname='public' AND tablename='schema_migrations';" 2>&1 | sed 's/^/  /'

echo ""
echo "【3】既有登记行样例（学习 status/applied_by/note 取值口径）"
Q "SELECT version||' | '||name||' | status='||status||' | by='||coalesce(applied_by,'NULL')||' | note='||coalesce(left(note,40),'NULL')
   FROM public.schema_migrations
   WHERE version IN ('0050','0051','0052','0054','0055')
   ORDER BY version;" 2>&1 | sed 's/^/  /'

echo ""
echo "【4】0053 是否真缺登记（应为 0）"
Q "SELECT 'count(0053)='||count(*) FROM public.schema_migrations WHERE version='0053';" 2>&1 | sed 's/^/  /'
echo "  重复登记的 version（0020/0030 历史各出现 2 次，需知道 ON CONFLICT 行为）:"
Q "SELECT version||' x'||count(*) FROM public.schema_migrations GROUP BY version HAVING count(*)>1 ORDER BY version;" 2>&1 | sed 's/^/    /'

echo ""
echo "【5】profiles 现状（0053 将新增列，先确认基线）"
Q "SELECT 'profiles 列总数='||count(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='profiles';" 2>&1 | sed 's/^/  /'
Q "SELECT 'profiles 行数='||count(*) FROM public.profiles;" 2>&1 | sed 's/^/  /'
Q "SELECT 'health_connected=true 行数='||count(*) FROM public.profiles WHERE health_connected IS TRUE;" 2>&1 | sed 's/^/  /'
Q "SELECT 'CHECK 约束总数='||count(*) FROM pg_constraint
   WHERE conrelid='public.profiles'::regclass AND contype='c';" 2>&1 | sed 's/^/  /'

echo ""
echo "【6】PostgREST 是否监听 pgrst 通道（NOTIFY 是否真会触发 reload）"
SUDO journalctl -u postgrest -n 400 --no-pager 2>&1 | grep -icE 'reload|schema cache' | sed 's/^/  近400行 reload\/schema cache 命中: /'
SUDO systemctl is-active postgrest 2>&1 | sed 's/^/  postgrest is-active: /'

echo ""
echo "【只读核实完成 · 零写入】"
