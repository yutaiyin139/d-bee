-- ============================================================
-- 0008 · 邀约拉新 + 蜜糖积分 + 成就徽章（V1.2.0 邀约机制）
-- 需求：见 docs/邀约拉新机制实施方案.md（v3 定稿）
--   1. 邀请关系：老用户生成邀请码，新用户注册绑定，绑定后不可改
--   2. 蜜糖积分（消耗型积分）：流水式记账，正负入账，余额=SUM
--   3. 成就徽章：一人多枚，去重解锁
--   4. profiles 加 invited_by / invite_code 两列承载邀请绑定
--   5. get_inviter_by_code 安全函数（SECURITY DEFINER，绕过 RLS 按码查邀请人）
--
-- 积分来源 reason 枚举：
--   checkin_daily / checkin_water / checkin_exercise（每日打卡）
--   streak_milestone（连续打卡里程碑）
--   invitee_register / invitee_checkin（新人注册/达标）
--   inviter_register / inviter_checkin（邀请人注册/达标）
--   redeem（兑换消耗，负）/ expire（过期失效，负）/ refund（风控扣回，负）
-- ============================================================

-- 1. 邀请码表（一人一码，码唯一）
CREATE TABLE public.invite_links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid() UNIQUE,
  code        text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.invite_links IS '邀约邀请码：一人一码，新用户注册时绑定';

-- 2. 蜜糖积分账本（流水式，正负记账）
CREATE TABLE public.honey_ledger (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  amount      integer     NOT NULL,
  reason      text        NOT NULL,
  ref_id      text,                              -- 关联标识（日期/关系id等，与 reason 组合防重复）
  expires_at  timestamptz,                       -- 入账有效期（1 年）
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.honey_ledger IS '蜜糖积分账本：正负流水记账，余额=SUM(amount)';
CREATE INDEX ON public.honey_ledger (owner_id, created_at);
-- 防重复：同一 reason + ref_id 只能入账一次（打卡/里程碑/邀请奖励去重）
CREATE UNIQUE INDEX honey_ledger_once ON public.honey_ledger (owner_id, reason, ref_id)
  WHERE ref_id IS NOT NULL;

-- 3. 成就徽章表（一人多枚，去重）
CREATE TABLE public.badges (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     text        NOT NULL DEFAULT auth.uid(),
  badge_key    text        NOT NULL,
  unlocked_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, badge_key)
);
COMMENT ON TABLE public.badges IS '成就徽章：一人多枚，badge_key 去重';

-- 4. profiles 加邀请绑定列
ALTER TABLE public.profiles ADD COLUMN invited_by text;
ALTER TABLE public.profiles ADD COLUMN invite_code text;
COMMENT ON COLUMN public.profiles.invited_by IS '邀请人 owner_id（绑定后不可改）';
COMMENT ON COLUMN public.profiles.invite_code IS '新人注册时填写的邀请码（审计用）';
-- ⚠️ 原约束方向错误（已在 0019 修正）：这里曾建在 invited_by 上，语义变成
--   「一个邀请人只能邀请一个新用户」。正确语义是「一个新人只能被邀请一次」，
--   应在 owner_id（新人）上建唯一。见 0019-invite-once-fix.sql。
CREATE UNIQUE INDEX profiles_invited_once ON public.profiles (owner_id)
  WHERE invited_by IS NOT NULL;
