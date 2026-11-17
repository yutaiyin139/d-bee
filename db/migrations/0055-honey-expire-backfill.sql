-- ═══════════════════════════════════════════════════════════════════════
-- 0055 · 补分订正：修正 179325 账户被多扣的过期冲正流水（-150 → -50）
--
-- 背景（2026-11-17 生产只读取证 + FEFO 精确核算）：
--   账户 1793253465481363901（手机号 18611114399）：
--     10-29 获新手 +150（11-05 到期）；11-02 兑换花 -100；
--     11-09 expire_stale_honey 按【整笔】冲正 -150（应只作废未消费的 50）。
--   → 多扣 100 分。另外 3 个 expire 账户（179284/179394/wx:osq）消费为 0，
--     整笔 150 过期作废【正确】，不在本迁移范围内。
--
-- 为何订正流水而非新增 +100 流水：
--   0054 已把 honey_balance() 改为 FEFO（忽略 reason='expire' 流水）。
--   该账户展示余额已是 34（正确）。若新增一条 +100 正流水，FEFO 会把它
--   当新批次再计一次 → 余额错变 134。故正解是把错误的 expire -150 订正为
--   -50：账本自洽（朴素 SUM 从 -66 → 34），与 FEFO=34、展示=34 三方一致，
--   且不影响当前正确展示、不重复计分。
--
-- 精确范围：仅 id=371 / ref_id='exp:283' / owner=179325... / amount=-150 一行。
--   三条件同时满足才 UPDATE，任一不符（已订正或被改动）则不改 → 幂等安全。
--   不新增/删除任何行；不动其余 3 条 expire；不动函数；不动网关。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 订正：条件严格匹配，只改金额。RETURNING 便于审计（应用脚本会核验影响行数）。
UPDATE public.honey_ledger
SET amount = -50
WHERE id = 371
  AND ref_id = 'exp:283'
  AND owner_id = '1793253465481363901'
  AND reason = 'expire'
  AND amount = -150;

-- 追踪表登记（幂等）
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0055: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0055', 'honey-expire-backfill', 'applied', 'self',
          '订正 179325 账户 exp:283 冲正 -150→-50（补回被多扣的100分），仅此一行')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;
