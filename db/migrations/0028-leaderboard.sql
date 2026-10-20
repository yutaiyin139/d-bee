-- ═══════════════════════════════════════════════════════════════
-- 0028 · 站内轻榜单（P2-1）
--
-- 背景：低成本构建社群氛围，不碰 UGC 审核。两个榜单：
--   1. 自律榜：按「当前连续打卡天数」降序。连续打卡口径与前端 streak.ts
--      computeStreak 严格一致——某天有 ≥1 条饮食记录即算打卡，从今天（或昨天）
--      往前回溯连续日期。今天没记则从昨天起算，段位保留到今天结束。
--   2. 邀请榜：按「本月成功邀请人数」降序（profiles.invited_by = 我 且
--      invited_at 落在本月，时区 Asia/Shanghai）。
--
-- 设计要点：
--   - 单个 RPC leaderboard() 返回 { self_discipline, invite, my }，一次拉全。
--   - 昵称脱敏：后端直接返回「首字 + *」，不返回 owner_id / 头像 / 完整昵称。
--   - 反刷：自律榜只计入「连续 ≥3 天」用户，避免零散用户刷屏。
--   - 我的排名：即使不在 Top50，也单独返回 my 供「我的排名」展示。
--   - 数据量：早期用户规模下逐用户计算可接受；量大后再引入 leaderboard_cache。
--
-- 权限：SECURITY DEFINER 只读；仅 authenticated 可调。
-- 执行方式：genie-baas db_exec_sql mode=migrate（逐条执行）
-- ═══════════════════════════════════════════════════════════════

-- ── 辅助函数 1：昵称脱敏「首字 + *」；无昵称回退「蜂友*」──────────────────
CREATE OR REPLACE FUNCTION public._lb_mask_name(nickname text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN nickname IS NULL OR btrim(nickname) = '' THEN '蜂友*'
    ELSE left(btrim(nickname), 1) || '*'
  END
$fn$;

-- ── 辅助函数 2：连续打卡天数（与前端 streak.ts computeStreak 一致）────────
CREATE OR REPLACE FUNCTION public._lb_compute_streak(p_days text[], p_today date)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_cursor date;
  v_n      integer := 0;
BEGIN
  IF p_days IS NULL OR array_length(p_days, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF p_today::text = ANY(p_days) THEN
    v_cursor := p_today;
  ELSE
    v_cursor := p_today - 1;
  END IF;
  LOOP
    EXIT WHEN NOT (v_cursor::text = ANY(p_days));
    v_n := v_n + 1;
    v_cursor := v_cursor - 1;
  END LOOP;
  RETURN v_n;
END;
$fn$;

-- ── 主函数：站内轻榜单（无临时表，游标遍历 + 数组聚合）────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid         text := auth.uid();
  v_today       date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_my_streak   integer := 0;
  v_my_invites  integer := 0;
  v_disc_json   json;
  v_inv_json    json;
  v_streak_arr  json[] := ARRAY[]::json[];
  v_inv_arr     json[] := ARRAY[]::json[];
  v_s           integer;
  r             record;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;

  -- 我的连续打卡天数
  SELECT public._lb_compute_streak(
           (SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text)
              FROM meal_entries WHERE owner_id = v_uid),
           v_today)
    INTO v_my_streak;

  -- 我的本月邀请成功人数
  SELECT count(*) INTO v_my_invites
    FROM profiles
   WHERE invited_by = v_uid
     AND invited_at >= v_month_start;

  -- 自律榜：逐用户计算连续打卡，收进数组
  FOR r IN
    SELECT m.owner_id AS uid,
           array_agg(DISTINCT m.log_date::text ORDER BY m.log_date::text) AS days,
           p.nickname AS nick
      FROM meal_entries m
      JOIN profiles p ON p.owner_id = m.owner_id
     GROUP BY m.owner_id, p.nickname
  LOOP
    v_s := public._lb_compute_streak(r.days, v_today);
    IF v_s >= 3 THEN
      v_streak_arr := v_streak_arr || json_build_object(
        'name', public._lb_mask_name(r.nick),
        'streak', v_s
      )::json;
    END IF;
  END LOOP;

  -- 邀请榜：本月成功邀请人数
  FOR r IN
    SELECT p.nickname AS nick, count(*) AS cnt
      FROM profiles p
      JOIN profiles invited ON invited.invited_by = p.owner_id
     WHERE invited.invited_at >= v_month_start
     GROUP BY p.owner_id, p.nickname
  LOOP
    v_inv_arr := v_inv_arr || json_build_object(
      'name', public._lb_mask_name(r.nick),
      'invites', r.cnt::int
    )::json;
  END LOOP;

  -- 排序 + 截断 Top50
  SELECT COALESCE(json_agg(e ORDER BY (e->>'streak')::int DESC), '[]'::json)
    INTO v_disc_json
    FROM unnest(v_streak_arr) AS e
   LIMIT 50;

  SELECT COALESCE(json_agg(e ORDER BY (e->>'invites')::int DESC), '[]'::json)
    INTO v_inv_json
    FROM unnest(v_inv_arr) AS e
   LIMIT 50;

  RETURN json_build_object(
    'self_discipline', COALESCE(v_disc_json, '[]'::json),
    'invite', COALESCE(v_inv_json, '[]'::json),
    'my', json_build_object('streak', v_my_streak, 'invites', v_my_invites)
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.leaderboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard() TO authenticated;
