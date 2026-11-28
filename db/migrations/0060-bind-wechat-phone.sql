-- ═══════════════════════════════════════════════════════════════════════
-- 0060 · 微信账号绑定手机号
--
-- 小程序微信登录的 owner 是 wx:<openid>，App 短信登录是另一个 19 位账号。
-- 会员记在微信账号上时，用手机号进 App 看不到。
--
-- 本迁移只加绑定能力，不改已有登录行：
--   · app_users.bound_phone_hash / bound_phone_masked：挂在微信账号上的手机号
--     （哈希口径与 ident_kind='phone' 相同，不存明文）
--   · bind_wechat_phone：把手机号绑到当前微信账号。若这个号码已经有独立的
--     手机号账号，会员取更晚到期（终身优先），饮食/积分等记录并过来，
--     然后停用那个手机号账号。
-- 幂等：列 IF NOT EXISTS，函数 CREATE OR REPLACE，追踪表 UPSERT。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS bound_phone_hash text,
  ADD COLUMN IF NOT EXISTS bound_phone_masked text;

COMMENT ON COLUMN public.app_users.bound_phone_hash IS
  '0060 · 绑在本账号上的手机号 HMAC（kind=phone）。微信账号靠它让 App 短信登录进入同一个 owner。';
COMMENT ON COLUMN public.app_users.bound_phone_masked IS
  '0060 · 绑定手机号的展示掩码（138****1234）。不是登录标识。';

CREATE UNIQUE INDEX IF NOT EXISTS app_users_bound_phone_hash_key
  ON public.app_users (bound_phone_hash)
  WHERE bound_phone_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bind_wechat_phone(
  p_owner text,
  p_phone_hash text,
  p_phone_masked text
) RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_kind text;
  v_bound text;
  v_other text;
  v_phone text;
  v_wx_plan text;
  v_wx_until timestamptz;
  v_ph_plan text;
  v_ph_until timestamptz;
  v_plan text;
  v_until timestamptz;
  v_source text;
