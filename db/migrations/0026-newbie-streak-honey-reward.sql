-- 0026：新手奖励从「识别次数」改为「蜜糖积分」
--
-- 产品规则调整（用户决策，2026-10-19）：
--   每日严格「3 次免费识别 + 2 次积分兑换」。
--   此前新手完善资料 +3 次识别（quota_bonus 次数），会叠加到免费额度，
--   把「免费识别」边界从 3 次突破到 6 次，与产品口径冲突。
--   本次把新手奖励改为发放蜜糖积分（newbie=150），积分只能用于兑换识别
--   （50 积分/次，每日最多兑 2 次），从根上让「免费识别」严格 = 3 次/天。
--   连续打卡 7 天仍送 2 次识别（每满 7 天循环发放，7/14/21…各送 2 次），
--   这部分保持 quota_bonus 次数不变。
--
-- 改动：
--   1. grant_honey 的 reason 白名单新增 newbie(150)。
--   2. 作废存量「新手识别次数 bonus」（source='newbie'），
--      避免继续叠加到免费额度，让「3 次免费」立即生效。
--      streak7/honey 的 bonus 保留（分别是打卡识别奖励、积分兑换额度，属正常流转）。

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
AS $$
DECLARE
  v_uid text := auth.uid();
  v_ok  boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  -- ref_id 必须非空（防重复的唯一约束依赖它，空值会绕过去重）
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN
    RETURN false;
  END IF;

  -- reason 白名单 + 金额校验
  IF p_reason = 'checkin_meal' THEN
    v_ok := p_amount = 5;
  ELSIF p_reason = 'checkin_water' THEN
    v_ok := p_amount = 2;
  ELSIF p_reason = 'checkin_exercise' THEN
    v_ok := p_amount = 2;
  ELSIF p_reason = 'streak_milestone' THEN
    v_ok := p_amount IN (15, 40, 80, 120, 200, 400, 800);
  ELSIF p_reason = 'newbie' THEN
    v_ok := p_amount = 150;
  ELSE
    v_ok := false;  -- 未知 reason 一律拒绝
  END IF;

  IF NOT v_ok THEN
    RETURN false;
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, p_amount, p_reason, p_ref_id,
          now() + make_interval(days => GREATEST(p_ttl_days, 1)))
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_honey(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_honey(text, text, integer, integer) TO authenticated;

-- 作废存量「新手识别次数 bonus」，让「3 次免费」立即生效。
-- streak7（打卡识别奖励）与 honey（积分兑换额度）的 bonus 保留。
UPDATE public.quota_bonus
   SET expires_at = now()
 WHERE source = 'newbie'
   AND amount > consumed
   AND expires_at > now();
