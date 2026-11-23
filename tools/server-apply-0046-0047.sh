#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0046-0047.sh · 服务器端应用 0046 + 0047 迁移（含专用备份）
# ═══════════════════════════════════════════════════════════════════════
# 由 tools/apply-app-payment-settlement-prod.py 上传到 /tmp/dbee-mig/ 后调用。
# 前置：0046/0047 两个 .sql 已上传（LF、权限 644）。
#
# ── 为什么现在要补这两个迁移（2026-11-22 20:45 生产实测）──────────────
#   用户要求「Android 今天打包收费」。只读探针实证 **Android APP 支付链路
#   是「代码已写、生产未部署」状态**，与 2026-11-06 的 0043/微信登录 A1 完全同型：
#     · POST /.cloud/payment/apppay/prepay → **404**（不是 503！）
#     · /opt/dbee-gateway/lib/apppay.mjs → **文件不存在**
#     · /opt/dbee-gateway/lib/config.mjs grep ALIPAY_APP_ID → **0 命中**
#     · 生产 lib/ 仅 13 个 .mjs（app/auth/config/db/dbproxy/http/iap/identity/
#       jwt/llm/otp/sms/werun），**无 apppay.mjs、无 xpay.mjs**
#     · schema_migrations 0040–0045、0048–0055 全 applied，**独缺 0046、0047**
#     · app_payment_transactions / xpay_transactions 表 **均不存在**
#     · settle_app_payment / settle_xpay_purchase 函数 **均不存在**
#       （🔴 探测教训：LIKE 'settle_app%' 会误匹配 settle_apple_purchase，
#         存在性判定必须用精确等值，本脚本全部断言用精确名）
#
# ── 本脚本的职责边界（诚实标注，不得越界宣称）─────────────────────────
#   ✅ 它做的：把 0046/0047 的 **DB 结构与权限** 在生产就位，并用断言钉死。
#   ❌ 它不做的（属后续步骤，别把本脚本的绿灯当成「能收款」）：
#     · 不部署网关代码（B3：apppay.mjs + config.mjs + app.mjs 三文件同批）
#       → 只做本脚本，端点**仍是 404**；做完 B3 未配 env，才变成 503。
#     · 不配任何支付 env（B8：ALIPAY_APP_ID/PRIVATE_KEY/PUBLIC_KEY）
#     · 不重打 APK（B9：vc31 的 dex 内 Lcom/dbee/alipay = 0）
#     · 不做端到端收款验证（B10/B11：须网关在线 + 资质齐 + 真机 1 分钱）
#     · 不做 settle_app_payment 的运行时行为探针：该函数 9 参数、依赖
#       payment_orders 真实订单态与 auth.uid() 上下文，端到端验证属 B10 职责；
#       本脚本只保证「结构与权限就位」，**不宣称「核销逻辑已验证」**。
#
# ── 🔴 顺序不可换（本脚本最核心的约束）────────────────────────────────
#   0046 与 0047 **都 CREATE OR REPLACE public.verify_payment_order(text,text,text)**：
#     · 0046 版：IF v_order.provider = 'wechat_xpay' THEN RETURN false
#     · 0047 版：IF v_order.provider IN ('wechat_xpay','wechat','alipay') THEN RETURN false
#   → 0047 是 0046 的**超集**，正序应用后 wechat_xpay 语义被完整继承。
#   → 🔴 **倒序（0047→0046）会让 xpay 侧核销逻辑被 0046 版覆盖**，
#     小程序虚拟支付（provider='wechat_xpay'）的查单语义丢失 = 静默资损。
#   本脚本用【顺序守卫】断言把这一点钉死：应用后 verify_payment_order 的
#   函数体必须**同时**含 'wechat_xpay' 与 'alipay'（缺一不可）。
#
# ── 🔴 与 0043-0044 范式的两处刻意差异（照搬会误杀）───────────────────
#   ① 0044 有「绝不允许 FORCE ROW LEVEL SECURITY」自检；但 **0046/0047 的设计
#      恰恰是 ENABLE + FORCE 双开**（0046:166-169、0047:126-129 明文写死），
#      因为这两组表只允许 SECDEF 函数以属主身份访问，FORCE 是**纵深防御**。
#      → 本脚本断言方向**相反**：relrowsecurity=1 且 relforcerowsecurity=1。
#      🔴 若将来有人把 0044 那条自检复制进来，会直接 FATAL 拒绝应用。
#   ② 0043-0044 由 deploy/dbee-ssh.py 注入 sudo 密码占位符；本脚本走
#      **sudo -n（免密）**，与 tools/server-apply-0056.sh 同口径。
#      2026-11-22 20:45 实测 ubuntu 用户具备 NOPASSWD sudo（sudo -n ls 成功）。
#      🔴 本脚本**刻意不含任何密码占位符**，避免渲染后密码落盘。
#
# 步骤（任一步失败立即终止，不留半成品）：
#   ⓪ 前置检查（文件在场、无 CR、无 0044 式 FORCE 误判、事务边界齐备）
#   ① 专用备份 pg_dump -Fc + pg_restore --list 验 TOC>100（没验过 TOC 的备份不算备份）
#   ② 应用 0046（文件自带 BEGIN/COMMIT，ON_ERROR_STOP=1，失败自动回滚）
#   ③ 应用 0047（同上，必须在 0046 之后）
#   ④ 幂等复验：两个文件各重跑一遍，必须依然成功
#   ⑤ 断言：0046 结构 / 0047 结构 / 🔴顺序守卫 / 权限守卫 / RLS 守卫 / CHECK 约束
#   ⑥ 回归守卫：既有支付相关对象未被本次迁移破坏
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { sudo -n "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR="${MIG_DIR:-/tmp/dbee-mig}"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/var/backups/dbee
DEST="$BACKUP_DIR/backup-before-0046-0047-$TS.dump"
M46=0046-wechat-xpay-settlement.sql
M47=0047-app-payment-settlement.sql

# 函数签名（精确等值匹配用；🔴 不得改成 LIKE 前缀匹配，见头部探测教训）
F_VERIFY="public.verify_payment_order(text,text,text)"
F_SETTLE_46="public.settle_xpay_purchase(text,text,text,text,text,integer,integer,integer,text,integer,bigint,text)"
F_REVOKE_46="public.revoke_xpay_purchase(text,text,text)"
F_LOG_46="public.log_xpay_notification(jsonb,text,text,text,text,boolean,text)"
F_SETTLE_47="public.settle_app_payment(text,text,text,text,text,text,integer,bigint,text)"
F_REVOKE_47="public.revoke_app_payment(text,text,text)"
F_LOG_47="public.log_app_notification(jsonb,text,text,text,text,boolean,text)"

die() { echo "✗ FATAL: $*"; exit 1; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 应用 0046 + 0047（Android APP 支付结算地基） $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ⓪ 前置检查 ─────────────────────────────────────────────────────
for f in "$M46" "$M47"; do
  [ -s "$MIG_DIR/$f" ] || die "缺少 $MIG_DIR/$f（先由驱动脚本上传）"
  if grep -qU $'\r' "$MIG_DIR/$f"; then die "$f 含 CR 字符（换行未归一，拒绝应用）"; fi
done
echo "✓ 迁移文件就绪（无 CR）"

# 事务边界：两文件都必须自带 BEGIN/COMMIT（否则 ON_ERROR_STOP 失败时留半成品）
for f in "$M46" "$M47"; do
  grep -qE '^BEGIN;' "$MIG_DIR/$f" || die "$f 无 BEGIN; —— 缺事务边界，拒绝应用"
  grep -qE '^COMMIT;' "$MIG_DIR/$f" || die "$f 无 COMMIT; —— 缺事务边界，拒绝应用"
done
echo "✓ 两文件事务边界齐备（BEGIN/COMMIT）"

# 🔴 破坏性语句自检：本批只应是 CREATE/ALTER ADD/GRANT/REVOKE/INSERT 登记，
#    绝不允许 DROP TABLE / TRUNCATE / 无 WHERE 的 DELETE（0056 范式同款守卫）。
for f in "$M46" "$M47"; do
  if grep -viE '^\s*--' "$MIG_DIR/$f" | grep -qiE 'DROP[[:space:]]+TABLE|TRUNCATE'; then
    die "$f 含 DROP TABLE / TRUNCATE —— 与本批「只增不减」定位矛盾，拒绝应用"
  fi
done
echo "✓ 无 DROP TABLE / TRUNCATE（符合「只增不减」定位）"

# 顺序守卫（静态）：0047 的 verify_payment_order 必须是三 provider 超集版
grep -q "IN ('wechat_xpay', 'wechat', 'alipay')" "$MIG_DIR/$M47" \
  || die "$M47 的 verify_payment_order 未含三 provider 超集分支 —— 文件版本异常，拒绝应用"
echo "✓ 0047 verify_payment_order 为三 provider 超集版（顺序守卫静态前提成立）"

# putfile 以 ubuntu:0600 上传，postgres 用户无权读 → 放开读权限
#   🔴 必须 644：psql 以 postgres 身份跑，700/600 会读不到（0045 首轮踩过）
SUDO chmod 644 "$MIG_DIR/$M46" "$MIG_DIR/$M47"
echo "✓ 权限已调整 644（postgres 可读）"

# 应用前基线：记录既有对象状态，供 ⑥ 回归守卫比对
BASE_MAXVER=$(Q "SELECT max(version) FROM public.schema_migrations;")
BASE_PRODUCTS=$(Q "SELECT count(*)::int FROM public.payment_products;")
BASE_VPO=$(Q "SELECT count(*)::int FROM pg_proc WHERE proname='verify_payment_order';")
echo "✓ 应用前基线：max(version)=${BASE_MAXVER:-<空>}  payment_products=${BASE_PRODUCTS:-<空>}  verify_payment_order 函数数=${BASE_VPO:-<空>}"

# ── ① 专用备份 ───────────────────────────────────────────────────────
echo "── ① 专用备份 ──"
SUDO mkdir -p "$BACKUP_DIR"
SUDO chown root:postgres "$BACKUP_DIR" 2>/dev/null
SUDO chmod 770 "$BACKUP_DIR"
SUDO -u postgres pg_dump -d dbee -Fc -f "$DEST" || die "pg_dump 失败"
SUDO chmod 640 "$DEST"
SIZE=$(SUDO stat -c %s "$DEST")
[ "$SIZE" -gt 10240 ] || die "备份异常过小（${SIZE}B）"
TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^' || true)
[ "$TOC" -gt 100 ] || die "归档 TOC 仅 $TOC 条，疑似损坏 —— 没验过 TOC 的备份不算备份"
echo "✓ 备份完成：$DEST（TOC=$TOC，$((SIZE/1024)) KB）"
echo "  回滚命令：sudo -n -u postgres pg_restore -d dbee --clean --if-exists $DEST"

# ── ②③ 应用 0046 → 0047（🔴 顺序不可换）────────────────────────────
for f in "$M46" "$M47"; do
  echo "── 应用 $f ──"
  if PSQL_SU -q -f "$MIG_DIR/$f" >/tmp/_apply_4647.txt 2>&1; then
    echo "✓ $f 应用成功"
    grep -E "NOTICE|WARNING" /tmp/_apply_4647.txt | head -5 | sed 's/^/    /'
  else
    tail -25 /tmp/_apply_4647.txt | sed 's/^/    /'
    die "$f 应用失败（事务已自动回滚，库仍为备份时点状态；备份在 $DEST）"
  fi
done

# ── ④ 幂等复验：全量重跑（0046/0047 均为 IF NOT EXISTS + OR REPLACE）──
echo "── ④ 幂等复验（全量重跑）──"
for f in "$M46" "$M47"; do
  if PSQL_SU -q -f "$MIG_DIR/$f" >/tmp/_apply_4647_2.txt 2>&1; then
    echo "✓ 重跑 $f 成功（幂等成立）"
  else
    tail -25 /tmp/_apply_4647_2.txt | sed 's/^/    /'
    die "重跑 $f 失败（幂等被破坏！但首轮已成功，库状态正常，需人工排查）"
  fi
done

# ── ⑤ 断言 ───────────────────────────────────────────────────────────
echo "── ⑤ 断言 ──"
FAIL=0
c() { # c <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1)); fi
}
tbl_exists() { Q "SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name='$1';"; }
fn_exists()  { Q "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$1';"; }
idx_exists() { Q "SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname='$1';"; }
fn_body()    { Q "SELECT (pg_get_functiondef('$1'::regprocedure) ~ '$2')::int;"; }

echo " 【0046 · 微信虚拟支付 xpay 结算】"
c "schema_migrations 登记 0046=applied" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0046' AND status='applied';")" "1"
c "表 xpay_transactions 存在"        "$(tbl_exists xpay_transactions)"   "1"
c "表 xpay_notifications 存在"       "$(tbl_exists xpay_notifications)"  "1"
c "索引 xpay_transactions_provider_txn_idx"  "$(idx_exists xpay_transactions_provider_txn_idx)" "1"
c "索引 xpay_transactions_owner_idx"         "$(idx_exists xpay_transactions_owner_idx)"        "1"
c "索引 xpay_notifications_trade_no_idx"     "$(idx_exists xpay_notifications_trade_no_idx)"    "1"
c "函数 settle_xpay_purchase 存在"   "$(fn_exists settle_xpay_purchase)"  "1"
c "函数 revoke_xpay_purchase 存在"   "$(fn_exists revoke_xpay_purchase)"  "1"
c "函数 log_xpay_notification 存在"  "$(fn_exists log_xpay_notification)" "1"

echo " 【0047 · Android APP 支付结算（微信/支付宝）】"
c "schema_migrations 登记 0047=applied" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0047' AND status='applied';")" "1"
c "表 app_payment_transactions 存在"  "$(tbl_exists app_payment_transactions)" "1"
c "表 app_payment_notifications 存在" "$(tbl_exists app_payment_notifications)" "1"
c "索引 app_payment_txn_provider_idx"          "$(idx_exists app_payment_txn_provider_idx)"          "1"
c "索引 app_payment_txn_owner_idx"             "$(idx_exists app_payment_txn_owner_idx)"             "1"
c "索引 app_payment_notifications_trade_no_idx" "$(idx_exists app_payment_notifications_trade_no_idx)" "1"
c "函数 settle_app_payment 存在"     "$(fn_exists settle_app_payment)"     "1"
c "函数 revoke_app_payment 存在"     "$(fn_exists revoke_app_payment)"     "1"
c "函数 log_app_notification 存在"   "$(fn_exists log_app_notification)"   "1"

echo " 【0047 · provider CHECK 约束（只收 wechat/alipay）】"
c "app_payment_transactions 的 provider CHECK 含 wechat 与 alipay" \
  "$(Q "SELECT (bool_and(pg_get_constraintdef(oid) LIKE '%wechat%' AND pg_get_constraintdef(oid) LIKE '%alipay%'))::int FROM pg_constraint WHERE conrelid='public.app_payment_transactions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%provider%';")" "1"

echo " 【🔴 顺序守卫】verify_payment_order 必须是 0047 三 provider 超集版"
c "函数体含 wechat_xpay（0046 语义被继承，未倒序覆盖）" \
  "$(fn_body "$F_VERIFY" 'wechat_xpay')" "1"
c "函数体含 alipay（0047 分支已生效）" \
  "$(fn_body "$F_VERIFY" 'alipay')" "1"
c "函数体含 IN 列表形态（三 provider 并列）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('$F_VERIFY'::regprocedure), 'wechat_xpay'', ''wechat'', ''alipay')>0)::int;")" "1"
c "verify_payment_order 仍为 SECURITY DEFINER" \
  "$(Q "SELECT prosecdef::int FROM pg_proc WHERE proname='verify_payment_order' AND pronamespace='public'::regnamespace;")" "1"
c "verify_payment_order 返回类型仍是 boolean" \
  "$(Q "SELECT pg_get_function_result('$F_VERIFY'::regprocedure);")" "boolean"

echo " 【🔴 RLS 守卫】两批表均 ENABLE + FORCE 双开（与 0044 方向相反，见头部差异②）"
for t in xpay_transactions xpay_notifications app_payment_transactions app_payment_notifications; do
  c "$t relrowsecurity=1" \
    "$(Q "SELECT relrowsecurity::int FROM pg_class WHERE oid='public.$t'::regclass;")" "1"
  c "$t relforcerowsecurity=1" \
    "$(Q "SELECT relforcerowsecurity::int FROM pg_class WHERE oid='public.$t'::regclass;")" "1"
done

echo " 【🔴 权限守卫】结算函数只授网关角色 dbee_app，前端角色零权限"
for f in "$F_SETTLE_46" "$F_REVOKE_46" "$F_LOG_46" "$F_SETTLE_47" "$F_REVOKE_47" "$F_LOG_47"; do
  c "dbee_app 可 EXECUTE ${f#public.}" \
    "$(Q "SELECT has_function_privilege('dbee_app','$f','EXECUTE')::int;")" "1"
  c "authenticated 不可 EXECUTE ${f#public.}（防 devtools 直调白嫖）" \
    "$(Q "SELECT has_function_privilege('authenticated','$f','EXECUTE')::int;")" "0"
  c "anon 不可 EXECUTE ${f#public.}" \
    "$(Q "SELECT has_function_privilege('anon','$f','EXECUTE')::int;")" "0"
done
for t in xpay_transactions xpay_notifications app_payment_transactions app_payment_notifications; do
  c "authenticated 对 $t 零表权限" \
    "$(Q "SELECT has_table_privilege('authenticated','public.$t','SELECT')::int;")" "0"
  c "anon 对 $t 零表权限" \
    "$(Q "SELECT has_table_privilege('anon','public.$t','SELECT')::int;")" "0"
done

# ── ⑥ 回归守卫：既有对象未被破坏 ─────────────────────────────────────
echo "── ⑥ 回归守卫（既有支付地基未被本次迁移破坏）──"
c "payment_products 行数未变（应用前=$BASE_PRODUCTS）" \
  "$(Q "SELECT count(*)::int FROM public.payment_products;")" "${BASE_PRODUCTS:-0}"
c "三档价仍为 1800/12800/29800（B4 生产实测值）" \
  "$(Q "SELECT string_agg(amount_cents::text,'/' ORDER BY id) FROM public.payment_products;")" "1800/12800/29800"
c "payment_orders 表仍在" "$(tbl_exists payment_orders)" "1"
c "apple_transactions 表仍在（0044 系产物，未被波及）" "$(tbl_exists apple_transactions)" "1"
c "settle_apple_purchase 函数仍在（🔴 精确名，勿与 settle_app_payment 混淆）" \
  "$(fn_exists settle_apple_purchase)" "1"
c "verify_payment_order 函数数仍为 1（未被重复创建/重载）" \
  "$(Q "SELECT count(*)::int FROM pg_proc WHERE proname='verify_payment_order' AND pronamespace='public'::regnamespace;")" "1"
c "迁移水位 = 0055（0046/0047 补入后 max 不变，因 0048–0055 早已 applied）" \
  "$(Q "SELECT max(version) FROM public.schema_migrations;")" "${BASE_MAXVER:-0055}"
c "schema_migrations 总行数 = 57（原 55 + 0046 + 0047）" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations;")" "57"

echo
if [ "$FAIL" = "0" ]; then
  echo "✅ 0046 + 0047 应用 + 幂等 + 全部断言（含顺序/RLS/权限/回归四组守卫）通过"
  echo "   备份：$DEST"
  echo "   FAIL=0"
  echo "   🔴 下一步（本脚本不覆盖）：B3 手术式部署网关 3 文件 → 端点才会从 404 变 503；"
  echo "      B8 配 ALIPAY_* 三键 → 503 才会变可下单；B9 重打 vc32 → 真机才能拉起收银台。"
  exit 0
else
  echo "❌ 断言失败 $FAIL 项（备份：$DEST）"
  echo "   回滚：sudo -n -u postgres pg_restore -d dbee --clean --if-exists $DEST"
  echo "   排查顺序：① 是否倒序应用（看顺序守卫三项）② 权限是否被既有 GRANT 覆盖"
  echo "             ③ FORCE RLS 是否被误改 ④ 备份 TOC 是否完整"
  echo "   FAIL=$FAIL"
  exit 1
fi
