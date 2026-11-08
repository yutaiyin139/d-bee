-- ═══════════════════════════════════════════════════════════════════════
-- 0046 · 微信小程序虚拟支付（xpay）核销闭环 + session_key 密文存储
-- ═══════════════════════════════════════════════════════════════════════
-- 背景（2026-11-08 用户拍板「小程序端展示三档价格并售卖订阅，走微信支付」）：
--
--   🔴 合规前提：会员订阅属**虚拟商品**，微信 2026-02-27《小程序虚拟支付业务
--   管理规范更新公告》明确 **2026-04-01 起全终端强制接入虚拟支付**，用普通
--   `wx.requestPayment`（JSAPI）卖虚拟商品会在真机报「小程序对应的支付能力
--   已经被限制」且判定违规。故本迁移服务的是 `wx.requestVirtualPayment`
--   （米大师 Midas / xpay）通道，与 P1-D 的微信/支付宝直连**是两套体系**：
--     · 商户号：虚拟支付专用二级商户号（offerId + AppKey），与普通商户号不通用
--     · 签名：HMAC-SHA256（非 RSA-SHA256 证书）
--     · 终端：iOS 自动路由 Apple 支付（费率 12%），安卓/鸿蒙/Windows 走微信支付（约 1%）
--     · 发货：`xpay_goods_deliver_notify` 推送（最多重试 15 次）+ `/xpay/query_order` 兜底
--
-- 本迁移做四件事：
--   ① app_users 加 session_key **密文**列（虚拟支付的用户态签名 signature
--      = HMAC-SHA256(session_key, signData)，服务端必须持有 session_key）
--   ② xpay_transactions 幂等表 + xpay_notifications 留痕表（同构 0037 的
--      apple_transactions / apple_notifications）
--   ③ settle_xpay_purchase / revoke_xpay_purchase / log_xpay_notification
--      三个 SECURITY DEFINER 函数 —— 与 0037 同一格局：**网关不可信到能直接
--      UPDATE entitlements**（0035 已收紧 dbee_app 权限），只能经 definer 函数
--   ④ verify_payment_order 补 wechat_xpay 分支：把「拉模式核销」改为
--      「查订单是否已 paid」—— 落地 docs/P1-D在线支付实装前置清单-2026-11-03.md
--      §二-A 的既定决策
--
-- ── 🔴 与 Apple IAP（0037）的三处刻意差异，都不是遗漏 ─────────────────────
--
--   差异 1 · 幂等键用 **out_trade_no（我方业务单号）**，不用平台单号
--     Apple 侧幂等键是 transaction_id（平台签发、必然存在）。xpay 不行：
--     官方文档明确「WeChatPayInfo 非微信支付渠道可能没有」——iOS 走 Apple
--     通道时推送里 MchOrderNo 可能缺失。若拿它当幂等键，同一笔订单的两次推送
--     （一次缺 MchOrderNo、一次带）会被当成两笔 → **重复发放权益 = 资损**。
--     out_trade_no 由我方 create_payment_order 生成、必填、UNIQUE、8–32 位，
--     是唯一在所有通道下都必然存在的键。平台单号仍存 provider_txn_id 供对账。
--
--   差异 2 · owner 可由 **openid 直接解析**，不需 Apple 那套订阅归组反查
--     Apple 的 webhook 无用户身份，只能按 original_transaction_id 反查首笔
--     核销记录（0037:168-176，找不到就 'owner_unresolved' 只留痕）。
--     xpay 推送自带 OpenId，而本项目 owner_id 形态就是 'wx:' || openid
--     （0043 + auth.mjs loginWechat 的既定决策）→ 推送路径可**确定性**定位
--     归属人，不存在 owner_unresolved 这一类失败。
--
--   差异 3 · 权益到期按 **months 累加**，没有平台侧 expires_date 权威
--     Apple 订阅由平台自动续期，expires_date_ms 是权威（0037 用 GREATEST 防
--     乱序回调把到期时间拉回去）。xpay 的道具直购是「买 N 个月时长」的
--     预付费模型，平台不给到期时间 → 只能按 payment_products.months ×
--     quantity 顺延。这与 P1-D §五「不做订阅自动续期」的既定结论一致。
--
-- ── 🔴 安全边界（继承 0037 的五条，逐条对齐）─────────────────────────────
--   · 商品价格以 payment_products 为唯一事实源；不在表里的 product_id 直接
--     拒绝（即使微信推送合法）—— 防止上架新商品前误发权益。
--   · 客户端回传的任何字段都**不作为信任依据**：product_id / quantity /
--     price 一律取微信推送报文，owner 取网关验过的 JWT sub 或推送 OpenId。
--   · session_key 只存密文（AES-256-GCM，网关侧加解密），**绝不下发前端、
--     绝不进日志**。这与 auth.mjs:294 原「拿到即弃」纪律的冲突是**有意为之**：
--     虚拟支付的 signature 必须用 session_key 计算，不落库就无法签名。
--     折中方案 = 加密落库 + TTL + 只在签名时于内存解密（见 server/lib/xpay.mjs）。
--   · 前端角色（anon/authenticated/dbee_web）对两张新表 + 三个函数三层全堵
--     （0015 的教训：只 REVOKE 一层会漏）。
--   · 核销默认拒绝：verify_payment_order 对未实现验签的 provider 仍恒 false。
--
-- 执行方式（超级用户；含建表 + 授权，dbee_app 自己无权）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0046-wechat-xpay-settlement.sql
-- 幂等：ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT EXISTS
--       + CREATE OR REPLACE FUNCTION + 先 REVOKE 后 GRANT（0033 实测的 GRANT 追加语义坑）
-- 编号说明：0045 = account-deletion；本迁移取 0046。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① session_key 密文存储 ──────────────────────────────────────────────
-- 为什么加在 app_users 而不是 profiles：session_key 是「身份/会话」概念，
-- 属身份表（仅网关可读写），不放进 PostgREST 可达的业务表（同 0042 的
-- token_version 决策）。若放 profiles，前端就能读到自己的 session_key ——
-- 那等于把签名密钥交给客户端，任何人都能伪造 signature。
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS wechat_session_key_enc text,
  ADD COLUMN IF NOT EXISTS wechat_session_key_at  timestamptz,
  ADD COLUMN IF NOT EXISTS wechat_appid           text;

