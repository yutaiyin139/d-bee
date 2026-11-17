#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-verify-backfill-target.sh · 补分目标行【只读】精确核验
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件注释不写出）。
# 确认 exp:283 冲正行的 owner 完整 id、当前金额、该账户朴素SUM与FEFO余额。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

echo "【expire 冲正行定位（按 ref_id，全局唯一）】"
PSQL_SU "SELECT 'id='||id||' owner='||owner_id||' amount='||amount||' reason='||reason||' ref='||ref_id FROM public.honey_ledger WHERE ref_id='exp:283';" 2>&1 | sed 's/^/  /'

echo "【四条 expire 行的 owner + 金额（确认只有 exp:283 需订正）】"
PSQL_SU "SELECT ref_id||' owner='||owner_id||' amount='||amount FROM public.honey_ledger WHERE reason='expire' ORDER BY id;" 2>&1 | sed 's/^/  /'

echo "【179325 账户当前余额】"
PSQL_SU "SET request.jwt.claim.sub='1793253465481363901'; SELECT honey_balance();" 2>&1 | grep -E 'balance' | sed 's/^/  /'
