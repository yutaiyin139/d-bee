#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-verify-fefo-readonly.sh · 0054 FEFO SQL 口径【只读】验证
# 由部署执行器 run 调用（sudo 密码占位符由执行器注入，本文件不写出）。
# ⚠️ 全程只读：不 CREATE FUNCTION、不写任何表。把 0054 的 FEFO 算法
#    内联成一段 plpgsql DO（用 RAISE NOTICE 输出），对真实账户验证得数，
#    确认与 shared computeHoneyBalance() 的 34 一致，再决定是否部署。
# 注：SQL 用单条 -c 参数传入（不走 stdin heredoc），避免与 sudo 密码管道冲突。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

SQL=$(cat <<'SQLBLOCK'
DO $DO$
DECLARE
  v_uid text;
  r record;
  v_exp timestamptz[];
  v_rem numeric[];
  v_to_consume numeric := 0;
  v_earned numeric := 0;
  v_spent numeric := 0;
  v_bal numeric := 0;
  v_i int; v_j int; v_best int; v_best_exp timestamptz; v_cur timestamptz;
  v_te timestamptz; v_tr numeric; v_used numeric;
BEGIN
  SELECT owner_id INTO v_uid FROM public.app_users WHERE ident_masked='186****4399' LIMIT 1;
  RAISE NOTICE 'owner=%', left(v_uid,6)||'...';

  FOR r IN SELECT amount, reason, expires_at FROM public.honey_ledger WHERE owner_id=v_uid ORDER BY id LOOP
    IF r.amount > 0 THEN
      v_earned := v_earned + r.amount;
      v_exp := array_append(v_exp, r.expires_at);
      v_rem := array_append(v_rem, r.amount::numeric);
    ELSIF r.amount < 0 AND r.reason <> 'expire' THEN
      v_spent := v_spent + (-r.amount);
    END IF;
  END LOOP;
  v_to_consume := v_spent;

  FOR v_i IN 1..coalesce(array_length(v_rem,1),0) LOOP
    v_best := v_i; v_best_exp := v_exp[v_i];
    FOR v_j IN v_i+1..coalesce(array_length(v_rem,1),0) LOOP
      v_cur := v_exp[v_j];
      IF v_best_exp IS NULL THEN
        IF v_cur IS NOT NULL THEN v_best := v_j; v_best_exp := v_cur; END IF;
      ELSIF v_cur IS NOT NULL AND v_cur < v_best_exp THEN
        v_best := v_j; v_best_exp := v_cur;
      END IF;
    END LOOP;
    IF v_best <> v_i THEN
      v_te := v_exp[v_i]; v_exp[v_i] := v_exp[v_best]; v_exp[v_best] := v_te;
      v_tr := v_rem[v_i]; v_rem[v_i] := v_rem[v_best]; v_rem[v_best] := v_tr;
    END IF;
  END LOOP;

  FOR v_i IN 1..coalesce(array_length(v_rem,1),0) LOOP
    EXIT WHEN v_to_consume <= 0;
    v_used := LEAST(v_rem[v_i], v_to_consume);
    v_rem[v_i] := v_rem[v_i] - v_used;
    v_to_consume := v_to_consume - v_used;
  END LOOP;

  FOR v_i IN 1..coalesce(array_length(v_rem,1),0) LOOP
    IF v_exp[v_i] IS NULL OR v_exp[v_i] > now() THEN v_bal := v_bal + v_rem[v_i]; END IF;
  END LOOP;

  RAISE NOTICE 'FEFO balance=% (期望 34) / earned=% / spent=% (期望 100)',
    greatest(0,v_bal)::int, v_earned::int, v_spent::int;
END
$DO$;
SQLBLOCK
)

echo "═══════════════════════════════════════════════════════════════════"
echo " FEFO SQL 口径只读验证  $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════════════════════════════"
PSQL_SU "$SQL" 2>&1 | sed 's/^/  /'
echo "═══════════════════════════════════════════════════════════════════"
echo " 验证完成（全程只读，未 CREATE、未写表、未部署 0054）"
echo "═══════════════════════════════════════════════════════════════════"
