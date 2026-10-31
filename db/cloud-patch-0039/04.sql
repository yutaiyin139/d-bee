CREATE OR REPLACE FUNCTION public.grant_photo_bonus(
  p_source text,
  p_grant_key text,
  p_amount integer,
  p_ttl_days integer DEFAULT 7
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      text := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_key_date date;
  v_cnt      integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_grant_key IS NULL OR btrim(p_grant_key) = '' THEN RETURN false; END IF;

  -- 🔴 只允许 streak7：
  --   · 'honey' 来源必须经 redeem_honey（扣积分后内部 INSERT quota_bonus），
  --     对客户端开放 = 凭空造识别额度（P0-B）。
  --   · 'newbie' 已被 0026 改为发 150 积分、0035 作废存量，不再对客户端开放。
  IF p_source IS DISTINCT FROM 'streak7' THEN RETURN false; END IF;
  -- 金额固定 2 次（packages/shared STREAK_BONUS_AMOUNT），TTL 1~7 天
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
$fn$;
