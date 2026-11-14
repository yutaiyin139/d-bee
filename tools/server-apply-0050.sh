#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0050.sh · 服务器端应用 0050 方案起始日迁移 + 只读实证
# ═══════════════════════════════════════════════════════════════════════
# 由 tools/apply-plan-start-date-prod.py 经 SSH 上传后执行；**可重复运行**。
#
# 与 0045 相同的安全纪律：完全不碰网关、不 restart、不 nginx reload，
# 更不跑 deploy-gateway.sh（IDENT_PEPPER 重置地雷）。只做：
#   前置检查 → 专用备份(验 TOC) → 应用 SQL → 幂等复跑 → 只读探针 → 回归守卫。
#
# 本脚本不删任何文件、不造测试账号、不签 JWT；临时 SQL/脚本留在 /tmp/dbee-mig
# （不含任何凭据与真实数据），备份保留在 /var/backups/dbee 供回滚。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { sudo -n "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
M50=0050-plan-start-date.sql
BACKUP_DIR=/var/backups/dbee
FAIL=0

c() {
  if [ "$2" = "$3" ]; then echo "  OK  $1"; else
    echo "  FAIL  $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " 0050 方案起始日  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ① 前置检查 ───────────────────────────────────────────────────────
[ -s "$MIG_DIR/$M50" ] || { echo "FAIL: 缺 $MIG_DIR/$M50"; exit 1; }
if grep -qU $'\r' "$MIG_DIR/$M50"; then echo "FAIL: $M50 含 CR"; exit 1; fi
echo "OK  迁移文件就绪（LF，无 CR）"

BASE_USERS=$(Q "SELECT count(*)::int FROM public.app_users;")
BASE_PROFILES=$(Q "SELECT count(*)::int FROM public.profiles;")
echo "  基线 app_users=$BASE_USERS profiles=$BASE_PROFILES"

ALREADY=$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0050' AND status='applied';")

if [ "$ALREADY" = "1" ]; then
  echo "INFO 0050 已登记 applied → 幂等分支：跳过备份/应用，直接复验"
else
  # ── ② 专用备份（没验过 TOC 的备份不算备份）────────────────────────
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="$BACKUP_DIR/backup-before-0050-$TS.dump"
  SUDO mkdir -p "$BACKUP_DIR"
  SUDO -u postgres pg_dump -Fc -d dbee -f "$DEST" >/dev/null 2>&1 \
    || { echo "FAIL: pg_dump 失败"; exit 1; }
  TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^[0-9]*; ' || true)
  if [ "${TOC:-0}" -lt 100 ]; then echo "FAIL: 备份 TOC 仅 ${TOC:-0} 项，疑似损坏"; exit 1; fi
  echo "OK  专用备份 $DEST （TOC $TOC 项）"

  # ── ③ 应用 0050 ─────────────────────────────────────────────────
  PSQL_SU -f "$MIG_DIR/$M50" >/dev/null 2>"$MIG_DIR/0050.err" \
    || { echo "FAIL: 应用 0050 失败"; sed -n '1,12p' "$MIG_DIR/0050.err"; exit 1; }
  echo "OK  0050 已应用"

  # ── ④ 幂等复验（原样重跑必须依然成功）───────────────────────────
  PSQL_SU -f "$MIG_DIR/$M50" >/dev/null 2>"$MIG_DIR/0050.err2" \
    || { echo "FAIL: 幂等复跑失败"; sed -n '1,12p' "$MIG_DIR/0050.err2"; exit 1; }
  echo "OK  幂等复跑通过"
fi

# ── ⑤ 只读探针 ──────────────────────────────────────────────────────
echo " 【结构探针】"
c "列 plan_started_at 存在" \
  "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='plan_started_at';")" "1"
c "列类型为 timestamptz" \
  "$(Q "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='plan_started_at';")" "timestamp with time zone"
c "列可空（不强约束既有档案）" \
  "$(Q "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='plan_started_at';")" "YES"
c "schema_migrations 登记 0050" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0050' AND status='applied';")" "1"

echo " 【回填探针】"
c "非空 plan_started_at 行数 = profiles 总数" \
  "$(Q "SELECT count(*)::int FROM public.profiles WHERE plan_started_at IS NOT NULL;")" "$BASE_PROFILES"
c "回填值与 created_at 一致（无编造日期）" \
  "$(Q "SELECT count(*)::int FROM public.profiles WHERE plan_started_at IS DISTINCT FROM created_at;")" "0"

echo " 【回归守卫】"
c "app_users 总数基线未变" "$(Q "SELECT count(*)::int FROM public.app_users;")" "$BASE_USERS"
c "profiles 总数基线未变" "$(Q "SELECT count(*)::int FROM public.profiles;")" "$BASE_PROFILES"
c "四服务 active" \
  "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"
c "healthz 仍 ok" \
  "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "0050 全部断言通过（FAIL=0）"; else echo "0050 有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
