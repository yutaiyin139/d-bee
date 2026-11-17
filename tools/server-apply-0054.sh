#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0054.sh · 应用 0054 FEFO 积分口径 + 生产实测（可重复运行）
# ═══════════════════════════════════════════════════════════════════════
# 由 tools/apply-honey-fefo-prod.py 经 SSH 上传后执行。
#
# 与 0050/0045 相同的安全纪律：完全不碰网关、不 restart、不 nginx reload，
# 更不跑 deploy-gateway.sh（IDENT_PEPPER 重置地雷）。只做：
#   前置检查 → 专用备份(验 TOC) → 应用 SQL → 幂等复跑 → 只读探针 → 实测 → 回归守卫。
#
# 本脚本不删任何文件、不造账号、不签 JWT、不改任何业务数据行；只 CREATE OR
# REPLACE 一个函数 + 写一行 schema_migrations 追踪。备份留 /var/backups/dbee。
# 实测用 SET request.jwt.claim.sub 模拟目标账户真实调用 honey_balance()。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
M54=0054-honey-balance-fefo.sql
BACKUP_DIR=/var/backups/dbee
OWNER=""
FAIL=0

c() {
  if [ "$2" = "$3" ]; then echo "  OK  $1"; else
    echo "  FAIL  $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " 0054 honey_balance FEFO  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ① 前置检查 ───────────────────────────────────────────────────────
[ -s "$MIG_DIR/$M54" ] || { echo "FAIL: 缺 $MIG_DIR/$M54"; exit 1; }
if grep -qU $'\r' "$MIG_DIR/$M54"; then echo "FAIL: $M54 含 CR"; exit 1; fi
echo "OK  迁移文件就绪（LF，无 CR）"

OWNER=$(Q "SELECT owner_id FROM public.app_users WHERE ident_masked='186****4399' LIMIT 1;")
BASE_USERS=$(Q "SELECT count(*)::int FROM public.app_users;")
BASE_PROFILES=$(Q "SELECT count(*)::int FROM public.profiles;")
BASE_LEDGER=$(Q "SELECT count(*)::int FROM public.honey_ledger;")
echo "  基线 app_users=$BASE_USERS profiles=$BASE_PROFILES ledger=$BASE_LEDGER owner=${OWNER:0:6}..."

ALREADY=$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0054' AND status='applied';")

if [ "$ALREADY" = "1" ]; then
  echo "INFO 0054 已登记 applied → 幂等分支：跳过备份/应用，直接复验"
else
  # ── ② 专用备份（没验过 TOC 的备份不算备份）────────────────────────
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="$BACKUP_DIR/backup-before-0054-$TS.dump"
  SUDO mkdir -p "$BACKUP_DIR"
  SUDO -u postgres pg_dump -Fc -d dbee -f "$DEST" >/dev/null 2>&1 \
    || { echo "FAIL: pg_dump 失败"; exit 1; }
  TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^[0-9]*; ' || true)
  if [ "${TOC:-0}" -lt 100 ]; then echo "FAIL: 备份 TOC 仅 ${TOC:-0} 项，疑似损坏"; exit 1; fi
  echo "OK  专用备份 $DEST （TOC $TOC 项）"

  # ── ③ 应用 0054 ─────────────────────────────────────────────────
  PSQL_SU -f "$MIG_DIR/$M54" >/dev/null 2>"$MIG_DIR/0054.err" \
    || { echo "FAIL: 应用 0054 失败"; sed -n '1,15p' "$MIG_DIR/0054.err"; exit 1; }
  echo "OK  0054 已应用"

  # ── ④ 幂等复跑（原样重跑必须依然成功）───────────────────────────
  PSQL_SU -f "$MIG_DIR/$M54" >/dev/null 2>"$MIG_DIR/0054.err2" \
    || { echo "FAIL: 幂等复跑失败"; sed -n '1,15p' "$MIG_DIR/0054.err2"; exit 1; }
  echo "OK  幂等复跑通过"
fi

# ── ⑤ 只读探针 ──────────────────────────────────────────────────────
echo " 【函数口径探针】"
DEF=$(Q "SELECT pg_get_functiondef('public.honey_balance()'::regprocedure);")
c "honey_balance() 含 FEFO 批次逻辑" "$(printf '%s' "$DEF" | grep -c 'v_lots_remain' || true)" "1"
c "honey_balance() 已移除旧 FILTER 双扣" "$(printf '%s' "$DEF" | grep -c 'FILTER' || true)" "0"
c "honey_balance() 忽略 expire 冲正流水" "$(printf '%s' "$DEF" | grep -c "reason <> 'expire'" || true)" "1"
c "schema_migrations 登记 0054" "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0054' AND status='applied';")" "1"
c "函数是 SECURITY DEFINER" "$(Q "SELECT prosecdef::int FROM pg_proc WHERE oid='public.honey_balance()'::regprocedure;")" "1"
c "PUBLIC/anon 无 EXECUTE" "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='honey_balance' AND grantee IN ('PUBLIC','anon') AND privilege_type='EXECUTE';")" "0"
c "authenticated 有 EXECUTE" "$(Q "SELECT count(*)::int FROM information_schema.routine_privileges WHERE routine_name='honey_balance' AND grantee='authenticated' AND privilege_type='EXECUTE';")" "1"

# ── ⑥ 生产实测：模拟目标账户真实调用新函数 ──────────────────────────
echo " 【生产实测 · 账户 ${OWNER:0:6}...】"
BAL=$(PSQL_SU -tA -c "SET request.jwt.claim.sub='$OWNER'; SELECT honey_balance();" 2>/dev/null | grep -E 'balance' | head -1)
echo "  honey_balance() = $BAL"
c "余额 balance = 34（旧口径为 0）" "$(printf '%s' "$BAL" | grep -cE '"balance"[[:space:]]*:[[:space:]]*34' || true)" "1"
c "累计获得 earned = 184" "$(printf '%s' "$BAL" | grep -cE '"total_earned"[[:space:]]*:[[:space:]]*184' || true)" "1"
c "累计消耗 spent = 100（旧口径虚高 250）" "$(printf '%s' "$BAL" | grep -cE '"total_spent"[[:space:]]*:[[:space:]]*100' || true)" "1"

# ── ⑦ 回归守卫 ──────────────────────────────────────────────────────
echo " 【回归守卫】"
c "app_users 总数基线未变" "$(Q "SELECT count(*)::int FROM public.app_users;")" "$BASE_USERS"
c "profiles 总数基线未变" "$(Q "SELECT count(*)::int FROM public.profiles;")" "$BASE_PROFILES"
c "honey_ledger 行数未变（未订正历史）" "$(Q "SELECT count(*)::int FROM public.honey_ledger;")" "$BASE_LEDGER"
c "四服务 active" "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"
c "healthz 仍 ok" "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "0054 全部断言通过（FAIL=0）"; else echo "0054 有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
