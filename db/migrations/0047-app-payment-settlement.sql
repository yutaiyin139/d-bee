-- ═══════════════════════════════════════════════════════════════
-- 0047 · Android APP 支付结算：微信 APP 支付 / 支付宝 App 支付
--
-- 背景（2026-11-09 用户定案）：
--   「Android 端必须能收款，只要政策允许的都要能收款；Web 暂不收费只做引导；
--    四端业务逻辑不变。」
--   0021 建的统一支付地基（payment_products 查价 + payment_orders + 下单/核销 RPC）
--   当时 verify_payment_order 对 wechat/alipay 留了 TODO 空实现（恒 false，默认拒绝，
--   防未接验签前被 devtools 直调 RPC 白嫖）。本迁移补上 APP 支付的**结算侧**：
--   已核销交易登记（幂等）+ 回调留痕 + 权益发放/回收 + verify 改查单语义。
--
-- ── 🔴 与 0046（微信虚拟支付 xpay）的关系：并列，不复用其表 ─────────────
--   0046 服务的是**微信小程序虚拟支付**（米大师 xpay，provider='wechat_xpay'），
--   本迁移服务的是 **Android 原生 APP 支付**（微信 APP 支付 + 支付宝 App 支付，
--   provider='wechat'/'alipay'，普通商户号体系）。两者是不同产品线、不同商户号、
--   不同回调协议，故**各建各的交易登记表**，不共用 xpay_transactions：
--     · xpay_transactions.channel CHECK 只含 ('wechat','apple')，且 openid NOT NULL
--       （支付宝无 openid，只有 buyer_id）→ 强行复用会破坏其约束语义；
--     · 分表便于对账（虚拟支付 vs APP 支付走两套商户结算）。
--   但**权益计算逻辑逐字复用 0046 的成熟模型**（见 settle_app_payment）：
--     months 累加顺延、lifetime 不降级、幂等键 = 我方业务单号、默认拒绝。
--   → 这是「四端业务逻辑不变」的落地：新增的只是「APP 支付」这条**通道**，
--     三档价格（payment_products）、权益规则（entitlements）、免费额度一概不动。
--
-- ── 🔴 推模式（与 Apple IAP 拉模式的差异，继承 P1-D §二-A / 0046 既定决策）──
--   客户端 SDK 支付成功 **只代表用户付完了钱**；权益发放的权威信号是服务端
--   异步收到的支付回调（微信 V3 通知 / 支付宝异步通知）验签通过后 settle。
--   → 故 verify_payment_order 对 wechat/alipay 退化为「查订单是否已 paid」，
--     真正的验签与发放在网关 apppay.mjs 的回调处理器里完成（别把验签塞进
--     plpgsql，10-22 决策 #6：验签落在 Node 网关）。
--   → 回调未到时 status 仍 pending → verify 返回 false，前端按 settling 语义
--     有限重试（见 src/lib/payment/apppayClient.ts），窗口内仍 pending 就提示
--     「支付已完成，权益正在到账」，**绝不报 error**（已扣款报错 = 资损级 UX 事故）。
--
-- ── 🔴 owner 解析：以订单归属为准，不从支付者身份反推 ──────────────────
--   与 xpay（openid → 'wx:'||openid）不同：APP 支付的订单在 create_payment_order
--   时已用下单者 JWT sub 绑定 owner_id，这才是权益归属的**权威**。支付者 openid/
--   buyer_id 只作对账留痕（可能 A 下单、B 代付，权益必须给 A）。故 settle 的
--   owner 一律取 payment_orders.owner_id，订单不存在则拒绝（不发无主权益）。
--
-- ── 🔴 安全边界（继承 0037/0046 五条，逐条对齐）─────────────────────────
--   · 商品价格以 payment_products 为唯一事实源；不在表里的 product_id 直接拒绝。
--   · 客户端回传的任何字段都**不作为信任依据**：金额以订单查价为准，回调金额仅
--     留痕对账（网关侧负责「回调金额 < 订单金额则拒绝」，RPC 保持按订单发权益）。
--   · 幂等键 = out_trade_no（我方业务单号），UNIQUE 兜底并发；重复回调是常态。
--   · 前端角色（anon/authenticated/dbee_web）对新表 + 新函数三层全堵（0015 教训）。
--   · 核销默认拒绝：verify_payment_order 对未 paid 的 wechat/alipay 仍 false。
--   · 回调报文只存摘要留痕（provider_txn_id / 金额 / 时间），敏感全文在平台侧可重查。
--
-- 执行方式（超级用户；含建表 + 授权，dbee_app 自己无权）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0047-app-payment-settlement.sql
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
--       + CREATE OR REPLACE FUNCTION + 先 REVOKE 后 GRANT（0033 实测的 GRANT 追加语义坑）
-- 编号说明：0046 = wechat-xpay-settlement；本迁移取 0047。
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ── ① APP 支付已核销交易表（幂等）────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_payment_transactions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 🔴 幂等键 = 我方业务单号（payment_orders.order_no）。UNIQUE = 全服只核销一次。
  --   刻意不用平台单号：微信 transaction_id / 支付宝 trade_no 在部分回调场景可能
  --   缺失或后到，out_trade_no 由我方 create_payment_order 生成、必填、UNIQUE，
  --   是唯一在所有通道下都必然存在的键（同 0046「差异 1」的理由）。
  out_trade_no       text        NOT NULL UNIQUE,

  -- 平台交易号（微信 transaction_id / 支付宝 trade_no）；可空，仅作对账，不参与幂等。
  provider_txn_id    text,

  -- 渠道：'wechat'（微信 APP 支付）| 'alipay'（支付宝 App 支付）。
  -- 决定 entitlements.source，进而决定「我的」页显示的解锁来源与退款路径。
  provider           text        NOT NULL
                     CHECK (provider IN ('wechat', 'alipay')),

  buyer_id           text,                   -- 微信 openid / 支付宝 buyer_id（对账用，可空）
  owner_id           text        NOT NULL,   -- 核销给了谁（= payment_orders.owner_id，权威）
  product_id         text        NOT NULL,   -- 服务端订单商品（非客户端自报）
  plan               text        NOT NULL,   -- 核销时从 payment_products 映射的快照
  order_no           text,                   -- 关联 payment_orders（= out_trade_no）

  amount_cents       integer,                -- 订单查价金额（分），发权益以此为准
  callback_amount    integer,                -- 回调报文金额（分），仅对账；不符由网关拒发
  paid_at            timestamptz,            -- 平台回调的支付完成时间

  revoked            boolean     NOT NULL DEFAULT false,
  revoked_reason     text,                   -- refund / complaint / manual
  settled_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);

