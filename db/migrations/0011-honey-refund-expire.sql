-- ============================================================
-- 0011 · 打卡积分删除收回 + 积分过期结算（V1.4 优化）
-- 需求：docs/邀约打卡社群会员-逻辑梳理与优化建议.md
--   O-2a 打卡积分删除收回：删除当日最后一条饮食记录时收回 checkin_meal 积分，
--        防止「记假数据拿 5 分再删除」白嫖（P0-2 防刷）
--   O-4  积分 12 个月有效期：过期入账记 expire 负流水，让用户可见过期明细
--
-- 设计：
--   1. refund_checkin_honey(bigint) → boolean  SECURITY DEFINER
--      删除 meal 后调用，内部判定：该 meal 所属 log_date 当天是否还有其它 meal，
--      若无且存在未退的 checkin_meal 正流水，则记 refund 负流水（幂等）。
--   2. expire_stale_honey() → integer  SECURITY DEFINER
--      扫描已过期（expires_at <= now()）但仍为正余额的入账，逐笔记 expire 负流水，
--      返回本次失效笔数。幂等：已记 expire 的不重复。
-- ============================================================

-- 1. 删除收回（按 log_date 幂等收回，供前端删除后调用）
-- 参数：p_log_date = 被删记录的 log_date（YYYY-MM-DD）
CREATE OR REPLACE FUNCTION public.refund_checkin_honey_by_date(p_log_date text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     text := auth.uid();
  v_others  integer;
  v_granted integer;
  v_amount  integer := 0;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN
    RETURN false;
  END IF;

  -- 当天是否还有其它饮食记录？有则不收回（用户只是删了其中一餐）
  SELECT count(*) INTO v_others
  FROM meal_entries
  WHERE owner_id = v_uid AND log_date = p_log_date;

  IF v_others > 0 THEN
    RETURN false;
  END IF;

  -- 是否发过 checkin_meal 积分（未退）
  SELECT COALESCE(sum(amount), 0) INTO v_granted
  FROM honey_ledger
  WHERE owner_id = v_uid
    AND reason = 'checkin_meal'
    AND ref_id = p_log_date;

  IF v_granted <= 0 THEN
    RETURN false;
  END IF;

  -- 是否已退过（幂等）
  PERFORM 1 FROM honey_ledger
  WHERE owner_id = v_uid
    AND reason = 'refund'
    AND ref_id = 'meal:' || p_log_date;

  IF FOUND THEN
    RETURN false;
  END IF;

  -- 记负流水收回（amount 取负，等于已发 checkin_meal 总额的相反数）
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id)
  VALUES (v_uid, -v_granted, 'refund', 'meal:' || p_log_date);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_checkin_honey_by_date(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_checkin_honey_by_date(text) TO authenticated;

-- 2. 积分过期结算：把已过期但仍计余额的正入账记 expire 负流水
--    注意：honey_ledger 的 UNIQUE(owner_id, reason, ref_id) 对负流水也生效，
--    expire 的 ref_id 用原流水 id 拼 'exp:' 前缀，避免与正流水 ref_id 冲突。
CREATE OR REPLACE FUNCTION public.expire_stale_honey()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   text := auth.uid();
  v_count integer := 0;
  r       record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 0;
  END IF;

  -- 遍历：已过期、正余额、且未记过 expire 的入账
  FOR r IN
    SELECT id, amount
    FROM honey_ledger
    WHERE owner_id = v_uid
      AND amount > 0
      AND expires_at IS NOT NULL
      AND expires_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM honey_ledger e
        WHERE e.owner_id = v_uid
          AND e.reason = 'expire'
          AND e.ref_id = 'exp:' || honey_ledger.id
      )
  LOOP
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id)
    VALUES (v_uid, -r.amount, 'expire', 'exp:' || r.id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_honey() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_stale_honey() TO authenticated;
