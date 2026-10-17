-- ═══════════════════════════════════════════════════════════════
-- 0021 · 统一支付：商品定价表 + 订单表 + 下单/核销 RPC
--
-- 背景（2026-10-17 前期规划落地）：
--   企业资质办理期间，先行搭建跨 iOS / Android / Web / 小程序 的统一支付地基。
--   核心原则：金额由服务端查价（客户端只传 product_id，防篡改）；
--   权益落库、幂等、防重全部收敛到服务端 RPC，各端只做「发起支付 + 回传凭证」。
--
-- 三档商品（与 src/lib/entitlement.ts 的 PRODUCT_IDS 一致）：
--   dbee_pro_monthly  ¥18   pro  1 个月
--   dbee_pro_yearly   ¥128  pro  12 个月
--   dbee_lifetime     ¥328  lifetime 永久
--
-- 幂等双保险：
--   - order_no（客户端生成的幂等键，UNIQUE）
--   - provider_txn_id（平台唯一交易号，核销时据此防重）
--
-- 注意：本迁移只建「表 + 骨架 RPC」。真实凭证校验（iOS verifyReceipt /
--   Google Play / 微信 / 支付宝验签）在对应平台资质就绪后，各自补进
--   verify_payment_order 的 provider 分支（当前留 TODO 空实现，返回 false）。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate（逐条执行）
-- ═══════════════════════════════════════════════════════════════

-- 1. 商品定价表（服务端唯一价格源）
CREATE TABLE public.payment_products (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   text        NOT NULL UNIQUE,
  plan         text        NOT NULL CHECK (plan IN ('pro', 'lifetime')),
  months       integer,                          -- pro 商品的订阅月数；lifetime 为 NULL
  amount_cents integer     NOT NULL CHECK (amount_cents > 0),
  currency     text        NOT NULL DEFAULT 'CNY',
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.payment_products IS '商品定价（服务端唯一价格源，客户端只传 product_id）';

-- 商品表只读 + 隔离：登录用户不得直读写定价，价格只能经 create_payment_order 读取
ALTER TABLE public.payment_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_products FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_products FROM PUBLIC, anon, authenticated;

-- 预置三档商品（金额单位：分）
INSERT INTO public.payment_products (product_id, plan, months, amount_cents, currency) VALUES
  ('dbee_pro_monthly', 'pro', 1, 1800, 'CNY'),
  ('dbee_pro_yearly',  'pro', 12, 12800, 'CNY'),
  ('dbee_lifetime',    'lifetime', NULL, 32800, 'CNY')
ON CONFLICT (product_id) DO NOTHING;

-- 2. 订单表
CREATE TABLE public.payment_orders (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id        text        NOT NULL DEFAULT auth.uid(),
  order_no        text        NOT NULL UNIQUE,
  provider        text        NOT NULL,
  product_id      text        NOT NULL,
  plan            text        NOT NULL CHECK (plan IN ('pro', 'lifetime')),
  months          integer,
  amount_cents    integer     NOT NULL,
  currency        text        NOT NULL DEFAULT 'CNY',
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
  provider_txn_id text,
  receipt_payload text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.payment_orders IS '统一支付订单（四端共用，双保险防重：order_no + provider_txn_id）';

-- 订单表隔离：只经 SECURITY DEFINER RPC 访问，登录用户不得直读写
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_orders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_orders FROM PUBLIC, anon, authenticated;

-- 3. 下单 RPC：客户端传 product_id + provider，服务端查价生成订单
CREATE OR REPLACE FUNCTION public.create_payment_order(
  p_product_id text,
  p_provider   text
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    text := auth.uid();
  v_prod   payment_products%ROWTYPE;
  v_order_no text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;

  -- 服务端查价（防客户端篡改金额）
  SELECT * INTO v_prod FROM payment_products
   WHERE product_id = p_product_id AND active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'invalid_product');
  END IF;

  -- 客户端幂等键：auth.uid() + 时间戳 + 随机（UNIQUE 兜底并发）
  v_order_no := 'PO' || to_char(now(), 'YYYYMMDDHH24MISSMS') || floor(random() * 900 + 100)::text;

  INSERT INTO payment_orders (owner_id, order_no, provider, product_id, plan, months, amount_cents, currency)
  VALUES (v_uid, v_order_no, p_provider, p_product_id, v_prod.plan, v_prod.months, v_prod.amount_cents, v_prod.currency);

  RETURN json_build_object(
    'order_no', v_order_no,
    'product_id', p_product_id,
    'plan', v_prod.plan,
    'months', v_prod.months,
    'amount_cents', v_prod.amount_cents,
    'currency', v_prod.currency
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_payment_order(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payment_order(text, text) TO authenticated;

-- 4. 核销 RPC：校验凭证 + 幂等发权益（四端共用，各 provider 分支后续补验签）
CREATE OR REPLACE FUNCTION public.verify_payment_order(
  p_order_no        text,
  p_provider_txn_id text,
  p_receipt         text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   text := auth.uid();
  v_order payment_orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_order FROM payment_orders
   WHERE order_no = p_order_no AND owner_id = v_uid;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_order.status = 'paid' THEN
    RETURN true;  -- 已核销过，幂等直接返回成功
  END IF;

  -- TODO(资质就绪后补)：按 provider 校验凭证
  --   apple   → verifyReceipt（App Store）
  --   google  → Google Play Developer API
  --   wechat  → 微信支付验签
  --   alipay  → 支付宝验签
  -- 骨架阶段一律返回 false（默认拒绝），杜绝未接验签前被 devtools 直调 RPC 白嫖会员。
  -- 实现时：校验通过后标记订单 paid + 写 entitlements（见 verify 完整逻辑注释）。
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_payment_order(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_payment_order(text, text, text) TO authenticated;
