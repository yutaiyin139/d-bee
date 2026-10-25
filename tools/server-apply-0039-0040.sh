#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0039-0040.sh · 服务器端应用 0039/0040 迁移（含专用备份）
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 调用（__SUDO_PWD__ 被替换成 SSH 密码）。
# 前置：0039/0040 两个 .sql 已 putfile 到 /tmp/dbee-mig/。
#
# 步骤（任一步失败立即终止，不留半成品）：
#   ① 专用备份 pg_dump -Fc → /var/backups/dbee/backup-before-0039-0040-<ts>.dump
#      + pg_restore --list 验证 TOC（没验证过可恢复的备份不算备份，同 dbee-backup.sh 纪律）
#   ② 应用 0039（ON_ERROR_STOP=1，事务内，失败自动回滚）
#   ③ 应用 0040（同上）
#   ④ 幂等复验：两个文件各重跑一遍，必须依然成功
#   ⑤ 快速标志位检查（llm_gate / honey_balance / leaderboard_cache / provolatile）
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/var/backups/dbee
DEST="$BACKUP_DIR/backup-before-0039-0040-$TS.dump"

die() { echo "✗ FATAL: $*"; exit 1; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 应用 0039/0040  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── 0) 前置检查：两个迁移文件都在 ────────────────────────────────────
for f in 0039-rpc-trust-boundary.sql 0040-honey-balance-and-leaderboard-cache.sql; do
  [ -s "$MIG_DIR/$f" ] || die "缺少 $MIG_DIR/$f（先 putfile 上传）"
  # CRLF 检查（putfile 已做 \r\n→\n，双保险：psql 对 CRLF 宽容但 dollar-quote 内会留 \r）
  if grep -qU $'\r' "$MIG_DIR/$f"; then die "$f 含 CR 字符（换行未归一）"; fi
done
echo "✓ 迁移文件就绪（无 CR）"
# putfile 以 ubuntu:0600 上传，postgres 用户无权读 → 放开读权限
SUDO chmod 644 "$MIG_DIR"/0039-rpc-trust-boundary.sql "$MIG_DIR"/0040-honey-balance-and-leaderboard-cache.sql
echo "✓ 权限已调整（postgres 可读）"

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
[ "$TOC" -gt 100 ] || die "归档 TOC 仅 $TOC 条，疑似损坏"
echo "✓ 备份完成：$DEST（TOC=$TOC，$((SIZE/1024)) KB）"
echo "  回滚命令：sudo -u postgres pg_restore -d dbee --clean --if-exists $DEST"

# ── ②③ 应用 0039 → 0040 ─────────────────────────────────────────────
for f in 0039-rpc-trust-boundary.sql 0040-honey-balance-and-leaderboard-cache.sql; do
  echo "── 应用 $f ──"
  if PSQL_SU -q -f "$MIG_DIR/$f" >/tmp/_apply_out.txt 2>&1; then
    echo "✓ $f 应用成功"
    grep -E "NOTICE|WARNING" /tmp/_apply_out.txt | head -5 | sed 's/^/    /'
  else
    tail -15 /tmp/_apply_out.txt | sed 's/^/    /'
    die "$f 应用失败（事务已自动回滚，库仍为备份时点状态；备份在 $DEST）"
  fi
done

# ── ④ 幂等复验：重跑一遍 ─────────────────────────────────────────────
echo "── ④ 幂等复验（全量重跑）──"
for f in 0039-rpc-trust-boundary.sql 0040-honey-balance-and-leaderboard-cache.sql; do
  if PSQL_SU -q -f "$MIG_DIR/$f" >/tmp/_apply_out2.txt 2>&1; then
    echo "✓ 重跑 $f 成功（幂等成立）"
  else
    tail -15 /tmp/_apply_out2.txt | sed 's/^/    /'
    die "重跑 $f 失败（幂等被破坏！但首轮已成功，库状态正常，需人工排查）"
  fi
done

# ── ⑤ 快速标志位 ─────────────────────────────────────────────────────
echo "── ⑤ 标志位快检 ──"
FAIL=0
c() { # c <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1)); fi
}
c "schema_migrations 登记 0039" "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0039' AND status='applied';")" "1"
c "schema_migrations 登记 0040" "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0040' AND status='applied';")" "1"
c "llm_gate 存在" "$(Q "SELECT (to_regprocedure('public.llm_gate(text)') IS NOT NULL)::int;")" "1"
c "llm_gate authenticated 不可执行" "$(Q "SELECT has_function_privilege('authenticated','public.llm_gate(text)','EXECUTE')::int;")" "0"
c "llm_gate dbee_app 可执行" "$(Q "SELECT has_function_privilege('dbee_app','public.llm_gate(text)','EXECUTE')::int;")" "1"
c "honey_balance() 存在" "$(Q "SELECT (to_regprocedure('public.honey_balance()') IS NOT NULL)::int;")" "1"
c "honey_balance authenticated 可执行" "$(Q "SELECT has_function_privilege('authenticated','public.honey_balance()','EXECUTE')::int;")" "1"
c "leaderboard_cache 表存在" "$(Q "SELECT (to_regclass('public.leaderboard_cache') IS NOT NULL)::int;")" "1"
c "leaderboard_cache authenticated 零权限" "$(Q "SELECT has_table_privilege('authenticated','public.leaderboard_cache','SELECT')::int;")" "0"
c "leaderboard() 易变性 = VOLATILE" "$(Q "SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='leaderboard';")" "v"
c "grant_honey 含事实验证" "$(Q "SELECT (position('meal_entries' IN pg_get_functiondef('public.grant_honey(text,text,integer,integer)'::regprocedure))>0)::int;")" "1"
c "redeem_honey 含 advisory 锁" "$(Q "SELECT (position('pg_advisory_xact_lock' IN pg_get_functiondef('public.redeem_honey(text)'::regprocedure))>0)::int;")" "1"

echo
if [ "$FAIL" = "0" ]; then
  echo "✅ 0039/0040 应用 + 幂等 + 标志位全部通过（备份：$DEST）"
  exit 0
else
  echo "❌ 标志位失败 $FAIL 项（备份：$DEST，如需回滚见上方 pg_restore 命令）"
  exit 1
fi
