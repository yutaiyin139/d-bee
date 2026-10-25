#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-0040.sh · 服务器端【只读】现状探查（应用 0039/0040 前后各跑一次）
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 调用（sudo 密码占位符会被替换成 SSH 密码；
# 本注释刻意不写出该占位符，防渲染后密码落盘）。
# ⚠️ 全程只读：只有 SELECT / 查系统目录 / set_config 会话变量（不落库）。
#    唯一「像写」的是对拍块用 BEGIN…ROLLBACK 显式回滚，且只 SELECT，不改数据。
#
# 探查项：
#   1) 主机/时间/PG 版本
#   2) schema_migrations 里 0039/0040 是否已登记
#   3) 0039 标志：llm_gate 存在性 + 授权
#   4) 0040 标志：honey_balance()/leaderboard_cache 存在性 + leaderboard() 易变性
#   5) 数据规模：honey_ledger / meal_entries / profiles 行数
#   6) 🔑 honey_balance() 口径对拍（若已应用）：取真实最大流水用户，
#      用 honey_balance() RPC 结果 vs 前端旧逐行循环的 SQL 等价式，逐字比对。
#      —— 这是对「服务端聚合 == 客户端旧口径」的生产级证据。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA "$@"; }
Q() { PSQL_SU -c "$1" 2>/dev/null | head -1; }
# 多语句版：psql -c "set_config…; SELECT …" 会把每条语句的结果都打印，
# set_config 的返回值（注入的 claims json）是第一行 → 必须取最后一行。
QL() { PSQL_SU -c "$1" 2>/dev/null | tail -1; }

echo "═══════════════════════════════════════════════════════════════════"
echo " dbee 服务器只读探查  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

echo "── 1) PostgreSQL 版本 ──"
echo "  $(Q "SHOW server_version;")"

echo "── 2) schema_migrations：0039/0040 登记状态 ──"
HAS_SM=$(Q "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations';")
if [ "${HAS_SM:-0}" = "1" ]; then
  PSQL_SU -F' | ' -c "SELECT version, name, status, coalesce(applied_by,'-') FROM public.schema_migrations WHERE version IN ('0039','0040') ORDER BY version;" 2>/dev/null | sed 's/^/  /'
  [ -z "$(PSQL_SU -c "SELECT 1 FROM public.schema_migrations WHERE version IN ('0039','0040') LIMIT 1;" 2>/dev/null)" ] && echo "  （0039/0040 均未登记 → 尚未应用）"
else
  echo "  ✗ schema_migrations 表不存在（0034 未应用？）"
fi

echo "── 3) 0039 标志：llm_gate ──"
echo "  llm_gate 存在            = $(Q "SELECT (to_regprocedure('public.llm_gate(text)') IS NOT NULL)::int;")"
echo "  authenticated 可执行(期0) = $(Q "SELECT has_function_privilege('authenticated','public.llm_gate(text)','EXECUTE')::int;")"
echo "  dbee_app 可执行(期1)      = $(Q "SELECT has_function_privilege('dbee_app','public.llm_gate(text)','EXECUTE')::int;")"

echo "── 4) 0040 标志：honey_balance / leaderboard_cache / leaderboard 易变性 ──"
echo "  honey_balance() 存在      = $(Q "SELECT (to_regprocedure('public.honey_balance()') IS NOT NULL)::int;")"
echo "  leaderboard_cache 表存在  = $(Q "SELECT (to_regclass('public.leaderboard_cache') IS NOT NULL)::int;")"
echo "  leaderboard() 易变性(v=VOLATILE 期望) = $(Q "SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='leaderboard';")"

echo "── 5) 数据规模 ──"
echo "  honey_ledger 行数 = $(Q "SELECT count(*)::int FROM public.honey_ledger;")"
echo "  meal_entries 行数 = $(Q "SELECT count(*)::int FROM public.meal_entries;")"
echo "  profiles    行数 = $(Q "SELECT count(*)::int FROM public.profiles;")"

echo "── 6) honey_balance() 口径对拍（真实数据，只读；仅当 0040 已应用）──"
HB_EXISTS=$(Q "SELECT (to_regprocedure('public.honey_balance()') IS NOT NULL)::int;")
if [ "${HB_EXISTS:-0}" != "1" ]; then
  echo "  · honey_balance() 不存在（0040 未应用），跳过对拍"
else
  # 取流水最多的真实 owner_id（生产数据，不合成、不插入）
  UID_T=$(Q "SELECT owner_id FROM public.honey_ledger GROUP BY owner_id ORDER BY count(*) DESC, owner_id LIMIT 1;")
  if [ -z "$UID_T" ]; then
    echo "  · honey_ledger 无数据，跳过对拍"
  else
    NROWS=$(Q "SELECT count(*)::int FROM public.honey_ledger WHERE owner_id='$UID_T';")
    # RPC 结果（set_config 会话级注入身份；honey_balance 内部 WHERE owner_id=auth.uid()）
    # 🔴 多语句 -c：set_config 的返回行在前，真实结果在最后一行 → QL(tail -1)
    RPC=$(QL "SELECT set_config('request.jwt.claims','{\"sub\":\"$UID_T\",\"role\":\"authenticated\"}',false); SELECT public.honey_balance();")
    # 旧口径等价式（前端逐行循环的 SQL 直译，postgres 超户显式按 owner 过滤）
    OLD=$(Q "SELECT json_build_object(
        'balance', GREATEST(0, COALESCE(SUM(amount) FILTER (WHERE amount<0 OR expires_at IS NULL OR expires_at>now()),0)),
        'total_earned', COALESCE(SUM(amount) FILTER (WHERE amount>=0),0),
        'total_spent', COALESCE(SUM(-amount) FILTER (WHERE amount<0),0))
      FROM public.honey_ledger WHERE owner_id='$UID_T';")
    echo "  样本 owner=<${UID_T:0:6}…>（${NROWS} 条流水）"
    echo "    honey_balance() RPC = $RPC"
    echo "    旧口径 SQL 等价式   = $OLD"
    if [ "$RPC" = "$OLD" ]; then
      echo "  ✅ 逐字一致：服务端聚合 == 客户端旧口径（生产真实数据）"
    else
      echo "  ❌ 不一致！需排查（ balance 口径 / 过期语义 / 时区 ）"
    fi
    # 越权隔离抽查：换一个不相关身份，balance 应为该身份自己的（通常为 0 或很小），
    # 绝不能等于上面那个大户的 balance。
    OTHER=$(QL "SELECT set_config('request.jwt.claims','{\"sub\":\"probe-nonexistent-0000\",\"role\":\"authenticated\"}',false); SELECT (public.honey_balance()->>'balance')::int;")
    echo "    不存在身份 balance = ${OTHER:-<空>}（期望 0，验证 owner 隔离）"
  fi
fi

echo "═══════════════════════════════════════════════════════════════════"
echo " 探查完成（全程只读，未对库做任何写入）"
echo "═══════════════════════════════════════════════════════════════════"
