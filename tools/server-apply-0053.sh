#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0053.sh · 应用 0053 health_vendor + 生产实测（可重复运行）
# ═══════════════════════════════════════════════════════════════════════
# 由 tools/apply-health-vendor-prod.py 经 SSH 上传后执行。
#
# 🔴 为什么必须先做这一步（顺序错了会全端崩）：
#   两端 PROFILE_WRITABLE 已含 'health_vendor'（mini/src/lib/api.ts:244、
#   src/lib/api.ts:58）。若在新前端上线后才补列 → saveProfile 写不存在的列 →
#   PostgREST PGRST204 → 前端 zh() 误翻「服务版本不匹配」→ **四端档案保存全崩**
#   （与 0051 的 meal_entries.updated_at 事故同一模式，铁律 #15）。
#
# 安全纪律（同 0054/0055）：不碰网关/nginx/postgrest 服务、不 restart、
#   绝不跑 deploy-gateway.sh（全站永久锁死级地雷）；只加 1 个可空列 + 1 个
#   CHECK 约束 + 1 条登记；幂等可重跑；不动任何业务数据行。
#
# 步骤：前置核验 → 基线采样 → 专用备份(验TOC) → 应用 → 幂等复跑
#      → 断言(列/约束/注释/登记/PostgREST 可见) → 回归守卫 → 完成。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
M53=0053-health-vendor.sql
BACKUP_DIR=/var/backups/dbee
FAIL=0

c() {
  if [ "$2" = "$3" ]; then echo "  OK  $1"; else
    echo "  FAIL  $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " 0053 health_vendor 应用  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── ① 前置检查 ───────────────────────────────────────────────────────
[ -s "$MIG_DIR/$M53" ] || { echo "FAIL: 缺 $MIG_DIR/$M53"; exit 1; }
if grep -qU $'\r' "$MIG_DIR/$M53"; then echo "FAIL: $M53 含 CR"; exit 1; fi
echo "OK  迁移文件就绪（LF，无 CR）"

# 🔴 铁律：写 SQL 前必核列名 —— 确认 profiles 表在场、schema_migrations 列名正确
c "profiles 表存在" "$(Q "SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name='profiles';")" "1"
c "schema_migrations 有 version 列（非 id）" "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='version';")" "1"
c "schema_migrations 有 name 列" "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='name';")" "1"

# ── ② 基线采样（回归守卫用）─────────────────────────────────────────
B_COLS=$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles';")
B_ROWS=$(Q "SELECT count(*)::int FROM public.profiles;")
B_CONN=$(Q "SELECT count(*)::int FROM public.profiles WHERE health_connected IS TRUE;")
B_CK=$(Q "SELECT count(*)::int FROM pg_constraint WHERE conrelid='public.profiles'::regclass AND contype='c';")
B_MIG=$(Q "SELECT count(*)::int FROM public.schema_migrations;")
B_USERS=$(Q "SELECT count(*)::int FROM public.app_users;")
echo "  基线 profiles列=$B_COLS 行=$B_ROWS health_connected=true:$B_CONN CHECK约束=$B_CK 迁移登记=$B_MIG"

HAS_COL=$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';")
ALREADY=$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0053' AND status='applied';")

if [ "$HAS_COL" = "1" ] && [ "$ALREADY" = "1" ]; then
  echo "INFO 0053 已应用（列在场 + 已登记）→ 幂等分支：跳过备份，直接复验"
else
  # ── ③ 专用备份 ───────────────────────────────────────────────────
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="$BACKUP_DIR/backup-before-0053-$TS.dump"
  SUDO mkdir -p "$BACKUP_DIR"
  SUDO -u postgres pg_dump -Fc -d dbee -f "$DEST" >/dev/null 2>&1 \
    || { echo "FAIL: pg_dump 失败"; exit 1; }
  TOC=$(SUDO -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^[0-9]*; ' || true)
  if [ "${TOC:-0}" -lt 100 ]; then echo "FAIL: 备份 TOC 仅 ${TOC:-0} 项，疑似损坏"; exit 1; fi
  echo "OK  专用备份 $DEST （TOC $TOC 项）"

  # ── ④ 应用 0053 ─────────────────────────────────────────────────
  PSQL_SU -f "$MIG_DIR/$M53" >/dev/null 2>"$MIG_DIR/0053.err" \
    || { echo "FAIL: 应用 0053 失败"; sed -n '1,15p' "$MIG_DIR/0053.err"; exit 1; }
  echo "OK  0053 已应用"

  # ── ⑤ 幂等复跑（原样重跑不得报错、不得改变结果）─────────────────
  PSQL_SU -f "$MIG_DIR/$M53" >/dev/null 2>"$MIG_DIR/0053.err2" \
    || { echo "FAIL: 幂等复跑失败"; sed -n '1,15p' "$MIG_DIR/0053.err2"; exit 1; }
  echo "OK  幂等复跑通过（未报错）"
fi

# ── ⑥ 应用结果断言 ──────────────────────────────────────────────────
echo " 【0053 应用结果】"
c "profiles.health_vendor 列已存在" \
  "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';")" "1"
