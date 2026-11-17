#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-scan-expire-accounts.sh · 只读扫描所有含 expire 冲正的账户账本
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件注释不写出）。
# 输出：每个受影响账户一行 JSON {owner_mask, n, ledger:[{id,amount,reason,ref_id,expires_at,created_at}]}
#       owner_id 脱敏（前6位+len）；订正按 ref_id 精确定位，不需 owner 明文。
# 全程只读：不写任何表、不调用函数、不部署。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

SQL=$(cat <<'SQLBLOCK'
WITH affected AS (
  SELECT DISTINCT owner_id FROM public.honey_ledger WHERE reason='expire'
)
SELECT json_build_object(
  'owner_mask', left(a.owner_id,6) || '...(' || length(a.owner_id) || ')',
  'n', (SELECT count(*)::int FROM public.honey_ledger l WHERE l.owner_id=a.owner_id),
  'ledger', (SELECT json_agg(json_build_object(
      'id', l.id, 'amount', l.amount, 'reason', l.reason,
      'ref_id', l.ref_id,
      'expires_at', to_char(l.expires_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI'),
      'created_at', to_char(l.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI')
    ) ORDER BY l.id) FROM public.honey_ledger l WHERE l.owner_id=a.owner_id)
)::text
FROM affected a ORDER BY a.owner_id;
SQLBLOCK
)

echo "═══════════════════════════════════════════════════════════════════"
echo " expire 账户账本只读扫描  $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════════════════════════════"
echo "受影响账户数: $(PSQL_SU "SELECT count(DISTINCT owner_id)::int FROM public.honey_ledger WHERE reason='expire';")"
echo "expire 流水总数: $(PSQL_SU "SELECT count(*)::int FROM public.honey_ledger WHERE reason='expire';")"
echo "──── LEDGER_JSON_BEGIN ────"
PSQL_SU "$SQL"
echo "──── LEDGER_JSON_END ────"
echo "═══════════════════════════════════════════════════════════════════"
