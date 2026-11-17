#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-precheck-0054.sh · 0054 应用前【只读】预检
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件注释不写出）。
# 全程只读：确认当前函数口径、登记状态、备份能力、服务健康，不写任何库。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 0054 应用前只读预检  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

DEF=$(PSQL_SU "SELECT coalesce(pg_get_functiondef('public.honey_balance()'::regprocedure),'');")
echo "【当前函数口径】"
echo "  honey_balance() 存在: $([ -n "$DEF" ] && echo YES || echo NO)"
echo "  含旧 FILTER 双扣口径: $(printf '%s' "$DEF" | grep -c 'FILTER' || true)"
echo "  含新 FEFO 批次逻辑:   $(printf '%s' "$DEF" | grep -c 'v_lots_remain' || true)"
echo "  含 reason='expire' 忽略: $(printf '%s' "$DEF" | grep -c "reason <> 'expire'" || true)"

echo "【登记状态】"
REG=$(PSQL_SU "SELECT count(*)::int FROM public.schema_migrations WHERE version='0054' AND status='applied';")
echo "  schema_migrations 已登记 0054 applied: $REG"

echo "【备份能力】"
echo "  /var/backups/dbee 存在: $([ -d /var/backups/dbee ] && echo YES || echo NO)"
echo "  磁盘可用: $(df -h /var/backups 2>/dev/null | tail -1 | awk '{print $4}' || echo '?')"

echo "【目标账户】"
OWNER=$(PSQL_SU "SELECT owner_id FROM public.app_users WHERE ident_masked='186****4399' LIMIT 1;")
echo "  owner=${OWNER:0:6}... (len=${#OWNER})"
echo "  honey_ledger 总行数: $(PSQL_SU "SELECT count(*)::int FROM public.honey_ledger;")"
echo "  expire 冲正笔数:     $(PSQL_SU "SELECT count(*)::int FROM public.honey_ledger WHERE reason='expire';")"

echo "【服务健康】"
echo "  四服务: $(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
echo "  healthz ok: $(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)"

echo "═══════════════════════════════════════════════════════════════════"
echo " 预检完成（全程只读，未写库、未部署）"
echo "═══════════════════════════════════════════════════════════════════"
