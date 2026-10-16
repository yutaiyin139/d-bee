-- ============================================================
-- 0009 · 邀请奖励闭环补齐（V1.3.0）
-- 背景：0008 只建了表/基础函数，但「绑定关系」和「发积分」是分离的，
--   且 grant_honey 是 SECURITY INVOKER（auth.uid()=调用者），
--   新用户无法给「邀请人」发积分（邀请人是另一个 uid）。
--   本 migration 补齐三个原子函数，完整跑通邀请闭环。
--
-- 新增：
--   1. bind_invite(p_code) → text
--      绑定邀请关系 + 双向发积分（新人 +100 / 邀请人 +50），原子完成。
--   2. settle_invite_checkin() → boolean
--      受邀人 7 日内打卡≥5 天达标后：新人 +200 + 7天Pro，邀请人 +250。
--   3. count_invitees() → json
--      我的邀请记录统计（已绑定好友数 + 达标好友数），供邀请面板展示。
-- ============================================================

-- ── 1. 绑定邀请关系 + 双向发积分 ─────────────────────────────
-- SECURITY DEFINER：需要给「邀请人」（另一个 uid）发积分，必须绕过 RLS。
-- 返回文本状态码：ok / invalid / self / already（与前端 bindInvite 契约一致）。
-- 安全约束：只返回状态码，不泄露邀请人信息；REVOKE anon，仅 authenticated 可执行。
CREATE OR REPLACE FUNCTION bind_invite(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid     text := auth.uid();
  v_inviter text;
  v_already  text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN 'invalid';
  END IF;

  -- 已在 bind 前由前端幂等判断；此处 DB 层再兜底一次
  SELECT invited_by INTO v_already FROM profiles WHERE owner_id = v_uid;
  IF v_already IS NOT NULL THEN
    RETURN 'already';
  END IF;

  -- 按码查邀请人（大小写/空格归一）
  SELECT owner_id INTO v_inviter FROM invite_links
    WHERE code = upper(trim(p_code)) LIMIT 1;

  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    RETURN CASE WHEN v_inviter = v_uid THEN 'self' ELSE 'invalid' END;
  END IF;

  -- 写绑定关系（profiles.invited_by 有 partial unique 兜底并发）
  UPDATE profiles
     SET invited_by = v_inviter,
         invite_code = upper(trim(p_code)),
         updated_at = now()
   WHERE owner_id = v_uid;

  -- 新人注册奖励 +100（reason + ref_id 防重复）
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 100, 'invitee_register', 'bind-' || v_inviter,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  -- 邀请人注册奖励 +50
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 50, 'inviter_register', 'invitee-' || v_uid,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  RETURN 'ok';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION bind_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bind_invite(text) TO authenticated;

-- ── 2. 受邀人 7 日打卡达标 → 双向奖励 ─────────────────────────
-- 达标口径：注册（绑定时）起 7 个自然日内，累计 ≥5 天有饮食记录。
-- 新人 +200 + 7 天 Pro；邀请人 +250。
-- ref_id 用 'settle-' || 邀请人id，确保同一对关系只发一次。
CREATE OR REPLACE FUNCTION settle_invite_checkin()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid       text := auth.uid();
  v_inviter   text;
  v_bind_date date;
  v_logged_days integer;
  v_ent       bigint;
  v_plan      text;
  v_until     timestamptz;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  SELECT invited_by, created_at::date INTO v_inviter, v_bind_date
    FROM profiles WHERE owner_id = v_uid;
  IF v_inviter IS NULL THEN
    RETURN false;  -- 未被邀请，无达标奖励
  END IF;

  -- 绑定日起 7 个自然日内，有饮食记录的天数（date 类型直接比较，避免时区歧义）
  SELECT count(DISTINCT log_date) INTO v_logged_days
    FROM meal_entries
   WHERE owner_id = v_uid
     AND log_date >= v_bind_date
     AND log_date <= v_bind_date + interval '6 days';

  IF v_logged_days < 5 THEN
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

-- ── 3. 邀请记录统计 ─────────────────────────────────────────
-- 返回 {invitees, settled}：已绑定好友数 + 已达标好友数。
-- SECURITY DEFINER：需跨用户统计 profiles 中 invited_by = 我的好友。
CREATE OR REPLACE FUNCTION count_invitees()
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT json_build_object(
    'invitees', (SELECT count(*) FROM profiles WHERE invited_by = auth.uid()),
    'settled',
      (SELECT count(*) FROM honey_ledger hl
        WHERE hl.owner_id = auth.uid()
          AND hl.reason = 'inviter_checkin')
  )
$fn$;

REVOKE EXECUTE ON FUNCTION count_invitees() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION count_invitees() TO authenticated;
