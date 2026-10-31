CREATE OR REPLACE FUNCTION public.grant_honey(
  p_reason text,
  p_ref_id text,
  p_amount integer,
  p_ttl_days integer DEFAULT 365
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid     text := auth.uid();
  v_today   date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_ref_date date;
  v_expect  integer;
  v_target  numeric;
  v_total   numeric;
  v_n       integer;
  v_streak  integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN RETURN false; END IF;

  IF p_reason = 'newbie' THEN
    -- 固定业务键 + 固定金额；事实 = 已完善身体数据（身高体重均已填）
    IF p_ref_id <> 'newbie' OR p_amount <> 150 THEN RETURN false; END IF;
    PERFORM 1 FROM profiles
      WHERE owner_id = v_uid AND height_cm IS NOT NULL AND current_weight_kg IS NOT NULL;
    IF NOT FOUND THEN RETURN false; END IF;

  ELSIF p_reason IN ('checkin_meal', 'checkin_water', 'checkin_exercise') THEN
    -- 金额固定（5/2/2，与 packages/shared 的 CHECKIN_* 同源）
    v_expect := CASE p_reason WHEN 'checkin_meal' THEN 5 ELSE 2 END;
    IF p_amount <> v_expect THEN RETURN false; END IF;
    -- ref_id 必须是日期，且只允许 今天/昨天（前端只在「今天」结算，昨天为跨零点容差）
    BEGIN
      v_ref_date := p_ref_id::date;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    IF v_ref_date > v_today OR v_ref_date < v_today - 1 THEN RETURN false; END IF;
    -- 库内事实验证（与 refund_checkin_*_by_date 的口径完全一致）
    IF p_reason = 'checkin_meal' THEN
      PERFORM 1 FROM meal_entries WHERE owner_id = v_uid AND log_date = v_ref_date LIMIT 1;
      IF NOT FOUND THEN RETURN false; END IF;
    ELSIF p_reason = 'checkin_water' THEN
      SELECT COALESCE(SUM(amount_ml), 0) INTO v_total
        FROM water_logs WHERE owner_id = v_uid AND log_date = v_ref_date;
      SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_target
        FROM profiles WHERE owner_id = v_uid;
      v_target := COALESCE(v_target, 2100);
      IF v_total < v_target THEN RETURN false; END IF;
    ELSE  -- checkin_exercise
      PERFORM 1 FROM exercise_logs WHERE owner_id = v_uid AND log_date = v_ref_date LIMIT 1;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;

  ELSIF p_reason = 'streak_milestone' THEN
    -- ref_id 格式 '<N>d-<YYYY-MM-DD>'（与前端 Dashboard.tsx 拼法一致）
    IF p_ref_id !~ '^[0-9]+d-[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
    BEGIN
      v_n := split_part(p_ref_id, 'd-', 1)::integer;
      v_ref_date := split_part(p_ref_id, 'd-', 2)::date;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    -- 只允许「今天」结算（前端也仅在 activeToday 时调用）
    IF v_ref_date <> v_today THEN RETURN false; END IF;
    -- 金额必须等于里程碑表值（与 src/lib/invite.ts STREAK_HONEY 同源）
    v_expect := CASE v_n WHEN 3 THEN 15 WHEN 7 THEN 40 WHEN 14 THEN 80
                         WHEN 21 THEN 120 WHEN 30 THEN 200 WHEN 60 THEN 400
                         WHEN 100 THEN 800 ELSE 0 END;
    IF v_expect = 0 OR p_amount <> v_expect THEN RETURN false; END IF;
    -- 事实：库内实算的当前连续打卡天数 == N（_lb_compute_streak 与 leaderboard 共用）
    SELECT public._lb_compute_streak(
             (SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text)
                FROM meal_entries WHERE owner_id = v_uid),
             v_today)
      INTO v_streak;
    IF COALESCE(v_streak, 0) <> v_n THEN RETURN false; END IF;

  ELSE
    RETURN false;  -- 未知 reason 一律拒绝
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, p_amount, p_reason, p_ref_id,
          now() + make_interval(days => LEAST(GREATEST(COALESCE(p_ttl_days, 365), 1), 365)))
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$fn$;
