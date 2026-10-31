CREATE OR REPLACE FUNCTION public.get_photo_quota(p_base_limit integer DEFAULT 3)
RETURNS TABLE(base_remaining integer, bonus_remaining integer, total_remaining integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_limit integer := 3;   -- 🔴 同上：入参不再被信任
  v_base_used integer;
  v_bonus integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT 0, 0, 0; RETURN; END IF;
  SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage
   WHERE owner_id = auth.uid() AND usage_date = v_today AND feature = 'scan';
  SELECT COALESCE(SUM(amount - consumed), 0) INTO v_bonus FROM quota_bonus
   WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now();
  base_remaining := GREATEST(v_limit - v_base_used, 0);
  bonus_remaining := GREATEST(v_bonus, 0);
  total_remaining := base_remaining + bonus_remaining;
  RETURN NEXT;
END;
$fn$;