BEGIN
  IF p_owner IS NULL OR p_owner NOT LIKE 'wx:%' OR length(p_owner) < 6 THEN
    RETURN json_build_object('error', 'not_wechat');
  END IF;
  IF p_phone_hash IS NULL OR length(p_phone_hash) <> 64
     OR p_phone_masked IS NULL OR position('*' in p_phone_masked) = 0 THEN
    RETURN json_build_object('error', 'invalid_phone');
  END IF;

  SELECT ident_kind, bound_phone_hash INTO v_kind, v_bound
    FROM app_users WHERE owner_id = p_owner;
  IF NOT FOUND OR v_kind IS DISTINCT FROM 'wechat' THEN
    RETURN json_build_object('error', 'not_wechat');
  END IF;

  IF v_bound IS NOT NULL AND v_bound = p_phone_hash THEN
    RETURN json_build_object('ok', true, 'masked', p_phone_masked, 'merged', false);
  END IF;
  IF v_bound IS NOT NULL AND v_bound <> p_phone_hash THEN
    RETURN json_build_object('error', 'phone_already_bound');
  END IF;

  SELECT owner_id INTO v_other
    FROM app_users
   WHERE bound_phone_hash = p_phone_hash AND owner_id <> p_owner
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    RETURN json_build_object('error', 'phone_taken');
  END IF;

  SELECT owner_id INTO v_phone
    FROM app_users
   WHERE ident_kind = 'phone' AND ident_hash = p_phone_hash;

  IF v_phone IS NOT NULL THEN
    SELECT plan, pro_until INTO v_wx_plan, v_wx_until
      FROM entitlements WHERE owner_id = p_owner;
    SELECT plan, pro_until INTO v_ph_plan, v_ph_until
      FROM entitlements WHERE owner_id = v_phone;

    IF v_wx_plan = 'lifetime' OR v_ph_plan = 'lifetime' THEN
      v_plan := 'lifetime';
      v_until := NULL;
      v_source := CASE WHEN v_wx_plan = 'lifetime' THEN
        (SELECT source FROM entitlements WHERE owner_id = p_owner)
      ELSE
        (SELECT source FROM entitlements WHERE owner_id = v_phone)
      END;
    ELSIF v_wx_plan = 'pro' OR v_ph_plan = 'pro' THEN
      v_plan := 'pro';
      IF v_wx_plan = 'pro' AND v_ph_plan = 'pro' THEN
        v_until := CASE
          WHEN v_wx_until IS NULL THEN v_ph_until
          WHEN v_ph_until IS NULL THEN v_wx_until
          ELSE GREATEST(v_wx_until, v_ph_until)
        END;
        v_source := COALESCE(
          (SELECT source FROM entitlements WHERE owner_id = p_owner),
          (SELECT source FROM entitlements WHERE owner_id = v_phone)
        );
      ELSIF v_wx_plan = 'pro' THEN
        v_until := v_wx_until;
        v_source := (SELECT source FROM entitlements WHERE owner_id = p_owner);
      ELSE
        v_until := v_ph_until;
        v_source := (SELECT source FROM entitlements WHERE owner_id = v_phone);
      END IF;
    ELSE
      v_plan := NULL;
    END IF;

    IF v_plan IS NOT NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (p_owner, v_plan, v_until, v_source)
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = EXCLUDED.plan,
            pro_until = EXCLUDED.pro_until,
            source = EXCLUDED.source,
            updated_at = now();
    END IF;
    DELETE FROM entitlements WHERE owner_id = v_phone;

    IF EXISTS (SELECT 1 FROM profiles WHERE owner_id = p_owner) THEN
      DELETE FROM profiles WHERE owner_id = v_phone;
    ELSE
      UPDATE profiles SET owner_id = p_owner WHERE owner_id = v_phone;
    END IF;

    IF EXISTS (SELECT 1 FROM invite_links WHERE owner_id = p_owner) THEN
      DELETE FROM invite_links WHERE owner_id = v_phone;
    ELSE
      UPDATE invite_links SET owner_id = p_owner WHERE owner_id = v_phone;
    END IF;

    DELETE FROM weight_logs a
     USING weight_logs b
     WHERE a.owner_id = v_phone AND b.owner_id = p_owner AND a.log_date = b.log_date;
    UPDATE weight_logs SET owner_id = p_owner WHERE owner_id = v_phone;

    DELETE FROM ai_usage a
     USING ai_usage b
     WHERE a.owner_id = v_phone AND b.owner_id = p_owner
       AND a.usage_date = b.usage_date AND a.feature = b.feature;
    UPDATE ai_usage SET owner_id = p_owner WHERE owner_id = v_phone;

    DELETE FROM badges a
     USING badges b
     WHERE a.owner_id = v_phone AND b.owner_id = p_owner AND a.badge_key = b.badge_key;
    UPDATE badges SET owner_id = p_owner WHERE owner_id = v_phone;

    DELETE FROM quota_bonus a
     USING quota_bonus b
     WHERE a.owner_id = v_phone AND b.owner_id = p_owner
       AND a.source = b.source AND a.grant_key = b.grant_key;
    UPDATE quota_bonus SET owner_id = p_owner WHERE owner_id = v_phone;

    DELETE FROM honey_ledger a
     USING honey_ledger b
     WHERE a.owner_id = v_phone AND b.owner_id = p_owner
       AND a.ref_id IS NOT NULL AND a.ref_id = b.ref_id AND a.reason = b.reason;
    UPDATE honey_ledger SET owner_id = p_owner WHERE owner_id = v_phone;

    UPDATE meal_entries SET owner_id = p_owner WHERE owner_id = v_phone;
    UPDATE water_logs SET owner_id = p_owner WHERE owner_id = v_phone;
    UPDATE exercise_logs SET owner_id = p_owner WHERE owner_id = v_phone;
    UPDATE payment_orders SET owner_id = p_owner WHERE owner_id = v_phone;
    UPDATE recipes SET owner_id = p_owner WHERE owner_id = v_phone;
    UPDATE ai_quota_claims SET owner_id = p_owner WHERE owner_id = v_phone;
    UPDATE invite_attempts SET owner_id = p_owner WHERE owner_id = v_phone;
    IF to_regclass('public.redeem_attempts') IS NOT NULL THEN
      UPDATE redeem_attempts SET owner_id = p_owner WHERE owner_id = v_phone;
    END IF;
    UPDATE quota_bonus_newbie_retire_log SET owner_id = p_owner WHERE owner_id = v_phone;

    IF to_regclass('public.apple_transactions') IS NOT NULL THEN
      UPDATE apple_transactions SET owner_id = p_owner WHERE owner_id = v_phone;
    END IF;
    IF to_regclass('public.app_payment_transactions') IS NOT NULL THEN
      UPDATE app_payment_transactions SET owner_id = p_owner WHERE owner_id = v_phone;
    END IF;
    IF to_regclass('public.xpay_transactions') IS NOT NULL THEN
      UPDATE xpay_transactions SET owner_id = p_owner WHERE owner_id = v_phone;
    END IF;

    DELETE FROM app_users WHERE owner_id = v_phone;
  END IF;

  UPDATE app_users
     SET bound_phone_hash = p_phone_hash,
         bound_phone_masked = p_phone_masked
   WHERE owner_id = p_owner;

  RETURN json_build_object('ok', true, 'masked', p_phone_masked, 'merged', v_phone IS NOT NULL);
END;
$fn$;

COMMENT ON FUNCTION public.bind_wechat_phone(text, text, text) IS
  '0060 · 把手机号绑到微信账号。已有手机号账号时合并会员（终身优先、否则取更晚到期）和记录，并停用原手机号账号。只允许网关调用。';

REVOKE ALL ON FUNCTION public.bind_wechat_phone(text, text, text)
  FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.bind_wechat_phone(text, text, text) FROM dbee_web';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.bind_wechat_phone(text, text, text) TO dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_gateway') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.bind_wechat_phone(text, text, text) TO dbee_gateway';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0060: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0060', 'bind-wechat-phone', 'applied', 'self',
          '微信账号可绑定手机号；App 短信登录进入同一 owner，并合并已有手机号账号的会员与记录')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
