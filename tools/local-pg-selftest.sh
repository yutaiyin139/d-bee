#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# local-pg-selftest.sh · 本地 Docker PG 实测 0039/0040 迁移（一次性容器）
# ═══════════════════════════════════════════════════════════════════════
# 目的：在没有服务器访问权限的开发机上，用一次性 postgres:17 容器验证：
#   A) 迁移全序列（0030-schema→0040）可从零应用成功（ON_ERROR_STOP=1）
#   B) 幂等性：全序列重跑第二遍仍成功
#   C) 0039 越权探针：无事实领分/凭空造额度/未知 reason/谎报里程碑/
#      谎报 limit 超限 全部被拒（BEGIN…ROLLBACK，合成 owner，不留痕）
#   D) 0040 实测：
#      · honey_balance() 与前端旧口径（逐行循环的 SQL 等价式）对拍一致
#        （合成流水覆盖：未过期正/已过期正/无过期正/负 四类）
#      · leaderboard() 缓存生效：连续两调（各自独立会话、自动提交），
#        第二次不刷新 computed_at；provolatile='v'（STABLE 写不进缓存）
#      · leaderboard_cache 对 authenticated/anon 零权限且直查被拒；
#        honey_balance 对 authenticated 可执行、对 anon 不可执行
#      · 未登录调 leaderboard() 返回 error=not_authenticated
#
# 用法：bash tools/local-pg-selftest.sh
# 依赖：docker 守护进程就绪；postgres:17-alpine 镜像（首次会拉取）。
# 清理：脚本自带 trap 删除容器（KEEP_CONTAINER=1 可保留现场排查）。
#
# 取值约定：psql -tA 会把 BEGIN/ROLLBACK 等命令标签也打成行，故所有
#   探针 SELECT 统一加 'MARK:' 前缀，用 grep '^MARK:' 精确取值。
# 事务约定：C 段探针在显式 BEGIN…ROLLBACK 内（不留痕）；
#   D3 缓存实测必须**自动提交**（缓存写入若随事务回滚，命中测试无意义）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="dbee-selftest-$$"
IMAGE="postgres:17-alpine"
PGPASSWORD_TEST="selftest-only"

FAIL=0
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
ok()   { echo "  ✓ $1"; }
chk()  { # chk <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 （实测=${2:-<空>}，期望=$3）"; fi
}

cleanup() {
  if [ "${KEEP_CONTAINER:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  else
    echo "  · KEEP_CONTAINER=1，保留容器 $NAME，排查后手动 docker rm -f $NAME"
  fi
}
trap cleanup EXIT

# 原样执行（多语句单隐式事务），stdout+stderr 全量返回
PSQL() { docker exec -e PGPASSWORD="$PGPASSWORD_TEST" "$NAME" psql -U postgres -d dbee -tA -c "$1" 2>&1; }
# 取 MARK 行值
MARK() { PSQL "$1" | grep '^MARK:' | head -1 | sed 's/^MARK://'; }
# 以 authenticated 身份取 MARK 行值（会话级 set_config + SET ROLE，自动提交）
MARK_AS() { # MARK_AS <uid> <sql>
  local claims="{\"sub\":\"$1\",\"role\":\"authenticated\"}"
  PSQL "SELECT set_config('request.jwt.claims', '$claims', false); SET ROLE authenticated; SELECT 'MARK:' || ($2)::text;" \
    | grep '^MARK:' | head -1 | sed 's/^MARK://'
}

echo "═══════════════════════════════════════════════════════════════════"
echo " dbee · 本地 Docker PG 实测（0039/0040）  $(date '+%F %T')"
echo "═══════════════════════════════════════════════════════════════════"

# ── 0) 起容器 ─────────────────────────────────────────────────────────
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PGPASSWORD_TEST" \
  -e POSTGRES_DB=dbee "$IMAGE" >/dev/null || {
  echo "✗ 容器启动失败（镜像拉取失败或 docker 守护进程未就绪）"; exit 1; }

echo "── 等待 PG 就绪 ──"
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d dbee >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d dbee >/dev/null 2>&1 \
  || { echo "✗ PG 60 秒未就绪"; exit 1; }
