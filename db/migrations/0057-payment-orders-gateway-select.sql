-- ═══════════════════════════════════════════════════════════════════════
-- 0057 · 网关能读到 payment_orders（修 App 支付 prepay「订单不存在」）
-- ═══════════════════════════════════════════════════════════════════════
-- 现象（2026-11-24 真机）：vc32 点支付宝后付费墙红字「订单不存在」。
--
-- 根因（2026-11-24 生产实测）：
--   客户端 create_payment_order 是 SECURITY DEFINER，订单已经写入。
--   postgres 能看到近两日 5 笔 alipay 订单；SET ROLE dbee_app 后同一查询是 0。
--   网关 prepay（server/lib/apppay.mjs loadOrder）用的就是 dbee_app。
--   现网 payment_orders：relrowsecurity=true，relforcerowsecurity=false，
--   policy 一条都没有。dbee_app 不是表属主，且 0033 起 NOBYPASSRLS。
--   无 policy 的角色看到 0 行。0046 的 GRANT SELECT 只过权限检查，不过 RLS。
--   prepay 把这 0 行报成 404「订单不存在」。
--   不是用户没下单，也不是支付宝侧没有这笔交易。
--   （0021 原稿写过 FORCE；现网没带上 FORCE。对非属主的 dbee_app，效果相同。）
--
-- 修法对齐 0033 给 app_users 的 gateway_ident_access：
--   只给 dbee_app 一条 SELECT policy（USING true）。
--   authenticated / anon / dbee_web 仍然没有 policy，加上 0021 的 REVOKE，
--   前端依旧不能直读订单表。
--   不授 INSERT / UPDATE / DELETE。改状态仍走 settle_app_payment 等
--   SECURITY DEFINER 函数。
--
-- 执行（超级用户）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 \
--     -f /opt/dbee-db/0057-payment-orders-gateway-select.sql
-- 幂等：DROP POLICY IF EXISTS 后重建，GRANT 可重复。
-- 不重启网关：这是库内策略，下一次 prepay 立刻生效。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

DROP POLICY IF EXISTS payment_orders_gateway_select ON public.payment_orders;
CREATE POLICY payment_orders_gateway_select ON public.payment_orders
  FOR SELECT
  TO dbee_app
  USING (true);

-- 0046 已授过；这里再写一次，避免「策略在、权限不在」的半截状态。
GRANT SELECT ON public.payment_orders TO dbee_app;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0057: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0057', 'payment-orders-gateway-select', 'applied', 'self',
          'payment_orders FORCE RLS + dbee_app NOBYPASSRLS 且无 policy，网关 SELECT 恒 0 行，'
          'apppay prepay 误报订单不存在。补 TO dbee_app 的 SELECT policy，不授写。')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;

-- 回滚：
--   DROP POLICY IF EXISTS payment_orders_gateway_select ON public.payment_orders;
--   DELETE FROM public.schema_migrations WHERE version = '0057' AND name = 'payment-orders-gateway-select';
--   回滚后 App 支付 prepay 会再次报「订单不存在」。
