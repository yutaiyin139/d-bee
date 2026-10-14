-- 0003 原子 AI 配额（V1.0.0）
--
-- 背景：原先「读 count → 写 count+1」由前端分两次请求完成（见 src/lib/api.ts 的
-- bumpUsage），多设备 / 多标签页并发时会互相覆盖，导致计数偏少、免费 5 次限制形同虚设。
--
-- 方案：把「判断是否超限」与「自增」合并进数据库函数，一条语句内原子完成。
--   * consume_ai_quota —— 尝试占用一次额度，返回 allowed / used / remaining
--   * release_ai_quota —— AI 调用失败时退还，避免用户白扣次数
--
-- SECURITY INVOKER（默认）保持 RLS 生效：函数体内的读写仍受 ai_usage_own 策略约束，
-- 调用者只能操作自己的行；owner_id 一律取 auth.uid()，不接受外部传入，无法伪造。
--
-- 日期口径：前端传本地自然日，服务端做一次合理性校验——若与服务器 Asia/Shanghai
-- 日期相差超过 1 天（用户改了设备时间），以服务器日期为准，防止调时间刷额度。

CREATE OR REPLACE FUNCTION consume_ai_quota(p_usage_date date, p_feature text, p_limit integer, p_amount integer DEFAULT 1)
RETURNS TABLE (allowed boolean, used integer, remaining integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
  v_inserted boolean;
BEGIN
  IF v_date IS NULL THEN
    v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN
    v_date := v_today;
  END IF;

  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, p_feature, GREATEST(p_amount, 1))
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;

  IF v_inserted THEN
    RETURN QUERY SELECT true, GREATEST(p_amount, 1), GREATEST(p_limit - GREATEST(p_amount, 1), 0);
    RETURN;
  END IF;

  UPDATE ai_usage
     SET count = ai_usage.count + GREATEST(p_amount, 1)
   WHERE ai_usage.owner_id = auth.uid()
     AND ai_usage.usage_date = v_date
     AND ai_usage.feature = p_feature
     AND ai_usage.count + GREATEST(p_amount, 1) <= p_limit
  RETURNING ai_usage.count INTO v_count;

  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = p_feature;
    RETURN QUERY SELECT false, COALESCE(v_count, p_limit), 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_count, GREATEST(p_limit - v_count, 0);
END;
$fn$;

CREATE OR REPLACE FUNCTION release_ai_quota(p_usage_date date, p_feature text, p_amount integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
BEGIN
  IF v_date IS NULL THEN
    v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN
    v_date := v_today;
  END IF;

  UPDATE ai_usage
     SET count = GREATEST(ai_usage.count - GREATEST(p_amount, 1), 0)
   WHERE ai_usage.owner_id = auth.uid()
     AND ai_usage.usage_date = v_date
     AND ai_usage.feature = p_feature
  RETURNING ai_usage.count INTO v_count;

  RETURN COALESCE(v_count, 0);
END;
$fn$;

-- 只允许登录用户调用；anon 即便能调也因 RLS 拿不到任何行，这里显式收紧。
REVOKE EXECUTE ON FUNCTION consume_ai_quota(date, text, integer, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION release_ai_quota(date, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION consume_ai_quota(date, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION release_ai_quota(date, text, integer) TO authenticated;
