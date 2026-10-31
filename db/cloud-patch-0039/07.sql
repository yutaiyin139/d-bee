CREATE OR REPLACE FUNCTION public.consume_ai_quota(
  p_usage_date date,
  p_feature text,
  p_limit integer,
  p_amount integer DEFAULT 1
)
RETURNS TABLE(allowed boolean, used integer, remaining integer)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date  date := p_usage_date;
  v_limit integer;
  v_count integer;
  v_inserted boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT false, 0, 0; RETURN;
  END IF;
  -- 🔴 限额白名单（库内唯一真相，与 packages/shared FREE_DAILY_AI=3 同源）。
  --   入参 p_limit / p_amount 一律忽略：客户端可控的限额等于没有限额。
  IF p_feature = 'scan' THEN
    v_limit := 3;
  ELSE
    RETURN QUERY SELECT false, 0, 0; RETURN;
  END IF;

  IF v_date IS NULL THEN v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;

  -- 首次插入也要受上限约束（旧版此分支无判断，limit=1 都能被穿）
  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, p_feature, 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN
    RETURN QUERY SELECT true, 1, v_limit - 1; RETURN;
  END IF;
  UPDATE ai_usage SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date
     AND ai_usage.feature = p_feature AND ai_usage.count + 1 <= v_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = p_feature;
    RETURN QUERY SELECT false, COALESCE(v_count, v_limit), 0; RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, GREATEST(v_limit - v_count, 0);
END;
$fn$;
