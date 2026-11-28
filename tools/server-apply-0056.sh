#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0056.sh · 服务器端应用 0056 IAP 幂等键修复 + 事务内行为探针
# ═══════════════════════════════════════════════════════════════════════
# 0056 修的是 P1 资损：0045 的 delete_own_account() 把 apple_transactions 一并
# DELETE，而该表 transaction_id UNIQUE 是全服 IAP 核销的**唯一幂等键**
# （0037:58 + settle_apple_purchase 第一闸 0037:147）。删号即释放幂等键 →
# 旧收据可对新账号重放核销。0056 改为「保留交易行 + owner_id 匿名化
# （'anon:'||md5）」，并给 settle 的 webhook owner 反查加 `NOT LIKE 'anon:%'`
# 防止给幽灵 owner 发孤儿权益。
#
# 🔴 与 0045/0043/0044 一样：本次**完全不碰网关**。
#   0056 只 CREATE OR REPLACE 两个 DB 函数，签名与返回结构均未变
#   （settle_apple_purchase 仍是 9 入参 / RETURNS json；delete_own_account
#   仍是 1 入参 / RETURNS jsonb，只**新增**了一个返回键 anonymized_txn_rows，
#   旧键 deleted_rows / identity_removed / ok 语义不变 —— 已 grep 确认
#   src/ mini/ tools/ server/ 对这三个键零依赖，唯一消费点是
#   tools/server-apply-0045.sh:217-218 断言 identity_removed=true，仍成立）。
#   故 server/lib/iap.mjs **无需改动**：没有 restart、没有 nginx reload，
#   更没有 deploy-gateway.sh 的 IDENT_PEPPER 重置地雷。
#   脚本只做：备份 → 应用 SQL → 幂等复验 → 结构/权限断言 → 事务内探针 → 复查。
#
# 🔴 本脚本 ⑥ 段探针的定位（如实声明，不夸大）：
#   用户要求**不使用 Docker**，且本机 PATH 无 psql/postgres/pg_ctl、无 postgresql
#   服务（2026-11-22 实测），tools/local-pg-selftest.sh 的 12 处 docker 依赖
#   （postgres:17-alpine）因此不可用 → **本地真库验证这条路已关闭**。
#   在生产库上用「BEGIN…ROLLBACK 单事务 + 合成 TEST- 数据」直接调函数，
#   是目前唯一能验证 0056 **真实运行时行为**（而非只做文本/语法静态检查）的手段。
#
#   ✅ 它验证了：
#     · 0056 应用后两个函数在生产 PG 17.11 上**语法合法、可创建、可执行**
#       （静态检查证不了这一点 —— plpgsql 函数体是延迟解析的）；
#     · 删号后 apple_transactions 行**仍在**、transaction_id / original_transaction_id
#       / product_id **原值未变**、owner_id 恰好等于 'anon:'||md5(原值)；
#     · 旧 owner_id 在表内已无踪迹（身份关联被切断，PIPL 第 47 条）；
#     · 幂等键**未被释放**：换 owner 重放同一 transaction_id → txn_taken_by_other；
#     · 幽灵 owner 防线生效：webhook 路径（p_owner_id=NULL）反查匿名行 →
#       owner_unresolved，且**阳性对照**证明同一查询对在世 owner 仍能解析出
#       owner（否则 owner_unresolved 可能是恒绿假象）；
#     · **反证对照**：在同一事务内先 DELETE 掉交易行再核销 → settled:true，
#       即「0045 旧行为下重放确实成功」，证明上一条拒绝不是恒绿；
#     · 0045 原有能力未被 0056 的 CREATE OR REPLACE 破坏：app_users 身份行
#       仍被删除、v_tables 里的业务表行仍被删除、p_confirm 闸门仍生效；
#     · 探针事务回滚干净（独立只读复查 + 行数与基线一致）。
#
#   ❌ 它**没有**验证（不要对外宣称「端到端全链路已验证」）：
#     · **没有真实 Apple 收据参与**：不外呼 verifyReceipt，不验 JWS 证书链，
#       网关 server/lib/iap.mjs 的 HTTP 路由、环境白名单、pickTransaction
#       挑交易逻辑全部不在覆盖范围内；
#     · **不经 PostgREST / nginx / JWT 链路**：探针以 postgres 超级用户直调函数，
#       用 set_config('request.jwt.claims',…) 模拟登录态。生产前端走的是
#       `https://d-bee.cn/.cloud/database/rest/rpc/delete_own_account`
#       （那条传输链路由 tools/server-apply-0045.sh ⑥ 段覆盖，本次不重复）；
#     · **不验证权限边界的拒绝面**：超级用户绕过 ACL 与 RLS，故「anon/authenticated
#       不得直读 apple_transactions」「dbee_app 不得直读」这类拒绝行为只能靠
#       ⑤ 段的 information_schema 权限位断言间接覆盖，不做真实越权写探针；
#     · **不验证并发**：单会话串行，UNIQUE 冲突下的并发重复核销路径未覆盖；
#     · 不覆盖 0046 xpay_transactions / 0047 app_payment_transactions 的同类风险
#       （二者的 out_trade_no 幂等键仍未进 v_tables，见 0056 文件头「已知待办」）。
#
# 🔴 安全纪律：
#   · 探针数据一律 `TEST-0056-` 前缀，**绝不碰审核演示账户 dbeesupport@163.com**，
#     绝不碰任何 19 位数字形态的真实 owner_id；
#   · 探针**全程在一个 BEGIN…ROLLBACK 事务内**，正常路径下一行都不落库；
#     trap 兜底再清一次 TEST-0056- 前缀（0045 首轮实测踩过「签 JWT 失败后
#     exit 1 早退，测试账号留在生产库」的坑，这道防线必须继承）；
#   · 本脚本不读、不写、不打印任何凭据（无需 JWT_SECRET —— 探针不走 PostgREST）；
#   · 只读断言一律 SELECT / 查系统目录；唯一的写动作全在回滚事务内，
#     加上 trap 里那条按 `TEST-0056-` 前缀精确匹配的兜底 DELETE。
#
# 步骤：① 前置检查 → ② 专用备份(验 TOC) → ③ 应用 0056 → ④ 幂等复验
#      → ⑤ 结构/权限断言 + 回归守卫 → ⑥ 事务内行为探针 → ⑦ 回滚后独立复查 + 清理
#
# 用法：由本地驱动脚本经 SSH 上传后在服务器执行（范式见
#       tools/apply-account-deletion-prod.py），或直接在服务器上：
#         MIG_DIR=/tmp/dbee-mig bash tools/server-apply-0056.sh
#       **可重复运行**：0056 已登记 applied 时走幂等分支，仍完整跑断言与探针。
# 退出码：全部断言通过 = 0；任一 ✗ = 失败项数。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail   # 刻意不加 -e：验收要「尽量多报」，单项失败不该中断整体

