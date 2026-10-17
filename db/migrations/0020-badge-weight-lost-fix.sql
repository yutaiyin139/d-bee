-- ═══════════════════════════════════════════════════════════════
-- 0020 · 修复 badge_stats 的 weight_lost 计算（无体重记录时误判减重）
--
-- 背景（2026-10-17 用户测试发现）：
--   新注册用户（goal=gain 增肥，start_weight_kg=26）尚未打卡任何体重记录
--   （weight_logs 为空），却点亮了「减重 3kg」徽章。
--
-- 根因：
--   badge_stats 里 weight_lost = COALESCE(start_weight_kg,0) - COALESCE(最新体重记录,0)
--   当 weight_logs 为空时，COALESCE(最新体重记录,0) 落成 0，于是
--   weight_lost = 26 - 0 = 26 ≥ 3，误判为「减重 26kg」。
--
-- 修复：
--   最新体重记录缺失时，回退到 profiles.current_weight_kg（注册时 = start_weight_kg，
--   打卡体重后由 saveWeight 同步更新），再回退 0。这样：
--     · 新用户（无体重记录，current=start）→ weight_lost = 0，不触发 ✓
--     · 打卡后 → start - 最新记录 ✓
--     · 两者都空 → 0 - 0 = 0 ✓
--
-- 执行方式：genie-baas db_exec_sql mode=migrate
-- ═══════════════════════════════════════════════════════════════

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

  SELECT
    COUNT(*) FILTER (WHERE source = 'photo'),
    COUNT(*) FILTER (WHERE source = 'barcode')
  INTO v_photo, v_barcode
  FROM meal_entries
  WHERE owner_id = v_uid;

  SELECT COUNT(*) INTO v_recipe FROM recipes WHERE owner_id = v_uid;

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

  SELECT COUNT(*) INTO v_exercise FROM exercise_logs WHERE owner_id = v_uid;

  -- 减重 = 起始体重 − 最新体重。
  -- 口径约束：仅 goal='lose'（减重目标）才计算有效减重量；增重/保持目标恒为 0，
  -- 避免增肥用户体重下降也点亮「减重 3kg」徽章。
  -- 最新体重优先取 weight_logs 最新记录；无记录时回退 current_weight_kg（注册时=起始体重，
  -- 打卡后同步更新），再回退 0。避免「无体重记录」被 COALESCE(...,0) 误当成「体重 0」。
  IF (SELECT goal FROM profiles WHERE owner_id = v_uid) = 'lose' THEN
    SELECT COALESCE(
      (SELECT start_weight_kg FROM profiles WHERE owner_id = v_uid), 0
    ) - COALESCE(
      (SELECT weight_kg FROM weight_logs WHERE owner_id = v_uid ORDER BY log_date DESC, id DESC LIMIT 1),
      (SELECT current_weight_kg FROM profiles WHERE owner_id = v_uid),
      0
    ) INTO v_lost;
  ELSE
    v_lost := 0;
  END IF;

  SELECT COUNT(*) INTO v_invitees FROM profiles WHERE invited_by = v_uid;

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
