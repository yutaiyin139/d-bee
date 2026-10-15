-- ============================================================
-- 0005 · 会员三档：free / pro / lifetime
-- 需求：V1.1 会员体系从「免费 / Pro 订阅」扩展为「免费 / Pro 订阅 / 终身买断」。
--   - plan 取值新增 'lifetime'（终身买断，pro_until 恒 null）
--   - pro 订阅带 pro_until 过期时间，到期回落 free
--   - entitlements 新增 source 列记录支付来源（redeem/wechat/alipay/apple/google）
--
-- 改动最小化原则：plan 本就是 text 列，无需改类型；只补 check 约束 + source 列。
-- 现有数据（plan in free/pro）不受影响。
-- ============================================================

-- 1) source 列（支付来源，可空；老数据为 null 视为未知/兑换）
ALTER TABLE public.entitlements
  ADD COLUMN IF NOT EXISTS source text;

-- 2) plan 取值约束（把非法值挡在数据库层）
--    若已有非法值会失败，这里先做一次收敛再挂约束更稳妥：
--    lifetime 尚未产生，free/pro 均为合法，直接挂约束即可。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entitlements_plan_check'
      AND conrelid = 'public.entitlements'::regclass
  ) THEN
    ALTER TABLE public.entitlements
      ADD CONSTRAINT entitlements_plan_check
      CHECK (plan IN ('free', 'pro', 'lifetime'));
  END IF;
END $$;
