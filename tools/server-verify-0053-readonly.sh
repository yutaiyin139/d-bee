#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-verify-0053-readonly.sh · 0053 应用后【纯只读】复验 + 假红归因
#
# 背景：server-apply-0053.sh 的断言「PostgREST 运行角色 dbee_app 可见
#   health_vendor 列」报 FAIL（实测=SET，期望=1）。归因＝**断言自身假红**：
#   `psql -c "SET ROLE dbee_app; SELECT count(*)…"` 会输出**两行**（`SET` + 计数），
#   而 Q() 内置 `head -1` 抓到了第一行 `SET`。
#   🔴 这是 0054 已踩过的同一坑（`pg_get_functiondef()` 多行被 head -1 截断）。
#   本脚本用「grep 取纯数字行」的正确口径重判，并加端到端证据。
#
# 🔴 零写入：只 SELECT / journalctl / ss / curl 只读。绝不 restart/reload/deploy。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
FAIL=0
c() {
  if [ "$2" = "$3" ]; then echo "  OK  $1"; else
    echo "  FAIL  $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "【A】原始两行输出（证明 head -1 抓到 SET ＝假红根因）"
SUDO -u postgres psql -d dbee -tA -c "SET ROLE dbee_app; SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';" 2>&1 | sed 's/^/  原始行: /'

echo ""
echo "【B】正确口径复验（grep 取纯数字行，不用 head -1）"
VIS=$(SUDO -u postgres psql -d dbee -tA -c "SET ROLE dbee_app; SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';" 2>/dev/null | grep -E '^[0-9]+$' | head -1)
c "dbee_app 可见 health_vendor 列" "${VIS:-}" "1"

echo ""
echo "【C】dbee_app 真能查询该列（比 information_schema 更强的证据）"
SEL=$(SUDO -u postgres psql -d dbee -tA -c "SET ROLE dbee_app; SELECT count(*)::int FROM public.profiles WHERE health_vendor IS NULL;" 2>/dev/null | grep -E '^[0-9]+$' | head -1)
c "dbee_app 可 SELECT health_vendor（无 permission denied）" "$([ -n "${SEL:-}" ] && echo yes || echo no)" "yes"
echo "  dbee_app 查得 health_vendor IS NULL 行数 = ${SEL:-<空>}"

echo ""
echo "【D】dbee_app 对 profiles 的 UPDATE 权限（纯目录查询，不做任何写动作）"
UPD=$(SUDO -u postgres psql -d dbee -tA -c "SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='dbee_app' AND table_schema='public' AND table_name='profiles' AND privilege_type='UPDATE';" 2>/dev/null | grep -E '^[0-9]+$' | head -1)
c "dbee_app 有 profiles UPDATE 权限（前端 saveProfile 依赖它）" "${UPD:-0}" "1"
echo "  🔴 刻意不用「事务内 UPDATE 后 ROLLBACK」验证：本脚本命名承诺零写入，"
echo "     写动作（即使回滚）也会占 WAL/触发触发器，改查权限目录才是真只读口径。"

echo ""
echo "【E】PostgREST schema cache 是否已重载（NOTIFY 生效证据）"
SUDO journalctl -u postgrest --since '-15 minutes' --no-pager 2>&1 | grep -iE 'reload|schema cache|Received|listening' | tail -6 | sed 's/^/  /'

echo ""
echo "【F】PostgREST 本地端口与 OpenAPI 是否暴露新列（端到端最强证据）"
SUDO ss -lntp 2>/dev/null | grep -iE 'postgrest|node' | head -6 | sed 's/^/  监听: /'
for PORT in 3001 3000 3002; do
  HIT=$(SUDO curl -sS --max-time 10 -H 'Accept: application/openapi+json' "http://127.0.0.1:$PORT/" 2>/dev/null | grep -c 'health_vendor' || true)
  if [ "${HIT:-0}" != "0" ]; then
    echo "  ✅ 端口 $PORT 的 OpenAPI 已含 health_vendor（命中 $HIT 次）→ schema cache 已重载"
    c "PostgREST OpenAPI 暴露 health_vendor" "yes" "yes"
    break
  fi
done

echo ""
echo "【G】0053 登记与列的最终状态"
c "schema_migrations 0053 登记" "$(SUDO -u postgres psql -d dbee -tA -c "SELECT count(*)::int FROM public.schema_migrations WHERE version='0053' AND name='health-vendor' AND status='applied';" 2>/dev/null | head -1)" "1"
c "profiles.health_vendor 列存在" "$(SUDO -u postgres psql -d dbee -tA -c "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';" 2>/dev/null | head -1)" "1"
c "CHECK 约束存在" "$(SUDO -u postgres psql -d dbee -tA -c "SELECT count(*)::int FROM pg_constraint WHERE conname='profiles_health_vendor_check';" 2>/dev/null | head -1)" "1"
c "四服务 active" "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"
c "healthz ok" "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "0053 复验全部通过（FAIL=0）—— 上一轮 FAIL 系断言假红"; else echo "0053 复验有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
