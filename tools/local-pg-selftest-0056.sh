#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# local-pg-selftest-0056.sh · 本地 Docker PG 实测 0056（一次性容器，不碰生产）
# ═══════════════════════════════════════════════════════════════════════
# 目的：验证 0056「Apple 交易行匿名化保留」修复真实生效。
#
# 🔴 为什么必须有这个脚本：0056 修的是 P1 资损漏洞 ——
#   0045 的 delete_own_account 把 apple_transactions 一并 DELETE，导致
#   transaction_id 的 UNIQUE 幂等键被释放，删号用户可用**旧收据**对新账号
#   重新核销一次终身会员（成本 0，且可无限重复）。
#   0056 改为 owner_id 匿名化保留（'anon:'||md5()），保住幂等键。
#   这种「重放被拒」的行为**只能在真库里跑出来**，静态读代码证明不了。
#
# 覆盖的 6 条断言（全在真实 PG 17 上执行）：
#   E1 全序列（0030-schema→0056）可从零应用成功
#   E2 幂等性：0056 重跑第二遍仍成功
#   E3 结构：delete_own_account 的 v_tables 不再含 'apple_transactions' 字面量，
#           但含匿名化 UPDATE；settle_apple_purchase 含 NOT LIKE 'anon:%'
#   E4 🔴 核心：删号后交易行**仍在**、transaction_id **原值未变**、
#           owner_id 变成 anon: 前缀 → 幂等键未被释放
#   E5 🔴 重放拒绝：新 owner 拿同一 transaction_id 核销 → txn_taken_by_other
#   E6 🔴 幽灵 owner：webhook 路径（p_owner_id=NULL）反查匿名行 → owner_unresolved
#           （证明 NOT LIKE 'anon:%' 生效，不会给不存在的 owner 发孤儿权益）
#   E7 回归：删号仍真的删掉 16 张业务表的数据 + app_users 身份行
#
# 用法：bash tools/local-pg-selftest-0056.sh
# 依赖：docker 守护进程就绪；postgres:17-alpine 镜像（首次会拉取）
# 清理：trap 删除容器（KEEP_CONTAINER=1 保留现场排查）
#
# 取值约定：psql -tA 会把 BEGIN/ROLLBACK 等命令标签也打成行，故所有探针
#   SELECT 统一加 'MARK:' 前缀，用 grep '^MARK:' 精确取值。
# 事务约定：E4–E7 探针在显式 BEGIN…ROLLBACK 内（容器是一次性的，
#   回滚只是额外保险；真正的不留痕靠脚本结束删容器）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="dbee-0056-selftest-$$"
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

PSQL() { docker exec -e PGPASSWORD="$PGPASSWORD_TEST" "$NAME" psql -U postgres -d dbee -tA -c "$1" 2>&1; }
MARK() { PSQL "$1" | grep '^MARK:' | head -1 | sed 's/^MARK://'; }

echo "═══════════════════════════════════════════════════════════════════"
echo " dbee · 本地 Docker PG 实测 0056（P1 幂等键修复）  $(date '+%F %T')"
echo "═══════════════════════════════════════════════════════════════════"

# ── 0) 起容器 ─────────────────────────────────────────────────────────
docker info >/dev/null 2>&1 || { echo "✗ docker 守护进程未就绪"; exit 1; }
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