c "health_vendor 类型为 text" \
  "$(Q "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';")" "text"
c "health_vendor 可空（旧包不写它也不会失败）" \
  "$(Q "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';")" "YES"
c "CHECK 约束 profiles_health_vendor_check 已建" \
  "$(Q "SELECT count(*)::int FROM pg_constraint WHERE conname='profiles_health_vendor_check' AND conrelid='public.profiles'::regclass;")" "1"
c "列注释已写入（含 werun 字样）" \
  "$(Q "SELECT count(*)::int FROM pg_description d JOIN pg_class c ON c.oid=d.objoid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.objsubid WHERE c.relname='profiles' AND a.attname='health_vendor' AND d.description LIKE '%werun%';")" "1"
c "schema_migrations 登记 0053/health-vendor" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0053' AND name='health-vendor' AND status='applied';")" "1"

# 🔴 关键：PostgREST 必须能看见新列，否则前端写入仍会 PGRST204。
#   口径 = 用 dbee_app（PostgREST 运行角色）查 information_schema，
#   模拟其 schema cache 重载后的可见性；NOTIFY 已在事务 COMMIT 时投递。
c "PostgREST 运行角色 dbee_app 可见 health_vendor 列" \
  "$(SUDO -u postgres psql -d dbee -tA -c "SET ROLE dbee_app; SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';" 2>/dev/null | head -1)" "1"

# CHECK 约束真生效（正例 + 反例；在事务里跑并回滚，不留数据）
c "CHECK 接受合法值 werun（事务内回滚）" \
  "$(SUDO -u postgres psql -d dbee -tA -c "BEGIN; UPDATE public.profiles SET health_vendor='werun' WHERE id=(SELECT id FROM public.profiles LIMIT 1); SELECT 'accepted'; ROLLBACK;" 2>&1 | grep -c 'accepted')" "1"
c "CHECK 拒绝非法值 bogus_vendor（应报错）" \
  "$(SUDO -u postgres psql -d dbee -tA -c "BEGIN; UPDATE public.profiles SET health_vendor='bogus_vendor' WHERE id=(SELECT id FROM public.profiles LIMIT 1); ROLLBACK;" 2>&1 | grep -c 'profiles_health_vendor_check')" "1"

# ── ⑦ 回归守卫 ──────────────────────────────────────────────────────
echo " 【回归守卫】"
c "profiles 行数未变（未增删行）" "$(Q "SELECT count(*)::int FROM public.profiles;")" "$B_ROWS"
c "profiles 列数 = 基线+1（只加了 health_vendor）" "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles';")" "$((B_COLS+1))"
c "health_connected=true 行数未变（未动业务数据）" "$(Q "SELECT count(*)::int FROM public.profiles WHERE health_connected IS TRUE;")" "$B_CONN"
c "profiles CHECK 约束数 = 基线+1" "$(Q "SELECT count(*)::int FROM pg_constraint WHERE conrelid='public.profiles'::regclass AND contype='c';")" "$((B_CK+1))"
c "既有 health_vendor 全为 NULL（未回填任何值）" "$(Q "SELECT count(*)::int FROM public.profiles WHERE health_vendor IS NOT NULL;")" "0"
c "schema_migrations 登记数 = 基线+1" "$(Q "SELECT count(*)::int FROM public.schema_migrations;")" "$((B_MIG+1))"
c "app_users 总数未变" "$(Q "SELECT count(*)::int FROM public.app_users;")" "$B_USERS"
c "0054/0055 登记仍在（未覆盖既有迁移）" "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version IN ('0054','0055') AND status='applied';")" "2"
c "honey_balance() 函数仍在（未被本次波及）" "$(Q "SELECT count(*)::int FROM pg_proc WHERE proname='honey_balance';")" "1"
c "四服务 active" "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"
c "网关未重启（NRestarts 仍 0）" "$(systemctl show dbee-gateway -p NRestarts 2>/dev/null | cut -d= -f2)" "0"
c "healthz ok" "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "0053 全部断言通过（FAIL=0）"; else echo "0053 有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