SUDO() { sudo -n "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR="${MIG_DIR:-/tmp/dbee-mig}"
M56="0056-apple-txn-anonymize.sql"
BACKUP_DIR=/var/backups/dbee

# 函数 OID 字面量（settle 是 9 入参，签名必须逐字对上，否则 regprocedure 解析失败）
DEL_OID="public.delete_own_account(text)"
SETTLE_OID="public.settle_apple_purchase(text,text,text,text,text,text,text,text,text)"

# 0056 起「删号即删」的业务表 = 16 张（apple_transactions 改为匿名化保留）。
# 与 tools/four-end-consistency.test.ts 护栏 9 的 EXPECTED_TABLES、
# tools/server-apply-0045.sh:128-135 同源。
TABLES16="'ai_quota_claims','ai_usage','badges','entitlements','exercise_logs','honey_ledger','invite_attempts','invite_links','meal_entries','payment_orders','profiles','quota_bonus','quota_bonus_newbie_retire_log','recipes','water_logs','weight_logs'"

FAIL=0

# ── 探针标识（全部 TEST-0056- 前缀；每次运行唯一，避免与任何历史残留相撞）──
STAMP="$(date +%s)"
RAND="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
RUN="TEST-0056-${STAMP}-${RAND}"
OWNER_A="${RUN}-A"   # 只有交易行、无 app_users 行 → 断言 identity_removed=false
OWNER_B="${RUN}-B"   # 有 app_users + entitlements + 交易行 → 断言 0045 能力未回退
OWNER_C="${RUN}-C"   # 「删号后重注册的新账号」，用于重放拒绝断言
OWNER_D="${RUN}-D"   # 反证对照组：其交易行被人为 DELETE，复现 0045 旧行为
OWNER_E="${RUN}-E"   # 反证对照组里拿旧收据重放的那个账号
TXN_A="${RUN}-TXNA"
TXN_B="${RUN}-TXNB"
TXN_D="${RUN}-TXND"
ORIG_A="${RUN}-ORIGA"
ORIG_B="${RUN}-ORIGB"
ORIG_D="${RUN}-ORIGD"
# webhook 反查用的「新交易号」：必须与已核销的不同，否则会先被幂等第一闸拦下，
# 走不到 owner 反查那一行 —— 那样就测不到 `NOT LIKE 'anon:%'` 了。
NEW_TXN="${RUN}-NEW"
CTRL_TXN="${RUN}-CTRLTXN"
CTRL_ORIG="${RUN}-CTRLORIG"
CTRL_NEW="${RUN}-CTRLNEW"
HASH_B="test-${RAND}b"
# 刻意用一个**不存在**的商品：settle 的幂等第一闸(0037:147)先于商品校验(0037:181)，
# 所以「闸生效 → txn_taken_by_other」「闸失效 → unknown_product」两者可区分，
# 且闸失效时也不会真的写出权益行（多一道安全垫）。
BOGUS_PRODUCT="TEST-0056-NO-SUCH-PRODUCT"
PRODUCT=""

PROBE_OUT=""

# 🔴 任何路径退出都必须清掉 TEST-0056- 前缀数据。正常路径下探针事务已 ROLLBACK、
#   库里本该一行不留；这条兜底防的是「psql 被 kill / 连接中断导致事务未正常回滚」
#   以及任何早退路径。DELETE 条件带死 TEST-0056- 前缀，绝不可能命中真实用户
#   （真实 owner_id 只有 19 位纯数字串与 'wx:'||openid 两种形态，见
#   server/lib/identity.mjs:135 与 0043:18；transaction_id 是 Apple 发的纯数字）。
cleanup() {
  SUDO -u postgres psql -d dbee -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<'EOSQL' || true
DELETE FROM public.apple_transactions WHERE transaction_id LIKE 'TEST-0056-%' OR owner_id LIKE 'TEST-0056-%' OR original_transaction_id LIKE 'TEST-0056-%';
DELETE FROM public.entitlements       WHERE owner_id LIKE 'TEST-0056-%';
DELETE FROM public.payment_orders     WHERE owner_id LIKE 'TEST-0056-%';
DELETE FROM public.app_users          WHERE owner_id LIKE 'TEST-0056-%';
EOSQL
}
trap cleanup EXIT

c() { # c <描述> <实测> <期望>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else
    echo "  ✗ $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

# fld <复合MARK值> <字段名> —— 复合 MARK 形如 ok:true|anon:1|deleted:0|ident:false
fld() { printf '%s' "$1" | tr '|' '\n' | grep "^$2:" | head -1 | sed "s/^$2://"; }
# mk <探针输出> <MARK名>
mk() { printf '%s\n' "$1" | grep "^MARK:$2=" | head -1 | sed "s/^MARK:$2=//"; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 0056 IAP 幂等键修复  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ① 前置检查 ───────────────────────────────────────────────────────
[ -s "$MIG_DIR/$M56" ] || { echo "✗ FATAL: 缺 $MIG_DIR/$M56"; exit 1; }
if grep -qU $'\r' "$MIG_DIR/$M56"; then echo "✗ FATAL: $M56 含 CR"; exit 1; fi
echo "✓ 迁移文件就绪（无 CR）"

# 0056 是 CREATE OR REPLACE 覆盖 0045/0037 的函数，前置依赖必须已在位
c "前置：delete_own_account 已存在（0045 已应用）" \
  "$(Q "SELECT count(*)::int FROM pg_proc WHERE oid='${DEL_OID}'::regprocedure;" 2>/dev/null || echo 0)" "1"
c "前置：settle_apple_purchase 已存在（0037 已应用）" \
  "$(Q "SELECT count(*)::int FROM pg_proc WHERE oid='${SETTLE_OID}'::regprocedure;" 2>/dev/null || echo 0)" "1"
c "前置：apple_transactions 表已存在（0037 已应用）" \
  "$(Q "SELECT (to_regclass('public.apple_transactions') IS NOT NULL)::int;")" "1"
# 2026-10 写脚本时是 18 张。其后支付等迁移新增了带 owner_id 的表，
# 0056 本身不建表不删表，所以这里只要求不少于当时的 18 张。
OWNER_TABLES="$(Q "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='owner_id' AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r';")"
if [ "${OWNER_TABLES:-0}" -ge 18 ]; then
  echo "  ✓ 前置：含 owner_id 的表不少于 18 张（0056 不建表不删表，实测=${OWNER_TABLES}）"
else
  echo "  ✗ 前置：含 owner_id 的表不少于 18 张（实测=${OWNER_TABLES:-<空>}）"
  FAIL=$((FAIL+1))
fi

# 探针需要一个真实在售的 lifetime 商品（settle 的商品映射以 payment_products 为唯一事实源）
PRODUCT="$(Q "SELECT product_id FROM public.payment_products WHERE active = true AND plan = 'lifetime' ORDER BY product_id LIMIT 1;")"
if [ -z "$PRODUCT" ]; then
  echo "✗ FATAL: payment_products 里没有 active 的 lifetime 商品，探针无法构造合法核销"
  exit 1
fi
echo "✓ 探针商品 = $PRODUCT（active lifetime，取自 payment_products）"

# 干净前置：库里不该有任何 TEST-0056- 残留（有则说明上一轮异常退出，先清）
PRE_DIRTY="$(Q "SELECT count(*)::int FROM public.apple_transactions WHERE transaction_id LIKE 'TEST-0056-%' OR owner_id LIKE 'TEST-0056-%';")"
if [ "${PRE_DIRTY:-0}" != "0" ]; then
  echo "⚠ 检出 ${PRE_DIRTY} 行 TEST-0056- 残留（上一轮异常退出？），先执行兜底清理"
  cleanup
fi

# ── 基线（用于 ⑤ 回归守卫与 ⑦ 回滚复查）──────────────────────────────
BASE_TXN="$(Q "SELECT count(*)::int FROM public.apple_transactions;")"
BASE_USERS="$(Q "SELECT count(*)::int FROM public.app_users;")"
BASE_ENT="$(Q "SELECT count(*)::int FROM public.entitlements;")"
BASE_ORDERS="$(Q "SELECT count(*)::int FROM public.payment_orders;")"
echo "  基线 apple_transactions=${BASE_TXN:-<空>} app_users=${BASE_USERS:-<空>} entitlements=${BASE_ENT:-<空>} payment_orders=${BASE_ORDERS:-<空>}"
if [ -z "${BASE_TXN:-}" ] || [ -z "${BASE_USERS:-}" ]; then
  echo "✗ FATAL: 基线读取失败（sudo/psql 不可用？）"; exit 1
fi

ALREADY="$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0056' AND status='applied';")"

if [ "${ALREADY:-0}" = "1" ]; then
  echo "ℹ 0056 已登记 applied → 幂等分支：跳过备份/应用，直接复验 + 断言 + 探针"
else
  # ── ② 专用备份（没验过 TOC 的备份不算备份）────────────────────────
  TS="$(date +%Y%m%d-%H%M%S)"
  DEST="$BACKUP_DIR/backup-before-0056-$TS.dump"
  SUDO mkdir -p "$BACKUP_DIR"
  SUDO -u postgres pg_dump -Fc -d dbee -f "$DEST" >/dev/null 2>&1 \
    || { echo "✗ FATAL: pg_dump 失败"; exit 1; }
  TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^[0-9]*; ' || true)
  if [ "${TOC:-0}" -lt 100 ]; then echo "✗ FATAL: 备份 TOC 仅 ${TOC:-0} 项，疑似损坏"; exit 1; fi
  echo "✓ 专用备份 $DEST （TOC $TOC 项）"

  # ── ③ 应用 0056 ─────────────────────────────────────────────────
  PSQL_SU -f "$MIG_DIR/$M56" >/dev/null 2>"$MIG_DIR/0056.err" \
    || { echo "✗ FATAL: 应用 0056 失败"; sed -n '1,15p' "$MIG_DIR/0056.err"; exit 1; }
  echo "✓ 0056 已应用"

  # ── ④ 幂等复验（原样重跑必须依然成功，且不改数据）────────────────
  PSQL_SU -f "$MIG_DIR/$M56" >/dev/null 2>"$MIG_DIR/0056.err2" \
    || { echo "✗ FATAL: 幂等复跑失败"; sed -n '1,15p' "$MIG_DIR/0056.err2"; exit 1; }
  echo "✓ 幂等复跑通过"
  rm -f "$MIG_DIR/0056.err" "$MIG_DIR/0056.err2"
fi

# ── ⑤ 结构 / 权限断言 + 回归守卫（全部只读）──────────────────────────
echo " 【结构断言 · delete_own_account】"
c "函数仍是 SECURITY DEFINER" \
  "$(Q "SELECT prosecdef::int FROM pg_proc WHERE oid='${DEL_OID}'::regprocedure;")" "1"
c "函数属主仍是 postgres" \
  "$(Q "SELECT proowner::regrole::text FROM pg_proc WHERE oid='${DEL_OID}'::regprocedure;")" "postgres"
c "函数返回值仍是 jsonb（签名未变 → 网关/前端零改动）" \
  "$(Q "SELECT pg_get_function_result(oid) FROM pg_proc WHERE oid='${DEL_OID}'::regprocedure;")" "jsonb"
# 🔴 核心：v_tables 里不得再有带引号的 'apple_transactions' 字面量。
#   0056 后该表在函数体里只以不带引号的 public.apple_transactions 出现，
#   所以「带引号命中数=0」与「public.apple_transactions 命中=1」必须同时成立。
c "函数体不含带引号的 'apple_transactions'（已从 v_tables 移除）" \
  "$(Q "SELECT (pg_get_functiondef('${DEL_OID}'::regprocedure) LIKE '%''apple_transactions''%')::int;")" "0"
c "函数体含 public.apple_transactions（匿名化 UPDATE 在位）" \
  "$(Q "SELECT (pg_get_functiondef('${DEL_OID}'::regprocedure) LIKE '%public.apple_transactions%')::int;")" "1"
# 用 strpos + chr(39) 拼单引号，避免 LIKE 通配符语义与 bash 引号地狱
c "函数体含 'anon:' || md5(v_owner)（匿名化表达式逐字在位）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${DEL_OID}'::regprocedure), chr(39)||'anon:'||chr(39)||' || md5(v_owner)') > 0)::int;")" "1"
c "函数体含 16 张「删号即删」业务表的全部字面量" \
  "$(Q "SELECT count(*)::int FROM unnest(ARRAY[${TABLES16}]) AS t WHERE pg_get_functiondef('${DEL_OID}'::regprocedure) LIKE '%''' || t || '''%';")" "16"
c "函数体不再含 DELETE FROM public.apple_transactions（旧行为已彻底消失）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${DEL_OID}'::regprocedure), 'DELETE FROM public.apple_transactions') > 0)::int;")" "0"
c "函数体含 anonymized_txn_rows 返回键（计数与 deleted_rows 分离）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${DEL_OID}'::regprocedure), 'anonymized_txn_rows') > 0)::int;")" "1"
c "身份删除语句仍在（0045 能力未被 CREATE OR REPLACE 弄丢）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${DEL_OID}'::regprocedure), 'DELETE FROM public.app_users WHERE owner_id = v_owner') > 0)::int;")" "1"
c "身份仍只取 auth.uid()（无 owner_id 入参 = 无越权面）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${DEL_OID}'::regprocedure), 'v_owner := auth.uid()') > 0)::int;")" "1"
c "p_confirm 服务端二次闸门仍在" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${DEL_OID}'::regprocedure), chr(39)||'DELETE_MY_ACCOUNT'||chr(39)) > 0)::int;")" "1"

echo " 【结构断言 · settle_apple_purchase】"
c "函数仍是 SECURITY DEFINER" \
  "$(Q "SELECT prosecdef::int FROM pg_proc WHERE oid='${SETTLE_OID}'::regprocedure;")" "1"
c "函数属主仍是 postgres" \
  "$(Q "SELECT proowner::regrole::text FROM pg_proc WHERE oid='${SETTLE_OID}'::regprocedure;")" "postgres"
c "函数返回值仍是 json（签名未变 → 网关 iap.mjs 零改动）" \
  "$(Q "SELECT pg_get_function_result(oid) FROM pg_proc WHERE oid='${SETTLE_OID}'::regprocedure;")" "json"
c "webhook owner 反查已排除匿名行（NOT LIKE 'anon:%'）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${SETTLE_OID}'::regprocedure), 'owner_id NOT LIKE '||chr(39)||'anon:%'||chr(39)) > 0)::int;")" "1"
c "幂等第一闸仍在（transaction_id = p_transaction_id）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${SETTLE_OID}'::regprocedure), 'WHERE transaction_id = p_transaction_id') > 0)::int;")" "1"
c "重放拒绝分支仍在（txn_taken_by_other）" \
  "$(Q "SELECT (strpos(pg_get_functiondef('${SETTLE_OID}'::regprocedure), chr(39)||'txn_taken_by_other'||chr(39)) > 0)::int;")" "1"

echo " 【权限断言（照抄 0045 口径）】"
c "delete_own_account：PUBLIC/anon 无 EXECUTE" \
  "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='delete_own_account' AND grantee IN ('PUBLIC','anon');")" "0"
c "delete_own_account：authenticated 有 EXECUTE" \
  "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='delete_own_account' AND grantee='authenticated' AND privilege_type='EXECUTE';")" "1"
c "settle_apple_purchase：PUBLIC/anon/authenticated 无 EXECUTE" \
  "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='settle_apple_purchase' AND grantee IN ('PUBLIC','anon','authenticated');")" "0"
c "settle_apple_purchase：dbee_app 有 EXECUTE" \
  "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='settle_apple_purchase' AND grantee='dbee_app' AND privilege_type='EXECUTE';")" "1"
c "apple_transactions 仍是 FORCE RLS（匿名化列对外物理不可读）" \
  "$(Q "SELECT relforcerowsecurity::int FROM pg_class WHERE oid='public.apple_transactions'::regclass;")" "1"

echo " 【登记与回归守卫】"
c "schema_migrations 登记 0056 且 applied" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0056' AND name='apple-txn-anonymize' AND status='applied';")" "1"
# 🔴 0056 不含任何数据回填：应用（含幂等重跑）后行数必须与基线逐一相同。
#   变了就说明迁移里混进了意料之外的 DML —— 立即停下排查。
c "回归守卫：apple_transactions 行数未变" "$(Q "SELECT count(*)::int FROM public.apple_transactions;")" "$BASE_TXN"
c "回归守卫：app_users 行数未变"           "$(Q "SELECT count(*)::int FROM public.app_users;")"           "$BASE_USERS"
c "回归守卫：entitlements 行数未变"         "$(Q "SELECT count(*)::int FROM public.entitlements;")"       "$BASE_ENT"
c "回归守卫：payment_orders 行数未变"       "$(Q "SELECT count(*)::int FROM public.payment_orders;")"     "$BASE_ORDERS"
c "回归守卫：四服务 active" \
  "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"

# ── ⑥ 事务内行为探针（🔴 全程一个 BEGIN…ROLLBACK，一行都不许落库）──────
echo " 【⑥ 事务内行为探针 · run=$RUN】"

# 说明（关键设计点）：
#  · 以 postgres 超级用户直调函数 —— settle_apple_purchase 的 EXECUTE 只授
#    dbee_app、delete_own_account 只授 authenticated，超级用户绕过 ACL，
#    且两函数本身都是 SECURITY DEFINER(owner=postgres)，故函数**内部**行为
#    与生产完全一致（生产也是以 postgres 身份执行函数体）。
#  · auth.uid() 三级回退（0030:15-35）：app.user_id → request.jwt.claim.sub →
#    request.jwt.claims->>'sub'。这里显式清空第一级（全新 psql 会话本就为空，
#    清空是为了不受任何会话残留影响），再设 request.jwt.claims 模拟 PostgREST
#    注入的登录态；随后用 MARK:uid 反查 auth.uid() 实际取值，若注入没生效
#    这条断言立刻红 —— 不让「身份没注入」伪装成「函数行为不对」。
#  · psql -v 传值 + :'VAR' 占位：值不进 SQL 文本拼接，无引号地狱、无注入面。
#  · 复合 MARK（a:x|b:y）+ fld() 解析：保证每个函数**只被调用一次**却取多个
#    返回字段（多次 SELECT 会重复调用有副作用的函数）。
PROBE_OUT="$(SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA \
  -v OWNER_A="$OWNER_A" -v OWNER_B="$OWNER_B" -v OWNER_C="$OWNER_C" \
  -v OWNER_D="$OWNER_D" -v OWNER_E="$OWNER_E" \
  -v TXN_A="$TXN_A" -v TXN_B="$TXN_B" -v TXN_D="$TXN_D" \
  -v ORIG_A="$ORIG_A" -v ORIG_B="$ORIG_B" -v ORIG_D="$ORIG_D" \
  -v NEW_TXN="$NEW_TXN" -v CTRL_TXN="$CTRL_TXN" -v CTRL_ORIG="$CTRL_ORIG" -v CTRL_NEW="$CTRL_NEW" \
  -v HASH_B="$HASH_B" -v PRODUCT="$PRODUCT" -v BOGUS="$BOGUS_PRODUCT" \
  2>&1 <<'PROBE_SQL'
BEGIN;

-- 会话态清零 + 注入 OWNER_A 的登录态
SELECT set_config('app.user_id', '', true);
SELECT set_config('request.jwt.claims', '{"sub":"' || :'OWNER_A' || '","role":"authenticated"}', true);
SELECT 'MARK:uid_a=' || COALESCE(auth.uid(), '<null>');

-- P0 干净前置（事务内自查）
SELECT 'MARK:pre_txn=' || count(*)::text FROM public.apple_transactions
 WHERE transaction_id LIKE 'TEST-0056-%' OR owner_id LIKE 'TEST-0056-%';
SELECT 'MARK:pre_user=' || count(*)::text FROM public.app_users WHERE owner_id LIKE 'TEST-0056-%';

-- ── P1 只有交易行、无身份行 ────────────────────────────────────────
INSERT INTO public.apple_transactions
  (transaction_id, original_transaction_id, owner_id, product_id, plan, environment)
VALUES (:'TXN_A', :'ORIG_A', :'OWNER_A', :'PRODUCT', 'lifetime', 'Production');

WITH d AS MATERIALIZED (SELECT public.delete_own_account('DELETE_MY_ACCOUNT') AS j)
SELECT 'MARK:del_a=ok:'    || COALESCE(j ->> 'ok', '<none>')
    || '|anon:'            || COALESCE(j ->> 'anonymized_txn_rows', '<none>')
    || '|deleted:'         || COALESCE(j ->> 'deleted_rows', '<none>')
    || '|ident:'           || COALESCE(j ->> 'identity_removed', '<none>') FROM d;

-- 核心断言：行仍在、幂等键原值未变、owner_id 已匿名化
SELECT 'MARK:row_a=' || count(*)::text FROM public.apple_transactions WHERE transaction_id = :'TXN_A';
SELECT 'MARK:intact_a=' || count(*)::text FROM public.apple_transactions
 WHERE transaction_id = :'TXN_A' AND original_transaction_id = :'ORIG_A'
   AND product_id = :'PRODUCT' AND plan = 'lifetime' AND environment = 'Production';
SELECT 'MARK:owner_a_now=' || COALESCE(max(owner_id), '<none>') FROM public.apple_transactions
 WHERE transaction_id = :'TXN_A';
SELECT 'MARK:owner_a_want=anon:' || md5(:'OWNER_A');
SELECT 'MARK:old_owner_gone_a=' || count(*)::text FROM public.apple_transactions
 WHERE owner_id = :'OWNER_A';
SELECT 'MARK:anon_prefix_a=' || count(*)::text FROM public.apple_transactions
 WHERE transaction_id = :'TXN_A' AND owner_id LIKE 'anon:%';

-- ── P2 有身份行 + 业务行：验证 0045 原能力未被 CREATE OR REPLACE 破坏 ──
SELECT set_config('request.jwt.claims', '{"sub":"' || :'OWNER_B' || '","role":"authenticated"}', true);
SELECT 'MARK:uid_b=' || COALESCE(auth.uid(), '<null>');
INSERT INTO public.app_users (owner_id, ident_kind, ident_hash, ident_masked)
VALUES (:'OWNER_B', 'phone', :'HASH_B', '138****9999');
INSERT INTO public.entitlements (owner_id) VALUES (:'OWNER_B');
INSERT INTO public.apple_transactions
  (transaction_id, original_transaction_id, owner_id, product_id, plan, environment)
VALUES (:'TXN_B', :'ORIG_B', :'OWNER_B', :'PRODUCT', 'lifetime', 'Production');

WITH d AS MATERIALIZED (SELECT public.delete_own_account('DELETE_MY_ACCOUNT') AS j)
SELECT 'MARK:del_b=ok:'    || COALESCE(j ->> 'ok', '<none>')
    || '|anon:'            || COALESCE(j ->> 'anonymized_txn_rows', '<none>')
    || '|deleted:'         || COALESCE(j ->> 'deleted_rows', '<none>')
    || '|ident:'           || COALESCE(j ->> 'identity_removed', '<none>') FROM d;

SELECT 'MARK:user_b_gone=' || count(*)::text FROM public.app_users     WHERE owner_id = :'OWNER_B';
SELECT 'MARK:ent_b_gone='  || count(*)::text FROM public.entitlements  WHERE owner_id = :'OWNER_B';
SELECT 'MARK:row_b='       || count(*)::text FROM public.apple_transactions WHERE transaction_id = :'TXN_B';
SELECT 'MARK:anon_b='      || count(*)::text FROM public.apple_transactions
 WHERE transaction_id = :'TXN_B' AND owner_id = 'anon:' || md5(:'OWNER_B');

-- ── P3 重放拒绝（本修复的生效点）────────────────────────────────────
-- 「删号后重注册的新账号 OWNER_C」拿 OWNER_A 那张已核销收据再来一次。
-- 期望 txn_taken_by_other：幂等第一闸命中匿名行，且 owner 不符 → 拒绝。
WITH r AS MATERIALIZED (
  SELECT public.settle_apple_purchase(:'OWNER_C', NULL, :'BOGUS', :'TXN_A', :'ORIG_A',
                                      NULL, NULL, 'Production', NULL) AS j)
SELECT 'MARK:replay=err:'     || COALESCE(j ->> 'error', '<none>')
    || '|settled:'            || COALESCE(j ->> 'settled', '<none>') FROM r;

-- ── P4 幽灵 owner 防线（webhook 路径 p_owner_id=NULL）───────────────
-- 新交易号 NEW_TXN（绕开幂等第一闸）+ 已匿名化的 ORIG_A → 反查必须查不到人。
WITH r AS MATERIALIZED (
  SELECT public.settle_apple_purchase(NULL, NULL, :'BOGUS', :'NEW_TXN', :'ORIG_A',
                                      NULL, NULL, 'Production', NULL) AS j)
SELECT 'MARK:webhook=err:'    || COALESCE(j ->> 'error', '<none>') FROM r;

-- P4 阳性对照：同样走 webhook 路径，但归组键指向一个**在世** owner（OWNER_C）。
-- 期望 unknown_product —— 证明反查**确实解析出了 owner**（走过了 owner_unresolved
-- 分支到达商品校验），从而 P4 的 owner_unresolved 不是「查询恒空」造成的假绿。
INSERT INTO public.apple_transactions
  (transaction_id, original_transaction_id, owner_id, product_id, plan, environment)
VALUES (:'CTRL_TXN', :'CTRL_ORIG', :'OWNER_C', :'PRODUCT', 'lifetime', 'Production');
WITH r AS MATERIALIZED (
  SELECT public.settle_apple_purchase(NULL, NULL, :'BOGUS', :'CTRL_NEW', :'CTRL_ORIG',
                                      NULL, NULL, 'Production', NULL) AS j)
SELECT 'MARK:ctrl_webhook=err:' || COALESCE(j ->> 'error', '<none>') FROM r;

-- ── P5 反证对照组：证明「删行 = 幂等键真的会被释放」────────────────
-- 在同一事务内复现 0045 旧行为（DELETE 掉交易行）再核销 → 期望 settled:true。
-- 这条**必须成功**，否则说明 P3 的拒绝是恒绿假象、本探针没有鉴别力。
-- 用真实商品，故会真的写 apple_transactions + entitlements（OWNER_E 是 TEST-
-- 合成 owner），但整段处于 BEGIN…ROLLBACK 内，随事务一并消失。
INSERT INTO public.apple_transactions
  (transaction_id, original_transaction_id, owner_id, product_id, plan, environment)
VALUES (:'TXN_D', :'ORIG_D', :'OWNER_D', :'PRODUCT', 'lifetime', 'Production');
DELETE FROM public.apple_transactions WHERE transaction_id = :'TXN_D';
SELECT 'MARK:vuln_gate=' || count(*)::text FROM public.apple_transactions WHERE transaction_id = :'TXN_D';
WITH r AS MATERIALIZED (
  SELECT public.settle_apple_purchase(:'OWNER_E', NULL, :'PRODUCT', :'TXN_D', :'ORIG_D',
                                      NULL, NULL, 'Production', NULL) AS j)
SELECT 'MARK:vuln=settled:' || COALESCE(j ->> 'settled', '<none>')
    || '|dup:'              || COALESCE(j ->> 'duplicate', '<none>')
    || '|plan:'             || COALESCE(j ->> 'plan', '<none>') FROM r;

ROLLBACK;
SELECT 'MARK:rolled_back=1';
PROBE_SQL
)"
PROBE_RC=$?

if [ "$PROBE_RC" != "0" ] || ! printf '%s\n' "$PROBE_OUT" | grep -q '^MARK:rolled_back=1$'; then
  echo "  ✗ FATAL: 探针事务未正常执行/回滚（rc=$PROBE_RC）。以下为 psql 输出末尾，"
  echo "         事务在连接断开时已自动回滚，trap 兜底清理仍会执行。"
  printf '%s\n' "$PROBE_OUT" | tail -20 | sed 's/^/      /'
  FAIL=$((FAIL+1))
else
  echo "  ✓ 探针事务执行完毕并已 ROLLBACK"

  echo " 【⑥-1 前置与登录态注入】"
  c "事务内自检：无 TEST-0056 交易行残留" "$(mk "$PROBE_OUT" pre_txn)"  "0"
  c "事务内自检：无 TEST-0056 身份行残留" "$(mk "$PROBE_OUT" pre_user)" "0"
  c "auth.uid() 确实取到 OWNER_A（登录态注入生效）" "$(mk "$PROBE_OUT" uid_a)" "$OWNER_A"
  c "auth.uid() 确实取到 OWNER_B（登录态可切换）"   "$(mk "$PROBE_OUT" uid_b)" "$OWNER_B"

  echo " 【⑥-2 P1 删号后交易行匿名化保留（无身份行场景）】"
  DA="$(mk "$PROBE_OUT" del_a)"
  c "delete_own_account 返回 ok=true"        "$(fld "$DA" ok)"       "true"
  # 🔴 identity_removed 期望 **false**，理由（team-lead 点名要求写明）：
  #   P1 刻意**不**给 OWNER_A 种 app_users 身份行 —— 探针不愿在身份表上留下
  #   任何写痕迹，且「身份行被真正删除」这条已由 P2（种了身份行、断言 true）
  #   和 tools/server-apply-0045.sh ⑥ 段（真实造号 + 真实公网链路）各自覆盖。
  #   故此处 false 是**设计使然**：DELETE FROM app_users WHERE owner_id=OWNER_A
  #   命中 0 行 → v_ident := (0 > 0) = false。它同时反证了一件事 ——
  #   函数走完了完整路径（④′ 匿名化 + ④ 删身份 + ⑤ 组装返回）而没有早退。
  c "identity_removed=false（P1 未种身份行，DELETE 命中 0 行 → 设计使然）" \
    "$(fld "$DA" ident)" "false"
  c "anonymized_txn_rows=1（匿名化了 1 行）"  "$(fld "$DA" anon)"     "1"
  c "deleted_rows=0（16 张表里无该 owner 的行，且未误伤他人）" \
    "$(fld "$DA" deleted)" "0"
  c "🔴 核心：交易行仍在（未被 DELETE）"      "$(mk "$PROBE_OUT" row_a)"      "1"
  c "🔴 核心：transaction_id/original_transaction_id/product_id/plan/environment 原值未变" \
    "$(mk "$PROBE_OUT" intact_a)" "1"
  c "🔴 核心：owner_id 恰等于 'anon:'||md5(原 owner_id)" \
    "$(mk "$PROBE_OUT" owner_a_now)" "$(mk "$PROBE_OUT" owner_a_want)"
  c "🔴 核心：owner_id 已带 anon: 前缀（≠ 原值，身份关联被切断）" \
    "$(mk "$PROBE_OUT" anon_prefix_a)" "1"
  c "🔴 核心：表内已搜不到原 owner_id（PIPL 删除权）" \
    "$(mk "$PROBE_OUT" old_owner_gone_a)" "0"

  echo " 【⑥-3 P2 0045 原能力未回退（有身份行 + 业务行）】"
  DB="$(mk "$PROBE_OUT" del_b)"
  c "delete_own_account 返回 ok=true"        "$(fld "$DB" ok)"   "true"
  c "identity_removed=true（身份行确实被删）" "$(fld "$DB" ident)" "true"
  c "deleted_rows=1（v_tables 里的 entitlements 行被删）" "$(fld "$DB" deleted)" "1"
  c "anonymized_txn_rows=1"                  "$(fld "$DB" anon)"  "1"
  c "app_users 身份行已删"                   "$(mk "$PROBE_OUT" user_b_gone)" "0"
  c "entitlements 业务行已删"                "$(mk "$PROBE_OUT" ent_b_gone)"  "0"
  c "apple_transactions 行仍在且已匿名化"    "$(mk "$PROBE_OUT" row_b)"       "1"
  c "该行 owner_id 恰为 'anon:'||md5(OWNER_B)" "$(mk "$PROBE_OUT" anon_b)"   "1"

  echo " 【⑥-4 P3/P4 幂等键未释放 + 幽灵 owner 防线】"
  c "🔴 旧收据对新账号重放 → txn_taken_by_other（幂等键未被释放 = 修复生效）" \
    "$(fld "$(mk "$PROBE_OUT" replay)" err)" "txn_taken_by_other"
  c "🔴 重放未发权益（settled 字段不存在）" \
    "$(fld "$(mk "$PROBE_OUT" replay)" settled)" "<none>"
  c "🔴 删号后续订通知 → owner_unresolved（不给幽灵 owner 发权益）" \
    "$(fld "$(mk "$PROBE_OUT" webhook)" err)" "owner_unresolved"
  c "阳性对照：在世 owner 的归组键能反查到人（走到商品校验 → unknown_product）" \
    "$(fld "$(mk "$PROBE_OUT" ctrl_webhook)" err)" "unknown_product"

  echo " 【⑥-5 P5 反证对照（证明上面的拒绝不是恒绿）】"
  c "复现 0045 旧行为后幂等第一闸查不到行（gate=0）" "$(mk "$PROBE_OUT" vuln_gate)" "0"
  VU="$(mk "$PROBE_OUT" vuln)"
  c "🔴 行被删则同一收据可重新核销成功（= 漏洞真实存在，反证 P3 有鉴别力）" \
    "$(fld "$VU" settled)" "true"
  c "反证对照：该次核销不是 duplicate（是全新核销 = 幂等键确已释放）" \
    "$(fld "$VU" dup)" "false"
  c "反证对照：发出了 lifetime 权益（资损成立）" "$(fld "$VU" plan)" "lifetime"
fi

# ── ⑦ 回滚后独立只读复查（新会话，证明事务真的回滚干净）──────────────
echo " 【⑦ 回滚后独立复查】"
c "apple_transactions 里搜不到任何 TEST-0056- 前缀行" \
  "$(Q "SELECT count(*)::int FROM public.apple_transactions WHERE transaction_id LIKE 'TEST-0056-%' OR owner_id LIKE 'TEST-0056-%' OR original_transaction_id LIKE 'TEST-0056-%';")" "0"
c "apple_transactions 里搜不到任何 anon: 匿名行（探针未污染真实数据）" \
  "$(Q "SELECT count(*)::int FROM public.apple_transactions WHERE owner_id LIKE 'anon:%';")" "0"
c "app_users 里搜不到 TEST-0056- 身份行" \
  "$(Q "SELECT count(*)::int FROM public.app_users WHERE owner_id LIKE 'TEST-0056-%';")" "0"
c "entitlements 里搜不到 TEST-0056- 权益行" \
  "$(Q "SELECT count(*)::int FROM public.entitlements WHERE owner_id LIKE 'TEST-0056-%';")" "0"
c "payment_orders 里搜不到 TEST-0056- 订单行" \
  "$(Q "SELECT count(*)::int FROM public.payment_orders WHERE owner_id LIKE 'TEST-0056-%';")" "0"
c "行数与基线一致：apple_transactions" "$(Q "SELECT count(*)::int FROM public.apple_transactions;")" "$BASE_TXN"
c "行数与基线一致：app_users"          "$(Q "SELECT count(*)::int FROM public.app_users;")"          "$BASE_USERS"
c "行数与基线一致：entitlements"       "$(Q "SELECT count(*)::int FROM public.entitlements;")"       "$BASE_ENT"
c "行数与基线一致：payment_orders"     "$(Q "SELECT count(*)::int FROM public.payment_orders;")"     "$BASE_ORDERS"
c "回归守卫：healthz 仍 ok" \
  "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 0056 全部断言通过（FAIL=0）—— 幂等键未被释放，资损链路已切断"
  echo "   ⚠️ 覆盖范围见文件头：不含真实 Apple 收据 / 不含 PostgREST-JWT 传输链路"
else
  echo "❌ 0056 有 $FAIL 项失败"
fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