ok "postgres:17 容器就绪（$NAME）"

# ── A) 全序列应用 ────────────────────────────────────────────────────
echo
echo "── A) 迁移全序列应用（0030-schema→0040）──"
MIGS=(
  0030-schema.sql
  0031-app-users.sql
  0032-postgrest-roles.sql
  0033-app-rls-fix.sql
  0034-schema-migrations.sql
  0035-security-and-integrity.sql
  0036-data-sync-from-cloud.sql
  0037-apple-iap-settlement.sql
  0038-lifetime-price-298.sql
  0039-rpc-trust-boundary.sql
  0040-honey-balance-and-leaderboard-cache.sql
)
SEQ_OK=1
for m in "${MIGS[@]}"; do
  docker cp "$ROOT/db/migrations/$m" "$NAME:/tmp/$m" >/dev/null 2>&1 || { fail "拷贝 $m"; SEQ_OK=0; continue; }
  if docker exec -e PGPASSWORD="$PGPASSWORD_TEST" "$NAME" \
      psql -U postgres -d dbee -v ON_ERROR_STOP=1 -q -f "/tmp/$m" >/tmp/_mig_out.txt 2>&1; then
    ok "$m"
  else
    fail "$m"; tail -5 /tmp/_mig_out.txt | sed 's/^/      /'; SEQ_OK=0
  fi
done
[ "$SEQ_OK" = "1" ] || { echo "✗ 首轮应用失败，后续实测无意义，终止"; exit 1; }

# ── B) 幂等性：全序列重跑 ────────────────────────────────────────────
echo
echo "── B) 幂等性（全序列重跑第二遍）──"
IDEM_OK=1
for m in "${MIGS[@]}"; do
  if ! docker exec -e PGPASSWORD="$PGPASSWORD_TEST" "$NAME" \
      psql -U postgres -d dbee -v ON_ERROR_STOP=1 -q -f "/tmp/$m" >/tmp/_mig_out2.txt 2>&1; then
    fail "重跑 $m"; tail -5 /tmp/_mig_out2.txt | sed 's/^/      /'; IDEM_OK=0
  fi
done
[ "$IDEM_OK" = "1" ] && ok "11 个迁移重跑全部成功（CREATE OR REPLACE / IF NOT EXISTS / ON CONFLICT 幂等成立）"

# ── C) 0039 越权探针（BEGIN…ROLLBACK，合成 owner，不留痕）─────────────
echo
echo "── C) 0039 越权探针（期望全部被拒）──"
PROBE_UID="probe-00000000-0000-0000-0000-000000000000"
# 显式事务内探针（回滚不留痕）：set_config local=true + SET LOCAL ROLE
PROBE() { # PROBE <select-表达式>
  PSQL "BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$PROBE_UID\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT 'MARK:' || ($1)::text; ROLLBACK;" \
    | grep '^MARK:' | head -1 | sed 's/^MARK://'
}
chk "C1 无打卡事实领 checkin_meal → false" \
  "$(PROBE "public.grant_honey('checkin_meal', to_char(now(),'YYYY-MM-DD'), 5)")" "false"
chk "C2 凭空 grant_photo_bonus(honey) → false" \
  "$(PROBE "public.grant_photo_bonus('honey', 'x' || random(), 1, 7)")" "false"
chk "C3 未知 reason → false" \
  "$(PROBE "public.grant_honey('free_money', 'x', 999)")" "false"
chk "C4 谎报 7 天里程碑 → false" \
  "$(PROBE "public.grant_honey('streak_milestone', '7d-' || to_char(now(),'YYYY-MM-DD'), 40)")" "false"
