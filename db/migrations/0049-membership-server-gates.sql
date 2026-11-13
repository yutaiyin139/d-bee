-- ═══════════════════════════════════════════════════════════════════════
-- 0049 · 会员软门升到服务端：报告窗口 / 导出 / llm_gate 分功能 / 包装日限额
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-11-13 阶段 B）：
--   拍照额度已由 consume_photo_quota + llm_gate(scan) 在库内强制。
--   报告 30 天、数据导出、本期解读、问答日上限仍主要靠前端拦截 ——
--   登录用户用抓包改区间 / 直调 LLM 即可拿到付费能力。
--
-- 本迁移补四件事（数字与 packages/shared/src/constants 同源，库内写死不信入参）：
--   (a) report_window_days() / list_meals_between()：非 Pro 全字段区间截断为 7 天
--   (b) export_user_bundle()：非 Pro 返回 {ok:false, code:pro_required}，不吐全量
--   (c) llm_gate 分 feature：scan 仍核销 claim；package 走 ai_usage 日限额 8；
--       coach 文本问答不设日上限（2026-11-13 定案）；recap（本期解读）免费 0（必须 Pro）
--   (d) 包装识别日限额入库，不再只靠网关进程内 RateLimiter（多实例会各自放行 8 次）
--
-- 🔴 刻意不收回 meal_entries 的表级 SELECT：INSERT/UPDATE/DELETE … RETURNING
--    需要 SELECT 权限；按日查看/改份量是免费记餐能力。全字段「跨日批量」走
--    list_meals_between。抓包仍可按日循环拼出历史 —— 那是记餐权，不是报告权。
--
-- 执行：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0049-membership-server-gates.sql
-- 幂等：CREATE OR REPLACE + GRANT/REVOKE 可重复执行。
-- 水位：在 0048 之后应用。0046/0047 跳号空洞与本迁移无关，不得顺手补跑。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 库内常量（与 shared FREE_REPORT_DAYS / PRO_REPORT_DAYS / 包装与问答上限同源）
-- 改数字必须同时改 packages/shared/src/constants/index.ts 与本文件，护栏 22 钉死。

CREATE OR REPLACE FUNCTION public.entitlement_is_pro()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(
    (SELECT plan = 'lifetime' OR (plan = 'pro' AND pro_until IS NOT NULL AND pro_until > now())
       FROM entitlements WHERE owner_id = auth.uid()),
    false
  );
$fn$;

REVOKE ALL ON FUNCTION public.entitlement_is_pro() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_app') THEN
    GRANT EXECUTE ON FUNCTION public.entitlement_is_pro() TO dbee_app;
  END IF;
END $$;

COMMENT ON FUNCTION public.entitlement_is_pro() IS
  '0049 · 当前会话是否有效 Pro/终身。仅供 DEFINER 函数与网关角色，不授登录用户。';

CREATE OR REPLACE FUNCTION public.report_window_days()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN 7;
  END IF;
  IF public.entitlement_is_pro() THEN
    RETURN 30;
  END IF;
  RETURN 7;
END;
$fn$;

REVOKE ALL ON FUNCTION public.report_window_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_window_days() TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_app') THEN
    GRANT EXECUTE ON FUNCTION public.report_window_days() TO dbee_app;
  END IF;
END $$;

COMMENT ON FUNCTION public.report_window_days() IS
  '0049 · 当前用户饮食报告允许的最大天数。免费 7、Pro/终身 30。';

