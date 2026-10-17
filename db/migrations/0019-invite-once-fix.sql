-- ═══════════════════════════════════════════════════════════════
-- 0019 · 修复 profiles_invited_once 唯一索引方向
--
-- 背景（2026-10-17 用户测试发现）：
--   0008 迁移把「一人只能被邀请一次」的唯一索引错误地建在了 invited_by 上：
--     CREATE UNIQUE INDEX profiles_invited_once ON profiles (invited_by)
--       WHERE invited_by IS NOT NULL;
--   这导致语义变成「一个邀请人只能邀请一个新用户」—— 第二个新人绑定同一邀请码时，
--   UPDATE profiles SET invited_by=... 会撞唯一约束直接失败，拉新闭环在第二人处断掉。
--
-- 正确语义：一个「新人（owner_id）」只能被邀请一次；一个「邀请人」可邀请多人。
--   故唯一约束应建在 owner_id 上（invited_by 非空时）。
--
-- 修复：删旧索引 → 建正确索引。幂等（IF EXISTS / IF NOT EXISTS）。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate
-- ═══════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS public.profiles_invited_once;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_invited_once
  ON public.profiles (owner_id)
  WHERE (invited_by IS NOT NULL);
