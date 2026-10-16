-- ============================================================
-- 0015 · 权益/积分/额度表级直写通道封堵（P0-0 根因）
--
-- 背景（2026-10-16 二次复查发现的最底层漏洞）：
--   之前的修复（0013/0014）都只加固了「函数层」——grant_honey/grant_photo_bonus/
--   redeem_honey 等加了 SECURITY DEFINER + 白名单。但遗漏了更底层的表级权限：
--
--   honey_ledger / entitlements / quota_bonus / ai_usage / badges / invite_links
--   这 6 张表的 RLS policy 都是 `FOR ALL USING (owner_id = auth.uid())`，且表级
--   GRANT 给了 authenticated 全权限（arwd...）。这意味着任何登录用户可以：
--     - 直接 INSERT honey_ledger 给自己发任意积分（绕过 grant_honey 白名单）
--     - 直接 UPDATE entitlements SET plan='lifetime' 免费拿终身会员
--     - 直接 INSERT quota_bonus 给自己发无限 AI 额度
--     - 直接 UPDATE ai_usage SET count=0 清零免费额度
--
--   函数白名单「治标不治本」——表级直写通道一直敞开着。
--
-- 修复：对这些「必须由服务端函数控制」的表，REVOKE authenticated 的写权限，
--   只保留读权限（前端读流水/余额/权益/徽章），写入统一走 SECURITY DEFINER 函数。
--   同时把两个仍为 INVOKER 的额度函数（consume_ai_quota / get_photo_quota）
--   改为 DEFINER，避免它们以 authenticated 身份运行时被新 REVOKE 误伤。
-- ============================================================

-- 1. consume_ai_quota 改 SECURITY DEFINER（原子占用基础额度，需服务端控制）
CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_usage_date date, p_feature text, p_limit integer, p_amount integer DEFAULT 1)
RETURNS TABLE (allowed boolean, used integer, remaining integer)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
  v_inserted boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;
  IF v_date IS NULL THEN
    v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN
    v_date := v_today;
  END IF;
  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, p_feature, GREATEST(p_amount, 1))
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN
    RETURN QUERY SELECT true, GREATEST(p_amount, 1), GREATEST(p_limit - GREATEST(p_amount, 1), 0);
    RETURN;
  END IF;
  UPDATE ai_usage
     SET count = ai_usage.count + GREATEST(p_amount, 1)
   WHERE ai_usage.owner_id = auth.uid()
     AND ai_usage.usage_date = v_date
     AND ai_usage.feature = p_feature
     AND ai_usage.count + GREATEST(p_amount, 1) <= p_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = p_feature;
    RETURN QUERY SELECT false, COALESCE(v_count, p_limit), 0;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, GREATEST(p_limit - v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_ai_quota(date, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(date, text, integer, integer) TO authenticated;

-- 2. get_photo_quota 改 SECURITY DEFINER（查询额度，需读 quota_bonus/ai_usage）
CREATE OR REPLACE FUNCTION public.get_photo_quota(p_base_limit integer DEFAULT 3)
RETURNS TABLE (base_remaining integer, bonus_remaining integer, total_remaining integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_base_used integer;
  v_bonus integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;
  SELECT COALESCE(SUM(count), 0) INTO v_base_used
    FROM ai_usage
   WHERE owner_id = auth.uid()
     AND usage_date = v_today
     AND feature = 'scan';
  SELECT COALESCE(SUM(amount - consumed), 0) INTO v_bonus
    FROM quota_bonus
   WHERE owner_id = auth.uid()
     AND amount > consumed
     AND expires_at > now();
  base_remaining := GREATEST(p_base_limit - v_base_used, 0);
  bonus_remaining := GREATEST(v_bonus, 0);
  total_remaining := base_remaining + bonus_remaining;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.get_photo_quota(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_photo_quota(integer) TO authenticated;

-- 3. 封堵表级直写：REVOKE authenticated 写权限，仅保留读（写统一走 DEFINER 函数）
-- honey_ledger：前端读流水/余额，写走 grant_honey/bind_invite/settle/redeem/refund/expire
REVOKE ALL ON TABLE public.honey_ledger FROM authenticated;
GRANT SELECT ON TABLE public.honey_ledger TO authenticated;

-- entitlements：前端读权益，写走 redeem_by_code/redeem_honey/settle_invite_checkin
REVOKE ALL ON TABLE public.entitlements FROM authenticated;
GRANT SELECT ON TABLE public.entitlements TO authenticated;

-- quota_bonus：前端不直读（走 get_photo_quota），写走 grant_photo_bonus/consume/release
REVOKE ALL ON TABLE public.quota_bonus FROM authenticated;

-- ai_usage：前端读（getUsage/导出），写走 consume_ai_quota/consume_photo_quota
REVOKE ALL ON TABLE public.ai_usage FROM authenticated;
GRANT SELECT ON TABLE public.ai_usage TO authenticated;

-- badges：前端读（成就墙），写走 unlock_badge
REVOKE ALL ON TABLE public.badges FROM authenticated;
GRANT SELECT ON TABLE public.badges TO authenticated;

-- invite_links：前端读 + 创建自己的邀请码（getMyInviteCode），禁止改/删
REVOKE ALL ON TABLE public.invite_links FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.invite_links TO authenticated;
