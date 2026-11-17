#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-honey-impact.sh · 积分过期冲正影响面【只读】统计
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件不写出）。
# ⚠️ 全程只读：仅 SELECT。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA "$@"; }
Q() { PSQL_SU -c "$1" 2>/dev/null; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 积分过期冲正影响面  $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════════════════════════════"
echo " honey_ledger 总行数   = $(Q "SELECT count(*) FROM public.honey_ledger;")"
echo " expire 冲正流水数     = $(Q "SELECT count(*) FROM public.honey_ledger WHERE reason='expire';")"
echo " 涉及 owner 数         = $(Q "SELECT count(DISTINCT owner_id) FROM public.honey_ledger WHERE reason='expire';")"
echo " expire 冲正总金额     = $(Q "SELECT coalesce(sum(amount),0) FROM public.honey_ledger WHERE reason='expire';")"
echo ""
echo "── 受影响 owner 的冲正金额分布（前 20，owner 脱敏）──"
Q "SELECT left(owner_id,6)||'…('||length(owner_id)||')' AS o, count(*) AS cnt, sum(amount) AS amt FROM public.honey_ledger WHERE reason='expire' GROUP BY owner_id ORDER BY amt ASC LIMIT 20;" | sed 's/^/   /'

echo ""
echo "── 判定「整笔冲正疑似多扣」：expire 金额绝对值 > 该 owner 未过期正流水合计 ──"
echo "   （若冲正额 > 仍在手的未过期积分，说明该笔已被部分消费却按整笔冲正）"
Q "WITH e AS (SELECT owner_id, sum(-amount) AS exp_amt FROM public.honey_ledger WHERE reason='expire' GROUP BY owner_id),
     a AS (SELECT owner_id, sum(amount) AS active FROM public.honey_ledger WHERE amount>0 AND (expires_at IS NULL OR expires_at>now()) GROUP BY owner_id)
 SELECT count(*) FROM e LEFT JOIN a ON a.owner_id=e.owner_id WHERE e.exp_amt > coalesce(a.active,0);" | sed 's/^/   疑似多扣 owner 数 = /'

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " 统计完成（全程只读）"
echo "═══════════════════════════════════════════════════════════════════"