COMMENT ON COLUMN public.app_users.wechat_session_key_enc IS
  '微信 session_key 密文（0046）。格式 v1:<iv_b64>:<tag_b64>:<ct_b64>，AES-256-GCM，'
  '密钥 = 网关 WECHAT_SESSION_ENC_KEY。虚拟支付的用户态签名 signature='
  'HMAC-SHA256(session_key, signData) 必须用它。🔴 绝不下发前端、绝不进日志。';

COMMENT ON COLUMN public.app_users.wechat_session_key_at IS
  'session_key 写入时间（0046）。微信未承诺有效期，但用户重新登录会换发；'
  '超期（网关 XPAY_SESSION_KEY_TTL_HOURS，默认 72h）视为不可用并要求重新登录，'
  '避免拿一个可能已失效的密钥去签名导致 signature 校验失败。';

COMMENT ON COLUMN public.app_users.wechat_appid IS
  '本条 session_key 归属的小程序 appid（0046）。试用与正式是两套独立小程序'
  '（WECHAT_MINI_SECRETS 支持多组），session_key 与 appid 绑定，跨小程序不可混用。';

-- ── ② xpay 已核销交易表（幂等）─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.xpay_transactions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 🔴 幂等键 = 我方业务单号（见文件头「差异 1」）。UNIQUE = 全服只核销一次。
  out_trade_no       text        NOT NULL UNIQUE,

  -- 微信平台单号（WeChatPayInfo.MchOrderNo / TransactionId）；iOS 走 Apple
  -- 通道时可能缺失，故可空，仅作对账用，**不参与幂等**。
  provider_txn_id    text,

  openid             text        NOT NULL,   -- 推送报文的 OpenId（发货给谁）
  owner_id           text        NOT NULL,   -- 核销给了谁（= 'wx:'||openid 或 JWT sub）
  product_id         text        NOT NULL,   -- 微信报文 GoodsInfo.ProductId（非客户端自报）
  plan               text        NOT NULL,   -- 核销时从 payment_products 映射的快照
  order_no           text,                   -- 关联 payment_orders（= out_trade_no）

  quantity           integer     NOT NULL DEFAULT 1,
  orig_price_cents   integer,                -- GoodsInfo.OrigPrice（分）
  actual_price_cents integer,                -- GoodsInfo.ActualPrice（分）

  -- 扣款方：'wechat'（安卓/鸿蒙/Windows）| 'apple'（iOS 自动路由）。
  -- 决定 entitlements.source，进而决定「我的」页显示的解锁来源与退款路径。
  channel            text        NOT NULL DEFAULT 'wechat'
                     CHECK (channel IN ('wechat', 'apple')),

  env                integer,                -- 0 现网 / 1 沙箱（对账用）
  attach             text,                   -- 透传数据原样留痕
  paid_at            timestamptz,            -- WeChatPayInfo.PaidTime（秒级）

  revoked            boolean     NOT NULL DEFAULT false,
  revoked_reason     text,                   -- refund / complaint / manual
  settled_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);

