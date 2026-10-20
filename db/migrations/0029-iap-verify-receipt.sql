-- ═══════════════════════════════════════════════════════════════
-- 0029 · iOS IAP 凭证验签（verifyReceipt）+ 权益落库
--
-- 背景：Apple 个人开发者账号已就绪（2026-10-20），补齐 0021 中
--   verify_payment_order 留空的 apple 分支。这是真实收费链路的
--   「最后一道闸门」——此前一律返回 false 防白嫖。
--
-- 架构说明（重要）：
--   验签需要 HTTPS 外呼 Apple 服务器（verifyReceipt），且需持有
--   sharedSecret（订阅专用密钥，绝不能暴露给前端）。本迁移用
--   pg_net 扩展（`net.http_post`）在数据库内完成外呼，密钥存于
--   受 RLS 保护的配置表 `app_config`（仅 SECURITY DEFINER 函数可读）。
--
-- ⚠️ 前置条件（执行前必须确认，否则函数建好后验签恒失败）：
--   1. 云环境已启用 pg_net 扩展：CREATE EXTENSION IF NOT EXISTS pg_net;
--      且允许访问 Apple 域名（buy.itunes.apple.com / sandbox）。
--      若 TCB 环境不支持 pg_net 外呼，本方案需改为云函数/Edge 验签
--      （见 docs/iOS收费IAP落地清单.md 第 4 步的备选说明）。
--   2. 已向 app_config 写入 apple_shared_secret（App Store Connect
--      生成的订阅共享密钥）。
--   3. App Store Connect 已配好三档商品 + 协议税务银行（收款的硬前提）。
--
-- verifyReceipt 双环境策略：
--   - 先用生产地址验签，返回 21007（沙箱收据发到生产）则改调沙箱地址重试。
--   - 21008（生产收据发到沙箱）少见，直接判失败。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate（逐条执行）
-- ═══════════════════════════════════════════════════════════════

-- 1. 应用配置表（存 sharedSecret 等敏感项，RLS 隔离，仅 SECURITY DEFINER 可读）
CREATE TABLE IF NOT EXISTS public.app_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.app_config IS '应用级敏感配置（如 Apple sharedSecret），仅经 SECURITY DEFINER 函数访问';

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_config FROM PUBLIC, anon, authenticated;

-- 2. 启用 pg_net（若环境支持）
--    注：TCB 若不支持此扩展，本行会报错，届时改走云函数方案。
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3. 重写 verify_payment_order：补 apple 分支（verifyReceipt 验签 + 写权益）
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
  v_uid       text := auth.uid();
  v_order     payment_orders%ROWTYPE;
  v_secret    text;
  v_resp      jsonb;
  v_status    int;
  v_receipt_ok boolean := false;
  v_body      jsonb;
  v_apple_ok  boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_order FROM payment_orders
   WHERE order_no = p_order_no AND owner_id = v_uid;
  IF NOT FOUND THEN
    -- 恢复购买场景：order_no 可能为 restore-<txnId>，允许无订单直接验签发权益
    IF left(p_order_no, 8) = 'restore-' THEN
      -- 走下方的验签 + 写权益（订单信息缺失，按 transaction 内容核销）
      v_order := NULL;
    ELSE
      RETURN false;
    END IF;
  END IF;

  IF v_order IS NOT NULL AND v_order.status = 'paid' THEN
    RETURN true;  -- 已核销过，幂等直接返回成功
  END IF;

  -- ── Apple 分支：verifyReceipt 验签 ──
  IF v_order IS NOT NULL AND v_order.provider = 'apple' THEN
    SELECT value INTO v_secret FROM app_config WHERE key = 'apple_shared_secret';
    IF v_secret IS NULL OR v_secret = '' THEN
      RETURN false;  -- 未配置密钥，拒绝（安全兜底）
    END IF;

    -- 生产地址验签
    v_body := jsonb_build_object(
      'receipt-data', p_receipt,
      'password', v_secret,
      'exclude-old-transactions', true
    );

    SELECT status_code, body INTO v_status, v_resp
      FROM net.http_post(
        url := 'https://buy.itunes.apple.com/verifyReceipt',
        body := v_body::text,
        headers := jsonb_build_object('Content-Type', 'application/json')
      );

    -- 21007 = 沙箱收据发到了生产，改调沙箱
    IF v_status IS NULL OR v_resp IS NULL THEN
      RETURN false;
    END IF;
    IF v_resp->>'status' = '21007' THEN
      SELECT status_code, body INTO v_status, v_resp
        FROM net.http_post(
          url := 'https://sandbox.itunes.apple.com/verifyReceipt',
          body := v_body::text,
          headers := jsonb_build_object('Content-Type', 'application/json')
        );
    END IF;

    -- status = 0 表示收据合法
    v_apple_ok := (v_status = 200 AND (v_resp->>'status') = '0');

    IF NOT v_apple_ok THEN
      RETURN false;
    END IF;

    -- 写权益（pro 顺延 / lifetime 买断）
    IF v_order.plan = 'lifetime' THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_uid, 'lifetime', NULL, 'apple')
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = 'lifetime', pro_until = NULL, source = 'apple', updated_at = now();
    ELSIF v_order.plan = 'pro' THEN
      -- 订阅顺延：未过期则在现有 pro_until 基础上累加月份
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (
        v_uid, 'pro',
        now() + (COALESCE(v_order.months, 1) || ' months')::interval,
        'apple'
      )
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = 'pro',
            pro_until = CASE
              WHEN entitlements.plan = 'pro'
                   AND entitlements.pro_until IS NOT NULL
                   AND entitlements.pro_until > now()
                THEN entitlements.pro_until + (COALESCE(v_order.months, 1) || ' months')::interval
              ELSE now() + (COALESCE(v_order.months, 1) || ' months')::interval
            END,
            source = 'apple',
            updated_at = now();
    END IF;

    -- 标记订单已支付
    IF v_order IS NOT NULL THEN
      UPDATE payment_orders
         SET status = 'paid',
             provider_txn_id = p_provider_txn_id,
             receipt_payload = p_receipt,
             updated_at = now()
       WHERE id = v_order.id;
    END IF;

    RETURN true;
  END IF;

  -- ── 其他 provider（google / wechat / alipay）暂未接验签，默认拒绝 ──
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_payment_order(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_payment_order(text, text, text) TO authenticated;