# ── E1) 全序列应用（0030-schema → 0056）──────────────────────────────
# 🔴 只跑 0030-schema 之后的自建序列（0030-full-selfhost-mirror 是云库镜像，
#    与 0030-schema 二选一；生产 selfhost 走 schema 这条）。
echo
echo "── E1) 迁移全序列应用（0030-schema → 0056）──"
MIGS=(
  0030-schema.sql 0031-app-users.sql 0032-postgrest-roles.sql
  0033-app-rls-fix.sql 0034-schema-migrations.sql 0035-security-and-integrity.sql
  0036-data-sync-from-cloud.sql 0037-apple-iap-settlement.sql
  0038-lifetime-price-298.sql 0039-rpc-trust-boundary.sql
  0040-honey-balance-and-leaderboard-cache.sql 0041-admin-readonly-role.sql
  0042-token-version.sql 0043-ident-kind-wechat.sql 0044-redeem-code-tiers.sql
  0045-account-deletion.sql 0046-wechat-xpay-settlement.sql
  0047-app-payment-settlement.sql 0048-redeem-code-hardening.sql
  0049-membership-server-gates.sql 0050-plan-start-date.sql
  0051-meal-entries-updated-at.sql 0052-llm-feature-walls.sql
  0053-health-vendor.sql 0054-honey-balance-fefo.sql 0055-honey-expire-backfill.sql
  0056-apple-txn-anonymize.sql
)
SEQ_OK=1
for m in "${MIGS[@]}"; do
  docker cp "$ROOT/db/migrations/$m" "$NAME:/tmp/$m" >/dev/null 2>&1 || { fail "拷贝 $m"; SEQ_OK=0; continue; }
  if docker exec -e PGPASSWORD="$PGPASSWORD_TEST" "$NAME" \
      psql -U postgres -d dbee -v ON_ERROR_STOP=1 -q -f "/tmp/$m" >/tmp/_mig56.txt 2>&1; then
    :
  else
    fail "应用 $m"; tail -8 /tmp/_mig56.txt | sed 's/^/      /'; SEQ_OK=0
  fi
done
[ "$SEQ_OK" = "1" ] && ok "${#MIGS[@]} 个迁移全序列应用成功（含 0056）" \
  || { echo "✗ 首轮应用失败，后续实测无意义，终止"; exit 1; }

# ── E2) 幂等性：0056 重跑 ────────────────────────────────────────────
echo
echo "── E2) 0056 幂等性（重跑第二遍）──"
if docker exec -e PGPASSWORD="$PGPASSWORD_TEST" "$NAME" \
    psql -U postgres -d dbee -v ON_ERROR_STOP=1 -q -f "/tmp/0056-apple-txn-anonymize.sql" >/tmp/_mig56b.txt 2>&1; then
  ok "0056 重跑成功（CREATE OR REPLACE + ON CONFLICT 幂等成立）"
else
  fail "0056 重跑失败"; tail -8 /tmp/_mig56b.txt | sed 's/^/      /'
fi
chk "schema_migrations 登记 0056 且 applied" \
  "$(MARK "SELECT count(*)::int FROM public.schema_migrations WHERE version='0056' AND status='applied'")" "1"

# ── E3) 结构断言 ─────────────────────────────────────────────────────
echo
echo "── E3) 函数结构断言 ──"
DEFDEL=$(PSQL "SELECT pg_get_functiondef('public.delete_own_account(text)'::regprocedure)")
echo "$DEFDEL" | grep -q "'apple_transactions'" \
  && fail "delete_own_account 的 v_tables 仍含 'apple_transactions' 字面量（幂等键会被释放）" \
  || ok "v_tables 已不含 'apple_transactions'（不再删交易行）"
echo "$DEFDEL" | grep -q "'anon:'" \
  && ok "含匿名化占位 'anon:'" \
  || fail "缺匿名化占位 'anon:'"
echo "$DEFDEL" | grep -q "md5(v_owner)" \
  && ok "含 md5(v_owner) 单向哈希" \
  || fail "缺 md5(v_owner)"
echo "$DEFDEL" | grep -q "public.apple_transactions" \
  && ok "含 UPDATE public.apple_transactions（匿名化在位）" \
  || fail "缺 UPDATE public.apple_transactions"