COMMENT ON TABLE public.xpay_transactions IS
  '微信虚拟支付已核销交易（0046 建）。out_trade_no UNIQUE = 全服幂等键'
  '（刻意不用平台单号，见迁移头「差异 1」）。仅经 definer 函数访问。';

-- 对账检索：按平台单号 / 按用户
CREATE INDEX IF NOT EXISTS xpay_transactions_provider_txn_idx
  ON public.xpay_transactions (provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS xpay_transactions_owner_idx
  ON public.xpay_transactions (owner_id, settled_at DESC);

-- ── ③ 推送留痕表 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.xpay_notifications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event          text,             -- xpay_goods_deliver_notify / xpay_refund_notify / …
  out_trade_no   text,
  provider_txn_id text,
  openid         text,
  processed      boolean NOT NULL DEFAULT false,
  error          text,             -- 未处理成功的原因（unknown_product / order_not_found / …）
  payload        jsonb   NOT NULL, -- 推送全文（验签通过才会进来）
  received_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.xpay_notifications IS
  '微信虚拟支付推送全量留痕（0046 建）。验签通过的推送无论处理成败都落库，'
  '供对账与人工重放（微信最多重试 15 次，留痕是判断「重试是否已生效」的唯一依据）。'
  '仅经 log_xpay_notification 写入。';

CREATE INDEX IF NOT EXISTS xpay_notifications_trade_no_idx
  ON public.xpay_notifications (out_trade_no);

-- ── ④ 表权限与 RLS（三层全堵，同 0037）────────────────────────────────
ALTER TABLE public.xpay_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xpay_transactions  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.xpay_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xpay_notifications FORCE ROW LEVEL SECURITY;

-- 不放任何 policy：FORCE RLS 下表属主也被挡；访问一律走 definer 函数。
REVOKE ALL ON public.xpay_transactions  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON public.xpay_notifications FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON public.xpay_transactions  FROM dbee_web';
    EXECUTE 'REVOKE ALL ON public.xpay_notifications FROM dbee_web';
  END IF;
END $$;

-- ── ⑤ 核销函数（唯一发权益入口）────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_xpay_purchase(
  p_out_trade_no    text,   -- 🔴 幂等键（我方业务单号）
  p_owner_id        text,   -- 客户端路径=JWT sub；推送路径传 NULL（用 p_openid 解析）
  p_openid          text,   -- 推送报文的 OpenId（微信侧权威身份）
  p_product_id      text,   -- 微信报文 GoodsInfo.ProductId（非客户端自报）
  p_provider_txn_id text,   -- 平台单号，可空（iOS 走 Apple 时可能没有）
  p_quantity        integer,
  p_orig_price      integer,
  p_actual_price    integer,
  p_channel         text,   -- 'wechat' | 'apple'
  p_env             integer,
  p_paid_at_sec     bigint, -- WeChatPayInfo.PaidTime（秒级时间戳），可空
  p_attach          text
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner     text;
  v_prod      payment_products%ROWTYPE;
  v_existing  xpay_transactions%ROWTYPE;
  v_ent_plan  text;
  v_ent_until timestamptz;
  v_order     payment_orders%ROWTYPE;
  v_channel   text;
  v_qty       integer;
  v_months    integer;
  v_paid_at   timestamptz;
BEGIN
  -- ── 入参底线：幂等键与商品不可缺 ──
  IF p_out_trade_no IS NULL OR p_out_trade_no = '' THEN
    RETURN json_build_object('error', 'missing_out_trade_no');
  END IF;
  IF p_product_id IS NULL OR p_product_id = '' THEN
    RETURN json_build_object('error', 'missing_product_id');
  END IF;

  -- ── 幂等第一闸：这笔业务单号是否已核销过 ──
  SELECT * INTO v_existing FROM xpay_transactions
   WHERE out_trade_no = p_out_trade_no;

  IF FOUND THEN
    -- 微信推送最多重试 15 次，重复到达是**常态**而非异常。
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

  -- ── owner 解析（见文件头「差异 2」：openid 可直接定位，无 owner_unresolved）──
  v_owner := p_owner_id;
  IF v_owner IS NULL OR v_owner = '' THEN
    IF p_openid IS NULL OR p_openid = '' THEN
      RETURN json_build_object('error', 'owner_unresolved');
    END IF;
    v_owner := 'wx:' || p_openid;
  END IF;

  -- ── 商品映射：payment_products 是唯一事实源 ──
  SELECT * INTO v_prod FROM payment_products
   WHERE product_id = p_product_id AND active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'unknown_product');
  END IF;

  -- ── 扣款方归一（决定 entitlements.source 与退款路径）──
  v_channel := CASE WHEN p_channel = 'apple' THEN 'apple' ELSE 'wechat' END;

  -- ── 数量归一（防御 0 / 负数 / NULL；一次买 N 份 = N 倍时长）──
  v_qty := CASE
    WHEN p_quantity IS NULL OR p_quantity < 1 THEN 1
    WHEN p_quantity > 100 THEN 100   -- 上限防御：异常报文不得放大成百倍时长
    ELSE p_quantity
  END;

  IF p_paid_at_sec IS NOT NULL AND p_paid_at_sec > 0 THEN
    v_paid_at := to_timestamp(p_paid_at_sec);
  END IF;

  -- ── 记录交易（先于权益写：UNIQUE 冲突 = 并发重复核销，整个事务回滚）──
  INSERT INTO xpay_transactions
    (out_trade_no, provider_txn_id, openid, owner_id, product_id, plan, order_no,
     quantity, orig_price_cents, actual_price_cents, channel, env, attach, paid_at)
  VALUES
    (p_out_trade_no, p_provider_txn_id, COALESCE(p_openid, ''), v_owner,
     p_product_id, v_prod.plan, p_out_trade_no,
     v_qty, p_orig_price, p_actual_price, v_channel, p_env, p_attach, v_paid_at);

  -- ── 权益落库 ──
  IF v_prod.plan = 'lifetime' THEN
    -- 买断：直接覆盖为 lifetime（已有 lifetime 则幂等无操作）
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_owner, 'lifetime', NULL, v_channel)
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime', pro_until = NULL, source = v_channel, updated_at = now();
  ELSE
    -- pro 订阅（道具直购 = 预付费时长，见文件头「差异 3」）：
    --   · 当前仍有效 → 从现到期时间往后顺延（用户提前续费不吃亏）
    --   · 已过期/从未有 → 从 now() 起算
    --   · lifetime 不降级（买断用户再买月订阅只是白送，不动其 lifetime）
    v_months := COALESCE(v_prod.months, 1) * v_qty;

    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_owner, 'pro', now() + make_interval(months => v_months), v_channel)
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
          pro_until = CASE
            WHEN entitlements.plan = 'lifetime' THEN NULL   -- 买断不降级
            WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
              THEN entitlements.pro_until + make_interval(months => v_months)
            ELSE now() + make_interval(months => v_months)
          END,
          source = CASE WHEN entitlements.plan = 'lifetime'
                        THEN entitlements.source ELSE v_channel END,
          updated_at = now();
  END IF;

  -- ── 订单核销（owner 与商品都对得上才动订单）──
  SELECT * INTO v_order FROM payment_orders WHERE order_no = p_out_trade_no;
  IF FOUND
     AND v_order.owner_id = v_owner
     AND v_order.product_id = p_product_id
     AND v_order.status = 'pending' THEN
    UPDATE payment_orders
       SET status = 'paid',
           provider_txn_id = COALESCE(p_provider_txn_id, v_order.provider_txn_id),
           -- 只存摘要式留痕（同 0037「收据只存摘要」的理由：全文在微信侧可重查）
           receipt_payload = 'xpay:' || v_channel || ':' || COALESCE(p_provider_txn_id, '-'),
           updated_at = now()
     WHERE id = v_order.id;
  END IF;
  -- owner/商品不符或订单不存在：不动订单（留 pending 供人工对账），
  -- 权益已按微信报文如实发放 —— 报文真实性由网关验签背书。

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

