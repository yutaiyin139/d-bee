CREATE OR REPLACE FUNCTION public.consume_photo_quota(p_usage_date date, p_base_limit integer DEFAULT 3)
RETURNS TABLE(allowed boolean, used integer, remaining integer, token text)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date  date := p_usage_date;
  v_limit integer := 3;   -- 🔴 库内常量，入参 p_base_limit 一律忽略
  v_bonus_id bigint;
  v_base_used integer;
  v_token text;
  v_inserted boolean;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT false, 0, 0, NULL::text; RETURN;
  END IF;
  IF v_date IS NULL THEN v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;

  -- 优先扣最早过期的奖励额度（FOR UPDATE 防并发双花同一 bonus 行）
  SELECT id INTO v_bonus_id FROM quota_bonus
   WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now()
   ORDER BY expires_at ASC LIMIT 1 FOR UPDATE;
  IF v_bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = consumed + 1 WHERE id = v_bonus_id;
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
    VALUES (auth.uid(), v_token, 'scan', v_date, v_bonus_id, 1);
    SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage
     WHERE owner_id = auth.uid() AND usage_date = v_date AND feature = 'scan';
    RETURN QUERY SELECT true, v_base_used, GREATEST(v_limit - v_base_used, 0), v_token; RETURN;
  END IF;

  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, 'scan', 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
    VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
    RETURN QUERY SELECT true, 1, v_limit - 1, v_token; RETURN;
  END IF;

  UPDATE ai_usage SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date
     AND ai_usage.feature = 'scan' AND ai_usage.count + 1 <= v_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = 'scan';
    RETURN QUERY SELECT false, COALESCE(v_count, v_limit), 0, NULL::text; RETURN;
  END IF;
  v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
  INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
  VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
  RETURN QUERY SELECT true, v_count, GREATEST(v_limit - v_count, 0), v_token;
END;
$fn$;
