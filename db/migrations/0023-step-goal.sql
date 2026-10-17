-- ═══════════════════════════════════════════════════════════════
-- 0023 · profiles 加 step_goal（每日步数目标）
--
-- 背景（2026-10-17）：运动卡片健康数据展示需要步数目标作进度条分母。
-- 步数目标不应写死，而是用户可在「我的 → 身体数据与目标」里自定义；
-- 默认 6000，前端缺省时按默认值展示。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ADD COLUMN step_goal integer;

COMMENT ON COLUMN public.profiles.step_goal IS '每日步数目标（默认 6000，用户可在「我的」里自定义）';