CREATE OR REPLACE FUNCTION public.list_meals_between(p_start date, p_end date)
RETURNS SETOF public.meal_entries
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid   text := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_days  integer;
  v_min   date;
  v_start date;
  v_end   date;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN;
  END IF;
  v_days := public.report_window_days();
  v_min := v_today - (v_days - 1);
  v_start := GREATEST(COALESCE(p_start, v_min), v_min);
  v_end := LEAST(COALESCE(p_end, v_today), v_today);
  IF v_start > v_end THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT m.*
      FROM meal_entries m
     WHERE m.owner_id = v_uid
       AND m.log_date >= v_start
       AND m.log_date <= v_end
     ORDER BY m.log_date ASC, m.created_at ASC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_meals_between(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_meals_between(date, date) TO authenticated;

COMMENT ON FUNCTION public.list_meals_between(date, date) IS
  '0049 · 全字段饮食区间查询。服务端按会员档截断窗口，不信客户端起止日。';

CREATE OR REPLACE FUNCTION public.export_user_bundle()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('ok', false, 'code', 'unauthenticated');
  END IF;
  IF NOT public.entitlement_is_pro() THEN
    RETURN json_build_object('ok', false, 'code', 'pro_required');
  END IF;
  RETURN json_build_object(
    'app', 'D-Bee 自律蜜蜂',
    'exported_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'profile', (SELECT row_to_json(p) FROM profiles p WHERE p.owner_id = v_uid LIMIT 1),
    'meal_entries', COALESCE((SELECT json_agg(m ORDER BY m.log_date, m.created_at) FROM meal_entries m WHERE m.owner_id = v_uid), '[]'::json),
    'weight_logs', COALESCE((SELECT json_agg(w ORDER BY w.log_date) FROM weight_logs w WHERE w.owner_id = v_uid), '[]'::json),
    'water_logs', COALESCE((SELECT json_agg(x ORDER BY x.log_date) FROM water_logs x WHERE x.owner_id = v_uid), '[]'::json),
    'exercise_logs', COALESCE((SELECT json_agg(e ORDER BY e.log_date) FROM exercise_logs e WHERE e.owner_id = v_uid), '[]'::json),
    'ai_usage', COALESCE((SELECT json_agg(a ORDER BY a.usage_date DESC) FROM ai_usage a WHERE a.owner_id = v_uid), '[]'::json)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.export_user_bundle() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.export_user_bundle() TO authenticated;

COMMENT ON FUNCTION public.export_user_bundle() IS
  '0049 · 全量个人数据导出。非 Pro 只返回 pro_required，不返回行数据。';

-- ── llm_gate：分功能 ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.llm_gate(p_feature text)
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      text := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_feature  text := COALESCE(p_feature, '');
  v_claim_id bigint;
  v_limit    integer;
  v_count    integer;
  v_inserted boolean;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('allowed', false, 'reason', 'unauthenticated');
  END IF;

  IF public.entitlement_is_pro() THEN
    RETURN json_build_object('allowed', true, 'pro', true, 'feature', v_feature);
  END IF;

  IF v_feature = 'scan' THEN
    UPDATE ai_quota_claims SET llm_used_at = now()
     WHERE id = (
       SELECT id FROM ai_quota_claims
        WHERE owner_id = v_uid AND usage_date = v_today
          AND released_at IS NULL AND llm_used_at IS NULL
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id INTO v_claim_id;
    IF v_claim_id IS NOT NULL THEN
      RETURN json_build_object('allowed', true, 'pro', false, 'feature', 'scan', 'claim_id', v_claim_id);
    END IF;
    RETURN json_build_object('allowed', false, 'pro', false, 'feature', 'scan', 'reason', 'quota_not_claimed');
  END IF;

  IF v_feature = 'recap' THEN
    RETURN json_build_object('allowed', false, 'pro', false, 'feature', 'recap', 'reason', 'pro_required');
  END IF;

  IF v_feature = 'text' THEN
    RETURN json_build_object('allowed', true, 'pro', false, 'feature', 'text');
  END IF;

  -- 文本问答：不记日次数。每分钟防刷在网关，不在本函数计数。
  IF v_feature = 'coach' THEN
    RETURN json_build_object('allowed', true, 'pro', false, 'feature', 'coach');
  END IF;

  IF v_feature = 'package' THEN
    v_limit := 8;
  ELSE
    RETURN json_build_object('allowed', false, 'pro', false, 'reason', 'unknown_feature');
  END IF;

  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (v_uid, v_today, v_feature, 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;
  IF COALESCE(v_inserted, false) THEN
    RETURN json_build_object('allowed', true, 'pro', false, 'feature', v_feature, 'used', 1, 'remaining', v_limit - 1);
  END IF;

  UPDATE ai_usage
     SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = v_uid
     AND ai_usage.usage_date = v_today
     AND ai_usage.feature = v_feature
     AND ai_usage.count + 1 <= v_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    RETURN json_build_object('allowed', false, 'pro', false, 'feature', v_feature, 'reason', 'quota_exhausted');
  END IF;
  RETURN json_build_object('allowed', true, 'pro', false, 'feature', v_feature, 'used', v_count, 'remaining', GREATEST(v_limit - v_count, 0));
END;
$fn$;

REVOKE ALL ON FUNCTION public.llm_gate(text) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_app') THEN
    GRANT EXECUTE ON FUNCTION public.llm_gate(text) TO dbee_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.llm_gate(text) FROM dbee_web';
  END IF;
END $$;

COMMENT ON FUNCTION public.llm_gate(text) IS
  '0049 · LLM 网关分功能闸门。scan 核销 claim；package 记 ai_usage 日限额；coach 不设日上限；recap 仅 Pro；仅 dbee_app 可执行。';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0049: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0049', 'membership-server-gates', 'applied', 'self',
          '(a) list_meals_between 按档截断 (b) export_user_bundle Pro 门控 '
          '(c) llm_gate 分 feature (d) 包装日限额入库；问答不设日上限')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
