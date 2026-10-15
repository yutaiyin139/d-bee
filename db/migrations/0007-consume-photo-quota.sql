-- ============================================================
-- 0007 · 拍照额度：奖励余额查询 + 统一消耗
-- 需求：每日可用拍照次数 = 基础 3 次（自然日重置）+ 未过期奖励余额（7 天有效）。
-- 消耗顺序：优先扣「最早过期」的奖励余额（避免浪费），不足再扣基础额度。
--
-- 两个函数：
--   get_photo_quota()    查询当前可用额度（用于 UI 展示）
--   consume_photo_quota() 原子消耗一次，返回 allowed / used / remaining
-- ============================================================

-- 查询当前额度：基础剩余 + 奖励剩余 + 总剩余
CREATE OR REPLACE FUNCTION get_photo_quota(p_base_limit integer DEFAULT 3)
RETURNS TABLE (base_remaining integer, bonus_remaining integer, total_remaining integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_base_used integer;
  v_bonus integer;
BEGIN
  SELECT COALESCE(SUM(count), 0) INTO v_base_used
    FROM ai_usage
   WHERE owner_id = auth.uid()
     AND usage_date = v_today
     AND feature = 'scan';

  SELECT COALESCE(SUM(amount - consumed), 0) INTO v_bonus
    FROM quota_bonus
   WHERE owner_id = auth.uid()
     AND amount > consumed
     AND expires_at > now();

  base_remaining := GREATEST(p_base_limit - v_base_used, 0);
  bonus_remaining := GREATEST(v_bonus, 0);
  total_remaining := base_remaining + bonus_remaining;
  RETURN NEXT;
END;
$fn$;

-- 原子消耗一次拍照额度：优先扣最早过期的奖励，不足扣基础
CREATE OR REPLACE FUNCTION consume_photo_quota(p_usage_date date, p_base_limit integer DEFAULT 3)
RETURNS TABLE (allowed boolean, used integer, remaining integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_bonus_id bigint;
  v_base_used integer;
BEGIN
  IF v_date IS NULL THEN
    v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN
    v_date := v_today;
  END IF;

  -- 1) 优先扣最早过期的未过期奖励余额（一次拍照扣 1）
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
    -- 消耗的是奖励，基础额度未动；remaining 返回基础剩余供参考
    SELECT COALESCE(SUM(count), 0) INTO v_base_used
      FROM ai_usage
     WHERE owner_id = auth.uid() AND usage_date = v_date AND feature = 'scan';
    RETURN QUERY SELECT true, v_base_used, GREATEST(p_base_limit - v_base_used, 0);
    RETURN;
  END IF;

  -- 2) 无奖励余额，扣基础额度
  RETURN QUERY SELECT * FROM consume_ai_quota(v_date, 'scan', p_base_limit, 1);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION get_photo_quota(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION consume_photo_quota(date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_photo_quota(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION consume_photo_quota(date, integer) TO authenticated;
