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
--
-- 🔴 2026-11-17 21:20 补齐三段（本文件原是全仓唯一缺登记的迁移）：
--   实测 0045/0048~0052/0054/0055 均含「BEGIN/COMMIT 事务 + schema_migrations 登记
--   + NOTIFY pgrst reload schema」，唯独本文件三项全缺 → 这正是生产 0053 被跳号、
--   profiles.health_vendor 列不存在的直接原因。三段的必要性：
--   ① 登记：不写 schema_migrations 就无法审计、且护栏/文档会以「已应用 005x」误判；
--   ② 🔴 NOTIFY pgrst：加列后不通知 PostgREST 重载 schema cache → 前端
--      saveProfile({health_vendor}) 必报 PGRST204 → 被误翻成「服务版本不匹配」
--      → 四端档案保存全崩（同 0051 的 meal_entries.updated_at 事故，铁律 #15）；
--   ③ BEGIN/COMMIT：DDL + 登记同事务，避免「列加了但没登记」的中间态。
-- ═══════════════════════════════════════════════════════════════

BEGIN;

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

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0053: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0053', 'health-vendor', 'applied', 'self',
          'profiles 新增 health_vendor（apple/health_connect/huawei/xiaomi/werun）+ CHECK 约束，供读取端按来源判定防跨端连接态串台')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