-- ── ⑥ 撤销函数（退款 / 投诉成立）───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_xpay_purchase(
  p_out_trade_no    text,   -- 退款推送的 MchOrderId = 我方业务单号
  p_provider_txn_id text,   -- 兜底：仅有平台单号时按它反查
  p_reason          text    -- 'refund' / 'complaint' / 'manual'
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn   xpay_transactions%ROWTYPE;
  v_owner text;
BEGIN
  SELECT * INTO v_txn FROM xpay_transactions
   WHERE out_trade_no = p_out_trade_no;
  IF NOT FOUND AND p_provider_txn_id IS NOT NULL THEN
    SELECT * INTO v_txn FROM xpay_transactions
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

  UPDATE xpay_transactions
     SET revoked = true, revoked_reason = p_reason, revoked_at = now()
   WHERE id = v_txn.id;

  -- 权益回收：只动 **本笔交易扣款方** 来源的权益（source = channel）。
  --   · 用户若另有兑换码/蜜糖兑换的权益（source='redeem' 等），不能被误伤；
  --   · iOS 买的（channel='apple'）退款只清 apple 来源，不影响微信支付来源。
  -- 与 0037 同款保守策略：整段回收该来源权益，不做「扣掉这一笔时长贡献」
  -- 的复杂计算（多次购买交叠时有争议），宁可少给不可多给（退款白嫖是资损）。
  UPDATE entitlements
     SET plan = 'free', pro_until = NULL, source = NULL, updated_at = now()
   WHERE owner_id = v_owner AND source = v_txn.channel;

  UPDATE payment_orders
     SET status = 'refunded', updated_at = now()
   WHERE order_no = v_txn.out_trade_no AND status = 'paid';

  RETURN json_build_object('revoked', true, 'owner_id', v_owner, 'plan_now', 'free');
END;
$$;

-- ── ⑦ 推送留痕函数 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_xpay_notification(
  p_payload         jsonb,
  p_event           text,
  p_out_trade_no    text,
  p_provider_txn_id text,
  p_openid          text,
  p_processed       boolean,
  p_error           text
)
RETURNS void
LANGUAGE sql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO xpay_notifications
    (event, out_trade_no, provider_txn_id, openid, processed, error, payload)
  VALUES
    (p_event, p_out_trade_no, p_provider_txn_id, p_openid,
     COALESCE(p_processed, false), p_error, p_payload);
$$;

-- ── ⑧ verify_payment_order 补 wechat_xpay 分支（拉模式 → 查单语义）──────
-- 🔴 这是 docs/P1-D在线支付实装前置清单-2026-11-03.md §二-A 的落地：
--   Apple 是**拉模式**（客户端拿收据 → 服务端验签 → 才 finish），
--   微信虚拟支付是**推模式**（客户端 success 只代表用户付完了，权益的权威
--   信号是服务端异步收到 xpay_goods_deliver_notify）。
--   若沿用「客户端回传凭证 → 服务端验签发权益」的拉模式，回调延迟（常态）
--   会让 verify 返回 false → 前端报「支付校验失败」→ **用户已扣款却被告知失败**。
--   故本 RPC 对 wechat_xpay 退化为「查订单是否已 paid」，真正的验签与发放
--   在网关推送处理器里完成（别把验签塞进 plpgsql，10-22 决策 #6）。
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

  -- 微信虚拟支付（推模式）：paid 由服务端验签后的 settle_xpay_purchase 写入，
  -- 客户端无法伪造 → 这里只回状态即可。回调未到时 status 仍 pending → false，
  -- 前端按 settling 语义有限重试（1.5s × 4），窗口内仍 pending 就提示
  -- 「支付已完成，权益正在到账」，**绝不报 error**。
  IF v_order.provider = 'wechat_xpay' THEN
    RETURN false;
  END IF;

  -- TODO(资质就绪后补)：按 provider 校验凭证
  --   apple   → 已由网关 /.cloud/payment/apple/verify + settle_apple_purchase 承担
  --   google  → Google Play Developer API（不在本期范围，见 P1-D §一「范围待定」）
  --   wechat  → 微信支付 V3 验签（普通商户号，仅实物；虚拟商品必须走 wechat_xpay）
  --   alipay  → 支付宝验签
  -- 骨架阶段一律返回 false（默认拒绝），杜绝未接验签前被 devtools 直调 RPC 白嫖会员。
  RETURN false;
END;
$$;

-- ── ⑨ 函数授权：只有网关连接角色能调 ───────────────────────────────────
-- 先 REVOKE 再 GRANT（0033 实测的 GRANT 追加语义坑）
REVOKE ALL ON FUNCTION public.settle_xpay_purchase(text,text,text,text,text,integer,integer,integer,text,integer,bigint,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON FUNCTION public.revoke_xpay_purchase(text,text,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON FUNCTION public.log_xpay_notification(jsonb,text,text,text,text,boolean,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.settle_xpay_purchase(text,text,text,text,text,integer,integer,integer,text,integer,bigint,text) FROM dbee_web';
    EXECUTE 'REVOKE ALL ON FUNCTION public.revoke_xpay_purchase(text,text,text) FROM dbee_web';
    EXECUTE 'REVOKE ALL ON FUNCTION public.log_xpay_notification(jsonb,text,text,text,text,boolean,text) FROM dbee_web';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.settle_xpay_purchase(text,text,text,text,text,integer,integer,integer,text,integer,bigint,text) TO dbee_app;
GRANT EXECUTE ON FUNCTION public.revoke_xpay_purchase(text,text,text) TO dbee_app;
GRANT EXECUTE ON FUNCTION public.log_xpay_notification(jsonb,text,text,text,text,boolean,text) TO dbee_app;

-- verify_payment_order 的授权维持 0021 原状（authenticated 可调）：
-- 它是「查自己订单状态」的只读语义，无发放能力，前端角色可调是安全的。

-- ── ⑩b 把网关对订单表的读权限显式化 ──────────────────────────────────
-- 🔴 为什么补这一条：iap.mjs:328/355 一直用 pool(dbee_app) 直读
--   `SELECT ... FROM public.payment_orders`，但全仓**从未有过对应 GRANT**
--   （0021 只 REVOKE 了 PUBLIC/anon/authenticated，0035 的收紧也只针对
--   authenticated）—— 即这条链路一直依赖「dbee_app 恰好是表属主或被隐式
--   授权」这个未写明的事实。xpay.mjs 同样需要读订单（生成 signData 时取
--   amount_cents、查单时取 status），故在此显式化，让权限不再靠运气。
--   只给 SELECT：网关改订单状态一律经 definer 函数（settle_xpay_purchase
--   内部的 UPDATE），不给直接写权限，与「写入必须走 SECURITY DEFINER」的
--   0035 核心口径一致。
GRANT SELECT ON public.payment_orders TO dbee_app;

-- ── ⑩ 登记迁移追踪表（0034 纪律）───────────────────────────────────────
INSERT INTO public.schema_migrations
       (version, name, status, applied_by, note)
VALUES ('0046','wechat-xpay-settlement','applied','self',
        '微信虚拟支付（xpay）核销闭环：session_key 密文列 + xpay_transactions/notifications + settle/revoke/log 三个 SECDEF 函数 + verify_payment_order 补 wechat_xpay 查单语义')
ON CONFLICT (version, name) DO UPDATE SET
  status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（只读，可重复执行）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) 列与对象齐了：
--    SELECT column_name FROM information_schema.columns
--     WHERE table_name='app_users' AND column_name LIKE 'wechat_%';
--    期望：wechat_session_key_enc / wechat_session_key_at / wechat_appid
--    SELECT to_regclass('public.xpay_transactions'), to_regclass('public.xpay_notifications');
--    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname IN
--       ('settle_xpay_purchase','revoke_xpay_purchase','log_xpay_notification');
-- 2) 三函数都是 SECDEF 且属主 postgres：
--    SELECT prosecdef, proowner::regrole FROM pg_proc
--     WHERE oid='public.settle_xpay_purchase(text,text,text,text,text,integer,integer,integer,text,integer,bigint,text)'::regprocedure;
--    期望：t | postgres
-- 3) 前端角色全堵（以 authenticated 身份）：
--    SET ROLE authenticated;
--    SELECT count(*) FROM xpay_transactions;                     -- 期望 permission denied
--    SELECT public.settle_xpay_purchase('T1',NULL,'o','dbee_lifetime',NULL,1,NULL,NULL,'wechat',0,NULL,NULL);
--                                                               -- 期望 permission denied
--    RESET ROLE;
-- 4) 网关角色只能调函数不能读表：
--    SET ROLE dbee_app;
--    SELECT count(*) FROM xpay_transactions;                     -- 期望 permission denied
--    SELECT public.settle_xpay_purchase('T-probe',NULL,'o','dbee_not_exist',NULL,1,NULL,NULL,'wechat',0,NULL,NULL);
--    RESET ROLE;                                                -- 期望 {"error":"unknown_product"}
-- 5) 幂等/防重放（用真商品干跑，事后清理）：
--    以 dbee_app 连续两次 settle 同一 out_trade_no → 第二次 duplicate:true 且 pro_until 不变；
--    换 owner 重放 → 'order_taken_by_other'；
--    revoke 后再 settle 同一单号 → 仍 duplicate（不会因退款而重新发放）。
-- 6) 端到端功能验收见 tools/xpay-selftest.mjs（mock pool，不连真库）。
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚
-- ═══════════════════════════════════════════════════════════════════════
-- 备份（执行本迁移前）：
--   sudo -u postgres pg_dump -d dbee -F c -f /opt/dbee-db/backup-before-0046.dump
-- 精确回滚（本迁移纯增量，无破坏性修改）：
--   DROP FUNCTION IF EXISTS public.settle_xpay_purchase(text,text,text,text,text,integer,integer,integer,text,integer,bigint,text);
--   DROP FUNCTION IF EXISTS public.revoke_xpay_purchase(text,text,text);
--   DROP FUNCTION IF EXISTS public.log_xpay_notification(jsonb,text,text,text,text,boolean,text);
--   DROP TABLE IF EXISTS public.xpay_notifications;
--   DROP TABLE IF EXISTS public.xpay_transactions;
--   ALTER TABLE public.app_users
--     DROP COLUMN IF EXISTS wechat_session_key_enc,
--     DROP COLUMN IF EXISTS wechat_session_key_at,
--     DROP COLUMN IF EXISTS wechat_appid;
--   -- verify_payment_order 需回退到 0021/0045 时的版本（重跑那份 CREATE OR REPLACE）
--   DELETE FROM public.schema_migrations WHERE version='0046';
-- ═══════════════════════════════════════════════════════════════════════
