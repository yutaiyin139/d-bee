#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-apply-0043-0044.sh · 服务器端应用 0043 + 0044 迁移（含专用备份）
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 调用（sudo 密码占位符会被替换成 SSH 密码；
# 本注释刻意不写出该占位符，防渲染后密码落盘）。
# 前置：0043/0044 两个 .sql 已 putfile 到 /tmp/dbee-mig/。
#
# 为什么 0043 要和 0044 一起补：
#   任务 #5（0043 ident_kind wechat）此前标记 completed，但 2026-11-06 21:00
#   只读探针实证 **服务器从未应用**：
#     · app_users_ident_kind_check 仍是 (phone,email)，无 wechat
#     · schema_migrations 无 0043 登记行
#
#   🔴 同一轮探针还查出：任务 #4（A1 网关 /v1/login-wechat）**同样从未部署到生产**：
#     · `POST /v1/login-wechat` 实测 → 404 `{"message":"未知端点 /v1/login-wechat"}`
#     · `/opt/dbee-gateway` 全目录 grep `login-wechat` / `loginWechat` → **命中 0**
#     · 生产 `index.mjs` mtime = 2026-10-29（早于 A1 所在的 commit c0224fc / 11-05）
#     · 本地仓库**确有**实现（`server/lib/app.mjs:91` 路由 + `server/lib/auth.mjs:548` handler）
#   → 即「微信登录 A1~A3」是**代码已写、生产未部署**的状态，不是「已上线」。
#
#   因此本次应用 0043 的定位要说清楚：
#     · 0043 是**前向兼容的独立改动**（只放宽 CHECK 值域，不动数据、不动权限），
#       先应用**不会**开启任何新功能，也**不会**破坏现有登录；
#     · 真正让小程序微信登录可用，还需要**单独部署网关**（A1）+ **配 WECHAT_* env**（A3）
#       + **小程序后端切自建库**（B5）。这三步不在本脚本范围内。
#     · 先补 0043 的价值：等网关部署时，DB 侧约束已就绪，不会出现「网关已上线但写库撞 CHECK」。
#
# 步骤（任一步失败立即终止，不留半成品）：
#   ① 专用备份 pg_dump -Fc → /var/backups/dbee/backup-before-0043-0044-<ts>.dump
#      + pg_restore --list 验证 TOC（没验证过可恢复的备份不算备份）
#   ② 应用 0043（文件自带 BEGIN/COMMIT，ON_ERROR_STOP=1，失败自动回滚）
#   ③ 应用 0044（同上）
#   ④ 幂等复验：两个文件各重跑一遍，必须依然成功
#   ⑤ 标志位检查（含 3 条回归守卫，见下方【回归守卫】注释）
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 "$@"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

MIG_DIR=/tmp/dbee-mig
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/var/backups/dbee
DEST="$BACKUP_DIR/backup-before-0043-0044-$TS.dump"
M43=0043-ident-kind-wechat.sql
M44=0044-redeem-code-tiers.sql

die() { echo "✗ FATAL: $*"; exit 1; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 应用 0043 + 0044  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── 0) 前置检查 ─────────────────────────────────────────────────────
for f in "$M43" "$M44"; do
  [ -s "$MIG_DIR/$f" ] || die "缺少 $MIG_DIR/$f（先 putfile 上传）"
  if grep -qU $'\r' "$MIG_DIR/$f"; then die "$f 含 CR 字符（换行未归一）"; fi
done
echo "✓ 迁移文件就绪（无 CR）"

# 0044 安全自检：绝不允许出现 FORCE ROW LEVEL SECURITY
#   （0044 (b) 段末论证：不为将来「属主迁到 NOBYPASSRLS 角色」埋雷。
#     若被误改成 FORCE 且属主非超级用户 → 兑换码查询静默返回 0 行 = 全线兑换失效）
if grep -qiE 'FORCE[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY' "$MIG_DIR/$M44"; then
  die "$M44 含 FORCE ROW LEVEL SECURITY —— 违反 0044 设计约束，拒绝应用"
