-- ═══════════════════════════════════════════════════════════════
-- 0017 · 邀请绑定关系修复（时序竞态 + 达标窗口基准）
--
-- 背景（2026-10-17 用户测试发现 + 云端数据核对）：
--   用户用邀请码拉新，honey_ledger 里已有 inviter_register +50 / invitee_register +100，
--   但 profiles.invited_by / invite_code 全 null，导致：
--     1. 邀请面板「已邀请 N 人」恒为 0（count_invitees 依赖 profiles.invited_by）
--     2. settle_invite_checkin 因 invited_by 为 null 直接 RETURN false，7 日达标奖励
--        （新人 +200+7天Pro / 邀请人 +250）永不结算
--
-- 根因（两个）：
--   A. 时序竞态：bind_invite 在注册 verifyOtp 后立即调用，此时 profiles 行尚不存在
--      （profiles 是首次进入 Onboarding 完善资料时才由 saveProfile INSERT），
--      旧版 `UPDATE profiles SET invited_by=... WHERE owner_id=v_uid` 匹配 0 行静默失败；
--      而发积分是直接 INSERT honey_ledger（不依赖 profiles 行），故「积分照发、绑定丢失」。
--   B. 窗口基准错：settle_invite_checkin 用 `profiles.created_at::date` 当「绑定日」，
--      但 created_at 是 profiles 行首次 INSERT（完善资料）时间，非绑定邀请码时间，
--      两者可差几小时到几天，导致「7 日内打卡 ≥5 天」窗口起点不准。
--
-- 修复方案：
--   1. profiles 新增 invited_at 字段（记录绑定时刻，不复用 created_at）
--   2. bind_invite 重写：profiles 行不存在 → 先 INSERT(owner_id, invited_by, invite_code, invited_at)
--      再写绑定；已存在 → UPDATE。发积分逻辑不变。
--   3. settle_invite_checkin 重写：窗口基准改用 invited_at::date（缺失时回退 created_at::date，
--      兼容回填前的旧数据）。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate（逐条执行，单次不支持多语句）
-- ═══════════════════════════════════════════════════════════════

-- 1. profiles 新增绑定时间戳（NULL 兼容存量数据）
ALTER TABLE public.profiles ADD COLUMN invited_at timestamptz;
COMMENT ON COLUMN public.profiles.invited_at IS '绑定邀请码的时刻（邀请关系建立时间，7日达标窗口基准）';

-- 2. bind_invite 重写：修复 profiles 行不存在时的绑定丢失
CREATE OR REPLACE FUNCTION public.bind_invite(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid          text := auth.uid();
  v_inviter      text;
  v_already      text;
  v_norm         text;
  v_month_honey  integer;
  v_profile_row  public.profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN 'invalid';
  END IF;

  IF (SELECT public.invite_throttled(v_uid)) THEN
    RETURN 'throttled';
  END IF;

  v_norm := upper(trim(coalesce(p_code, '')));
  IF v_norm = '' THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, '', false);
    RETURN 'invalid';
  END IF;

  -- 已绑定过则拒绝（幂等语义：一人只能被邀请一次）
  SELECT invited_by INTO v_already FROM profiles WHERE owner_id = v_uid;
  IF v_already IS NOT NULL THEN
    RETURN 'already';
  END IF;

  SELECT owner_id INTO v_inviter FROM invite_links WHERE code = v_norm LIMIT 1;
  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN CASE WHEN v_inviter = v_uid THEN 'self' ELSE 'invalid' END;
  END IF;

  INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, true);

  -- 【核心修复】profiles 行可能尚未创建（注册后、完善资料前）。
  -- 用 UPSERT 语义：不存在则创建仅含 owner_id + 绑定关系的行；存在则更新绑定关系。
  -- 这样无论时序如何，绑定关系都会落库，且 invited_at 精确记录绑定时刻。
  SELECT * INTO v_profile_row FROM public.profiles WHERE owner_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO public.profiles (owner_id, invited_by, invite_code, invited_at)
    VALUES (v_uid, v_inviter, v_norm, now());
  ELSE
    UPDATE public.profiles
       SET invited_by = v_inviter,
           invite_code = v_norm,
           invited_at = now(),
           updated_at = now()
     WHERE owner_id = v_uid;
  END IF;

  -- 新人注册奖励 +100（reason + ref_id 防重复）
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 100, 'invitee_register', 'bind-' || v_inviter,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  -- 邀请人注册奖励 +50（受月度返佣 3000 上限约束）
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey
    FROM honey_ledger
   WHERE owner_id = v_inviter
     AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 50 <= 3000 THEN
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_inviter, 50, 'inviter_register', 'invitee-' || v_uid,
            now() + make_interval(days => 365))
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN 'ok';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION bind_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bind_invite(text) TO authenticated;

-- 3. settle_invite_checkin 重写：窗口基准改用 invited_at（缺失回退 created_at）
CREATE OR REPLACE FUNCTION public.settle_invite_checkin()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid        text := auth.uid();
  v_inviter    text;
  v_bind_date  date;
  v_logged_days integer;
  v_ent        bigint;
  v_plan       text;
  v_until      timestamptz;
  v_month_honey integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  -- 绑定日：优先 invited_at（真实绑定时刻），回填前的旧数据缺失时回退 created_at
  SELECT invited_by,
         COALESCE(invited_at::date, created_at::date)
    INTO v_inviter, v_bind_date
    FROM profiles WHERE owner_id = v_uid;
  IF v_inviter IS NULL THEN
    RETURN false;  -- 未被邀请，无达标奖励
  END IF;

  -- 绑定日起 7 个自然日内，有饮食记录的天数
  SELECT count(DISTINCT log_date) INTO v_logged_days
    FROM meal_entries
   WHERE owner_id = v_uid
     AND log_date >= v_bind_date
     AND log_date <= v_bind_date + interval '6 days';

  IF v_logged_days < 5 THEN
    RETURN false;
  END IF;

  -- 邀请人月度返佣上限校验
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey
    FROM honey_ledger
   WHERE owner_id = v_inviter
     AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 250 > 3000 THEN
    RETURN false;
  END IF;

  -- 防重复：同一对关系只发一次（reason+ref_id UNIQUE 兜底）
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 200, 'invitee_checkin', 'settle-' || v_inviter,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 250, 'inviter_checkin', 'settle-' || v_uid,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  -- 新人 7 天 Pro（非 lifetime 时顺延）
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until
    FROM entitlements WHERE owner_id = v_uid;
  IF v_plan IS DISTINCT FROM 'lifetime' THEN
    IF v_ent IS NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_uid, 'pro', now() + make_interval(days => 7), 'invite');
    ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
      UPDATE entitlements SET pro_until = v_until + make_interval(days => 7), updated_at = now()
       WHERE id = v_ent;
    ELSE
      UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => 7), updated_at = now()
       WHERE id = v_ent;
    END IF;
  END IF;

  RETURN true;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION settle_invite_checkin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION settle_invite_checkin() TO authenticated;
