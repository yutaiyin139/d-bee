-- ═══════════════════════════════════════════════════════════════
-- 0053 · 健康数据来源标识（WX-4 · 跨端连接态串台防护）
--
-- 背景（2026-11-17）：
--   profiles.health_connected 是单布尔、跨端共享。iPhone App 连了 Apple 健康 →
--   小程序 isHealthConnected() 也返回 true → 误判「微信运动已连接」并触发同步，
--   属假绿（规划 §11）。0052 已被 llm-feature-walls 占用且生产已应用，故顺延 0053。
--
-- 字段：
--   health_vendor  数据来源：apple | health_connect | huawei | xiaomi | werun
--                  连接成功时由前端 saveProfile 写入；解除连接时置 NULL。
--
-- 兼容：health_connected 保留不动（旧包只读布尔）。读取端按 isVendorConnected()
--       判定：新数据（vendor 有值）严格按来源匹配，旧数据（vendor 为 NULL）回退
--       布尔，避免升级后老用户连接态无故丢失（D3「兼容旧包」）。
--
-- 前端经 saveProfile 写入（两端 PROFILE_WRITABLE 已加 health_vendor），无需新 RPC。
-- 幂等：列与约束均带 IF NOT EXISTS / DO $$ 守卫，可安全重跑。
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS health_vendor text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_health_vendor_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_health_vendor_check
      CHECK (health_vendor IS NULL OR health_vendor IN
        ('apple', 'health_connect', 'huawei', 'xiaomi', 'werun'));
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.health_vendor IS
  '健康数据来源（apple/health_connect/huawei/xiaomi/werun）；连接成功写入、解除置 NULL，供读取端按来源判定防跨端串台';