fi
echo "✓ 0044 无 FORCE RLS（符合设计约束）"

# 返回类型必须是 text（两端前端 `r === 'ok' || r === 'used' ? r : 'bad'` 依赖它）
grep -q 'RETURNS text' "$MIG_DIR/$M44" || die "$M44 未声明 RETURNS text —— 兼容性约束被破坏"
echo "✓ 0044 返回类型仍为 text"

# putfile 以 ubuntu:0600 上传，postgres 用户无权读 → 放开读权限
SUDO chmod 644 "$MIG_DIR/$M43" "$MIG_DIR/$M44"
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

# ── ②③ 应用 0043 → 0044 ────────────────────────────────────────────
for f in "$M43" "$M44"; do
  echo "── 应用 $f ──"
  if PSQL_SU -q -f "$MIG_DIR/$f" >/tmp/_apply_out.txt 2>&1; then
    echo "✓ $f 应用成功"
    grep -E "NOTICE|WARNING" /tmp/_apply_out.txt | head -5 | sed 's/^/    /'
  else
    tail -20 /tmp/_apply_out.txt | sed 's/^/    /'
    die "$f 应用失败（事务已自动回滚，库仍为备份时点状态；备份在 $DEST）"
  fi
done

# ── ④ 幂等复验：重跑一遍 ─────────────────────────────────────────────
echo "── ④ 幂等复验（全量重跑）──"
for f in "$M43" "$M44"; do
  if PSQL_SU -q -f "$MIG_DIR/$f" >/tmp/_apply_out2.txt 2>&1; then
    echo "✓ 重跑 $f 成功（幂等成立）"
  else
    tail -20 /tmp/_apply_out2.txt | sed 's/^/    /'
    die "重跑 $f 失败（幂等被破坏！但首轮已成功，库状态正常，需人工排查）"
  fi
done

# ── ⑤ 标志位检查 ─────────────────────────────────────────────────────
echo "── ⑤ 标志位快检 ──"
FAIL=0
c() { # c <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1)); fi
}

echo " 【0043 · ident_kind wechat】"
c "schema_migrations 登记 0043" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0043' AND status='applied';")" "1"
c "ident_kind CHECK 含 wechat" \
  "$(Q "SELECT (pg_get_constraintdef(oid) LIKE '%wechat%')::int FROM pg_constraint WHERE conname='app_users_ident_kind_check';")" "1"
c "ident_kind CHECK 仍含 phone/email（未误删旧值）" \
  "$(Q "SELECT (pg_get_constraintdef(oid) LIKE '%phone%' AND pg_get_constraintdef(oid) LIKE '%email%')::int FROM pg_constraint WHERE conname='app_users_ident_kind_check';")" "1"

echo " 【0044 · schema】"
c "schema_migrations 登记 0044" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0044' AND status='applied';")" "1"
c "redeem_codes.plan 列存在" \
  "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_name='redeem_codes' AND column_name='plan';")" "1"
c "redeem_codes.months 列存在" \
  "$(Q "SELECT count(*)::int FROM information_schema.columns WHERE table_name='redeem_codes' AND column_name='months';")" "1"
c "redeem_codes_plan_chk 约束存在" \
  "$(Q "SELECT count(*)::int FROM pg_constraint WHERE conname='redeem_codes_plan_chk';")" "1"
c "redeem_codes_months_chk 约束存在" \
  "$(Q "SELECT count(*)::int FROM pg_constraint WHERE conname='redeem_codes_months_chk';")" "1"
c "redeem_codes_unused_idx 部分索引存在" \
  "$(Q "SELECT count(*)::int FROM pg_indexes WHERE indexname='redeem_codes_unused_idx';")" "1"
