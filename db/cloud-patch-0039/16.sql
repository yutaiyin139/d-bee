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
  -- 🔴 用户级事务锁：并发双击/双设备同时兑换时串行化，
  --   否则「先查余额后扣分」存在竞态，可双花。
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:redeem_honey:' || v_uid, 0));

  IF p_kind = 'pro1Day' THEN v_cost := 100; v_days := 1;
  ELSIF p_kind = 'pro30Day' THEN v_cost := 2600; v_days := 30;
  ELSIF p_kind = 'ai1Scan' THEN v_cost := 50; v_days := 0;
  ELSE RETURN false; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_balance FROM honey_ledger
   WHERE owner_id = v_uid AND (expires_at IS NULL OR expires_at > now());
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
