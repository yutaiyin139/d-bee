-- ═══════════════════════════════════════════════════════════════════════
-- 0037 · Apple IAP 网关核销落库：交易幂等表 + 通知留痕表 + 三个 definer 函数
-- ═══════════════════════════════════════════════════════════════════════
-- 背景（10-22 决策 #6 的落地）：
--   Apple 验签从 pg_net（0029，已 void：服务器 PG17.11 无该扩展）改为
--   **Node 网关**（server/lib/iap.mjs）。职责切分：
--     · 网关：外呼 Apple verifyReceipt / 验 JWS 证书链 —— 一切「与 Apple 对话」
--     · 数据库（本迁移）：核销落库的**原子性与幂等** —— 一切「与钱有关的状态」
--   网关不可信到能直接 UPDATE entitlements（dbee_app 无该权限，0035 收紧），
--   只能通过本迁移的 SECURITY DEFINER 函数走受控入口。
--
-- 三个函数（owner=postgres，EXECUTE 仅授 dbee_app；前端角色一律 REVOKE）：
--   settle_apple_purchase(...)  购买/恢复/续订通知的幂等核销（唯一发权益入口）
--   revoke_apple_purchase(...)  REFUND/REVOKE 通知触发的权益撤销
--   log_apple_notification(...) webhook 全量落库留痕（对账与重放）
--
-- 幂等与防重放设计（对应网关 iap.mjs 文件头的 5 条安全边界）：
--   · apple_transactions.transaction_id UNIQUE —— 一笔交易全服只核销一次；
--     换账号重放同一收据 → 'txn_taken_by_other'（409）。
--   · 订阅续订以 transaction_id 区分、original_transaction_id 归组：
--     webhook 没有登录态，续订时按 original_transaction_id 反查首笔核销
--     记录的 owner —— 找不到说明用户从未在客户端核销过（'owner_unresolved'，
--     只留痕不发权益，等客户端下次 verify 时对齐）。
--   · 商品映射以 payment_products 为唯一事实源（Apple 报文 product_id →
--     plan/months）；不在表里的商品直接拒绝 —— 即使收据合法（bundle_id
--     已被网关钉扎，这里是第二道闸：防止未来上架新商品前误发权益）。
--   · 订阅时长以 Apple 的 expires_date_ms 为权威（续订顺延不再按 months
--     累加，避免「网关宕机漏掉一次 DID_RENEW 后补核销」造成时长错算）；
--     无 expires_date_ms 的商品（当前只有 dbee_lifetime，买断无到期）走
--     plan=lifetime 分支。
--
-- 为什么收据只存摘要不存全文：
--   verifyReceipt 的收据 base64 常 30–100KB，payment_orders.receipt_payload
--   存全文会让订单表快速膨胀且无检索价值（全文在 Apple 侧可重验）。
--   统一存 sha256 hex（64 字符），既可对账（同一收据重放摘要必相同）
--   又省空间。摘要由网关计算传入，函数内不信任客户端字段。
--
-- 权限口径（与 0033/0035 的既定格局对齐）：
--   · dbee_app：NOBYPASSRLS，只经本迁移函数触达新表（函数 owner=postgres，
--     definer 权限访问）；对两张新表本身零直接权限。
--   · authenticated/anon/dbee_web：表 REVOKE ALL + 函数 REVOKE ALL +
--     FORCE RLS 无 policy —— 三层全堵（0015 的教训：只 REVOKE 一层会漏）。
--   · 函数用显式参数传 owner_id，**不读 auth.uid()**：调用方是网关
--     （dbee_app 连接，无用户身份注入），身份来自网关验过的 JWT sub。
--     这正是 0033 注释里预留的「角色分离」路径。
--
-- 执行方式（超级用户；含建表+授权，dbee_app 自己无权）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0037-apple-iap-settlement.sql
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION + 先 REVOKE 后 GRANT，
--   可重复执行。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① 交易幂等表 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.apple_transactions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id        text        NOT NULL UNIQUE,   -- Apple 交易号（幂等键）
  original_transaction_id text,                        -- 订阅归组键（webhook 反查 owner 用）
  owner_id              text        NOT NULL,          -- 核销给了谁（= 网关 JWT sub）
  product_id            text        NOT NULL,          -- Apple 报文里的商品（非客户端自报）
  plan                  text        NOT NULL,          -- 核销时从 payment_products 映射的快照
  order_no              text,                          -- 关联订单（恢复购买/续订通知为 NULL）
  expires_at            timestamptz,                   -- Apple expires_date_ms（买断为 NULL）
  purchased_at          timestamptz,                   -- Apple purchase_date_ms
  environment           text,                          -- Production / Sandbox（对账用）
  receipt_sha256        text,                          -- 收据摘要（webhook 路径为 NULL）
  revoked               boolean     NOT NULL DEFAULT false,
  revoked_reason        text,                          -- refund / revoke
  settled_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);