c "存量码全部 lifetime（非 lifetime 计数=0）" \
  "$(Q "SELECT count(*)::int FROM redeem_codes WHERE plan IS DISTINCT FROM 'lifetime';")" "0"

echo " 【0044 · 函数体】"
c "redeem_by_code 含 advisory lock（防并发丢顺延）" \
  "$(Q "SELECT (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'advisory_xact_lock')::int;")" "1"
c "redeem_by_code 含 make_interval（pro 顺延）" \
  "$(Q "SELECT (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'make_interval')::int;")" "1"
c "redeem_by_code 含 lifetime 分支" \
  "$(Q "SELECT (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'lifetime')::int;")" "1"

echo " 【回归守卫 1 · 兼容性】返回值仍是 text（两端前端依赖）"
c "pg_get_function_result = text" \
  "$(Q "SELECT pg_get_function_result('public.redeem_by_code(text)'::regprocedure);")" "text"

echo " 【回归守卫 2 · 隔离】表未被放宽、FORCE 未被打开"
c "authenticated 对 redeem_codes 零表权限" \
  "$(Q "SELECT has_table_privilege('authenticated','public.redeem_codes','SELECT')::int;")" "0"
c "anon 对 redeem_codes 零表权限" \
  "$(Q "SELECT has_table_privilege('anon','public.redeem_codes','SELECT')::int;")" "0"
c "redeem_codes rls=true" \
  "$(Q "SELECT relrowsecurity::int FROM pg_class WHERE oid='public.redeem_codes'::regclass;")" "1"
c "redeem_codes force=false（刻意不加，见 0044 (b) 段末）" \
  "$(Q "SELECT relforcerowsecurity::int FROM pg_class WHERE oid='public.redeem_codes'::regclass;")" "0"

# 【回归守卫 3 · 授权】2026-11-06 21:05 只读探针实证：
#   生产 PROACL 是显式授权 `postgres=X/postgres ;; dbee_app=X/postgres ;; authenticated=X/postgres`
#   （PUBLIC 无条目）→ 0044 的 `REVOKE ALL ... FROM PUBLIC, anon` 不会波及 dbee_app；
#   且 CREATE OR REPLACE FUNCTION 在 PG 中保留既有 proacl。
#   这两点是「推断」，故用实测断言钉死：任一角色丢失 EXECUTE 立即报红。
echo " 【回归守卫 3 · 授权】兑换函数对网关与前端角色仍可执行"
c "dbee_app 可 EXECUTE redeem_by_code（网关侧）" \
  "$(Q "SELECT has_function_privilege('dbee_app','public.redeem_by_code(text)','EXECUTE')::int;")" "1"
c "authenticated 可 EXECUTE redeem_by_code（PostgREST RPC 侧）" \
  "$(Q "SELECT has_function_privilege('authenticated','public.redeem_by_code(text)','EXECUTE')::int;")" "1"
c "anon 不可 EXECUTE redeem_by_code（未登录不得兑换）" \
  "$(Q "SELECT has_function_privilege('anon','public.redeem_by_code(text)','EXECUTE')::int;")" "0"

echo " 【函数属主真能读到码】（直接证明兑换没被 RLS 挡死）"
CODES=$(Q "SELECT count(*)::int FROM redeem_codes;")
c "属主可见码数 > 0（库存实测=$CODES）" \
  "$([ "${CODES:-0}" -gt 0 ] && echo yes || echo no)" "yes"

echo
if [ "$FAIL" = "0" ]; then
  echo "✅ 0043 + 0044 应用 + 幂等 + 标志位（含 3 条回归守卫）全部通过"
  echo "   备份：$DEST"
  echo "   下一步：deploy/probe-0044-parity.sh 采新指纹 → 与云库 §B 逐项比对"
  exit 0
else
  echo "❌ 标志位失败 $FAIL 项（备份：$DEST，如需回滚见上方 pg_restore 命令）"
  exit 1
fi
