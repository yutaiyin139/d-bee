-- ════════════════════════════════════════════════════════════════════════════
-- 0020 AI 数据处理显式同意字段（P0-3 合规）
-- ════════════════════════════════════════════════════════════════════════════
-- 为 profiles 表增加 ai_consented 布尔字段，记录用户是否已同意 AI 拍照识别 /
-- AI 教练问答处理其饮食数据与图片。
--
-- 注意：本字段由前端在首次使用 AI 功能前弹窗获取，写入 profiles.ai_consented。
--       现有用户首次使用时会被要求重新同意（字段默认为 null）。

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ai_consented boolean NULL;

COMMENT ON COLUMN public.profiles.ai_consented IS '用户是否已显式同意 AI 处理个人数据（拍照识别/AI 问答）';