COMMENT ON TABLE public.apple_transactions IS
  'Apple IAP 已核销交易（0037 建）。transaction_id UNIQUE = 全服幂等键；'
  'webhook 续订按 original_transaction_id 反查 owner。仅经 definer 函数访问。';

-- 订阅归组反查（webhook DID_RENEW → 找首笔核销的 owner）
CREATE INDEX IF NOT EXISTS apple_transactions_orig_txn_idx
  ON public.apple_transactions (original_transaction_id, settled_at DESC);

-- ── ② 通知留痕表 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.apple_notifications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_type text,          -- 冗余列便于对账检索（payload 里也有）
  transaction_id text,
  original_transaction_id text,
  processed      boolean NOT NULL DEFAULT false,
  error          text,             -- 未处理成功的原因（owner_unresolved / txn_not_found / …）
  payload        jsonb   NOT NULL, -- V2 通知解码后的全文（验签通过才会进来）
  received_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.apple_notifications IS
  'App Store Server Notifications V2 全量留痕（0037 建）。验签通过的通知无论'
  '处理成败都落库，供对账与人工重放。仅经 log_apple_notification 写入。';

CREATE INDEX IF NOT EXISTS apple_notifications_txn_idx
  ON public.apple_notifications (transaction_id);

-- ── ③ 表权限与 RLS（三层全堵）──────────────────────────────────────────
ALTER TABLE public.apple_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apple_transactions  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.apple_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apple_notifications FORCE ROW LEVEL SECURITY;

-- 不放任何 policy：FORCE RLS 下表属主也被挡；访问一律走 definer 函数。
REVOKE ALL ON public.apple_transactions  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON public.apple_notifications FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON public.apple_transactions  FROM dbee_web';
    EXECUTE 'REVOKE ALL ON public.apple_notifications FROM dbee_web';
  END IF;
END $$;