COMMENT ON TABLE public.app_payment_transactions IS
  'Android APP 支付已核销交易（0047 建）。out_trade_no UNIQUE = 全服幂等键'
  '（刻意不用平台单号，见迁移头）。与 0046 的 xpay_transactions 分表：xpay 是小程序'
  '虚拟支付、本表是原生 APP 支付，两套商户体系。仅经 definer 函数访问。';

CREATE INDEX IF NOT EXISTS app_payment_txn_provider_idx
  ON public.app_payment_transactions (provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_payment_txn_owner_idx
  ON public.app_payment_transactions (owner_id, settled_at DESC);

-- ── ② 回调留痕表 ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_payment_notifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text,             -- wechat / alipay
  event           text,             -- pay_notify / refund_notify / query
  out_trade_no    text,
  provider_txn_id text,
  processed       boolean NOT NULL DEFAULT false,
  error           text,             -- 未处理成功的原因（unknown_product / order_not_found / amount_mismatch / …）
  payload         jsonb   NOT NULL, -- 回调全文（验签通过才会进来）
  received_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_payment_notifications IS
  'Android APP 支付回调全量留痕（0047 建）。验签通过的回调无论处理成败都落库，'
  '供对账与人工重放（微信/支付宝失败会重试，留痕是判断「重试是否已生效」的唯一依据）。'
  '仅经 log_app_notification 写入。';

CREATE INDEX IF NOT EXISTS app_payment_notifications_trade_no_idx
  ON public.app_payment_notifications (out_trade_no);

-- ── ③ 表权限与 RLS（三层全堵，同 0037/0046）───────────────────────────
ALTER TABLE public.app_payment_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_payment_transactions  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_payment_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_payment_notifications FORCE ROW LEVEL SECURITY;

-- 不放任何 policy：FORCE RLS 下表属主也被挡；访问一律走 definer 函数。
REVOKE ALL ON public.app_payment_transactions  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON public.app_payment_notifications FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON public.app_payment_transactions  FROM dbee_web';
    EXECUTE 'REVOKE ALL ON public.app_payment_notifications FROM dbee_web';
  END IF;
END $$;

-- ── ④ 核销函数（APP 支付唯一发权益入口）───────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_app_payment(
  p_out_trade_no    text,   -- 🔴 幂等键（= payment_orders.order_no）
  p_owner_id        text,   -- 客户端查单路径 = JWT sub；回调路径可空（从订单反查）
  p_buyer_id        text,   -- 微信 openid / 支付宝 buyer_id（回调报文，可空，仅对账）
  p_product_id      text,   -- 服务端订单商品（回调核对用）
  p_provider_txn_id text,   -- 平台交易号（微信 transaction_id / 支付宝 trade_no），可空
  p_provider        text,   -- 'wechat' | 'alipay'
  p_amount_cents    integer,-- 回调报文金额（分），仅对账留痕
  p_paid_at_sec     bigint, -- 支付完成秒级时间戳，可空
  p_channel_note    text    -- 摘要留痕（不含敏感全文）
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order     payment_orders%ROWTYPE;
  v_prod      payment_products%ROWTYPE;
  v_existing  app_payment_transactions%ROWTYPE;
  v_owner     text;
  v_ent_plan  text;
  v_ent_until timestamptz;
  v_months    integer;
  v_paid_at   timestamptz;
  v_provider  text;
BEGIN
  -- ── 入参底线：幂等键不可缺 ──
  IF p_out_trade_no IS NULL OR p_out_trade_no = '' THEN
    RETURN json_build_object('error', 'missing_out_trade_no');
  END IF;

  -- ── 幂等第一闸：这笔业务单号是否已核销过 ──
  SELECT * INTO v_existing FROM app_payment_transactions
   WHERE out_trade_no = p_out_trade_no;

  IF FOUND THEN
    -- 微信/支付宝回调失败会重试，重复到达是**常态**而非异常。
    IF p_owner_id IS NOT NULL AND v_existing.owner_id <> p_owner_id THEN
      -- 换账号重放他人订单：拒绝（网关据此回 409 并 warn 留痕）
      RETURN json_build_object('error', 'order_taken_by_other');
    END IF;
    -- 同 owner 重复核销：幂等返回成功 + 当前权益（🔴 不重复顺延时长！）
    SELECT plan, pro_until INTO v_ent_plan, v_ent_until
      FROM entitlements WHERE owner_id = v_existing.owner_id;
    RETURN json_build_object(
      'settled', true, 'duplicate', true,
      'owner_id', v_existing.owner_id,
      'plan', COALESCE(v_ent_plan, 'free'),
      'pro_until', v_ent_until
    );
  END IF;

  -- ── owner 解析：以订单归属为权威（见迁移头「owner 解析」）──
  --   APP 支付的订单在下单时已绑定 owner_id（JWT sub），回调只负责置 paid + 发权益。
  --   支付者 openid/buyer_id 可能 ≠ 下单者（代付），故一律取订单 owner_id。
  SELECT * INTO v_order FROM payment_orders WHERE order_no = p_out_trade_no;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'order_not_found');
  END IF;
  v_owner := v_order.owner_id;
  IF v_owner IS NULL OR v_owner = '' THEN
    RETURN json_build_object('error', 'owner_unresolved');
  END IF;
  -- 客户端查单路径带了 JWT sub：必须与订单归属一致，否则是越权尝试
  IF p_owner_id IS NOT NULL AND p_owner_id <> '' AND v_owner <> p_owner_id THEN
    RETURN json_build_object('error', 'order_taken_by_other');
  END IF;

  -- ── 商品映射：payment_products 是唯一事实源 ──
  --   以订单登记的 product_id 为准（下单时已查价固定），回调 p_product_id 仅核对。
  SELECT * INTO v_prod FROM payment_products
   WHERE product_id = v_order.product_id AND active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'unknown_product');
  END IF;

  -- ── 渠道归一（决定 entitlements.source 与退款路径）──
  v_provider := CASE WHEN p_provider = 'alipay' THEN 'alipay' ELSE 'wechat' END;

  IF p_paid_at_sec IS NOT NULL AND p_paid_at_sec > 0 THEN
    v_paid_at := to_timestamp(p_paid_at_sec);
  END IF;

  -- ── 记录交易（先于权益写：UNIQUE 冲突 = 并发重复核销，整个事务回滚）──
  INSERT INTO app_payment_transactions
    (out_trade_no, provider_txn_id, provider, buyer_id, owner_id, product_id, plan,
     order_no, amount_cents, callback_amount, paid_at)
  VALUES
    (p_out_trade_no, p_provider_txn_id, v_provider, COALESCE(p_buyer_id, ''), v_owner,
     v_order.product_id, v_prod.plan, p_out_trade_no,
     v_order.amount_cents, p_amount_cents, v_paid_at);

  -- ── 权益落库（逐字复用 0046 的成熟模型：months 累加、lifetime 不降级）──
  IF v_prod.plan = 'lifetime' THEN
    -- 买断：直接覆盖为 lifetime（已有 lifetime 则幂等无操作）
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_owner, 'lifetime', NULL, v_provider)
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime', pro_until = NULL, source = v_provider, updated_at = now();
  ELSE
    -- pro 订阅（APP 支付 = 一次性预付购买，非自动续期，见 legal.ts §六）：
    --   · 当前仍有效 → 从现到期时间往后顺延（用户提前续费不吃亏）
    --   · 已过期/从未有 → 从 now() 起算
    --   · lifetime 不降级（买断用户再买月订阅只是白送，不动其 lifetime）
    v_months := COALESCE(v_prod.months, 1);

    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_owner, 'pro', now() + make_interval(months => v_months), v_provider)
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
          pro_until = CASE
            WHEN entitlements.plan = 'lifetime' THEN NULL   -- 买断不降级
            WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
              THEN entitlements.pro_until + make_interval(months => v_months)
            ELSE now() + make_interval(months => v_months)
          END,
          source = CASE WHEN entitlements.plan = 'lifetime'
                        THEN entitlements.source ELSE v_provider END,
          updated_at = now();
  END IF;

  -- ── 订单核销（owner 与商品都对得上才动订单）──
  IF v_order.status = 'pending' THEN
    UPDATE payment_orders
       SET status = 'paid',
           provider_txn_id = COALESCE(p_provider_txn_id, v_order.provider_txn_id),
           -- 只存摘要式留痕（同 0037「收据只存摘要」：全文在平台侧可重查）
           receipt_payload = 'apppay:' || v_provider || ':' || COALESCE(p_provider_txn_id, '-'),
           updated_at = now()
     WHERE id = v_order.id;
  END IF;

  SELECT plan, pro_until INTO v_ent_plan, v_ent_until
    FROM entitlements WHERE owner_id = v_owner;

  RETURN json_build_object(
    'settled', true, 'duplicate', false,
    'owner_id', v_owner,
    'plan', COALESCE(v_ent_plan, 'free'),
    'pro_until', v_ent_until
  );
