-- ═══════════════════════════════════════════════════════════════════════
-- 0038 · 终身买断价格调整 ¥328 → ¥298
-- ═══════════════════════════════════════════════════════════════════════
-- 背景（2026-10-25）：App Store Connect 中国区价格点**没有 ¥328 档**（仅 298 / 348 可选），
--   为对齐商店可选价格点，终身买断 `dbee_lifetime` 定价从 ¥328 下调为 ¥298。
--
-- 同步改动（同一提交）：
--   · packages/shared/src/constants/index.ts  PRICE_LIFETIME 328 → 298
--   · packages/shared/src/rules/index.ts      PRODUCTS[].price 328 → 298
--   · src/pages/PaywallSheet.tsx              PRICE_TAG.lifetime '¥328 永久' → '¥298 永久'
--   · ios/App/DbeeProducts.storekit           displayPrice "328" → "298"
--
-- 本迁移只更新「服务端唯一价格源」payment_products.amount_cents（单位：分），幂等可重跑。
-- 注意：0021 是已 applied 的历史迁移，不回溯修改其种子数据；本迁移作为增量修正。

BEGIN;

UPDATE public.payment_products
   SET amount_cents = 29800, updated_at = now()
 WHERE product_id = 'dbee_lifetime'
   AND amount_cents = 32800;

-- 登记迁移追踪表（0034 建的；模式与 0037 一致）
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0038: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0038', 'lifetime-price-298', 'applied', 'self',
          'dbee_lifetime amount_cents 32800→29800（Apple 价格点无 ¥328，选 ¥298）')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（部署后手工/脚本执行）
-- ═══════════════════════════════════════════════════════════════════════
--   SELECT product_id, amount_cents, updated_at FROM public.payment_products ORDER BY id;
--   期望：dbee_lifetime 的 amount_cents = 29800（其余 1800 / 12800 不变）。
--
-- 回滚：
--   UPDATE public.payment_products SET amount_cents = 32800, updated_at = now()
--    WHERE product_id = 'dbee_lifetime';
