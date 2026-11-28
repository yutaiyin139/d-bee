-- ═══════════════════════════════════════════════════════════════════════
-- 0059 · 积分扣减按发生时间摊销，过期剩余不再吸收之后的兑换
--
-- 背景：0058 让 redeem_honey 改读 honey_balance()。0054 的余额把全部真实
-- 消费一次性摊到最早到期的批次上，不看扣减发生时该批次是否已经过期。
-- 于是一笔新兑换会被记到「已经过期、页面上本来就不算」的剩余里，
-- 兑换成功，页面余额却不下降。
--
-- 修法：按 created_at 重放流水。每笔负向扣减只打在「扣减当时尚未过期」
-- 的批次上，仍是先到期先扣。reason='expire' 继续忽略。
-- 兑换函数不改，它已经读 honey_balance()。
-- 不改任何流水。幂等：CREATE OR REPLACE + 追踪表 UPSERT。
--
-- 执行：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 \
--   -f db/migrations/0059-honey-balance-spend-time.sql
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.honey_balance()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  r record;
  v_lots_expires timestamptz[] := ARRAY[]::timestamptz[];
  v_lots_remain  numeric[]     := ARRAY[]::numeric[];
  v_total_earned numeric := 0;
  v_total_spent  numeric := 0;
  v_balance      numeric := 0;
  v_debt         numeric := 0;
  v_left         numeric;
  v_spend_at     timestamptz;
  v_best         integer;
  v_i            integer;
  v_used         numeric;
  v_remain       numeric;
  v_born_expired boolean;
  v_now          timestamptz := now();
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('balance', 0, 'total_earned', 0, 'total_spent', 0);
  END IF;

  FOR r IN
    SELECT amount, reason, expires_at, created_at
    FROM honey_ledger
    WHERE owner_id = v_uid
    ORDER BY created_at NULLS FIRST, id
  LOOP
    IF r.amount > 0 THEN
      v_total_earned := v_total_earned + r.amount;
      v_remain := r.amount::numeric;
      v_born_expired := r.expires_at IS NOT NULL
        AND r.expires_at <= COALESCE(r.created_at, '-infinity'::timestamptz);
      IF v_debt > 0 AND NOT v_born_expired THEN
        v_used := LEAST(v_remain, v_debt);
        v_remain := v_remain - v_used;
        v_debt := v_debt - v_used;
      END IF;
      v_lots_expires := array_append(v_lots_expires, r.expires_at);
      v_lots_remain  := array_append(v_lots_remain, v_remain);
    ELSIF r.amount < 0 AND r.reason <> 'expire' THEN
      v_total_spent := v_total_spent + (-r.amount);
      v_left := (-r.amount)::numeric;
      v_spend_at := COALESCE(r.created_at, '-infinity'::timestamptz);
      WHILE v_left > 0 LOOP
        v_best := 0;
        FOR v_i IN 1..coalesce(array_length(v_lots_remain, 1), 0) LOOP
          IF v_lots_remain[v_i] <= 0 THEN
            CONTINUE;
          END IF;
          IF v_lots_expires[v_i] IS NOT NULL AND v_lots_expires[v_i] <= v_spend_at THEN
            CONTINUE;
          END IF;
          IF v_best = 0 THEN
            v_best := v_i;
          ELSIF v_lots_expires[v_best] IS NULL THEN
            IF v_lots_expires[v_i] IS NOT NULL THEN
              v_best := v_i;
            END IF;
          ELSIF v_lots_expires[v_i] IS NOT NULL AND v_lots_expires[v_i] < v_lots_expires[v_best] THEN
            v_best := v_i;
          END IF;
        END LOOP;
        EXIT WHEN v_best = 0;
        v_used := LEAST(v_lots_remain[v_best], v_left);
        v_lots_remain[v_best] := v_lots_remain[v_best] - v_used;
        v_left := v_left - v_used;
      END LOOP;
      v_debt := v_debt + v_left;
    END IF;
  END LOOP;

  FOR v_i IN 1..coalesce(array_length(v_lots_remain, 1), 0) LOOP
    IF v_lots_expires[v_i] IS NULL OR v_lots_expires[v_i] > v_now THEN
      v_balance := v_balance + v_lots_remain[v_i];
    END IF;
  END LOOP;

  RETURN json_build_object(
    'balance', GREATEST(0, v_balance)::integer,
    'total_earned', v_total_earned::integer,
    'total_spent', v_total_spent::integer
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.honey_balance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.honey_balance() TO authenticated;

COMMENT ON FUNCTION public.honey_balance() IS
  '0059 · 按扣减发生时间先到期先扣。已过期剩余不再吸收之后的兑换。';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0059: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0059', 'honey-balance-spend-time', 'applied', 'self',
          'honey_balance 按 created_at 摊销扣减，过期剩余不再吸收之后的兑换')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
