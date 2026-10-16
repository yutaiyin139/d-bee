-- ============================================================
-- 0014 · 拍照额度「预占 token」机制（堵 release_ai_quota 额度绕过）
--
-- 背景（2026-10-16 审计遗留 P1）：
--   release_ai_quota 是 SECURITY INVOKER，用 GREATEST(count-amount, 0) 最多清零，
--   任何登录用户可在 devtools 调 release_ai_quota(today,'scan',3) 把当日已用额度
--   清零，免费用户白嫖无限次拍照。
--   根因：退还动作不区分「是否对应一次真实的失败」，也不校验调用来源。
--
-- 方案：引入「预占 token」——consume 时生成一次性 token 并落表（记录扣的是基础
--   还是奖励额度），release 必须携带 token，且每个 token 只能退一次。这样：
--   1. 无法凭空清零（没有真实 consume 就没有 token）；
--   2. 每个 token 只能退一次（防重复退）；
--   3. 退还精确（扣了奖励还奖励、扣了基础还基础，修复原 releasePhotoQuota
--      无法区分来源、统一还基础导致「凭空多额度」的隐性问题）。
--
-- 废弃 release_ai_quota：REVOKE authenticated 执行权限，防旧路径被滥用。
-- ============================================================

-- 1. 预占记录表（consume 落 token，release 标记 released_at）
CREATE TABLE public.ai_quota_claims (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  token       text        NOT NULL UNIQUE,
  feature     text        NOT NULL,
  usage_date  date        NOT NULL,
  bonus_id    bigint,          -- 扣的是哪条奖励额度（quota_bonus.id）；NULL=扣基础额度
  amount      integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz      -- NULL=未释放
);
COMMENT ON TABLE public.ai_quota_claims IS '拍照额度预占记录：consume 落 token，release 校验 token 一次性退还';
CREATE INDEX ON public.ai_quota_claims (owner_id, created_at);

-- 隔离：这张表只经 SECURITY DEFINER 函数访问，登录用户不得直读写（否则可伪造
-- token 记录再 release 套现额度）
ALTER TABLE public.ai_quota_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quota_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_quota_claims FROM PUBLIC, anon, authenticated;

-- 2. consume_photo_quota 重写：返回 token + 落 claim 记录
--    改动：扣奖励时记 bonus_id，扣基础时 bonus_id=NULL；每次成功生成 md5 token。
--    改为 SECURITY DEFINER（绕过 RLS 后仍全程用 auth.uid() 过滤，安全）。
CREATE OR REPLACE FUNCTION public.consume_photo_quota(p_usage_date date, p_base_limit integer DEFAULT 3)
RETURNS TABLE (allowed boolean, used integer, remaining integer, token text)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date     date := p_usage_date;
  v_bonus_id bigint;
  v_base_used integer;
  v_token    text;
  v_inserted boolean;
  v_count    integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT false, 0, 0, NULL::text;
    RETURN;
  END IF;

  IF v_date IS NULL THEN
    v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN
    v_date := v_today;
  END IF;

  -- 1) 优先扣最早过期的奖励余额
  SELECT id INTO v_bonus_id
    FROM quota_bonus
   WHERE owner_id = auth.uid()
     AND amount > consumed
     AND expires_at > now()
   ORDER BY expires_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = consumed + 1 WHERE id = v_bonus_id;
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
    VALUES (auth.uid(), v_token, 'scan', v_date, v_bonus_id, 1);
    SELECT COALESCE(SUM(count), 0) INTO v_base_used
      FROM ai_usage
     WHERE owner_id = auth.uid() AND usage_date = v_date AND feature = 'scan';
    RETURN QUERY SELECT true, v_base_used, GREATEST(p_base_limit - v_base_used, 0), v_token;
    RETURN;
  END IF;

  -- 2) 无奖励余额，扣基础额度（内联原 consume_ai_quota 逻辑 + 落 token）
  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, 'scan', 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;

  IF v_inserted THEN
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
    VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
    RETURN QUERY SELECT true, 1, GREATEST(p_base_limit - 1, 0), v_token;
    RETURN;
  END IF;

  UPDATE ai_usage
     SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid()
     AND ai_usage.usage_date = v_date
     AND ai_usage.feature = 'scan'
     AND ai_usage.count + 1 <= p_base_limit
  RETURNING ai_usage.count INTO v_count;

  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = 'scan';
    RETURN QUERY SELECT false, COALESCE(v_count, p_base_limit), 0, NULL::text;
    RETURN;
  END IF;

  v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
  INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
  VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
  RETURN QUERY SELECT true, v_count, GREATEST(p_base_limit - v_count, 0), v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_photo_quota(date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_photo_quota(date, integer) TO authenticated;

-- 3. release_photo_quota 新增：凭 token 一次性精确退还
CREATE OR REPLACE FUNCTION public.release_photo_quota(p_token text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   text := auth.uid();
  v_claim ai_quota_claims%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' OR p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_claim
    FROM ai_quota_claims
   WHERE token = p_token AND owner_id = v_uid AND released_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- 先标记释放（条件更新防并发重复释放同一 token）
  UPDATE ai_quota_claims SET released_at = now()
   WHERE id = v_claim.id AND released_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- 精确退还：扣了奖励还奖励、扣了基础还基础
  IF v_claim.bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = GREATEST(consumed - v_claim.amount, 0)
     WHERE id = v_claim.bonus_id AND owner_id = v_uid;
  ELSE
    UPDATE ai_usage SET count = GREATEST(count - v_claim.amount, 0)
     WHERE owner_id = v_uid
       AND usage_date = v_claim.usage_date
       AND feature = v_claim.feature;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_photo_quota(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_photo_quota(text) TO authenticated;

-- 4. 废弃 release_ai_quota：撤销 authenticated 执行权限，堵住「清零当日用量」旧路径
REVOKE EXECUTE ON FUNCTION public.release_ai_quota(date, text, integer) FROM authenticated;