END;
$$;

-- ── ⑤ 撤销函数（退款 / 投诉成立）───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_app_payment(
  p_out_trade_no    text,   -- 退款回调的商户单号 = 我方业务单号
  p_provider_txn_id text,   -- 兜底：仅有平台单号时按它反查
  p_reason          text    -- 'refund' / 'complaint' / 'manual'
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn   app_payment_transactions%ROWTYPE;
  v_owner text;
BEGIN
  SELECT * INTO v_txn FROM app_payment_transactions
   WHERE out_trade_no = p_out_trade_no;
  IF NOT FOUND AND p_provider_txn_id IS NOT NULL THEN
    SELECT * INTO v_txn FROM app_payment_transactions
     WHERE provider_txn_id = p_provider_txn_id
     ORDER BY settled_at DESC LIMIT 1;
  END IF;
  IF NOT FOUND THEN
    RETURN json_build_object('revoked', false, 'error', 'txn_not_found');
  END IF;

  IF v_txn.revoked THEN
    RETURN json_build_object('revoked', true, 'duplicate', true, 'owner_id', v_txn.owner_id);
  END IF;

  v_owner := v_txn.owner_id;

  UPDATE app_payment_transactions
     SET revoked = true, revoked_reason = p_reason, revoked_at = now()
   WHERE id = v_txn.id;

  -- 权益回收：只动 **本笔交易渠道** 来源的权益（source = provider）。
  --   · 用户若另有兑换码/蜜糖兑换的权益（source='redeem' 等），不能被误伤；
  --   · 微信买的退款只清 wechat 来源，不影响支付宝/兑换来源（与 0037/0046 同款保守策略）。
  UPDATE entitlements
     SET plan = 'free', pro_until = NULL, source = NULL, updated_at = now()
   WHERE owner_id = v_owner AND source = v_txn.provider;

  UPDATE payment_orders
     SET status = 'refunded', updated_at = now()
   WHERE order_no = v_txn.out_trade_no AND status = 'paid';

  RETURN json_build_object('revoked', true, 'owner_id', v_owner, 'plan_now', 'free');
END;
$$;

-- ── ⑥ 回调留痕函数 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_app_notification(
  p_payload         jsonb,
  p_provider        text,
  p_event           text,
  p_out_trade_no    text,
  p_provider_txn_id text,
  p_processed       boolean,
  p_error           text
)
RETURNS void
LANGUAGE sql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO app_payment_notifications
    (provider, event, out_trade_no, provider_txn_id, processed, error, payload)
  VALUES
    (p_provider, p_event, p_out_trade_no, p_provider_txn_id,
     COALESCE(p_processed, false), p_error, p_payload);
$$;

-- ── ⑦ verify_payment_order 补 wechat/alipay 分支（查单语义）────────────
-- 🔴 与 0046 对 wechat_xpay 的处理同理：APP 支付是**推模式**，paid 由网关回调
--   验签后 settle_app_payment 写入，客户端无法伪造 → 这里只回状态即可。
--   回调未到时 status 仍 pending → false，前端按 settling 语义有限重试，
--   窗口内仍 pending 就提示「支付已完成，权益正在到账」，**绝不报 error**。
--   顶部「status='paid' → RETURN true」的通用幂等逻辑已覆盖成功路径，
--   本分支只是把 wechat/alipay 从「TODO 默认拒绝」明确改判为「查单语义」，
--   杜绝后人误读为「未实现」。
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

  -- 推模式渠道（0046 xpay + 0047 APP 支付）：paid 由服务端验签回调写入，
  -- 客户端无法伪造 → 这里只回状态。回调未到 → false，前端有限重试兜底。
  IF v_order.provider IN ('wechat_xpay', 'wechat', 'alipay') THEN
    RETURN false;
  END IF;

  -- TODO(其余渠道)：apple → 已由网关 /.cloud/payment/apple/verify + settle_apple_purchase
  --   承担；google → Google Play Developer API（不在本期范围，见 P1-D §一）。
  -- 骨架阶段一律返回 false（默认拒绝），杜绝未接验签前被 devtools 直调 RPC 白嫖会员。
  RETURN false;
END;
$$;

-- ── ⑧ 函数授权：只有网关连接角色能调 ───────────────────────────────────
-- 先 REVOKE 再 GRANT（0033 实测的 GRANT 追加语义坑）
REVOKE ALL ON FUNCTION public.settle_app_payment(text,text,text,text,text,text,integer,bigint,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON FUNCTION public.revoke_app_payment(text,text,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON FUNCTION public.log_app_notification(jsonb,text,text,text,text,boolean,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.settle_app_payment(text,text,text,text,text,text,integer,bigint,text) FROM dbee_web';
    EXECUTE 'REVOKE ALL ON FUNCTION public.revoke_app_payment(text,text,text) FROM dbee_web';
    EXECUTE 'REVOKE ALL ON FUNCTION public.log_app_notification(jsonb,text,text,text,text,boolean,text) FROM dbee_web';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.settle_app_payment(text,text,text,text,text,text,integer,bigint,text) TO dbee_app;
GRANT EXECUTE ON FUNCTION public.revoke_app_payment(text,text,text) TO dbee_app;
GRANT EXECUTE ON FUNCTION public.log_app_notification(jsonb,text,text,text,text,boolean,text) TO dbee_app;

-- verify_payment_order 的授权在 0021 已 GRANT EXECUTE TO authenticated（前端 RPC 直调路径），
-- 本迁移只 REPLACE 函数体、不改签名，故无需重新授权；网关侧用 dbee_app 连接调用亦已覆盖。

-- ── ⑨ 迁移追踪表登记（0034 建的；模式与 0038/0046 一致）────────────────
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0047: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0047', 'app-payment-settlement', 'applied', 'self',
          'Android APP 支付结算：微信/支付宝，推模式查单语义，复用 0046 权益模型')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════
-- 验证（部署后手工/脚本执行）
-- ═══════════════════════════════════════════════════════════════
--   SELECT max(version) FROM public.schema_migrations;   -- 期望 0047
--   \d public.app_payment_transactions                   -- 表结构 + CHECK(provider)
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('settle_app_payment','revoke_app_payment','log_app_notification');  -- 期望 3 行
--   -- verify_payment_order 对 wechat/alipay 应走查单语义：
--   --   建一笔 pending 的 wechat 订单 → 直调 verify 应 false；
--   --   settle_app_payment 后再调 → true。
--
-- 回滚（谨慎：会丢已核销 APP 支付交易记录）：
--   DROP FUNCTION IF EXISTS public.settle_app_payment(text,text,text,text,text,text,integer,bigint,text);
--   DROP FUNCTION IF EXISTS public.revoke_app_payment(text,text,text);
--   DROP FUNCTION IF EXISTS public.log_app_notification(jsonb,text,text,text,text,boolean,text);
--   DROP TABLE IF EXISTS public.app_payment_notifications;
--   DROP TABLE IF EXISTS public.app_payment_transactions;
--   -- verify_payment_order 需回滚到 0046 版本（去掉 wechat/alipay 查单分支）
