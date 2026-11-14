-- ═══════════════════════════════════════════════════════════════════════
-- 0050 · 体重管理方案：当前方案起始日（第 N 天 / 按周节奏推算达成日）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-11-14 16:15 拍板 ④B）：
--   profiles 已有 created_at（账号创建日），但「第 N 天」语义应是「当前方案生效至今」。
--   直接用 created_at 会在改目标后出现「增重增肌 · 第 300 天」这种自相矛盾的状态。
--   因此新增可空列 plan_started_at，由客户端在首次完成引导 / 改目标确认时写入。
--
-- 设计纪律：
--   ① 可空、无默认、无索引 —— 只随 profiles 单行读取，不做查询条件；
--   ② 既有档案回填 created_at 作为「近似起点」，诚实标注，不假装有精确历史；
--   ③ profiles 已启用 RLS，新增列自动继承行级策略，无需新策略；
--   ④ 0045 真删号删 profiles 整行 → 本列随之消失，无需改 0045；
--   ⑤ 幂等：ADD COLUMN IF NOT EXISTS + UPDATE WHERE NULL + ON CONFLICT，可重复运行；
--   ⑥ NOTIFY pgrst 让 PostgREST 重载 schema，否则 select('*') 读不到新列。
-- ═══════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS plan_started_at timestamptz;

UPDATE public.profiles
   SET plan_started_at = created_at
 WHERE plan_started_at IS NULL;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0050: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0050', 'plan-start-date', 'applied', 'self',
          'profiles.plan_started_at 可空新增 + 回填 created_at；体重管理方案第 N 天与达成日推算')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
