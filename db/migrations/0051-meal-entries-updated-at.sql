-- ═══════════════════════════════════════════════════════════════════════
-- 0051 · meal_entries 补 updated_at（修「编辑份量」四端共因）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-11-14 22:30 生产实证）：
--   0030 建表时给 profiles / entitlements / payment_orders / payment_products /
--   recipes 都补了 updated_at（0030:283/329/359/372/384），唯独 meal_entries 漏了。
--   但主端与 mini 的 updateMealGrams() 一直往 PATCH 里写 updated_at → PostgREST
--   返回 PGRST204 "Could not find the 'updated_at' column ... in the schema cache"，
--   被 src/lib/errmsg.ts 误翻成「服务版本不匹配，请更新应用后重试」，四端编辑份量全崩。
--
-- 为什么选择「补列」而不是只重发新版：
--   线上 mini 体验版 / Android vc25 / iOS 旧包内仍写该列。补列可让四端旧包
--   **立即全部恢复**，免去 mini 重传 / Android 重编译 / iOS Mac 重打包。
--   源码侧 22:30 已同步移除幽灵列写入（新包不依赖本列），两者互不冲突：
--   旧包显式写 ISO 时间戳；新包不写，INSERT 由 DEFAULT now() 兜底。
--
-- 设计纪律（对齐 0030 既有口径）：
--   ① timestamptz DEFAULT now()，可空、不强制 NOT NULL —— 与其余 5 张表逐字一致；
--   ② 生产表仅 140 行 / 96 kB（2026-11-14 实测），加列代价可忽略、瞬时完成；
--   ③ 无触发器：全库其它 updated_at 也由前端/RPC 显式维护，保持一致，不引入新机制；
--   ④ meal_entries 已启用 RLS，新增列自动继承行级策略，无需新策略；
--   ⑤ 幂等：ADD COLUMN IF NOT EXISTS + ON CONFLICT，可重复运行；
--   ⑥ NOTIFY pgrst 让 PostgREST 重载 schema，否则 schema cache 仍报 PGRST204。
-- ═══════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public.meal_entries
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0051: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0051', 'meal-entries-updated-at', 'applied', 'self',
          '补齐 0030 漏加的 meal_entries.updated_at，恢复四端旧包「编辑份量」写入；NOTIFY pgrst 重载 schema')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
