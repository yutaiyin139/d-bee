-- ============================================================
-- 0013 · 积分体系安全加固（审计后修复 P0-0/P0-1/P1-3/P2-1 + ai1Scan 上限）
--
-- 背景：2026-10-16 逐文件审计收费/邀请体系，导出云端真实 DDL 后确认：
--
--   P0-0  grant_honey 是 SECURITY INVOKER 且无任何入参校验：
--         任何登录用户在 devtools 调 RPC grant_honey('x','y',999999999)
--         即可给自己发任意积分，再用 redeem_honey 换终身会员 —— 最致命漏洞。
--
--   P0-1  bind_invite 未接节流：0012 建了 invite_attempts + invite_throttled
--         但没重写 bind_invite 函数体，风控空转。
--
--   P1-3  打卡积分删除收回只覆盖 checkin_meal，饮水(+2)/运动(+2)删除不收回，
--         且 ref_id 是日期，当天删了再记可反复刷分。
--
--   P2-1  月度邀请返佣 3000 分上限是死代码，邀请返佣无上限。
--
--   新增  ai1Scan 兑换单日上限 5 次（用户决策）。
--
-- 本 migration 一次性修复上述全部问题。
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 0. grant_photo_bonus 重写（复查时补充发现的同类漏洞）
--    原实现同样是 SECURITY INVOKER + 无入参校验，任何人可 RPC 给自己
--    发任意 AI 拍照额度绕过免费 3 次限制。
--    改为 SECURITY DEFINER + source 白名单（newbie=3/streak7=2/honey=1）
--    + ttl 上限 7 天。
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.grant_photo_bonus(
  p_source text,
  p_grant_key text,
  p_amount integer,
  p_ttl_days integer DEFAULT 7
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_ok  boolean := false;
  v_max_ttl integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;
  IF p_grant_key IS NULL OR btrim(p_grant_key) = '' THEN
    RETURN false;
  END IF;
  IF p_source = 'newbie' THEN
    v_ok := p_amount = 3; v_max_ttl := 7;
  ELSIF p_source = 'streak7' THEN
    v_ok := p_amount = 2; v_max_ttl := 7;
  ELSIF p_source = 'honey' THEN
    v_ok := p_amount = 1; v_max_ttl := 7;
  ELSE
    v_ok := false;
  END IF;
  IF NOT v_ok THEN
    RETURN false;
  END IF;
  IF p_ttl_days > v_max_ttl THEN
    RETURN false;
  END IF;
  INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
  VALUES (v_uid, p_source, p_grant_key, p_amount, 0,
          now() + make_interval(days => p_ttl_days))
  ON CONFLICT (owner_id, source, grant_key) DO NOTHING;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_photo_bonus(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_photo_bonus(text, text, integer, integer) TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 1. grant_honey 重写：SECURITY DEFINER + reason 白名单 + 金额校验
-- ════════════════════════════════════════════════════════════
-- 设计：
--   - 改为 SECURITY DEFINER（以函数 owner 身份运行，防止调用方伪造 auth.uid()）
--     但 owner_id 仍写 auth.uid()（当前登录用户），语义不变。
--   - reason 白名单：只允许前端已知的 4 种打卡/里程碑来源。
--   - amount 校验：每个 reason 有固定的合法金额集合，超范围直接拒绝。
--   - ref_id 非空校验：防重复依赖 UNIQUE(owner_id, reason, ref_id)，空 ref_id 会绕过。
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.grant_honey(
  p_reason text,
  p_ref_id text,
  p_amount integer,
  p_ttl_days integer DEFAULT 365
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_ok  boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  -- ref_id 必须非空（防重复的唯一约束依赖它，空值会绕过去重）
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN
    RETURN false;
  END IF;

  -- reason 白名单 + 金额校验（streak_milestone 为 7 档固定值）
  IF p_reason = 'checkin_meal' THEN
    v_ok := p_amount = 5;
  ELSIF p_reason = 'checkin_water' THEN
    v_ok := p_amount = 2;
  ELSIF p_reason = 'checkin_exercise' THEN
    v_ok := p_amount = 2;
  ELSIF p_reason = 'streak_milestone' THEN
    v_ok := p_amount IN (15, 40, 80, 120, 200, 400, 800);
  ELSE
    v_ok := false;  -- 未知 reason 一律拒绝
  END IF;

  IF NOT v_ok THEN
    RETURN false;
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, p_amount, p_reason, p_ref_id,
          now() + make_interval(days => GREATEST(p_ttl_days, 1)))
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_honey(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_honey(text, text, integer, integer) TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 2. unlock_badge 加 badge_key 白名单（一致性加固，危害低但顺手补）
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.unlock_badge(p_badge_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;
  -- 12 枚徽章白名单（与 src/lib/badge.ts BADGES 对齐）
  IF p_badge_key NOT IN (
    'streak_3','streak_7','streak_21','streak_100',
    'photo_50','scan_30','recipe_3',
    'water_10','exercise_20','lose_3kg',
    'invite_3','invite_top'
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO badges (owner_id, badge_key) VALUES (v_uid, p_badge_key)
  ON CONFLICT (owner_id, badge_key) DO NOTHING;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_badge(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlock_badge(text) TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 3. redeem_honey 重写：ai1Scan 加单日上限 5 次 + 明确 ref_id
-- ════════════════════════════════════════════════════════════
-- 改动：
--   - ai1Scan 分支：先统计当日已兑换次数（honey_ledger reason='redeem'
--     且 ref_id='ai-'||今天 的负流水数），>=5 则拒绝。
--   - ai1Scan 负流水 ref_id 写 'ai-'||今天，使单日计数可精确统计。
--   - 其余逻辑（扣分 + 发权益原子性、lifetime 拒绝）不变。
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.redeem_honey(p_kind text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost     integer;
  v_days     integer;
  v_uid      text := auth.uid();
  v_balance  integer;
  v_ent      bigint;
  v_plan     text;
  v_until    timestamptz;
  v_today    text;
  v_ai_today integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  -- 兑换价
  IF p_kind = 'pro1Day' THEN
    v_cost := 100; v_days := 1;
  ELSIF p_kind = 'pro30Day' THEN
    v_cost := 2600; v_days := 30;
  ELSIF p_kind = 'ai1Scan' THEN
    v_cost := 50; v_days := 0;
  ELSE
    RETURN false;
  END IF;

  -- 余额 = 未过期入账 − 消耗（负流水），不足则拒绝
  SELECT COALESCE(SUM(amount), 0) INTO v_balance
    FROM honey_ledger
   WHERE owner_id = v_uid
     AND (expires_at IS NULL OR expires_at > now());
  IF v_balance < v_cost THEN
    RETURN false;
  END IF;

  -- ai1Scan：单日兑换上限 5 次（用户决策：每日免费 3 次 + 积分单日上限 5 次）
  IF p_kind = 'ai1Scan' THEN
    v_today := to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD');
    SELECT count(*) INTO v_ai_today
      FROM honey_ledger
     WHERE owner_id = v_uid
       AND reason = 'redeem'
       AND ref_id = 'ai-' || v_today
       AND amount < 0;
    IF v_ai_today >= 5 THEN
      RETURN false;
    END IF;

    -- 扣积分（ref_id 标记日期，供单日上限统计）
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_uid, -v_cost, 'redeem', 'ai-' || v_today, NULL);

    -- 发放 AI 拍照额度（走 quota_bonus，与免费基础额度叠加，7 天有效）
    INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
    VALUES (v_uid, 'honey', 'redeem-' || to_char(now(), 'YYYYMMDDHH24MISSMS'),
            1, 0, now() + make_interval(days => 7));
    RETURN true;
  END IF;

  -- Pro 兑换：lifetime 拒绝
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until
    FROM entitlements WHERE owner_id = v_uid;
  IF v_plan = 'lifetime' THEN
    RETURN false;
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, -v_cost, 'redeem', NULL, NULL);

  IF v_ent IS NULL THEN
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_uid, 'pro', now() + make_interval(days => v_days), 'honey');
  ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
    UPDATE entitlements SET pro_until = v_until + make_interval(days => v_days), updated_at = now()
     WHERE id = v_ent;
  ELSE
    UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => v_days), updated_at = now()
     WHERE id = v_ent;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_honey(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_honey(text) TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 4. bind_invite 重写：接入节流（P0-1）
-- ════════════════════════════════════════════════════════════
-- 在 0009 基础上增加：
--   - 开头判 invite_throttled(auth.uid())，被限流返回 'throttled'
--   - 每次尝试（成功/失败）写 invite_attempts（含 code + ok）
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.bind_invite(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     text := auth.uid();
  v_inviter text;
  v_already text;
  v_norm    text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN 'invalid';
  END IF;

  -- 节流：60 秒内失败 ≥5 次则拒绝（防枚举爆破）
  IF (SELECT public.invite_throttled(v_uid)) THEN
    RETURN 'throttled';
  END IF;

  v_norm := upper(trim(coalesce(p_code, '')));
  IF v_norm = '' THEN
    -- 空码也记一次失败尝试，防止高频空请求
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, '', false);
    RETURN 'invalid';
  END IF;

  -- 已在绑定（幂等）
  SELECT invited_by INTO v_already FROM profiles WHERE owner_id = v_uid;
  IF v_already IS NOT NULL THEN
    RETURN 'already';
  END IF;

  -- 按码查邀请人
  SELECT owner_id INTO v_inviter FROM invite_links WHERE code = v_norm LIMIT 1;

  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    -- 失败尝试记录（供节流统计）
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN CASE WHEN v_inviter = v_uid THEN 'self' ELSE 'invalid' END;
  END IF;

  -- 成功尝试记录
  INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, true);

  -- 写绑定关系
  UPDATE profiles
     SET invited_by = v_inviter, invite_code = v_norm, updated_at = now()
   WHERE owner_id = v_uid;

  -- 双向发积分（新人 +100 / 邀请人 +50）
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 100, 'invitee_register', 'bind-' || v_inviter,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 50, 'inviter_register', 'invitee-' || v_uid,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.bind_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bind_invite(text) TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 5. 打卡积分删除收回扩展到饮水/运动（P1-3）
-- ════════════════════════════════════════════════════════════
-- 原 refund_checkin_honey_by_date 只收回 checkin_meal。现扩展为：收回该日
-- 已发但当前不再达标的 checkin_water / checkin_exercise 积分。
-- 策略：删除/撤销后调用，按「当日是否仍有达标记录」判定是否收回。
--
-- 由于饮水/运动的「达标」判定依赖具体记录（饮水达标=总量≥目标，运动达标=有≥1条），
-- 删除/撤销后若当天不再达标，应收回。这里提供两个新函数，与前端撤销入口对齐。
-- ════════════════════════════════════════════════════════════

-- 5a. 收回饮水积分：删除/撤销饮水后，若当日总量不再达标且已发 checkin_water 未退，则收回
CREATE OR REPLACE FUNCTION public.refund_checkin_water_by_date(p_log_date text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      text := auth.uid();
  v_total    integer;
  v_target   numeric;
  v_granted  integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN
    RETURN false;
  END IF;

  -- 当日饮水总量
  SELECT COALESCE(SUM(amount_ml), 0) INTO v_total
    FROM water_logs WHERE owner_id = v_uid AND log_date = p_log_date;

  -- 饮水目标（体重×35ml，缺体重按 60kg，与前端一致）
  SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_target
    FROM profiles WHERE owner_id = v_uid;
  v_target := COALESCE(v_target, 2100);

  -- 仍达标则不收回
  IF v_total >= v_target THEN
    RETURN false;
  END IF;

  -- 已发未退的 checkin_water
  SELECT COALESCE(SUM(amount), 0) INTO v_granted
    FROM honey_ledger
   WHERE owner_id = v_uid AND reason = 'checkin_water' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN
    RETURN false;
  END IF;

  -- 幂等
  PERFORM 1 FROM honey_ledger
   WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'water:' || p_log_date;
  IF FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id)
  VALUES (v_uid, -v_granted, 'refund', 'water:' || p_log_date);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_checkin_water_by_date(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_checkin_water_by_date(text) TO authenticated;

-- 5b. 收回运动积分：删除运动后，若当日已无运动记录且已发 checkin_exercise 未退，则收回
CREATE OR REPLACE FUNCTION public.refund_checkin_exercise_by_date(p_log_date text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      text := auth.uid();
  v_count    integer;
  v_granted  integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_count
    FROM exercise_logs WHERE owner_id = v_uid AND log_date = p_log_date;

  -- 仍有运动记录则不收回
  IF v_count > 0 THEN
    RETURN false;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_granted
    FROM honey_ledger
   WHERE owner_id = v_uid AND reason = 'checkin_exercise' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM honey_ledger
   WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'exercise:' || p_log_date;
  IF FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id)
  VALUES (v_uid, -v_granted, 'refund', 'exercise:' || p_log_date);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_checkin_exercise_by_date(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_checkin_exercise_by_date(text) TO authenticated;
