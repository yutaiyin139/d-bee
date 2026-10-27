-- 业务函数完整 DDL（云库 pg_get_functiondef 实时导出，2026-10-20 21:00）
-- 全部 SECURITY DEFINER + SET search_path TO 'public'（权益/积分/额度核心逻辑）

CREATE OR REPLACE FUNCTION public._lb_compute_streak(p_days text[], p_today date)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_cursor date;
  v_n      integer := 0;
BEGIN
  IF p_days IS NULL OR array_length(p_days, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF p_today::text = ANY(p_days) THEN
    v_cursor := p_today;
  ELSE
    v_cursor := p_today - 1;
  END IF;
  LOOP
    EXIT WHEN NOT (v_cursor::text = ANY(p_days));
    v_n := v_n + 1;
    v_cursor := v_cursor - 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public._lb_mask_name(nickname text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN nickname IS NULL OR btrim(nickname) = '' THEN '蜂友*'
    ELSE left(btrim(nickname), 1) || '*'
  END
$function$;

CREATE OR REPLACE FUNCTION public.badge_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_photo int;
  v_barcode int;
  v_recipe int;
  v_water int;
  v_exercise int;
  v_lost numeric;
  v_invitees int;
  v_settled int;
  v_water_target numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;
  SELECT COUNT(*) FILTER (WHERE source = 'photo'), COUNT(*) FILTER (WHERE source = 'barcode')
  INTO v_photo, v_barcode FROM meal_entries WHERE owner_id = v_uid;
  SELECT COUNT(*) INTO v_recipe FROM recipes WHERE owner_id = v_uid;
  SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_water_target FROM profiles WHERE owner_id = v_uid;
  v_water_target := COALESCE(v_water_target, 2100);
  SELECT COUNT(*) INTO v_water FROM (
    SELECT log_date FROM water_logs WHERE owner_id = v_uid GROUP BY log_date HAVING SUM(amount_ml) >= v_water_target
  ) t;
  SELECT COUNT(*) INTO v_exercise FROM exercise_logs WHERE owner_id = v_uid;
  IF (SELECT goal FROM profiles WHERE owner_id = v_uid) = 'lose' THEN
    SELECT COALESCE(
      (SELECT start_weight_kg FROM profiles WHERE owner_id = v_uid), 0
    ) - COALESCE(
      (SELECT weight_kg FROM weight_logs WHERE owner_id = v_uid ORDER BY log_date DESC, id DESC LIMIT 1),
      (SELECT current_weight_kg FROM profiles WHERE owner_id = v_uid), 0
    ) INTO v_lost;
  ELSE
    v_lost := 0;
  END IF;
  SELECT COUNT(*) INTO v_invitees FROM profiles WHERE invited_by = v_uid;
  SELECT COUNT(*) INTO v_settled FROM honey_ledger WHERE owner_id = v_uid AND reason = 'inviter_checkin' AND amount > 0;
  RETURN json_build_object(
    'photo_count', COALESCE(v_photo, 0), 'barcode_count', COALESCE(v_barcode, 0),
    'recipe_count', COALESCE(v_recipe, 0), 'water_days', COALESCE(v_water, 0),
    'exercise_count', COALESCE(v_exercise, 0), 'weight_lost', COALESCE(v_lost, 0),
    'invitees', COALESCE(v_invitees, 0), 'invite_settled', COALESCE(v_settled, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bind_invite(p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          text := auth.uid();
  v_inviter      text;
  v_already      text;
  v_norm         text;
  v_month_honey  integer;
  v_profile_row  public.profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN 'invalid'; END IF;
  IF (SELECT public.invite_throttled(v_uid)) THEN RETURN 'throttled'; END IF;
  v_norm := upper(trim(coalesce(p_code, '')));
  IF v_norm = '' THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, '', false);
    RETURN 'invalid';
  END IF;
  SELECT invited_by INTO v_already FROM profiles WHERE owner_id = v_uid;
  IF v_already IS NOT NULL THEN RETURN 'already'; END IF;
  SELECT owner_id INTO v_inviter FROM invite_links WHERE code = v_norm LIMIT 1;
  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN CASE WHEN v_inviter = v_uid THEN 'self' ELSE 'invalid' END;
  END IF;
  INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, true);
  SELECT * INTO v_profile_row FROM public.profiles WHERE owner_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO public.profiles (owner_id, invited_by, invite_code, invited_at)
    VALUES (v_uid, v_inviter, v_norm, now());
  ELSE
    UPDATE public.profiles SET invited_by = v_inviter, invite_code = v_norm, invited_at = now(), updated_at = now()
    WHERE owner_id = v_uid;
  END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 100, 'invitee_register', 'bind-' || v_inviter, now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey FROM honey_ledger
   WHERE owner_id = v_inviter AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 50 <= 3000 THEN
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_inviter, 50, 'inviter_register', 'invitee-' || v_uid, now() + make_interval(days => 365))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_usage_date date, p_feature text, p_limit integer, p_amount integer DEFAULT 1)
 RETURNS TABLE(allowed boolean, used integer, remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
  v_inserted boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT false, 0, 0; RETURN; END IF;
  IF v_date IS NULL THEN v_date := v_today; ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;
  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, p_feature, GREATEST(p_amount, 1))
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING RETURNING true INTO v_inserted;
  IF v_inserted THEN RETURN QUERY SELECT true, GREATEST(p_amount, 1), GREATEST(p_limit - GREATEST(p_amount, 1), 0); RETURN; END IF;
  UPDATE ai_usage SET count = ai_usage.count + GREATEST(p_amount, 1)
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date AND ai_usage.feature = p_feature
     AND ai_usage.count + GREATEST(p_amount, 1) <= p_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = p_feature;
    RETURN QUERY SELECT false, COALESCE(v_count, p_limit), 0; RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, GREATEST(p_limit - v_count, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_photo_quota(p_usage_date date, p_base_limit integer DEFAULT 3)
 RETURNS TABLE(allowed boolean, used integer, remaining integer, token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_bonus_id bigint;
  v_base_used integer;
  v_token text;
  v_inserted boolean;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT false, 0, 0, NULL::text; RETURN; END IF;
  IF v_date IS NULL THEN v_date := v_today; ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;
  SELECT id INTO v_bonus_id FROM quota_bonus WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now() ORDER BY expires_at ASC LIMIT 1 FOR UPDATE;
  IF v_bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = consumed + 1 WHERE id = v_bonus_id;
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount) VALUES (auth.uid(), v_token, 'scan', v_date, v_bonus_id, 1);
    SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage WHERE owner_id = auth.uid() AND usage_date = v_date AND feature = 'scan';
    RETURN QUERY SELECT true, v_base_used, GREATEST(p_base_limit - v_base_used, 0), v_token; RETURN;
  END IF;
  INSERT INTO ai_usage (owner_id, usage_date, feature, count) VALUES (auth.uid(), v_date, 'scan', 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING RETURNING true INTO v_inserted;
  IF v_inserted THEN
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount) VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
    RETURN QUERY SELECT true, 1, GREATEST(p_base_limit - 1, 0), v_token; RETURN;
  END IF;
  UPDATE ai_usage SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date AND ai_usage.feature = 'scan'
     AND ai_usage.count + 1 <= p_base_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = 'scan';
    RETURN QUERY SELECT false, COALESCE(v_count, p_base_limit), 0, NULL::text; RETURN;
  END IF;
  v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
  INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount) VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
  RETURN QUERY SELECT true, v_count, GREATEST(p_base_limit - v_count, 0), v_token;
END;
$function$;

CREATE OR REPLACE FUNCTION public.count_invitees()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object('invitees', (SELECT count(*) FROM profiles WHERE invited_by = auth.uid()),
    'settled', (SELECT count(*) FROM honey_ledger hl WHERE hl.owner_id = auth.uid() AND hl.reason = 'inviter_checkin'))
$function$;

CREATE OR REPLACE FUNCTION public.create_payment_order(p_product_id text, p_provider text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_prod payment_products%ROWTYPE;
  v_order_no text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN json_build_object('error', 'not_authenticated'); END IF;
  SELECT * INTO v_prod FROM payment_products WHERE product_id = p_product_id AND active = true;
  IF NOT FOUND THEN RETURN json_build_object('error', 'invalid_product'); END IF;
  v_order_no := 'PO' || to_char(now(), 'YYYYMMDDHH24MISSMS') || floor(random() * 900 + 100)::text;
  INSERT INTO payment_orders (owner_id, order_no, provider, product_id, plan, months, amount_cents, currency)
  VALUES (v_uid, v_order_no, p_provider, p_product_id, v_prod.plan, v_prod.months, v_prod.amount_cents, v_prod.currency);
  RETURN json_build_object('order_no', v_order_no, 'product_id', p_product_id, 'plan', v_prod.plan,
    'months', v_prod.months, 'amount_cents', v_prod.amount_cents, 'currency', v_prod.currency);
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_honey()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_count integer := 0;
  r record;
BEGIN
  IF v_uid IS NULL THEN RETURN 0; END IF;
  FOR r IN
    SELECT id, amount FROM honey_ledger
    WHERE owner_id = v_uid AND amount > 0 AND expires_at IS NOT NULL AND expires_at <= now()
      AND NOT EXISTS (SELECT 1 FROM honey_ledger e WHERE e.owner_id = v_uid AND e.reason = 'expire' AND e.ref_id = 'exp:' || honey_ledger.id)
  LOOP
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -r.amount, 'expire', 'exp:' || r.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_inviter_by_code(p_code text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT owner_id FROM invite_links WHERE code = upper(trim(p_code)) LIMIT 1 $function$;

CREATE OR REPLACE FUNCTION public.get_photo_quota(p_base_limit integer DEFAULT 3)
 RETURNS TABLE(base_remaining integer, bonus_remaining integer, total_remaining integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_base_used integer;
  v_bonus integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT 0, 0, 0; RETURN; END IF;
  SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage WHERE owner_id = auth.uid() AND usage_date = v_today AND feature = 'scan';
  SELECT COALESCE(SUM(amount - consumed), 0) INTO v_bonus FROM quota_bonus WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now();
  base_remaining := GREATEST(p_base_limit - v_base_used, 0);
  bonus_remaining := GREATEST(v_bonus, 0);
  total_remaining := base_remaining + bonus_remaining;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_today_photo_count()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::integer FROM ai_quota_claims
   WHERE owner_id = auth.uid() AND usage_date = (now() AT TIME ZONE 'Asia/Shanghai')::date AND released_at IS NULL
$function$;

CREATE OR REPLACE FUNCTION public.grant_honey(p_reason text, p_ref_id text, p_amount integer, p_ttl_days integer DEFAULT 365)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      text := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_ref_date date;
  v_expect   integer;
  v_target   numeric;
  v_total    numeric;
  v_n        integer;
  v_streak   integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN RETURN false; END IF;

  -- 🔴 安全审计⑤（0039 库内事实验证版）：不信任客户端入参，逐 reason 验证库内事实。
  --  此前只校验「金额在白名单里」，任何登录用户可直接 RPC 领分自刷换 Pro。
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
$function$;

CREATE OR REPLACE FUNCTION public.grant_photo_bonus(p_source text, p_grant_key text, p_amount integer, p_ttl_days integer DEFAULT 7)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      text := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_key_date date;
  v_cnt      integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_grant_key IS NULL OR btrim(p_grant_key) = '' THEN RETURN false; END IF;

  -- 🔴 安全审计⑤（0039 P0-B）：只允许 streak7。
  --   · 'honey' 来源必须经 redeem_honey（扣积分后内部 INSERT quota_bonus），
  --     对客户端开放 = 凭空造识别额度。
  --   · 'newbie' 已被 0026 改为发 150 积分、0035 作废存量，不再对客户端开放。
  IF p_source IS DISTINCT FROM 'streak7' THEN RETURN false; END IF;
  IF p_amount <> 2 THEN RETURN false; END IF;
  IF COALESCE(p_ttl_days, 7) NOT BETWEEN 1 AND 7 THEN RETURN false; END IF;

  -- grant_key = 连续段第 7k 天的日期（前端 streak.ts streak7Date 的拼法）
  BEGIN
    v_key_date := p_grant_key::date;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_key_date > v_today OR v_key_date < v_today - 2 THEN RETURN false; END IF;

  -- 事实：以 v_key_date 结尾的最近 7 天每天都有饮食记录
  SELECT count(DISTINCT log_date) INTO v_cnt
    FROM meal_entries
   WHERE owner_id = v_uid AND log_date <= v_key_date AND log_date > v_key_date - 7;
  IF COALESCE(v_cnt, 0) < 7 THEN RETURN false; END IF;

  INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
  VALUES (v_uid, p_source, p_grant_key, p_amount, 0,
          now() + make_interval(days => COALESCE(p_ttl_days, 7)))
  ON CONFLICT (owner_id, source, grant_key) DO NOTHING;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.invite_throttled(p_owner text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fail integer;
BEGIN
  SELECT count(*) INTO v_fail FROM invite_attempts WHERE owner_id = p_owner AND ok = false AND created_at > now() - interval '60 seconds';
  RETURN v_fail >= 5;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leaderboard()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_my_streak integer := 0;
  v_my_invites integer := 0;
  v_disc_json json;
  v_inv_json json;
  v_streak_arr json[] := ARRAY[]::json[];
  v_inv_arr json[] := ARRAY[]::json[];
  v_s integer;
  r record;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN json_build_object('error', 'not_authenticated'); END IF;
  SELECT public._lb_compute_streak((SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text) FROM meal_entries WHERE owner_id = v_uid), v_today) INTO v_my_streak;
  SELECT count(*) INTO v_my_invites FROM profiles WHERE invited_by = v_uid AND invited_at >= v_month_start;
  FOR r IN
    SELECT m.owner_id AS uid, array_agg(DISTINCT m.log_date::text ORDER BY m.log_date::text) AS days, p.nickname AS nick
    FROM meal_entries m JOIN profiles p ON p.owner_id = m.owner_id GROUP BY m.owner_id, p.nickname
  LOOP
    v_s := public._lb_compute_streak(r.days, v_today);
    IF v_s >= 3 THEN
      v_streak_arr := v_streak_arr || json_build_object('name', public._lb_mask_name(r.nick), 'streak', v_s)::json;
    END IF;
  END LOOP;
  FOR r IN
    SELECT p.nickname AS nick, count(*) AS cnt FROM profiles p JOIN profiles invited ON invited.invited_by = p.owner_id
    WHERE invited.invited_at >= v_month_start GROUP BY p.owner_id, p.nickname
  LOOP
    v_inv_arr := v_inv_arr || json_build_object('name', public._lb_mask_name(r.nick), 'invites', r.cnt::int)::json;
  END LOOP;
  SELECT COALESCE(json_agg(e ORDER BY (e->>'streak')::int DESC), '[]'::json) INTO v_disc_json FROM unnest(v_streak_arr) AS e LIMIT 50;
  SELECT COALESCE(json_agg(e ORDER BY (e->>'invites')::int DESC), '[]'::json) INTO v_inv_json FROM unnest(v_inv_arr) AS e LIMIT 50;
  RETURN json_build_object('self_discipline', COALESCE(v_disc_json, '[]'::json), 'invite', COALESCE(v_inv_json, '[]'::json),
    'my', json_build_object('streak', v_my_streak, 'invites', v_my_invites));
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_by_code(p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_norm text;
  v_row redeem_codes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN 'bad'; END IF;
  v_norm := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  IF v_norm = '' THEN RETURN 'bad'; END IF;
  SELECT * INTO v_row FROM redeem_codes WHERE code = v_norm;
  IF NOT FOUND THEN RETURN 'bad'; END IF;
  IF v_row.used_by IS NOT NULL THEN RETURN 'used'; END IF;
  UPDATE redeem_codes SET used_by = v_uid, used_at = now() WHERE id = v_row.id AND used_by IS NULL;
  IF NOT FOUND THEN RETURN 'used'; END IF;
  INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
  VALUES (v_uid, 'lifetime', NULL, v_norm, 'redeem')
  ON CONFLICT (owner_id) DO UPDATE SET plan = 'lifetime', pro_until = NULL, redeemed_code = v_norm, source = 'redeem', updated_at = now();
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_honey(p_kind text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF p_kind = 'pro1Day' THEN v_cost := 100; v_days := 1;
  ELSIF p_kind = 'pro30Day' THEN v_cost := 2600; v_days := 30;
  ELSIF p_kind = 'ai1Scan' THEN v_cost := 50; v_days := 0;
  ELSE RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_balance FROM honey_ledger WHERE owner_id = v_uid AND (expires_at IS NULL OR expires_at > now());
  IF v_balance < v_cost THEN RETURN false; END IF;
  IF p_kind = 'ai1Scan' THEN
    v_today := to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD');
    SELECT count(*) INTO v_ai_today FROM honey_ledger WHERE owner_id = v_uid AND reason = 'redeem' AND ref_id LIKE 'ai-' || v_today || '%' AND amount < 0;
    IF v_ai_today >= 2 THEN RETURN false; END IF;
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_uid, -v_cost, 'redeem', 'ai-' || v_today || '-' || to_char(clock_timestamp(), 'HH24MISSMS'), NULL);
    INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
    VALUES (v_uid, 'honey', 'redeem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 1, 0, now() + make_interval(days => 7));
    RETURN true;
  END IF;
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan = 'lifetime' THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at) VALUES (v_uid, -v_cost, 'redeem', NULL, NULL);
  IF v_ent IS NULL THEN
    INSERT INTO entitlements (owner_id, plan, pro_until, source) VALUES (v_uid, 'pro', now() + make_interval(days => v_days), 'honey');
  ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
    UPDATE entitlements SET pro_until = v_until + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  ELSE
    UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_checkin_exercise_by_date(p_log_date text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid text := auth.uid(); v_count integer; v_granted integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN RETURN false; END IF;
  SELECT count(*) INTO v_count FROM exercise_logs WHERE owner_id = v_uid AND log_date = p_log_date;
  IF v_count > 0 THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_granted FROM honey_ledger WHERE owner_id = v_uid AND reason = 'checkin_exercise' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN RETURN false; END IF;
  PERFORM 1 FROM honey_ledger WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'exercise:' || p_log_date;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -v_granted, 'refund', 'exercise:' || p_log_date);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_checkin_honey_by_date(p_log_date text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_others integer;
  v_granted integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN RETURN false; END IF;
  SELECT count(*) INTO v_others FROM meal_entries WHERE owner_id = v_uid AND log_date = p_log_date;
  IF v_others > 0 THEN RETURN false; END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_granted FROM honey_ledger WHERE owner_id = v_uid AND reason = 'checkin_meal' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN RETURN false; END IF;
  PERFORM 1 FROM honey_ledger WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'meal:' || p_log_date;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -v_granted, 'refund', 'meal:' || p_log_date);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_checkin_water_by_date(p_log_date text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid text := auth.uid(); v_total integer; v_target numeric; v_granted integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount_ml), 0) INTO v_total FROM water_logs WHERE owner_id = v_uid AND log_date = p_log_date;
  SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_target FROM profiles WHERE owner_id = v_uid;
  v_target := COALESCE(v_target, 2100);
  IF v_total >= v_target THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_granted FROM honey_ledger WHERE owner_id = v_uid AND reason = 'checkin_water' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN RETURN false; END IF;
  PERFORM 1 FROM honey_ledger WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'water:' || p_log_date;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -v_granted, 'refund', 'water:' || p_log_date);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_ai_quota(p_usage_date date, p_feature text, p_amount integer DEFAULT 1)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
BEGIN
  IF v_date IS NULL THEN v_date := v_today; ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;
  UPDATE ai_usage SET count = GREATEST(ai_usage.count - GREATEST(p_amount, 1), 0)
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date AND ai_usage.feature = p_feature
  RETURNING ai_usage.count INTO v_count;
  RETURN COALESCE(v_count, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_photo_quota(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_claim ai_quota_claims%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' OR p_token IS NULL OR btrim(p_token) = '' THEN RETURN false; END IF;
  SELECT * INTO v_claim FROM ai_quota_claims WHERE token = p_token AND owner_id = v_uid AND released_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE ai_quota_claims SET released_at = now() WHERE id = v_claim.id AND released_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_claim.bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = GREATEST(consumed - v_claim.amount, 0) WHERE id = v_claim.bonus_id AND owner_id = v_uid;
  ELSE
    UPDATE ai_usage SET count = GREATEST(count - v_claim.amount, 0) WHERE owner_id = v_uid AND usage_date = v_claim.usage_date AND feature = v_claim.feature;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_invite_checkin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_inviter text;
  v_bind_date date;
  v_logged_days integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_month_honey integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  SELECT invited_by, COALESCE(invited_at::date, created_at::date) INTO v_inviter, v_bind_date FROM profiles WHERE owner_id = v_uid;
  IF v_inviter IS NULL THEN RETURN false; END IF;
  SELECT count(DISTINCT log_date) INTO v_logged_days FROM meal_entries
   WHERE owner_id = v_uid AND log_date >= v_bind_date AND log_date <= v_bind_date + interval '6 days';
  IF v_logged_days < 5 THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey FROM honey_ledger
   WHERE owner_id = v_inviter AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 250 > 3000 THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 200, 'invitee_checkin', 'settle-' || v_inviter, now() + make_interval(days => 365)) ON CONFLICT DO NOTHING;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 250, 'inviter_checkin', 'settle-' || v_uid, now() + make_interval(days => 365)) ON CONFLICT DO NOTHING;
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan IS DISTINCT FROM 'lifetime' THEN
    IF v_ent IS NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source) VALUES (v_uid, 'pro', now() + make_interval(days => 7), 'invite');
    ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
      UPDATE entitlements SET pro_until = v_until + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    ELSE
      UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    END IF;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlock_badge(p_badge_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_badge_key NOT IN ('streak_3','streak_7','streak_21','streak_100','photo_50','scan_30','recipe_3','water_10','exercise_20','lose_3kg','invite_3','invite_top') THEN RETURN false; END IF;
  INSERT INTO badges (owner_id, badge_key) VALUES (v_uid, p_badge_key) ON CONFLICT (owner_id, badge_key) DO NOTHING;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_payment_order(p_order_no text, p_provider_txn_id text, p_receipt text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_order payment_orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  SELECT * INTO v_order FROM payment_orders WHERE order_no = p_order_no AND owner_id = v_uid;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_order.status = 'paid' THEN RETURN true; END IF;
  RETURN false;
END;
$function$;
