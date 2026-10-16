-- ════════════════════════════════════════════════════════════════════════════
-- migration 0010 · 徽章统计函数（badge_stats）
--
-- 背景：首批 12 枚徽章里有 8 枚（photo_50 / scan_30 / recipe_3 / water_10 /
--   exercise_20 / lose_3kg / invite_3 / invite_top）只有定义、没有触发逻辑，
--   用户永远解锁不了。本函数一次性返回这些徽章所需的全部统计，前端据此批量
--   调用 unlock_badge 解锁。
--
-- 计数口径（与产品语义严格对齐）：
--   photo_count     AI 拍照识别并成功入库的饮食记录数（meal_entries.source='photo'）
--                   用 meal_entries 而非 ai_usage：只有识别成功且用户确认入库才算一次
--                   有效拍照，ai_usage 含失败/放弃占用，语义不符。
--   barcode_count   条码扫码入库的记录数（source='barcode'）
--   recipe_count    自定义食谱数
--   water_days      饮水达标天数（当日 SUM(amount_ml) ≥ 体重×35ml；体重缺失按 60kg）
--   exercise_count  运动记录总次数
--   weight_lost     起始体重 − 最新体重（kg，正数=减重）
--   invitees        累计成功邀请人数（profiles.invited_by = 我）
--   invite_settled  其中 7 日打卡达标的人数（honey_ledger reason='inviter_checkin'）
--
-- 权限：SECURITY DEFINER，统计当前 auth.uid() 自己的数据，不跨用户。
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.badge_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- 拍照 / 扫码入库数
  SELECT
    COUNT(*) FILTER (WHERE source = 'photo'),
    COUNT(*) FILTER (WHERE source = 'barcode')
  INTO v_photo, v_barcode
  FROM meal_entries
  WHERE owner_id = v_uid;

  -- 食谱数
  SELECT COUNT(*) INTO v_recipe FROM recipes WHERE owner_id = v_uid;

  -- 饮水达标天数：目标 = 当前体重 × 35ml（与前端 nutrition.waterTargetMl 一致），缺体重按 60kg
  SELECT COALESCE(current_weight_kg, 60) * 35
  INTO v_water_target
  FROM profiles
  WHERE owner_id = v_uid;
  v_water_target := COALESCE(v_water_target, 2100);

  SELECT COUNT(*) INTO v_water
  FROM (
    SELECT log_date
    FROM water_logs
    WHERE owner_id = v_uid
    GROUP BY log_date
    HAVING SUM(amount_ml) >= v_water_target
  ) t;

  -- 运动总次数
  SELECT COUNT(*) INTO v_exercise FROM exercise_logs WHERE owner_id = v_uid;

  -- 减重 = 起始体重 − 最新体重（取最新一条体重记录）
  SELECT COALESCE(
    (SELECT start_weight_kg FROM profiles WHERE owner_id = v_uid), 0
  ) - COALESCE(
    (SELECT weight_kg FROM weight_logs WHERE owner_id = v_uid ORDER BY log_date DESC LIMIT 1), 0
  ) INTO v_lost;

  -- 邀请人数：绑定了我的账号数
  SELECT COUNT(*) INTO v_invitees FROM profiles WHERE invited_by = v_uid;

  -- 邀请达标人数：我拿到 inviter_checkin 奖励的次数（一次 = 一位好友达标）
  SELECT COUNT(*) INTO v_settled
  FROM honey_ledger
  WHERE owner_id = v_uid AND reason = 'inviter_checkin' AND amount > 0;

  RETURN json_build_object(
    'photo_count', COALESCE(v_photo, 0),
    'barcode_count', COALESCE(v_barcode, 0),
    'recipe_count', COALESCE(v_recipe, 0),
    'water_days', COALESCE(v_water, 0),
    'exercise_count', COALESCE(v_exercise, 0),
    'weight_lost', COALESCE(v_lost, 0),
    'invitees', COALESCE(v_invitees, 0),
    'invite_settled', COALESCE(v_settled, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.badge_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.badge_stats() TO authenticated;
