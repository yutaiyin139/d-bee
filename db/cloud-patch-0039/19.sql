CREATE OR REPLACE FUNCTION public.settle_invite_checkin()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_inviter text;
  v_bind_date date;
  v_logged_days integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_month_honey integer;
  v_first boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  -- 🔴 用户级事务锁：并发调用串行化（锁粒度小，事务短）
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:settle_invite:' || v_uid, 0));

  SELECT invited_by, COALESCE(invited_at::date, created_at::date)
    INTO v_inviter, v_bind_date FROM profiles WHERE owner_id = v_uid;
  IF v_inviter IS NULL THEN RETURN false; END IF;

  -- 事实：受邀后 7 个自然日内累计 ≥5 天有饮食记录
  SELECT count(DISTINCT log_date) INTO v_logged_days FROM meal_entries
   WHERE owner_id = v_uid AND log_date >= v_bind_date AND log_date <= v_bind_date + interval '6 days';
  IF v_logged_days < 5 THEN RETURN false; END IF;

  -- 月度返佣上限（邀请人侧，0013/0017 口径）
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey FROM honey_ledger
   WHERE owner_id = v_inviter AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 250 > 3000 THEN RETURN false; END IF;

  -- 🔴 首次插入成功 = 唯一放行凭据。UNIQUE(owner_id, reason, ref_id) 部分索引兜底；
  --   非首次直接幂等返回 true，**不再执行 Pro 顺延**。
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 200, 'invitee_checkin', 'settle-' || v_inviter, now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING
  RETURNING true INTO v_first;
  IF NOT COALESCE(v_first, false) THEN RETURN true; END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 250, 'inviter_checkin', 'settle-' || v_uid, now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  -- 新人 Pro 7 天（仅首次结算）
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan IS DISTINCT FROM 'lifetime' THEN
    IF v_ent IS NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_uid, 'pro', now() + make_interval(days => 7), 'invite');
    ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
      UPDATE entitlements SET pro_until = v_until + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    ELSE
      UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    END IF;
  END IF;
  RETURN true;
END;
$fn$;
