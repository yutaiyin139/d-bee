-- 0052 · 营养解读 / 计划再生成的服务端墙。
-- 不改 0049 原文件。生产若已应用 0049，本迁移用 CREATE OR REPLACE 覆盖 llm_gate。
-- meal、recap：非 Pro 直接 pro_required。
-- plan：非 Pro 终身 1 次，记在 ai_usage 的 1970-01-01，不按日清零。Pro 在前面的分支直接放行，不占这 1 次。

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

  IF v_feature = 'recap' OR v_feature = 'meal' THEN
    RETURN json_build_object('allowed', false, 'pro', false, 'feature', v_feature, 'reason', 'pro_required');
  END IF;

  IF v_feature = 'plan' THEN
    INSERT INTO ai_usage (owner_id, usage_date, feature, count)
    VALUES (v_uid, DATE '1970-01-01', 'plan', 1)
    ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
    RETURNING true INTO v_inserted;
    IF COALESCE(v_inserted, false) THEN
      RETURN json_build_object(
        'allowed', true, 'pro', false, 'feature', 'plan', 'used', 1, 'remaining', 0
      );
    END IF;
    RETURN json_build_object('allowed', false, 'pro', false, 'feature', 'plan', 'reason', 'pro_required');
  END IF;

  IF v_feature = 'text' THEN
    RETURN json_build_object('allowed', true, 'pro', false, 'feature', 'text');
  END IF;

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
  '0052 · scan 核销 claim；package 日记限额；coach 不设日上限；meal/recap 仅 Pro；plan 非 Pro 终身 1 次。仅 dbee_app 可执行。';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0052: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0052', 'llm-feature-walls', 'applied', 'self',
          'meal/recap 仅 Pro；plan 非 Pro 终身 1 次记在 1970-01-01')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';
