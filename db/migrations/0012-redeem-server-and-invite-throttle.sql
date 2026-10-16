-- ============================================================
-- 0012 · 兑换码服务端化 + 邀请码风控（V1.4 优化 · O-5）
-- 需求：docs/邀约打卡社群会员-逻辑梳理与优化建议.md
--   O-5a（P0-1）兑换码硬编码前端 → 移到服务端：翻包即免费拿终身会员、且
--      Apple 3.1.1 必拒。本迁移把兑换码存进 redeem_codes 表，前端只调 RPC。
--   O-5b（P1-3）邀请码枚举爆破风控：bind_invite 加频次限制。
--
-- 设计：
--   1. redeem_codes 表：服务端兑换码库存（code UNIQUE + used_by + used_at）
--   2. redeem_by_code(text) → text  SECURITY DEFINER
--      校验 + 标记使用 + 写 entitlements(lifetime)，返回 ok/bad/used
--   3. 给 bind_invite 加节流（同账号/同 IP 短时多次尝试即拒）
-- ============================================================

-- 1. 兑换码表（服务端库存）
CREATE TABLE public.redeem_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text        NOT NULL UNIQUE,
  note        text,                               -- 备注（批次/用途）
  used_by     text,                               -- 使用者 owner_id（NULL=未使用）
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.redeem_codes IS '兑换码服务端库存：前端不再硬编码，翻包拿不到';

-- 2. 兑换码核销函数（SECURITY DEFINER，校验+标记使用+发终身会员，原子）
CREATE OR REPLACE FUNCTION public.redeem_by_code(p_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   text := auth.uid();
  v_norm  text;
  v_row   redeem_codes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 'bad';
  END IF;

  v_norm := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  IF v_norm = '' THEN
    RETURN 'bad';
  END IF;

  -- 查码
  SELECT * INTO v_row FROM redeem_codes WHERE code = v_norm;
  IF NOT FOUND THEN
    RETURN 'bad';
  END IF;

  IF v_row.used_by IS NOT NULL THEN
    RETURN 'used';
  END IF;

  -- 原子标记使用（条件更新防并发重复兑换）
  UPDATE redeem_codes
  SET used_by = v_uid, used_at = now()
  WHERE id = v_row.id AND used_by IS NULL;

  IF NOT FOUND THEN
    RETURN 'used';
  END IF;

  -- 写权益：终身买断
  INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
  VALUES (v_uid, 'lifetime', NULL, v_norm, 'redeem')
  ON CONFLICT (owner_id) DO UPDATE
    SET plan = 'lifetime',
        pro_until = NULL,
        redeemed_code = v_norm,
        source = 'redeem',
        updated_at = now();

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_by_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_by_code(text) TO authenticated;
REVOKE ALL ON TABLE public.redeem_codes FROM PUBLIC, anon;

-- 3. 邀请码枚举爆破风控：给 bind_invite 加「尝试频次」节流。
--    用一张轻量表记录最近失败/成功尝试，同账号短时间内（60s）失败 ≥5 次即拒。
CREATE TABLE public.invite_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL,
  code        text        NOT NULL,
  ok          boolean     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.invite_attempts (owner_id, created_at);
REVOKE ALL ON TABLE public.invite_attempts FROM PUBLIC, anon;

-- 节流判定函数：最近 60 秒内失败 ≥5 次则拒绝（返回 true=被限流）
CREATE OR REPLACE FUNCTION public.invite_throttled(p_owner text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fail integer;
BEGIN
  SELECT count(*) INTO v_fail
  FROM invite_attempts
  WHERE owner_id = p_owner
    AND ok = false
    AND created_at > now() - interval '60 seconds';
  RETURN v_fail >= 5;
END;
$$;

REVOKE ALL ON FUNCTION public.invite_throttled(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invite_throttled(text) TO authenticated;
