#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-points-186.sh · 积分"双扣"缺陷【只读】取证探针
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 调用（sudo 密码占位符由执行器注入，本文件不写出）
# ⚠️ 全程只读：仅 SELECT，绝不 INSERT/UPDATE/DELETE，绝不碰网关/nginx。
#
# 目标：按脱敏掩码 186****4399 定位账户，对拍：
#   · 当前 honey_balance() 口径 = GREATEST(0, SUM(amount) FILTER (amount<0 OR expires_at IS NULL OR expires_at>now()))
#   · 朴素 SUM 口径            = SUM(amount) 全量（物理冲正已平衡掉过期正流水）
# 若两者不等 → 双扣缺陷在该账户真实发生（过期正流水被 FILTER 排除，
# 但其 reason='expire' 冲正负流水被纳入，变成净负债吃掉新积分）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA "$@"; }
Q() { PSQL_SU -c "$1" 2>/dev/null; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 积分双扣缺陷只读取证  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

echo "── 前置：honey_balance() 是否已应用 ──"
echo "  honey_balance() 存在 = $(Q "SELECT (to_regprocedure('public.honey_balance()') IS NOT NULL)::int;")"
echo "  app_users 表存在     = $(Q "SELECT (to_regclass('public.app_users') IS NOT NULL)::int;")"

echo "── 1) 定位手机号账户（掩码 186****4399）──"
OWNERS=$(Q "SELECT owner_id FROM public.app_users WHERE ident_masked='186****4399' ORDER BY owner_id;")
NOWN=$(echo "$OWNERS" | grep -c .)
echo "  匹配 owner 数: $NOWN"

if [ "$NOWN" = "0" ]; then
  echo "  ✗ 未找到该掩码账户。兜底：列出所有 phone 类型账户的掩码分布（脱敏）"
  Q "SELECT ident_masked, count(*) FROM public.app_users WHERE ident_kind='phone' GROUP BY ident_masked ORDER BY ident_masked;" | sed 's/^/    /' | head -30
else
  for uid in $OWNERS; do
    echo ""
    echo "───────────────────────────────────────────────────────────────"
    echo " owner=${uid:0:6}…（len=${#uid}）"
    echo "───────────────────────────────────────────────────────────────"
    echo " [流水明细] id | 金额 | reason | ref_id | 过期时间(北京) | 发生时间(北京)"
    Q "SELECT id||' | '||amount||' | '||reason||' | '||coalesce(ref_id,'-')||' | '||coalesce(to_char(expires_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24'),'-')||' | '||to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI') FROM public.honey_ledger WHERE owner_id='$uid' ORDER BY id;" | sed 's/^/   /'

    echo " [口径对拍] 当前FILTER余额 vs 朴素SUM余额"
    Q "SELECT '当前口径(FILTER) balance='||GREATEST(0,COALESCE(SUM(amount) FILTER (WHERE amount<0 OR expires_at IS NULL OR expires_at>now()),0))||' | 朴素SUM balance='||COALESCE(SUM(amount),0)||' | 累计获得='||COALESCE(SUM(amount) FILTER (WHERE amount>=0),0)||' | 累计消耗='||COALESCE(SUM(-amount) FILTER (WHERE amount<0),0)||' | 流水数='||count(*) FROM public.honey_ledger WHERE owner_id='$uid';" | sed 's/^/   /'

    echo " [双扣特征] 已过期正流水数 / 对应 expire 冲正负数 / 冲正之后的新正流水"
    Q "SELECT '过期未排除正流水='||count(*) FILTER (WHERE amount>0 AND expires_at IS NOT NULL AND expires_at<=now())||' | expire冲正流水='||count(*) FILTER (WHERE reason='expire')||' | 冲正总额='||COALESCE(SUM(amount) FILTER (WHERE reason='expire'),0) FROM public.honey_ledger WHERE owner_id='$uid';" | sed 's/^/   /'
  done
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " 取证完成（全程只读，未对库做任何写入）"
echo "═══════════════════════════════════════════════════════════════════"
