-- ============================================================
-- 0006 · 拍照额度奖励体系（连续打卡 / 完善资料）
-- 需求（V1.1.1）：
--   1. 免费每日 AI 拍照识别由 10 次改为 3 次（前端常量 FREE_DAILY_AI）
--   2. 连续打卡 7 天奖励 2 次拍照额度，7 天有效、不可长期囤积
--   3. 完善个人身体数据（身高/体重/减脂目标）一次性赠送 3 次（新手奖励）
--   4. 只有 AI 拍照识别消耗次数；手动录入/体重/饮水/文字解析/包装识别/AI 问答不计
--   5. 自然日 0 点重置，基础额度不累计
--   6. 识别失败不扣次数（已由前端 refund 实现）
--
-- 设计：
--   基础额度（3 次/日）继续走 ai_usage(feature='scan') + consume_ai_quota，
--   自然日重置、不累计。奖励额度单独存 quota_bonus 表，带 expires_at 过期时间，
--   「防囤」靠过期时间实现；「防重复领取」靠 grant_key 唯一约束。
-- ============================================================

-- 奖励额度表：一人可有多条奖励（不同来源/批次）
CREATE TABLE public.quota_bonus (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  -- 奖励来源：newbie（完善资料新手奖励）/ streak7（连续打卡 7 天）
  source      text        NOT NULL,
  -- 该来源的领取标识：newbie 固定 'newbie'（一人只能领一次）；streak7 用 'YYYY-MM-DD'
  -- 标识「在哪一天达成的 7 连」，同一天不重复发。
  grant_key   text        NOT NULL,
  -- 奖励的次数
  amount      integer     NOT NULL DEFAULT 0,
  -- 已消耗次数（amount - consumed = 剩余余额）
  consumed    integer     NOT NULL DEFAULT 0,
  -- 过期时间：连续打卡奖励 7 天有效；新手奖励 7 天有效（防囤积）
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 同一来源同一标识只能发一次（防重复领取）
  UNIQUE (owner_id, source, grant_key)
);

-- RLS：用户只能读写自己的奖励
ALTER TABLE public.quota_bonus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quota_bonus_own ON public.quota_bonus;
CREATE POLICY quota_bonus_own ON public.quota_bonus FOR ALL
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- 权限：只授予 authenticated，anon 撤销
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quota_bonus TO authenticated;
REVOKE ALL ON public.quota_bonus FROM anon;

-- 发放奖励：靠 UNIQUE(owner_id, source, grant_key) 防重复领取，
-- 并发/重复调用第二次会 ON CONFLICT DO NOTHING 静默跳过，返回是否实际发放。
CREATE OR REPLACE FUNCTION grant_photo_bonus(
  p_source text,
  p_grant_key text,
  p_amount integer,
  p_ttl_days integer DEFAULT 7
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
  VALUES (auth.uid(), p_source, p_grant_key, GREATEST(p_amount, 0), 0,
          now() + make_interval(days => GREATEST(p_ttl_days, 1)))
  ON CONFLICT (owner_id, source, grant_key) DO NOTHING;
  RETURN FOUND;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION grant_photo_bonus(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION grant_photo_bonus(text, text, integer, integer) TO authenticated;
