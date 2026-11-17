#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-verify-0054-readonly.sh · 0054 应用后【只读】复验
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件注释不写出）。
# 修正 server-apply-0054.sh 里 Q() 的 head -1 截断多行函数定义导致的假红：
# 把判断下推到 SQL 层（strpos > 0 → 单行 t/f），避免 shell 截断。
# 全程只读，不写库、不重新应用迁移。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }
Q() { SUDO -u postgres psql -d dbee -tA -c "$1" 2>/dev/null | head -1; }

FAIL=0
c() {
  if [ "$2" = "$3" ]; then echo "  OK  $1"; else
    echo "  FAIL  $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " 0054 应用后只读复验  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

echo "【函数口径（SQL 层布尔判断，规避 head -1 假红）】"
c "honey_balance() 含 FEFO 批次逻辑" \
  "$(Q "SELECT strpos(pg_get_functiondef('public.honey_balance()'::regprocedure), 'v_lots_remain') > 0;")" "t"
c "honey_balance() 已移除旧 FILTER 双扣" \
  "$(Q "SELECT strpos(pg_get_functiondef('public.honey_balance()'::regprocedure), 'FILTER') > 0;")" "f"
c "honey_balance() 忽略 expire 冲正流水" \
  "$(Q "SELECT strpos(pg_get_functiondef('public.honey_balance()'::regprocedure), 'reason <> ''expire''') > 0;")" "t"
c "honey_balance() 按到期升序分摊" \
  "$(Q "SELECT strpos(pg_get_functiondef('public.honey_balance()'::regprocedure), 'v_best_exp') > 0;")" "t"
c "schema_migrations 登记 0054" \
  "$(Q "SELECT count(*)::int FROM public.schema_migrations WHERE version='0054' AND status='applied';")" "1"

echo "【生产实测（二次确认稳定）】"
OWNER=$(Q "SELECT owner_id FROM public.app_users WHERE ident_masked='186****4399' LIMIT 1;")
BAL=$(PSQL_SU "SET request.jwt.claim.sub='$OWNER'; SELECT honey_balance();" 2>/dev/null | grep -E 'balance' | head -1)
echo "  honey_balance() = $BAL"
c "余额 balance = 34" "$(printf '%s' "$BAL" | grep -cE '"balance"[[:space:]]*:[[:space:]]*34' || true)" "1"
c "累计获得 earned = 184" "$(printf '%s' "$BAL" | grep -cE '"total_earned"[[:space:]]*:[[:space:]]*184' || true)" "1"
c "累计消耗 spent = 100" "$(printf '%s' "$BAL" | grep -cE '"total_spent"[[:space:]]*:[[:space:]]*100' || true)" "1"

echo "【4 个受影响账户的 expire 冲正分布（供追溯，余额 FEFO 已重算）】"
SUDO -u postgres psql -d dbee -tA -c "
  SELECT left(l.owner_id,6)||'... | expire笔数='||count(*) FILTER (WHERE l.reason='expire')::text
  FROM public.honey_ledger l
  WHERE l.reason='expire'
  GROUP BY l.owner_id ORDER BY l.owner_id;
" 2>/dev/null | sed 's/^/  /'

echo "【服务健康】"
c "四服务 active" "$(systemctl is-active dbee-gateway postgrest nginx postgresql 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "active active active active"
c "healthz ok" "$(curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>/dev/null | grep -cE '"ok"[[:space:]]*:[[:space:]]*true' || true)" "1"

echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then echo "0054 只读复验全部通过（FAIL=0）"; else echo "0054 复验有 $FAIL 项失败"; fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