# C5 consume_ai_quota：feature='scan' 白名单内，limit 谎报 999999 被库内化(=3)封顶：
#    前 3 次 allowed=t，第 4 次 allowed=f（返回 TABLE(allowed,used,remaining)，取 .allowed）
R5=$(PSQL "BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$PROBE_UID\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated;
SELECT (public.consume_ai_quota(NULL,'scan',999999,1)).allowed;
SELECT (public.consume_ai_quota(NULL,'scan',999999,1)).allowed;
SELECT (public.consume_ai_quota(NULL,'scan',999999,1)).allowed;
SELECT 'MARK:' || (SELECT allowed FROM public.consume_ai_quota(NULL,'scan',999999,1))::text;
ROLLBACK;" | grep '^MARK:' | head -1 | sed 's/^MARK://')
chk "C5 第 4 次 consume_ai_quota（谎报 limit=999999）→ allowed=false" "$R5" "false"
# C6 白名单外 feature 直接拒绝
chk "C6 feature='coach'（白名单外）→ allowed=false" \
  "$(PROBE "(SELECT allowed FROM public.consume_ai_quota(NULL,'coach',999999,1))")" "false"

# ── D1) 0040 对象与权限 ──────────────────────────────────────────────
echo
echo "── D1) 0040 对象与权限 ──"
chk "honey_balance() 存在" "$(MARK "SELECT (to_regprocedure('public.honey_balance()') IS NOT NULL)::int")" "1"
chk "honey_balance authenticated 可执行" "$(MARK "SELECT has_function_privilege('authenticated','public.honey_balance()','EXECUTE')::int")" "1"
chk "honey_balance anon 不可执行" "$(MARK "SELECT has_function_privilege('anon','public.honey_balance()','EXECUTE')::int")" "0"
chk "leaderboard_cache 表存在" "$(MARK "SELECT (to_regclass('public.leaderboard_cache') IS NOT NULL)::int")" "1"
chk "leaderboard_cache authenticated 零权限" "$(MARK "SELECT has_table_privilege('authenticated','public.leaderboard_cache','SELECT')::int")" "0"
chk "leaderboard_cache anon 零权限" "$(MARK "SELECT has_table_privilege('anon','public.leaderboard_cache','SELECT')::int")" "0"
chk "leaderboard() 易变性 = VOLATILE（写缓存的前提）" "$(MARK "SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='leaderboard'")" "v"
chk "honey_balance() 易变性 = STABLE" "$(MARK "SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='honey_balance'")" "s"
chk "schema_migrations 已登记 0040" "$(MARK "SELECT count(*)::int FROM public.schema_migrations WHERE version='0040' AND status='applied'")" "1"

# ── D2) honey_balance() 口径对拍 ─────────────────────────────────────
echo
echo "── D2) honey_balance() 口径对拍（四类流水合成）──"
HB_UID="hb-00000000-0000-0000-0000-000000000000"
# 合成流水：+100 未过期 / +50 已过期 / +30 无过期时间 / -40 负流水（自动提交）
PSQL "INSERT INTO public.honey_ledger (owner_id, amount, reason, ref_id, expires_at) VALUES
  ('$HB_UID', 100, 'probe_a', 'p1', now() + interval '30 days'),
  ('$HB_UID',  50, 'probe_b', 'p2', now() - interval '1 day'),
  ('$HB_UID',  30, 'probe_c', 'p3', NULL),
  ('$HB_UID', -40, 'probe_d', 'p4', now() + interval '30 days');" >/dev/null \
  || fail "合成流水插入失败"
RPC=$(MARK_AS "$HB_UID" "public.honey_balance()")
OLD=$(MARK "SELECT json_build_object(
    'balance', GREATEST(0, COALESCE(SUM(amount) FILTER (WHERE amount<0 OR expires_at IS NULL OR expires_at>now()),0)),
    'total_earned', COALESCE(SUM(amount) FILTER (WHERE amount>=0),0),
    'total_spent', COALESCE(SUM(-amount) FILTER (WHERE amount<0),0))
  FROM public.honey_ledger WHERE owner_id='$HB_UID'")
chk "RPC 与旧口径 SQL 等价式逐字一致" "$RPC" "$OLD"
chk "balance=90（100+30-40，过期 50 被排除）" "$(echo "$RPC" | grep -o '"balance":[0-9]*' | cut -d: -f2)" "90"
chk "total_earned=180（含过期入账，旧口径同）" "$(echo "$RPC" | grep -o '"total_earned":[0-9]*' | cut -d: -f2)" "180"
chk "total_spent=40" "$(echo "$RPC" | grep -o '"total_spent":[0-9]*' | cut -d: -f2)" "40"
# 越权隔离：另一个 uid 看不到 HB_UID 的流水
OTHER=$(MARK_AS "other-00000000-0000-0000-0000-000000000000" "public.honey_balance()")
chk "他人身份查询 → balance=0（owner 隔离）" "$(echo "$OTHER" | grep -o '"balance":[0-9]*' | cut -d: -f2)" "0"
PSQL "DELETE FROM public.honey_ledger WHERE owner_id='$HB_UID';" >/dev/null

# ── D3) leaderboard() 缓存命中 + 权限 ────────────────────────────────
echo
echo "── D3) leaderboard() 缓存 + 实时 my + 未登录拒绝 ──"
LB_UID="lb-00000000-0000-0000-0000-000000000000"
# 造满足上榜条件的用户：连续 3 天记餐（含今天）+ profile（自动提交）
PSQL "INSERT INTO public.profiles (owner_id, nickname, onboarded) VALUES ('$LB_UID','探针蜂',true);" >/dev/null \
  || fail "profile 插入失败"
PSQL "INSERT INTO public.meal_entries (owner_id, log_date, food_name, meal_type, calories)
  SELECT '$LB_UID', (current_date - (i||' days')::interval)::date, '探针餐', 'lunch', 500
  FROM generate_series(0,2) i;" >/dev/null || fail "meal_entries 插入失败"
# 第一次调用（独立会话，自动提交 → 缓存落盘）
R1=$(MARK_AS "$LB_UID" "public.leaderboard()")
T1=$(MARK "SELECT computed_at FROM public.leaderboard_cache WHERE id=1")
if [ -n "$T1" ]; then ok "首调后缓存已写入（computed_at=$T1）"; else fail "首调后缓存表为空（VOLATILE 写入未生效？）"; fi
sleep 2
# 第二次调用（应命中缓存 → computed_at 不变；my 部分实时）
R2=$(MARK_AS "$LB_UID" "public.leaderboard()")
T2=$(MARK "SELECT computed_at FROM public.leaderboard_cache WHERE id=1")
chk "二调命中缓存（computed_at 不变）" "$T2" "$T1"
MY=$(echo "$R2" | grep -o '"my":{[^}]*}')
chk "my.streak 实时 = 3" "$(echo "$MY" | grep -o '"streak":[0-9]*' | cut -d: -f2)" "3"
chk "my.invites 实时 = 0" "$(echo "$MY" | grep -o '"invites":[0-9]*' | cut -d: -f2)" "0"
echo "$R2" | grep -q '"name":"探\*"' && ok "自律榜含脱敏昵称「探*」" || fail "自律榜未见脱敏昵称（payload=$R2）"
# 未登录调用 → not_authenticated
R3=$(MARK_AS "" "public.leaderboard()")
# sub 为空串时 leaderboard 应拒绝
case "$R3" in *not_authenticated*) ok "空身份调用 → error=not_authenticated" ;; *) fail "空身份调用未拒绝（返回 $R3）" ;; esac
# authenticated 直查缓存表 → permission denied
R4=$(PSQL "BEGIN; SET LOCAL ROLE authenticated; SELECT count(*) FROM public.leaderboard_cache; ROLLBACK;" | tail -1)
case "$R4" in *[Pp]ermission\ denied*) ok "authenticated 直查缓存表 → permission denied" ;; *) fail "缓存表可被 authenticated 直查（$R4）" ;; esac
# 清理探针数据
PSQL "DELETE FROM public.meal_entries WHERE owner_id='$LB_UID'; DELETE FROM public.profiles WHERE owner_id='$LB_UID'; DELETE FROM public.leaderboard_cache WHERE id=1;" >/dev/null

# ── 汇总 ─────────────────────────────────────────────────────────────
echo
echo "══════════════════════════════════════════════════════════════════"
if [ "$FAIL" = "0" ]; then
  echo " ✅ 本地 PG 实测全过（迁移序列 + 幂等 + 0039 越权探针 + 0040 口径/缓存/权限）"
else
  echo " ❌ 失败 $FAIL 项"
fi
echo "══════════════════════════════════════════════════════════════════"
[ "$FAIL" = "0" ] && exit 0 || exit 1