-- ── ④ 核销函数 ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_apple_purchase(
  p_owner_id          text,   -- 客户端路径=JWT sub；webhook 路径传 NULL（内部反查）
  p_order_no          text,   -- 可空；'restore-…' 前缀=恢复购买
  p_product_id        text,   -- Apple 报文 product_id（非客户端自报）
  p_transaction_id    text,
  p_original_txn_id   text,
  p_expires_ms        text,   -- Apple expires_date_ms 字符串；可空（买断）
  p_purchase_ms       text,   -- Apple purchase_date_ms 字符串；可空
  p_environment       text,
  p_receipt_sha256    text    -- 收据摘要；webhook 路径可空
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner     text;
  v_prod      payment_products%ROWTYPE;
  v_existing  apple_transactions%ROWTYPE;
  v_ent_id    bigint;
  v_ent_plan  text;
  v_ent_until timestamptz;
  v_expires   timestamptz;
  v_purchased timestamptz;
  v_order     payment_orders%ROWTYPE;
BEGIN
  -- ── 幂等第一闸：这笔交易是否已核销过 ──
  SELECT * INTO v_existing FROM apple_transactions
   WHERE transaction_id = p_transaction_id;

  IF FOUND THEN
    -- webhook 续订通知会带**新** transaction_id，走不到这里；
    -- 走到这里的是「同一交易重复提交」（客户端重试 / 恢复购买重放）。
    IF p_owner_id IS NOT NULL AND v_existing.owner_id <> p_owner_id THEN
      -- 换账号重放他人收据：拒绝（网关据此回 409 并 warn 留痕）
      RETURN json_build_object('error', 'txn_taken_by_other');
    END IF;
    -- 同 owner 重复核销：幂等返回成功 + 当前权益（不重复顺延！）
    SELECT id, plan, pro_until INTO v_ent_id, v_ent_plan, v_ent_until
      FROM entitlements WHERE owner_id = v_existing.owner_id;
    RETURN json_build_object(
      'settled', true, 'duplicate', true,
      'owner_id', v_existing.owner_id,
      'plan', COALESCE(v_ent_plan, 'free'),
      'pro_until', v_ent_until
    );
  END IF;

  -- ── owner 解析：webhook 路径（p_owner_id NULL）按订阅归组反查 ──
  v_owner := p_owner_id;
  IF v_owner IS NULL THEN
    SELECT owner_id INTO v_owner FROM apple_transactions
     WHERE original_transaction_id = p_original_txn_id
     ORDER BY settled_at ASC LIMIT 1;
    IF v_owner IS NULL THEN
      -- 用户从未在客户端核销过这笔订阅 → 无人可发，只留痕（网关落通知表）
      RETURN json_build_object('error', 'owner_unresolved');
    END IF;
  END IF;

  -- ── 商品映射：payment_products 是唯一事实源 ──
  SELECT * INTO v_prod FROM payment_products
   WHERE product_id = p_product_id AND active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'unknown_product');
  END IF;

  -- ── 时间解析（Apple 报文是毫秒字符串）──
  IF p_expires_ms IS NOT NULL AND p_expires_ms ~ '^\d+$' THEN
    v_expires := to_timestamp(p_expires_ms::bigint / 1000.0);
  END IF;
  IF p_purchase_ms IS NOT NULL AND p_purchase_ms ~ '^\d+$' THEN
    v_purchased := to_timestamp(p_purchase_ms::bigint / 1000.0);
  END IF;

  -- ── 记录交易（先于权益写：UNIQUE 冲突 = 并发重复核销，整个事务回滚）──
  INSERT INTO apple_transactions
    (transaction_id, original_transaction_id, owner_id, product_id, plan,
     order_no, expires_at, purchased_at, environment, receipt_sha256)
  VALUES
    (p_transaction_id, COALESCE(p_original_txn_id, p_transaction_id), v_owner,
     p_product_id, v_prod.plan, p_order_no, v_expires, v_purchased,
     p_environment, p_receipt_sha256);

  -- ── 权益落库（与 0029 同款语义，但订阅到期以 Apple expires 为权威）──
  SELECT id, plan, pro_until INTO v_ent_id, v_ent_plan, v_ent_until
    FROM entitlements WHERE owner_id = v_owner;

  IF v_prod.plan = 'lifetime' THEN
    -- 买断：直接覆盖为 lifetime（已有 lifetime 则幂等无操作）
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_owner, 'lifetime', NULL, 'apple')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime', pro_until = NULL, source = 'apple', updated_at = now();
  ELSE
    -- pro 订阅：
    --   · 有 expires（自动续期商品的常态）→ pro_until = GREATEST(现值, Apple 到期)
    --     GREATEST 保证：乱序到达的旧续订通知不会把更晚的到期时间拉回去。
    --   · 无 expires（理论上不出现，防御分支）→ 按 months 顺延（0029 旧语义）。
    IF v_expires IS NOT NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_owner, 'pro', v_expires, 'apple')
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
            pro_until = CASE
              WHEN entitlements.plan = 'lifetime' THEN NULL  -- 买断不降级
              ELSE GREATEST(COALESCE(entitlements.pro_until, now()), v_expires)
            END,
            source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'apple' END,
            updated_at = now();
    ELSE
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_owner, 'pro',
              now() + make_interval(months => COALESCE(v_prod.months, 1)), 'apple')
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
            pro_until = CASE
              WHEN entitlements.plan = 'lifetime' THEN NULL
              WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
                THEN entitlements.pro_until + make_interval(months => COALESCE(v_prod.months, 1))
              ELSE now() + make_interval(months => COALESCE(v_prod.months, 1))
            END,
            source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'apple' END,
            updated_at = now();
    END IF;
  END IF;

  -- ── 订单核销（仅客户端购买路径；owner 与商品都对得上才动订单）──
  IF p_order_no IS NOT NULL AND left(p_order_no, 8) <> 'restore-' THEN
    SELECT * INTO v_order FROM payment_orders WHERE order_no = p_order_no;
    IF FOUND
       AND v_order.owner_id = v_owner
       AND v_order.product_id = p_product_id
       AND v_order.status = 'pending' THEN
      UPDATE payment_orders
         SET status = 'paid',
             provider_txn_id = p_transaction_id,
             -- 只存摘要（见文件头「为什么收据只存摘要」）
             receipt_payload = 'sha256:' || COALESCE(p_receipt_sha256, ''),
             updated_at = now()
       WHERE id = v_order.id;
    END IF;
    -- owner/商品不符或订单不存在：不动订单（留 pending 供人工对账），
    -- 权益已按 Apple 报文如实发放 —— 收据真实性由网关验签背书。
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

