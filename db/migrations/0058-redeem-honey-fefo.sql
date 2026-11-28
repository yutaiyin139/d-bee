-- ═══════════════════════════════════════════════════════════════════════
-- 0058 · 兑换扣减改用 honey_balance() 的先到期先扣余额
--
-- 背景：0054 把页面余额改成 FEFO。redeem_honey 仍用
--   SUM(amount) WHERE expires_at IS NULL OR expires_at > now()
-- 已过期批次上花掉的分会从这笔求和里再减一次，页面有余额时兑换返回 false。
--
-- 修法：加锁之后用 honey_balance() 的 balance 判断够不够。
-- 价格、每日 2 次拍照兑换、终身会员不加天数，都保持 0039 的原样。
-- 不改任何流水。幂等：CREATE OR REPLACE + 追踪表 UPSERT。
--
-- 执行：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 \
--   -f db/migrations/0058-redeem-honey-fefo.sql
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.redeem_honey(p_kind text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cost integer;
  v_days integer;
  v_uid text := auth.uid();
  v_balance integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_today text;
  v_ai_today integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  -- 用户级事务锁：并发双击时串行化，避免先查余额后扣分的双花。
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:redeem_honey:' || v_uid, 0));

  IF p_kind = 'pro1Day' THEN v_cost := 100; v_days := 1;
  ELSIF p_kind = 'pro30Day' THEN v_cost := 2600; v_days := 30;
  ELSIF p_kind = 'ai1Scan' THEN v_cost := 50; v_days := 0;
  ELSE RETURN false; END IF;

  -- 与页面同一口径。0054 的 honey_balance() 按先到期先扣重算，忽略过期冲正。
  SELECT COALESCE((public.honey_balance()->>'balance')::integer, 0) INTO v_balance;
  IF v_balance < v_cost THEN RETURN false; END IF;

  IF p_kind = 'ai1Scan' THEN
    v_today := to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD');
    SELECT count(*) INTO v_ai_today FROM honey_ledger
     WHERE owner_id = v_uid AND reason = 'redeem' AND ref_id LIKE 'ai-' || v_today || '%' AND amount < 0;
    IF v_ai_today >= 2 THEN RETURN false; END IF;
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_uid, -v_cost, 'redeem', 'ai-' || v_today || '-' || to_char(clock_timestamp(), 'HH24MISSMS'), NULL);
    INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
    VALUES (v_uid, 'honey', 'redeem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 1, 0,
            now() + make_interval(days => 7));
    RETURN true;
  END IF;

  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan = 'lifetime' THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, -v_cost, 'redeem', NULL, NULL);
  IF v_ent IS NULL THEN
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_uid, 'pro', now() + make_interval(days => v_days), 'honey');
  ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
    UPDATE entitlements SET pro_until = v_until + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  ELSE
    UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.redeem_honey(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_honey(text) TO authenticated;

COMMENT ON FUNCTION public.redeem_honey(text) IS
  '0058 · 扣减前用 honey_balance() 的先到期先扣余额。价格与每日 2 次拍照兑换不变。';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0058: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0058', 'redeem-honey-fefo', 'applied', 'self',
          'redeem_honey 改用 honey_balance() 判断余额，与页面先到期先扣一致')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
