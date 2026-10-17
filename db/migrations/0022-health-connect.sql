-- ═══════════════════════════════════════════════════════════════
-- 0022 · Apple 健康连接状态（云端唯一真相源）
--
-- 背景（2026-10-17）：
--   用户需求：iOS 用户点「连接 Apple 健康」→ 弹 HealthKit 授权 →
--   授权后存连接状态，下次登录自动获取步数/活动能量，且连接按钮消失。
--   连接状态需跨设备一致（换设备/重装后仍记住），故存 profiles（一人一行）。
--
-- 字段：
--   health_connected    是否已连接（授权成功才置 true）
--   health_connected_at 连接时间（审计/排序用）
--
-- 前端经 saveProfile 写入（PROFILE_WRITABLE 已加这两个字段），无需新 RPC。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ADD COLUMN health_connected boolean;
ALTER TABLE public.profiles ADD COLUMN health_connected_at timestamptz;

COMMENT ON COLUMN public.profiles.health_connected IS '是否已连接 Apple 健康（授权成功才置 true，云端唯一真相源）';
COMMENT ON COLUMN public.profiles.health_connected_at IS 'Apple 健康连接时间';