-- ── ⑤ 撤销函数（REFUND / REVOKE）────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_apple_purchase(
  p_transaction_id    text,
  p_original_txn_id   text,
  p_reason            text      -- 'refund' / 'revoke'
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn   apple_transactions%ROWTYPE;
  v_owner text;
BEGIN
  -- 退款通知带的是被退那笔的 transaction_id；找不到再按订阅归组兜底
  SELECT * INTO v_txn FROM apple_transactions
   WHERE transaction_id = p_transaction_id;
  IF NOT FOUND AND p_original_txn_id IS NOT NULL THEN
    SELECT * INTO v_txn FROM apple_transactions
     WHERE original_transaction_id = p_original_txn_id
     ORDER BY settled_at DESC LIMIT 1;
  END IF;
  IF NOT FOUND THEN
    RETURN json_build_object('revoked', false, 'error', 'txn_not_found');
  END IF;

  IF v_txn.revoked THEN
    RETURN json_build_object('revoked', true, 'duplicate', true, 'owner_id', v_txn.owner_id);
  END IF;

  v_owner := v_txn.owner_id;

  UPDATE apple_transactions
     SET revoked = true, revoked_reason = p_reason, revoked_at = now()
   WHERE id = v_txn.id;

  -- 权益回收：只动 source='apple' 的权益。
  -- 用户若另有兑换码/蜜糖兑换的 lifetime（source<>'apple'），不能被误伤；
  -- 反之苹果侧退了款，苹果发的权益必须收回（否则退款白嫖）。
  -- pro 到期时间处理：把该笔交易的时长贡献扣掉过于复杂且有争议
  -- （多次续订交叠），采用**保守整段回收**：退款即清掉 apple 来源的 pro_until。
  -- 若同时存在其他来源的有效权益（蜜糖兑换的 pro），那些走各自 source，
  -- 本 UPDATE 不命中（entitlements 一行一 owner，source 是最后一次发放来源）。
  -- ⚠️ 已知边界：蜜糖兑换 pro 后又苹果购买 pro（source 变 apple），退款会
  --   连带清掉蜜糖那段时长。发生率低且宁可少给不可多给（退款白嫖是资损），
  --   真发生走客服补发（redeem 通道仍在）。
  UPDATE entitlements
     SET plan = 'free', pro_until = NULL, source = NULL, updated_at = now()
   WHERE owner_id = v_owner AND source = 'apple';

  -- 订单侧同步（能对上的话）
  UPDATE payment_orders
     SET status = 'refunded', updated_at = now()
   WHERE provider_txn_id = p_transaction_id AND status = 'paid';

  RETURN json_build_object('revoked', true, 'owner_id', v_owner, 'plan_now', 'free');
END;
$$;

-- ── ⑥ 通知留痕函数 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_apple_notification(
  p_payload       jsonb,
  p_transaction_id text,
  p_original_txn_id text,
  p_processed     boolean,
  p_error         text
)
RETURNS void
LANGUAGE sql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO apple_notifications
    (notification_type, transaction_id, original_transaction_id, processed, error, payload)
  VALUES
    (p_payload ->> 'notificationType', p_transaction_id, p_original_txn_id,
     COALESCE(p_processed, false), p_error, p_payload);
$$;

-- ── ⑦ 函数授权：只有网关连接角色能调 ───────────────────────────────────
-- 先 REVOKE 再 GRANT（0033 实测的 GRANT 追加语义坑）
REVOKE ALL ON FUNCTION public.settle_apple_purchase(text,text,text,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON FUNCTION public.revoke_apple_purchase(text,text,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
REVOKE ALL ON FUNCTION public.log_apple_notification(jsonb,text,text,boolean,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.settle_apple_purchase(text,text,text,text,text,text,text,text,text) FROM dbee_web';
    EXECUTE 'REVOKE ALL ON FUNCTION public.revoke_apple_purchase(text,text,text) FROM dbee_web';
    EXECUTE 'REVOKE ALL ON FUNCTION public.log_apple_notification(jsonb,text,text,boolean,text) FROM dbee_web';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.settle_apple_purchase(text,text,text,text,text,text,text,text,text) TO dbee_app;
GRANT EXECUTE ON FUNCTION public.revoke_apple_purchase(text,text,text) TO dbee_app;
GRANT EXECUTE ON FUNCTION public.log_apple_notification(jsonb,text,text,boolean,text) TO dbee_app;

-- 注意：**不** NOTIFY pgrst reload。两张新表对 PostgREST（dbee_web）完全不可见
-- （REVOKE + FORCE RLS 无 policy），函数也只授 dbee_app；PostgREST 的 schema
-- 缓存里没有它们的位置，reload 无意义。

-- ── ⑧ 登记迁移追踪表（0034 建的；模式与 0035 一致）─────────────────────
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0037: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0037', 'apple-iap-settlement', 'applied', 'self',
          'Apple IAP 网关核销落库：apple_transactions（幂等表）+ apple_notifications（留痕表）'
          ' + settle/revoke/log 三个 definer 函数（EXECUTE 仅 dbee_app）。'
          ' 配套网关 server/lib/iap.mjs（10-22 决策 #6：验签在 Node，弃 pg_net/0029）')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（部署后手工/脚本执行）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) 对象齐了：
--    SELECT to_regclass('public.apple_transactions'), to_regclass('public.apple_notifications');
--    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname IN
--       ('settle_apple_purchase','revoke_apple_purchase','log_apple_notification');
--    期望：两表非 NULL，三函数齐。
-- 2) 前端角色全堵（以 authenticated 身份）：
--    SET ROLE authenticated;
--    SELECT count(*) FROM apple_transactions;                    -- 期望 permission denied
--    SELECT public.settle_apple_purchase(NULL,NULL,'x','t','o',NULL,NULL,NULL,NULL);
--                                                                -- 期望 permission denied
--    RESET ROLE;
-- 3) 网关角色只能调函数不能读表：
--    SET ROLE dbee_app;
--    SELECT count(*) FROM apple_transactions;                    -- 期望 permission denied
--    SELECT public.settle_apple_purchase('no-such-owner',NULL,'dbee_not_exist','txn-test','orig-test',NULL,NULL,'Sandbox',NULL);
--    RESET ROLE;                                                 -- 期望 {"error":"unknown_product"}
-- 4) 幂等/防重放（用真商品干跑，事后清理）：
--    以 dbee_app 连续两次 settle 同一 txn（owner 用测试值）→ 第二次 duplicate:true；
--    换 owner 重放 → 'txn_taken_by_other'；
--    清理：以 postgres DELETE FROM apple_transactions WHERE transaction_id='…';
--         并还原 entitlements 测试行。
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚
-- ═══════════════════════════════════════════════════════════════════════
-- 备份（执行本迁移前）：
--   sudo -u postgres pg_dump -d dbee -F c -f /opt/dbee-db/backup-before-0037.dump
-- 精确回滚（本迁移纯增量，无破坏性修改）：
--   DROP FUNCTION IF EXISTS public.settle_apple_purchase(text,text,text,text,text,text,text,text,text);
--   DROP FUNCTION IF EXISTS public.revoke_apple_purchase(text,text,text);
--   DROP FUNCTION IF EXISTS public.log_apple_notification(jsonb,text,text,boolean,text);
--   DROP TABLE IF EXISTS public.apple_notifications;
--   DROP TABLE IF EXISTS public.apple_transactions;
--   DELETE FROM public.schema_migrations WHERE version='0037';
-- ═══════════════════════════════════════════════════════════════════════
