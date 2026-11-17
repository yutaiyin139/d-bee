#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0055.sh · 应用 0055 补分订正 + 生产实测（可重复运行）
# ═══════════════════════════════════════════════════════════════════════
# 由 tools/apply-honey-backfill-prod.py 经 SSH 上传后执行。
# 安全纪律同 0054：不碰网关/nginx/postgrest、不 restart、不跑 deploy-gateway；
# 只 UPDATE 一行 amount（-150→-50），条件严格匹配、幂等；不做任何增删行。
#
# 步骤：前置核验 → 专用备份(验TOC) → 精确UPDATE(核验影响行) → 三方对账
#      → 幂等复跑 → 回归守卫(其余账户/行数/服务) → 完成。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
M55=0055-honey-expire-backfill.sql
BACKUP_DIR=/var/backups/dbee
OWNER=1793253465481363901
FAIL=0

c() {
  if [ "$2" = "$3" ]; then echo "  OK  $1"; else
    echo "  FAIL  $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " 0055 补分订正  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ① 前置检查 ───────────────────────────────────────────────────────
[ -s "$MIG_DIR/$M55" ] || { echo "FAIL: 缺 $MIG_DIR/$M55"; exit 1; }
if grep -qU $'\r' "$MIG_DIR/$M55"; then echo "FAIL: $M55 含 CR"; exit 1; fi
echo "OK  迁移文件就绪（LF，无 CR）"

CUR_AMT=$(Q "SELECT amount::text FROM public.honey_ledger WHERE id=371 AND ref_id='exp:283';")
CUR_OWNER=$(Q "SELECT owner_id FROM public.honey_ledger WHERE id=371 AND ref_id='exp:283';")
echo "  目标行 id=371: amount=$CUR_AMT owner=${CUR_OWNER:0:6}..."
if [ "$CUR_AMT" != "-150" ] && [ "$CUR_AMT" != "-50" ]; then
  echo "FAIL: 目标行金额异常（$CUR_AMT），既非 -150 也非 -50，终止"; exit 1
fi
if [ "${CUR_OWNER:0:6}" != "179325" ]; then
  echo "FAIL: 目标行 owner 不符，终止"; exit 1
fi

# 基线：其余三账户余额 + 行数（回归守卫）
B_284=$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='1792845025064566575';")
B_394=$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='1793940190199540839';")
B_WX=$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='wx:osq4HxiMv5VOdF9uCL8WaG9teUI8';")
B_ROWS=$(Q "SELECT count(*)::int FROM public.honey_ledger;")
B_USERS=$(Q "SELECT count(*)::int FROM public.app_users;")
echo "  基线 exp:281账户SUM=$B_284 exp:302账户SUM=$B_394 wx账户SUM=$B_WX ledger行=$B_ROWS"

ALREADY=$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0055' AND status='applied';")

if [ "$ALREADY" = "1" ] && [ "$CUR_AMT" = "-50" ]; then
  echo "INFO 0055 已订正（amount=-50）→ 幂等分支：跳过备份/更新，直接复验"
else
  # ── ② 专用备份 ───────────────────────────────────────────────────
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="$BACKUP_DIR/backup-before-0055-$TS.dump"
  SUDO mkdir -p "$BACKUP_DIR"
  SUDO -u postgres pg_dump -Fc -d dbee -f "$DEST" >/dev/null 2>&1 \
    || { echo "FAIL: pg_dump 失败"; exit 1; }
  TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^[0-9]*; ' || true)
  if [ "${TOC:-0}" -lt 100 ]; then echo "FAIL: 备份 TOC 仅 ${TOC:-0} 项，疑似损坏"; exit 1; fi
  echo "OK  专用备份 $DEST （TOC $TOC 项）"

  # ── ③ 精确 UPDATE（条件严格匹配，后查金额核验）──────────────────
  PSQL_SU -c "UPDATE public.honey_ledger SET amount=-50
    WHERE id=371 AND ref_id='exp:283' AND owner_id='$OWNER'
      AND reason='expire' AND amount=-150;" >/dev/null 2>"$MIG_DIR/0055.err" \
    || { echo "FAIL: UPDATE 失败"; sed -n '1,12p' "$MIG_DIR/0055.err"; exit 1; }
  NEW_AMT=$(Q "SELECT amount::text FROM public.honey_ledger WHERE id=371 AND ref_id='exp:283';")
  if [ "$NEW_AMT" != "-50" ]; then echo "FAIL: 订正后金额=$NEW_AMT，期望 -50"; exit 1; fi
  echo "OK  目标行已订正 -150 → -50"

  # ── ④ 幂等复跑（原样重跑 UPDATE 应影响 0 行、金额仍 -50）─────────
  PSQL_SU -f "$MIG_DIR/$M55" >/dev/null 2>"$MIG_DIR/0055.err2" \
    || { echo "FAIL: 幂等复跑失败"; sed -n '1,12p' "$MIG_DIR/0055.err2"; exit 1; }
  NEW_AMT2=$(Q "SELECT amount::text FROM public.honey_ledger WHERE id=371 AND ref_id='exp:283';")
  if [ "$NEW_AMT2" != "-50" ]; then echo "FAIL: 幂等复跑后金额=$NEW_AMT2"; exit 1; fi
  echo "OK  幂等复跑通过（金额仍 -50）"
fi

# ── ⑤ 三方对账 ──────────────────────────────────────────────────────
echo " 【三方对账 · 179325】"
NAIVE=$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='$OWNER';")
FEFO=$(PSQL_SU -tA -c "SET request.jwt.claim.sub='$OWNER'; SELECT honey_balance();" 2>/dev/null | grep -E 'balance' | head -1)
echo "  朴素SUM=$NAIVE  FEFO=$FEFO"
c "朴素 SUM = 34（订正前 -66）" "$NAIVE" "34"
c "FEFO balance 仍 = 34（未被重复计分）" "$(printf '%s' "$FEFO" | grep -cE '"balance"[[:space:]]*:[[:space:]]*34' || true)" "1"
c "FEFO total_earned = 184" "$(printf '%s' "$FEFO" | grep -cE '"total_earned"[[:space:]]*:[[:space:]]*184' || true)" "1"
c "FEFO total_spent = 100" "$(printf '%s' "$FEFO" | grep -cE '"total_spent"[[:space:]]*:[[:space:]]*100' || true)" "1"
c "schema_migrations 登记 0055" "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0055' AND status='applied';")" "1"

# ── ⑥ 回归守卫 ──────────────────────────────────────────────────────
echo " 【回归守卫】"
c "其余账户 exp:281 SUM 未变" "$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='1792845025064566575';")" "$B_284"
c "其余账户 exp:302 SUM 未变" "$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='1793940190199540839';")" "$B_394"
c "其余账户 wx:osq SUM 未变" "$(Q "SELECT sum(amount)::int FROM public.honey_ledger WHERE owner_id='wx:osq4HxiMv5VOdF9uCL8WaG9teUI8';")" "$B_WX"
c "ledger 行数未变（未增删行）" "$(Q "SELECT count(*)::int FROM public.honey_ledger;")" "$B_ROWS"
c "app_users 总数未变" "$(Q "SELECT count(*)::int FROM public.app_users;")" "$B_USERS"
c "其余三条 expire 金额仍 -150" "$(Q "SELECT count(*)::int FROM public.honey_ledger WHERE reason='expire' AND ref_id<>'exp:283' AND amount=-150;")" "3"
c "四服务 active" "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"
c "healthz ok" "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "0055 全部断言通过（FAIL=0）"; else echo "0055 有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
