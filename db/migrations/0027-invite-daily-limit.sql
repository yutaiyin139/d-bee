-- ═══════════════════════════════════════════════════════════════
-- 0027 · 邀请码单日绑定频次限制（P1-2 邀请风控补齐）
--
-- 背景：0012 加了「枚举爆破节流」（60s 内失败 ≥5 次），0017 加了「月度返佣
--   3000 上限」，但「同一邀请码单日被新用户成功绑定 ≤10 次」这条仍缺——
--   单码可被无限次绑定（例如邀请码被公开转发、羊毛党批量注册），导致返佣
--   被刷、异常邀请无法识别。
--
-- 本迁移在 bind_invite 成功分支前增加单码单日频次校验：
--   - 复用 invite_attempts 表（0012 已建，记录每次尝试的 code + ok 标志），
--     统计「当日该 code 成功（ok=true）次数」，≥10 则返回 'daily_limit'。
--   - 时区统一 Asia/Shanghai（与月度返佣上限口径一致）。
--   - 新增状态码 'daily_limit' 不破坏前端旧契约（前端 bindInvite 对未知码
--     一律回退 'invalid'，展示「邀请码无效」，后续可扩展为「该邀请码今日已达上限」）。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate
-- ═══════════════════════════════════════════════════════════════

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
  v_daily_binds  integer;
  v_profile_row  public.profiles%ROWTYPE;
  v_today_ts     timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
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

  -- 【新增】同一邀请码单日成功绑定 ≤10 次（防码被公开转发 / 羊毛党批量注册刷返佣）
  SELECT count(*) INTO v_daily_binds
    FROM invite_attempts
   WHERE code = v_norm
     AND ok = true
     AND created_at >= v_today_ts;
  IF v_daily_binds >= 10 THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN 'daily_limit';
  END IF;

  INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, true);

  -- 写绑定关系（profiles 行可能尚未创建，UPSERT 语义，见 0017）
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

REVOKE EXECUTE ON FUNCTION public.bind_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bind_invite(text) TO authenticated;
