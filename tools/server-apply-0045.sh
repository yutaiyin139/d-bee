#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0045.sh · 服务器端应用 0045 真删号迁移 + 生产端到端验收
# ═══════════════════════════════════════════════════════════════════════
# 由 tools/apply-account-deletion-prod.py 经 SSH 上传后执行；**可重复运行**。
#
# 🔴 与 0043/0044 的关键差异：本次**完全不碰网关**。
#   删号走 PostgREST RPC（SECURITY DEFINER 函数），生产网关仍是 10-29 旧代码也能用，
#   因此没有 restart、没有 nginx reload、更没有 deploy-gateway.sh 的
#   IDENT_PEPPER 重置地雷。脚本只做：备份 → 应用 SQL → 幂等复验 → 实测。
#
# 🔴 凭据纪律：JWT_SECRET / WB_PUBLISHABLE_KEY 只在服务器本机由 node 读取并写入
#   chmod 600 的临时文件，shell 读进变量后立刻删除；**绝不 echo 到 stdout**，
#   绝不出现在任何命令行参数里（避免 ps/journal 留痕）。
#
# 🔴 验收纪律（铁律 #13）：必须走**真实公网用户链路**
#   https://d-bee.cn/.cloud/database/rest/rpc/delete_own_account
#   （经 nginx → 网关 dbproxy 反代 → PostgREST → PG 函数），而不是在服务器上
#   直接 psql 调函数 —— 后者证明不了前端能用。
#   验收账号是新建的 TEST- 前缀临时账号，**绝不碰审核演示账户**。
#
# 步骤：① 前置检查 → ② 专用备份(验 TOC) → ③ 应用 0045 → ④ 幂等复验
#      → ⑤ 标志位/权限/回归守卫 → ⑥ 端到端删号验收(负向 + 正向) → ⑦ 清理
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { sudo -n "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
M45=0045-account-deletion.sql
BACKUP_DIR=/var/backups/dbee
RPC='https://d-bee.cn/.cloud/database/rest/rpc/delete_own_account'

FAIL=0
OWNER=""
MIG_DIR_LOCAL="$MIG_DIR"

# 🔴 任何路径退出都必须清掉临时账号与凭据文件。首轮实测踩过：签 JWT 失败后
#   脚本 `exit 1` 早退，TEST- 前缀测试账号留在生产库里、.cred/mkjwt 也没删。
#   trap 保证「造号之后无论成功失败」都不会留脏数据。
cleanup() {
  if [ -n "$OWNER" ]; then
    SUDO -u postgres psql -d dbee -q -c "
      DELETE FROM public.profiles WHERE owner_id='$OWNER';
      DELETE FROM public.meal_entries WHERE owner_id='$OWNER';
      DELETE FROM public.entitlements WHERE owner_id='$OWNER';
      DELETE FROM public.ai_usage WHERE owner_id='$OWNER';
      DELETE FROM public.app_users WHERE owner_id='$OWNER';
    " >/dev/null 2>&1 || true
  fi
  # 清理更早批次遗留的 TEST- 账号（真实账号是 19 位数字串，绝不会是 TEST- 前缀）
  SUDO -u postgres psql -d dbee -q -c "
    DELETE FROM public.profiles WHERE owner_id LIKE 'TEST-%';
    DELETE FROM public.meal_entries WHERE owner_id LIKE 'TEST-%';
    DELETE FROM public.entitlements WHERE owner_id LIKE 'TEST-%';
    DELETE FROM public.ai_usage WHERE owner_id LIKE 'TEST-%';
    DELETE FROM public.app_users WHERE owner_id LIKE 'TEST-%';
  " >/dev/null 2>&1 || true
  rm -f "$MIG_DIR_LOCAL/.cred" "$MIG_DIR_LOCAL/mkjwt.mjs" \
        "$MIG_DIR_LOCAL"/*.err "$MIG_DIR_LOCAL/0045.err2"
}
trap cleanup EXIT

c() {
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else
    echo "  ✗ $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " 0045 真删号  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ① 前置检查 ───────────────────────────────────────────────────────
[ -s "$MIG_DIR/$M45" ] || { echo "✗ FATAL: 缺 $MIG_DIR/$M45"; exit 1; }
if grep -qU $'\r' "$MIG_DIR/$M45"; then echo "✗ FATAL: $M45 含 CR"; exit 1; fi
echo "✓ 迁移文件就绪（无 CR）"

# 生产实测出的 18 张含 owner_id 的表必须仍然存在（防止函数里的 v_tables 悄悄过期）
OWNER_TABLES=$(Q "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='owner_id' AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r';")
c "含 owner_id 的表仍为 18 张（快照基线）" "$OWNER_TABLES" "18"

# 基线：用于回归守卫，证明删号没误伤别的账号。
# 🔴 先清掉上一轮早退可能遗留的 TEST- 账号，否则基线会把测试数据也算进去。
cleanup
BASE_USERS=$(Q "SELECT count(*)::int FROM public.app_users;")
BASE_PROFILES=$(Q "SELECT count(*)::int FROM public.profiles;")
echo "  基线 app_users=$BASE_USERS profiles=$BASE_PROFILES"

ALREADY=$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0045' AND status='applied';")

if [ "$ALREADY" = "1" ]; then
  echo "ℹ 0045 已登记 applied → 幂等分支：跳过备份/应用，直接复验 + 验收"
else
  # ── ② 专用备份（没验过 TOC 的备份不算备份）────────────────────────
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="$BACKUP_DIR/backup-before-0045-$TS.dump"
  SUDO mkdir -p "$BACKUP_DIR"
  SUDO -u postgres pg_dump -Fc -d dbee -f "$DEST" >/dev/null 2>&1 \
    || { echo "✗ FATAL: pg_dump 失败"; exit 1; }
  TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^[0-9]*; ' || true)
  if [ "${TOC:-0}" -lt 100 ]; then echo "✗ FATAL: 备份 TOC 仅 ${TOC:-0} 项，疑似损坏"; exit 1; fi
  echo "✓ 专用备份 $DEST （TOC $TOC 项）"

  # ── ③ 应用 0045 ─────────────────────────────────────────────────
  PSQL_SU -f "$MIG_DIR/$M45" >/dev/null 2>"$MIG_DIR/0045.err" \
    || { echo "✗ FATAL: 应用 0045 失败"; sed -n '1,12p' "$MIG_DIR/0045.err"; exit 1; }
  echo "✓ 0045 已应用"

  # ── ④ 幂等复验（原样重跑必须依然成功）───────────────────────────
  PSQL_SU -f "$MIG_DIR/$M45" >/dev/null 2>"$MIG_DIR/0045.err2" \
    || { echo "✗ FATAL: 幂等复跑失败"; sed -n '1,12p' "$MIG_DIR/0045.err2"; exit 1; }
  echo "✓ 幂等复跑通过"
fi

# ── ⑤ 标志位 / 权限 / 回归守卫 ──────────────────────────────────────
echo " 【标志位】"
c "schema_migrations 登记 0045" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0045' AND status='applied';")" "1"
c "函数是 SECURITY DEFINER" \
  "$(Q "SELECT prosecdef::int FROM pg_proc WHERE oid='public.delete_own_account(text)'::regprocedure;")" "1"
c "函数属主是 postgres" \
  "$(Q "SELECT proowner::regrole::text FROM pg_proc WHERE oid='public.delete_own_account(text)'::regprocedure;")" "postgres"
c "函数返回值是 jsonb" \
  "$(Q "SELECT pg_get_function_result(oid) FROM pg_proc WHERE oid='public.delete_own_account(text)'::regprocedure;")" "jsonb"
c "函数体含 17 张业务表的全部字面量" \
  "$(Q "SELECT count(*)::int FROM unnest(ARRAY['ai_quota_claims','ai_usage','apple_transactions','badges','entitlements','exercise_logs','honey_ledger','invite_attempts','invite_links','meal_entries','payment_orders','profiles','quota_bonus','quota_bonus_newbie_retire_log','recipes','water_logs','weight_logs']) AS t WHERE pg_get_functiondef('public.delete_own_account(text)'::regprocedure) LIKE '%''' || t || '''%';")" "17"
c "PUBLIC/anon 无 EXECUTE" \
  "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='delete_own_account' AND grantee IN ('PUBLIC','anon');")" "0"
c "authenticated 有 EXECUTE" \
  "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='delete_own_account' AND grantee='authenticated' AND privilege_type='EXECUTE';")" "1"
c "回归守卫：app_users 总数基线未变" "$(Q "SELECT count(*)::int FROM public.app_users;")" "$BASE_USERS"
c "回归守卫：profiles 总数基线未变" "$(Q "SELECT count(*)::int FROM public.profiles;")" "$BASE_PROFILES"
c "回归守卫：四服务 active" \
  "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"

# ── ⑥ 端到端删号验收（真实公网链路）─────────────────────────────────
echo " 【端到端验收 · 临时账号 TEST- 前缀】"
OWNER="TEST-$(date +%s)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
HASH="test-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"

PSQL_SU -c "
INSERT INTO public.app_users (owner_id, ident_kind, ident_hash, ident_masked)
  VALUES ('$OWNER','phone','$HASH','138****9999');
INSERT INTO public.profiles (owner_id, nickname) VALUES ('$OWNER','删号验收');
INSERT INTO public.meal_entries (owner_id, log_date, meal_type, food_name, calories)
  VALUES ('$OWNER', current_date, 'lunch', 'test', 100);
INSERT INTO public.entitlements (owner_id) VALUES ('$OWNER');
INSERT INTO public.ai_usage (owner_id, usage_date) VALUES ('$OWNER', current_date);
" >/dev/null 2>"$MIG_DIR/seed.err" || { echo "✗ FATAL: 造测试账号失败"; sed -n '1,10p' "$MIG_DIR/seed.err"; exit 1; }
c "测试账号已造且跨 4 张业务表有数据" \
  "$(Q "SELECT (SELECT count(*) FROM public.profiles WHERE owner_id='$OWNER') + (SELECT count(*) FROM public.meal_entries WHERE owner_id='$OWNER') + (SELECT count(*) FROM public.entitlements WHERE owner_id='$OWNER') + (SELECT count(*) FROM public.ai_usage WHERE owner_id='$OWNER');")" "4"

# 签 JWT：node 读 /etc/dbee/gateway.env（明文只在服务器本机、只写进 chmod600 文件）
cat > "$MIG_DIR/mkjwt.mjs" <<'NODE'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
const lines = readFileSync('/etc/dbee/gateway.env', 'utf8').split('\n')
const env = {}
for (const l of lines) {
  const i = l.indexOf('=')
  if (i > 0 && /^[A-Z]/.test(l)) env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const now = Math.floor(Date.now() / 1000)
const h = b64({ alg: 'HS256', typ: 'JWT' })
const p = b64({ sub: process.argv[2], role: 'authenticated', is_anonymous: false, ver: 1, iat: now, exp: now + 600 })
const sig = createHmac('sha256', env.JWT_SECRET || '').update(`${h}.${p}`).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
process.stdout.write(`${h}.${p}.${sig}\n${env.WB_PUBLISHABLE_KEY || ''}\n`)
NODE
# 🔴 node 必须以 sudo 跑：/etc/dbee/gateway.env 是 0640 root:dbee，ubuntu 读不到
#   （首轮实测 EACCES）。stdout 重定向仍由 ubuntu shell 完成 → .cred 属主是
#   ubuntu、权限 600，密钥既不进命令行参数也不进日志。
SUDO /usr/local/bin/node "$MIG_DIR/mkjwt.mjs" "$OWNER" > "$MIG_DIR/.cred" 2>"$MIG_DIR/jwt.err" \
  || { echo "✗ FATAL: 签 JWT 失败"; sed -n '1,8p' "$MIG_DIR/jwt.err"; exit 1; }
chmod 600 "$MIG_DIR/.cred"
TOKEN=$(sed -n 1p "$MIG_DIR/.cred")
AK=$(sed -n 2p "$MIG_DIR/.cred")
[ -n "$TOKEN" ] && [ -n "$AK" ] || { echo "✗ FATAL: 凭据文件为空"; exit 1; }

do_rpc() {
  local token="$1" key="$2" body="$3" out
  if [ -z "$token" ]; then
    out=$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST "$RPC" \
      -H 'content-type: application/json' -d "$body" 2>/dev/null)
  else
    out=$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST "$RPC" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $token" \
      -H "x-wb-webapp-access-key: $key" \
      -d "$body" 2>/dev/null)
  fi
  HTTP=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# 负向①：未登录不得删号
do_rpc "" "" '{"p_confirm":"DELETE_MY_ACCOUNT"}'
c "负向① 未登录被拒（非 200）" "$([ "$HTTP" != "200" ] && echo 1 || echo 0)" "1"

# 负向②：确认令牌错误不得删任何数据
do_rpc "$TOKEN" "$AK" '{"p_confirm":"WRONG"}'
c "负向② 错误令牌被拒（非 200）" "$([ "$HTTP" != "200" ] && echo 1 || echo 0)" "1"
c "负向② 错误令牌后数据仍在（事务未误删）" \
  "$(Q "SELECT count(*)::int FROM public.app_users WHERE owner_id='$OWNER';")" "1"

# 正向：真实删号
do_rpc "$TOKEN" "$AK" '{"p_confirm":"DELETE_MY_ACCOUNT"}'
if [ "$HTTP" != "200" ]; then
  echo "  诊断: HTTP=$HTTP BODY=$(printf '%s' "$BODY" | head -c 220)"
fi
c "正向 HTTP 200" "$HTTP" "200"
c "正向响应 identity_removed=true" \
  "$(printf '%s' "$BODY" | grep -cE '"identity_removed"[[:space:]]*:[[:space:]]*true' || true)" "1"
c "正向响应 ok=true" \
  "$(printf '%s' "$BODY" | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

# 库内实证：身份行 + 4 张业务表全清零
c "app_users 身份行已删" \
  "$(Q "SELECT count(*)::int FROM public.app_users WHERE owner_id='$OWNER';")" "0"
c "4 张业务表的临时数据全删" \
  "$(Q "SELECT (SELECT count(*) FROM public.profiles WHERE owner_id='$OWNER') + (SELECT count(*) FROM public.meal_entries WHERE owner_id='$OWNER') + (SELECT count(*) FROM public.entitlements WHERE owner_id='$OWNER') + (SELECT count(*) FROM public.ai_usage WHERE owner_id='$OWNER');")" "0"
c "回归守卫：其它账号 app_users 未被误删" "$(Q "SELECT count(*)::int FROM public.app_users;")" "$BASE_USERS"
c "回归守卫：其它账号 profiles 未被误删" "$(Q "SELECT count(*)::int FROM public.profiles;")" "$BASE_PROFILES"
c "回归守卫：healthz 仍 ok" \
  "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

# ── ⑦ 清理（含失败兜底：测试账号若没删干净，显式清掉）──────────────
PSQL_SU -c "DELETE FROM public.profiles WHERE owner_id='$OWNER'; DELETE FROM public.meal_entries WHERE owner_id='$OWNER'; DELETE FROM public.entitlements WHERE owner_id='$OWNER'; DELETE FROM public.ai_usage WHERE owner_id='$OWNER'; DELETE FROM public.app_users WHERE owner_id='$OWNER';" >/dev/null 2>&1 || true
rm -f "$MIG_DIR/.cred" "$MIG_DIR/mkjwt.mjs" "$MIG_DIR"/*.err "$MIG_DIR"/0045.err2
echo "✓ 临时凭据与测试账号已清理"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "✅ 0045 全部断言通过（FAIL=0）"; else echo "❌ 0045 有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