# 16 张带引号字面量（与 server-apply-0045.sh 同款口径）
chk "v_tables 覆盖 16 张「删号即删」业务表" \
  "$(MARK "SELECT count(*)::int FROM unnest(ARRAY['ai_quota_claims','ai_usage','badges','entitlements','exercise_logs','honey_ledger','invite_attempts','invite_links','meal_entries','payment_orders','profiles','quota_bonus','quota_bonus_newbie_retire_log','recipes','water_logs','weight_logs']) AS t WHERE pg_get_functiondef('public.delete_own_account(text)'::regprocedure) LIKE '%''' || t || '''%'")" "16"
DEFSET=$(PSQL "SELECT pg_get_functiondef('public.settle_apple_purchase(text,text,text,text,text,text,text,text,text)'::regprocedure)")
echo "$DEFSET" | grep -q "NOT LIKE 'anon:%'" \
  && ok "settle_apple_purchase 的 webhook 反查含 NOT LIKE 'anon:%'（防幽灵 owner）" \
  || fail "settle_apple_purchase 缺 NOT LIKE 'anon:%' 过滤"
chk "delete_own_account 仍是 SECURITY DEFINER" \
  "$(MARK "SELECT prosecdef::int FROM pg_proc WHERE oid='public.delete_own_account(text)'::regprocedure")" "1"
chk "PUBLIC/anon 无 EXECUTE" \
  "$(MARK "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='delete_own_account' AND grantee IN ('PUBLIC','anon')")" "0"
chk "authenticated 有 EXECUTE" \
  "$(MARK "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='delete_own_account' AND grantee='authenticated' AND privilege_type='EXECUTE'")" "1"

# ── 准备探针数据（真实商品行，settle 要求 payment_products 命中）──────
# 🔴 0030-schema 只建表不种商品（0038 是 UPDATE 已有行）→ 本地库必须先插一条，
#    否则 settle_apple_purchase 会返回 unknown_product 而不是我们要验的分支。
echo
echo "── 准备探针数据 ──"
PSQL "INSERT INTO public.payment_products (product_id, plan, months, amount_cents)
      VALUES ('dbee_lifetime','lifetime',NULL,29800)
      ON CONFLICT (product_id) DO UPDATE SET plan='lifetime', amount_cents=29800, active=true;" >/dev/null \
  && ok "payment_products 已有 dbee_lifetime（active）" \
  || fail "插入 payment_products 失败"

OLD_OWNER="1793250000000000001"
NEW_OWNER="1793990000000000002"
TXN="2000000111111111"
ORIG="1000000099999999"

# 造一个「已购买终身会员」的用户：app_users 身份行 + 一笔已核销交易 + 权益
PSQL "
INSERT INTO public.app_users (owner_id, ident_kind, ident_hash, ident_masked)
VALUES ('$OLD_OWNER','phone','probe-hash-0056','138****0001');
INSERT INTO public.profiles (owner_id, nickname, onboarded)
VALUES ('$OLD_OWNER','探针蜂',true);
INSERT INTO public.meal_entries (owner_id, log_date, food_name, meal_type, calories, source)
VALUES ('$OLD_OWNER', current_date, '探针餐', 'lunch', 500, 'photo');
INSERT INTO public.apple_transactions
  (transaction_id, original_transaction_id, owner_id, product_id, plan, environment)
VALUES ('$TXN','$ORIG','$OLD_OWNER','dbee_lifetime','lifetime','Production');
INSERT INTO public.entitlements (owner_id, plan, source)
VALUES ('$OLD_OWNER','lifetime','apple')
ON CONFLICT (owner_id) DO UPDATE SET plan='lifetime';
" >/dev/null && ok "探针数据就绪（老 owner 已购终身 + 1 笔交易 + 1 条餐食 + 权益）" \
  || fail "探针数据插入失败"

BEFORE_TXN=$(MARK "SELECT count(*)::int FROM public.apple_transactions")

# ── E4–E7) 核心探针：删号 → 幂等键是否保留 → 重放是否被拒 ──────────────
echo
echo "── E4) 🔴 核心：删号后幂等键是否保留 ──"
# delete_own_account 只信 auth.uid()，用 app.user_id GUC 注入身份（0030-schema:21）
DELRET=$(PSQL "SELECT set_config('app.user_id','$OLD_OWNER',false);
SELECT 'MARK:' || public.delete_own_account('DELETE_MY_ACCOUNT')::text;" \
  | grep '^MARK:' | head -1 | sed 's/^MARK://')
echo "  delete_own_account 返回：$DELRET"
echo "$DELRET" | grep -q '"ok": *true\|"ok":true' \
  && ok "删号成功（ok=true）" || fail "删号未成功：$DELRET"
echo "$DELRET" | grep -q '"anonymized_txn_rows": *1\|"anonymized_txn_rows":1' \
  && ok "anonymized_txn_rows=1（交易行被匿名化而非删除）" \
  || fail "anonymized_txn_rows 不为 1：$DELRET"
echo "$DELRET" | grep -q '"identity_removed": *true\|"identity_removed":true' \
  && ok "identity_removed=true（app_users 身份行已删）" \
  || fail "identity_removed 不为 true：$DELRET"

ROW=$(PSQL "SELECT 'MARK:' || json_build_object(
    'n', count(*),
    'txn', max(transaction_id),
    'owner', max(owner_id),
    'orig', max(original_transaction_id)
  )::text FROM public.apple_transactions WHERE transaction_id='$TXN';" \
  | grep '^MARK:' | head -1 | sed 's/^MARK://')
echo "  删号后该行：$ROW"
chk "🔴 交易行仍在（count=1，未被 DELETE）" \
  "$(echo "$ROW" | grep -o '"n":[0-9]*' | cut -d: -f2)" "1"
chk "🔴 transaction_id 原值未变（幂等键未被释放）" \
  "$(echo "$ROW" | grep -o '"txn":"[^"]*"' | cut -d'"' -f4)" "$TXN"
ANON_OWNER=$(echo "$ROW" | grep -o '"owner":"[^"]*"' | cut -d'"' -f4)
case "$ANON_OWNER" in
  anon:*) ok "owner_id 已匿名化为 anon: 前缀（$ANON_OWNER）" ;;
  *)      fail "owner_id 未匿名化：${ANON_OWNER:-<空>}" ;;
esac
[ "$ANON_OWNER" != "$OLD_OWNER" ] \
  && ok "owner_id 已不等于原值（身份关联被切断，PIPL 第 47 条）" \
  || fail "owner_id 仍等于原值（身份未切断）"
EXPECT_ANON="anon:$(printf '%s' "$OLD_OWNER" | md5sum | cut -d' ' -f1)"
chk "匿名值 == 'anon:'||md5(原 owner_id)（可复算，非随机）" "$ANON_OWNER" "$EXPECT_ANON"
chk "original_transaction_id 保留（退款/续订仍可归组对账）" \
  "$(echo "$ROW" | grep -o '"orig":"[^"]*"' | cut -d'"' -f4)" "$ORIG"
chk "apple_transactions 总行数未变（删号不产生也不消灭交易行）" \
  "$(MARK "SELECT count(*)::int FROM public.apple_transactions")" "$BEFORE_TXN"

echo
echo "── E7) 回归：删号仍真删 16 张业务表 + 身份行 ──"
chk "app_users 身份行已删" \
  "$(MARK "SELECT count(*)::int FROM public.app_users WHERE owner_id='$OLD_OWNER'")" "0"
chk "entitlements 权益行已删（幽灵权益不存在）" \
  "$(MARK "SELECT count(*)::int FROM public.entitlements WHERE owner_id='$OLD_OWNER'")" "0"
chk "meal_entries 业务数据已删" \
  "$(MARK "SELECT count(*)::int FROM public.meal_entries WHERE owner_id='$OLD_OWNER'")" "0"
chk "profiles 档案已删" \
  "$(MARK "SELECT count(*)::int FROM public.profiles WHERE owner_id='$OLD_OWNER'")" "0"

echo
echo "── E5) 🔴 重放拒绝：新 owner 拿同一 transaction_id 核销 ──"
# 这就是 P1 漏洞的攻击路径：删号 → 同号重注册 → 用旧收据再核销一次
REPLAY=$(PSQL "SELECT 'MARK:' || public.settle_apple_purchase(
    '$NEW_OWNER', NULL, 'dbee_lifetime', '$TXN', '$ORIG',
    NULL, NULL, 'Production', 'probe-receipt-sha')::text;" \
  | grep '^MARK:' | head -1 | sed 's/^MARK://')
echo "  settle 返回：$REPLAY"
case "$REPLAY" in
  *txn_taken_by_other*) ok "🔴 返回 txn_taken_by_other —— 重放被拒（修复生效）" ;;
  *) fail "🔴🔴 重放未被拒！返回：$REPLAY （= P1 资损漏洞仍存在）" ;;
esac
chk "新 owner 未获得权益（entitlements 无其行）" \
  "$(MARK "SELECT count(*)::int FROM public.entitlements WHERE owner_id='$NEW_OWNER'")" "0"
chk "未新增交易行（行数仍 = $BEFORE_TXN）" \
  "$(MARK "SELECT count(*)::int FROM public.apple_transactions")" "$BEFORE_TXN"

echo
echo "── E6) 🔴 幽灵 owner：webhook 路径反查匿名行 ──"
# p_owner_id=NULL 走 webhook 分支，按 original_transaction_id 反查 owner。
# 若缺 NOT LIKE 'anon:%'，这里会反查出 'anon:xxx' 当合法 owner →
# 给 app_users 里不存在的幽灵写 entitlements（静默脏数据，最难发现）。
GHOST=$(PSQL "SELECT 'MARK:' || public.settle_apple_purchase(
    NULL, NULL, 'dbee_lifetime', '2000000222222222', '$ORIG',
    NULL, NULL, 'Production', NULL)::text;" \
  | grep '^MARK:' | head -1 | sed 's/^MARK://')
echo "  settle 返回：$GHOST"
case "$GHOST" in
  *owner_unresolved*) ok "🔴 返回 owner_unresolved —— 不给幽灵 owner 发权益（与 0037 原语义一致）" ;;
  *) fail "🔴 幽灵 owner 被当成合法 owner！返回：$GHOST" ;;
esac
chk "未产生孤儿权益行（owner_id 以 anon: 开头的 entitlements 为 0）" \
  "$(MARK "SELECT count(*)::int FROM public.entitlements WHERE owner_id LIKE 'anon:%'")" "0"
chk "webhook 路径未新增交易行（行数仍 = $BEFORE_TXN）" \
  "$(MARK "SELECT count(*)::int FROM public.apple_transactions")" "$BEFORE_TXN"

# ── 附加：对照实验 —— 证明「删掉交易行」确实会导致重放成功 ────────────
echo
echo "── E8) 对照实验：还原 0045 行为（删交易行）→ 重放应成功 ──"
# 🔴 这一段是「无变异对照组」的反向应用：证明 E5 的拒绝**确实来自幂等键存在**，
#    而不是 settle 函数因为别的原因（如商品未激活）恰好拒绝。
#    删掉交易行后同一调用若返回 settled=true，则因果链闭合。
CTRL=$(PSQL "
DELETE FROM public.apple_transactions WHERE transaction_id='$TXN';
SELECT 'MARK:' || public.settle_apple_purchase(
    '$NEW_OWNER', NULL, 'dbee_lifetime', '$TXN', '$ORIG',
    NULL, NULL, 'Production', 'probe-receipt-sha')::text;" \
  | grep '^MARK:' | head -1 | sed 's/^MARK://')
echo "  删掉交易行后 settle 返回：$CTRL"
case "$CTRL" in
  *'"settled":true'*|*'"settled": true'*)
    ok "🔴 对照成立：交易行被删 → 重放立刻成功拿到权益（= 0045 原状的资损路径）"
    echo "     → 反证 E5 的拒绝确实由「幂等键保留」造成，因果链闭合" ;;
  *) fail "对照实验未按预期成功，E5 的结论存疑：$CTRL" ;;
esac
chk "对照组确证：删行后新 owner 拿到了 lifetime 权益" \
  "$(MARK "SELECT plan FROM public.entitlements WHERE owner_id='$NEW_OWNER'")" "lifetime"

# ── 汇总 ─────────────────────────────────────────────────────────────
echo
echo "══════════════════════════════════════════════════════════════════"
if [ "$FAIL" = "0" ]; then
  echo " ✅ 0056 本地真库实测全过"
  echo "    P1 幂等键漏洞已闭合：删号后 transaction_id 保留 → 旧收据重放被拒"
else
  echo " ❌ 失败 $FAIL 项"
fi
echo "══════════════════════════════════════════════════════════════════"
[ "$FAIL" = "0" ] && exit 0 || exit 1
