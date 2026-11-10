/**
 * D · Android APP 支付（微信 APP 支付 V3 / 支付宝 App 支付 RSA2）
 *   —— 统一下单、回调验签、主动查单兜底。
 *
 * 2026-11-09 用户定案：「Android 端必须能收款；Web 暂不收费只做引导；四端业务逻辑不变。」
 *   本模块是 Android 收款的**服务端地基**，与 0046 的 xpay.mjs（小程序虚拟支付）
 *   **并列且互不复用**：xpay 是米大师虚拟支付（provider='wechat_xpay'），
 *   本模块是普通商户号的 APP 支付（provider='wechat'/'alipay'），两套商户体系。
 *
 * ── 端点（挂在 /.cloud/payment/apppay 前缀，app.mjs 装配）──────────────
 *   POST /.cloud/payment/apppay/prepay   统一下单（需 Bearer）→ 平台拉起参数
 *   POST /.cloud/payment/apppay/query    主动查单兜底（需 Bearer）→ 补发权益
 *   POST /.cloud/payment/wechat-app/notify   微信支付结果通知（微信直发，无 Bearer）
 *   POST /.cloud/payment/alipay/notify       支付宝异步通知（支付宝直发，无 Bearer）
 *
 * ── 🔴 推模式（继承 P1-D §二-A / 0046 既定决策）─────────────────────────
 *   客户端 SDK 支付成功 **只代表用户付完了钱**；权益发放的权威信号是服务端
 *   异步收到的支付回调验签通过后 settle_app_payment（0047）。
 *   → prepay 只下单不发权益；notify 才发；query 兜底「回调未到」的窗口。
 *   → verify_payment_order（0047 已改查单语义）对 wechat/alipay 回订单状态，
 *     回调未到 → false，前端有限重试（src/lib/payment/apppayClient.ts），
 *     窗口内提示「支付已完成，权益正在到账」，**绝不报 error**（已扣款报错 = 资损）。
 *
 * ── 🔴 安全边界（继承 iap/xpay 五条 + APP 支付特有）─────────────────────
 *   1. prepay/query 必须带网关 Bearer JWT（含 token_version 校验，同 xpay）；
 *   2. 下单金额/商品以 payment_orders（create_payment_order 服务端查价）为唯一
 *      事实源：客户端只报 order_no，price/product 一律查库，改不了；
 *   3. 回调验签用**平台公钥/证书**（微信 V3 平台证书、支付宝公钥），验签失败 →
 *      400（不是平台发的，重试也没用），**绝不**因验签异常而放行发权益；
 *   4. 回调金额 < 订单金额 → 拒绝发权益（amount_mismatch，防「1 分钱买会员」）；
 *   5. 幂等键 = out_trade_no（我方业务单号，见 0047 头注），settle/revoke UNIQUE 兜底；
 *   6. 商户私钥 / APIv3 密钥 / 支付宝私钥一律不进日志、不下发前端。
 *
 * ── 🔴 零依赖签名（与项目「只依赖 pg」纪律一致，全部 node:crypto 手写）───
 *   微信 V3：RSA-SHA256（商户私钥签名，平台证书验签）+ AES-256-GCM（APIv3 密钥解密回调）
 *   支付宝：RSA2 = SHA256withRSA（商户私钥签名，支付宝公钥验签）
 *   签名/验签/解密全部抽成**导出纯函数**，供 tools/apppay-selftest.mjs 用自造密钥
 *   做正/负用例（正确签名→通过、篡改→拒绝），无需真实商户号即可验证密码学实现。
 */
import { createSign, createVerify, createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { verifyJwt, bearerFrom } from './jwt.mjs'
import { cloudError, readBody } from './http.mjs'
import { getTokenVersion } from './identity.mjs'

// ══════════════════════════════════════════════════════════════════
// 一、微信 APP 支付 V3 —— 签名 / 验签 / 回调解密（纯函数，导出供自测）
// ══════════════════════════════════════════════════════════════════

/**
 * RSA-SHA256 签名，返回 base64（微信 V3 / 支付宝 RSA2 通用底层）。
 * @param {string|Buffer} privateKeyPem PKCS#8 PEM（可带换行）
 * @param {string} message 待签原文（**必须与实际发送字节逐字一致**）
 */
export function rsaSign(privateKeyPem, message) {
  return createSign('RSA-SHA256').update(message, 'utf8').end().sign(privateKeyPem, 'base64')
}

/**
 * RSA-SHA256 验签（微信 V3 平台证书 / 支付宝公钥通用底层）。
 * @param {string|Buffer} publicKeyPem 公钥/证书 PEM
 * @param {string} message 待验原文
 * @param {string} signatureBase64 签名（base64）
 * @returns {boolean}
 */
export function rsaVerify(publicKeyPem, message, signatureBase64) {
  try {
    return createVerify('RSA-SHA256').update(message, 'utf8').end()
      .verify(publicKeyPem, signatureBase64, 'base64')
  } catch {
    return false // 证书格式错 / 签名非法：一律 false，绝不放行
  }
}

/** 微信支付 V3 Authorization 头的签名原文：method\nurl\ntimestamp\nnonce\nbody\n */
export function wechatV3SignMessage(method, urlPath, timestamp, nonceStr, body) {
  return `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`
}

/**
 * 微信 V3 请求 Authorization 头（WECHATPAY2-SHA256-RSA2048）。
 * @returns {string} 形如 `WECHATPAY2-SHA256-RSA2048 mchid="..",nonce_str="..",timestamp="..",serial_no="..",signature=".."`
 */
export function buildWechatV3AuthHeader({ mchid, serialNo, privateKeyPem, method, urlPath, body, timestamp, nonceStr }) {
  const message = wechatV3SignMessage(method, urlPath, timestamp, nonceStr, body)
  const signature = rsaSign(privateKeyPem, message)
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",` +
    `nonce_str="${nonceStr}",timestamp="${timestamp}",` +
    `serial_no="${serialNo}",signature="${signature}"`
  )
}

/**
 * 微信 APP 支付「拉起收银台」二次签名原文：appid\ntimestamp\nnoncestr\nprepayid\n
 * （与 JSAPI 的 package 拼接不同，APP 支付这四行固定顺序，package 单独传 "Sign=WXPay"）
 */
export function wechatAppPaySignMessage(appid, timestamp, nonceStr, prepayId) {
  return `${appid}\n${timestamp}\n${nonceStr}\n${prepayId}\n`
}

/**
 * 微信 V3 回调通知验签原文：timestamp\nnonce\nbody\n
 * @returns {boolean} 验签是否通过
 */
export function verifyWechatNotifySignature({ platformCertPem, timestamp, nonce, body, signature }) {
  if (!platformCertPem || !timestamp || !nonce || !signature) return false
  const message = `${timestamp}\n${nonce}\n${body}\n`
  return rsaVerify(platformCertPem, message, signature)
}

/**
 * 微信 V3 回调 resource 解密（AES-256-GCM，密钥 = APIv3 密钥 32 字节）。
 * resource = { ciphertext, associated_data, nonce }，均为 base64（nonce 除外）。
 * @returns {object|null} 解密后的 JSON（含 out_trade_no/transaction_id/trade_state/amount/payer），失败 null
 */
export function decryptWechatNotifyResource(apiV3Key, resource) {
  try {
    const key = Buffer.from(apiV3Key, 'utf8')
    if (key.length !== 32) return null // APIv3 密钥必须 32 字节
    const ciphertext = Buffer.from(resource.ciphertext, 'base64')
    const nonce = Buffer.from(resource.nonce, 'utf8')
    const aad = Buffer.from(resource.associated_data || '', 'utf8')
    // 微信把 authTag 附在 ciphertext 末尾 16 字节
    const authTag = ciphertext.subarray(ciphertext.length - 16)
    const data = ciphertext.subarray(0, ciphertext.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    if (aad.length) decipher.setAAD(aad)
    const plain = Buffer.concat([decipher.update(data), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return null // 密钥错 / 报文被篡改 / 非法 base64：一律 null（调用方据此拒发权益）
  }
}

/** AES-256-GCM 加密（与 decrypt 对称，仅供自测构造回调报文用） */
export function encryptWechatNotifyResource(apiV3Key, plaintextObj, { nonce, associatedData = '' } = {}) {
  const key = Buffer.from(apiV3Key, 'utf8')
  const iv = Buffer.from(nonce || randomBytes(12).toString('hex').slice(0, 12), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const aad = Buffer.from(associatedData, 'utf8')
  if (aad.length) cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(JSON.stringify(plaintextObj), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([enc, authTag]).toString('base64'),
    nonce: iv.toString('utf8'),
    associated_data: associatedData,
  }
}

// ══════════════════════════════════════════════════════════════════
// 二、支付宝 App 支付 RSA2 —— orderStr 构造 / 验签（纯函数，导出供自测）
// ══════════════════════════════════════════════════════════════════

/**
 * 支付宝「待签名字符串」：所有非空参数按 key 字典序排列，k=v&k=v 拼接（value 不 urlencode）。
 * 🔴 签名与发送必须用同一份拼接结果；sign / sign_type 不参与签名。
 * @param {Record<string,string|number|undefined>} params
 */
export function alipaySignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type')
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
}

/**
 * 构造支付宝 App 支付 orderStr（喂给 SDK payV2）。
 * 业务参数放 biz_content（JSON 字符串），整体 RSA2 签名后 urlencoded 拼接。
 * @returns {string} 完整 orderStr
 */
export function buildAlipayOrderStr({ appId, method, bizContent, notifyUrl, privateKeyPem, timestamp, version = '1.0', charset = 'utf-8' }) {
  const params = {
    app_id: appId,
    method,
    format: 'JSON',
    charset,
    sign_type: 'RSA2',
    timestamp,
    version,
    notify_url: notifyUrl,
    biz_content: typeof bizContent === 'string' ? bizContent : JSON.stringify(bizContent),
  }
  const content = alipaySignContent(params)
  const sign = rsaSign(privateKeyPem, content)
  // orderStr = 参数 urlencode 拼接 + &sign=urlencode(sign)
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) usp.append(k, v)
  usp.append('sign', sign)
  return usp.toString()
}

/**
 * 支付宝异步通知验签。
 * 通知是 form 表单（application/x-www-form-urlencoded），含 sign / sign_type + 业务字段。
 * 验签：取除 sign / sign_type 外全部字段，按 alipaySignContent 拼接，用**支付宝公钥**RSA2 验。
 * 🔴 通知字段值已是 urldecode 后的原值（Node querystring 解析所得），直接拼接即可。
 * @returns {boolean}
 */
export function verifyAlipayNotifySignature({ alipayPublicKeyPem, params, sign }) {
  if (!alipayPublicKeyPem || !sign) return false
  const content = alipaySignContent(params)
  return rsaVerify(alipayPublicKeyPem, content, sign)
}

// ══════════════════════════════════════════════════════════════════
// 三、handlers 工厂（deps 注入，同 iap/xpay 风格）
// ══════════════════════════════════════════════════════════════════

const WECHAT_APP_ORDER_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/app'
const WECHAT_APP_ORDER_PATH = '/v3/pay/transactions/app'
const WECHAT_QUERY_PATH = (outTradeNo) => `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=`
const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do'

/**
 * @param {object} deps
 * @param {object} deps.cfg          loadConfig() 产物
 * @param {object} deps.pool         业务池 dbee_app（调 0047 definer 函数 + 读 payment_orders）
 * @param {object} deps.gatewayPool  身份池（token_version 校验）
 * @param {object} deps.logger
 * @param {typeof globalThis.fetch} [deps.fetchImpl] 自测注入（微信/支付宝外呼）
 * @param {object} [deps.clock]      自测注入 { now() }（固定时间戳）
 * @param {() => string} [deps.nonceImpl] 自测注入（固定 nonce）
 */
export function createAppPayHandlers(deps) {
  const { cfg, pool, gatewayPool, logger } = deps
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.clock?.now ?? (() => Math.floor(Date.now() / 1000))
  const nonce = deps.nonceImpl ?? (() => randomBytes(16).toString('hex'))

  // 微信 APP 支付就绪：商户号 + 序列号 + 私钥 + APIv3 密钥 + AppID 齐备
  const wechatConfigured = () =>
    !!(cfg.wechatPayMchid && cfg.wechatPaySerialNo && cfg.wechatPayPrivateKey &&
       cfg.wechatPayApiV3Key && cfg.wechatPayAppId)
  // 支付宝就绪：AppID + 商户私钥 + 支付宝公钥齐备
  const alipayConfigured = () =>
    !!(cfg.alipayAppId && cfg.alipayPrivateKey && cfg.alipayPublicKey)
  // 任一渠道就绪即可提供 prepay（具体渠道按订单 provider + 该渠道是否配置决定）
  const anyConfigured = () => wechatConfigured() || alipayConfigured()

  function notConfigured(res) {
    return cloudError(res, 503, 'App 支付未配置', 'apppay_not_configured')
  }

  /** Bearer → ownerId（带 token_version 校验，同 xpay.mjs authOwnerId） */
  async function authOwnerId(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    if (!v) return null
    const sub = v?.payload?.sub
    if (typeof sub !== 'string' || !sub) return null
    if (gatewayPool && Number.isInteger(v.payload.ver)) {
      try {
        const cur = await getTokenVersion(gatewayPool, sub)
        if (cur == null || cur !== v.payload.ver) return null
      } catch (err) {
        logger.error(`[apppay] token_version 查询失败，跳过版本校验: ${err?.message || err}`)
      }
    }
    return sub
  }

  /**
   * 按 order_no 读订单（pool=dbee_app）。返回 { order } 或 { error }。
   * 🔴 列名严格对齐 0021 的 payment_orders 建表定义（无 quantity 列，一单一件）。
   */
  async function loadOrder(orderNo, ownerId) {
    const { rows } = await pool.query(
      `SELECT order_no, owner_id, product_id, plan, months, amount_cents, currency, status, provider
         FROM public.payment_orders
        WHERE order_no = $1`,
      [orderNo],
    )
    const order = rows[0]
    if (!order) return { error: { status: 404, message: '订单不存在', code: 'order_not_found' } }
    if (ownerId && order.owner_id !== ownerId) {
      logger.warn(`[apppay] 订单归属不符 order=${orderNo} order_owner=${order.owner_id} jwt=${ownerId}`)
      return { error: { status: 403, message: '订单不属于当前用户', code: 'order_forbidden' } }
    }
    return { order }
  }

  /** 商品描述（下单 subject/body 用）：从 plan + months 生成，不含价格（价格走 amount） */
  function productSubject(order) {
    if (order.plan === 'lifetime') return '自律蜜蜂 · 终身会员'
    const m = Number(order.months) || 1
    return m >= 12 ? `自律蜜蜂 · Pro 会员 ${Math.round(m / 12)} 年` : `自律蜜蜂 · Pro 会员 ${m} 个月`
  }

  // ── 微信 V3 统一下单外呼 ────────────────────────────────────────────
  async function wechatUnifiedOrder(order, ownerId) {
    const bodyObj = {
      appid: cfg.wechatPayAppId,
      mchid: cfg.wechatPayMchid,
      description: productSubject(order),
      out_trade_no: order.order_no,
      notify_url: `${cfg.publicBaseUrl}/.cloud/payment/wechat-app/notify`,
      amount: { total: Number(order.amount_cents), currency: order.currency || 'CNY' },
      // attach 透传 owner_id，回调时可用于交叉校验（仍以订单归属为准）
      attach: ownerId,
    }
    const body = JSON.stringify(bodyObj)
    const timestamp = String(now())
    const nonceStr = nonce()
    const authorization = buildWechatV3AuthHeader({
      mchid: cfg.wechatPayMchid,
      serialNo: cfg.wechatPaySerialNo,
      privateKeyPem: cfg.wechatPayPrivateKey,
      method: 'POST',
      urlPath: WECHAT_APP_ORDER_PATH,
      body,
      timestamp,
      nonceStr,
    })
    const resp = await fetchImpl(WECHAT_APP_ORDER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'dbee-apppay/1.0',
        authorization,
      },
      body,
    })
    const text = await resp.text()
    if (!resp.ok) {
      logger.warn(`[apppay] 微信统一下单失败 status=${resp.status} body=${text.slice(0, 200)}`)
      throw Object.assign(new Error('wechat_unified_order_failed'), { detail: text })
    }
    const data = JSON.parse(text)
    const prepayId = data?.prepay_id
    if (!prepayId) throw new Error('wechat_missing_prepay_id')

    // APP 拉起参数二次签名（appid\ntimestamp\nnonce\nprepayid\n）
    const ts2 = String(now())
    const nonce2 = nonce()
    const sign = rsaSign(cfg.wechatPayPrivateKey, wechatAppPaySignMessage(cfg.wechatPayAppId, ts2, nonce2, prepayId))
    return {
      partnerId: cfg.wechatPayMchid,
      prepayId,
      nonceStr: nonce2,
      timeStamp: ts2,
      package: 'Sign=WXPay',
      sign,
    }
  }

  // ── 支付宝 App 支付 orderStr 构造（无需外呼，本地签名即可）───────────
  function alipayOrderStr(order) {
    const timestamp = new Date(now() * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const bizContent = {
      out_trade_no: order.order_no,
      total_amount: (Number(order.amount_cents) / 100).toFixed(2), // 支付宝金额单位=元，两位小数
      subject: productSubject(order),
      product_code: 'QUICK_MSECURITY_PAY', // 支付宝 App 支付固定值
      timeout_express: '15m',
    }
    return buildAlipayOrderStr({
      appId: cfg.alipayAppId,
      method: 'alipay.trade.app.pay',
      bizContent,
      notifyUrl: `${cfg.publicBaseUrl}/.cloud/payment/alipay/notify`,
      privateKeyPem: cfg.alipayPrivateKey,
      timestamp,
    })
  }

  /** 通用 settle：调 0047 definer 函数发权益。返回 { ok, result, code } */
  async function settle(args) {
    try {
      const { rows } = await pool.query(
        `SELECT public.settle_app_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r`,
        [
          args.outTradeNo,
          args.ownerId ?? null,
          args.buyerId ?? null,
          args.productId ?? null,
          args.providerTxnId ?? null,
          args.provider,
          args.amountCents ?? null,
          args.paidAtSec ?? null,
          args.channelNote ?? null,
        ],
      )
      const r = rows[0]?.r ?? {}
      if (r.error) return { ok: false, code: r.error }
      return { ok: true, result: r }
    } catch (err) {
      logger.error(`[apppay] settle 失败 order=${args.outTradeNo}: ${err?.message || err}`)
      return { ok: false, code: 'settle_db_error' }
    }
  }

  async function revoke(outTradeNo, providerTxnId, reason) {
    try {
      const { rows } = await pool.query(
        `SELECT public.revoke_app_payment($1,$2,$3) AS r`,
        [outTradeNo ?? null, providerTxnId ?? null, reason],
      )
      return rows[0]?.r ?? {}
    } catch (err) {
      logger.error(`[apppay] revoke 失败 order=${outTradeNo}: ${err?.message || err}`)
      return { revoked: false, error: 'revoke_db_error' }
    }
  }

  async function logNotification(payload, provider, event, outTradeNo, providerTxnId, processed, error) {
    try {
      await pool.query(
        `SELECT public.log_app_notification($1,$2,$3,$4,$5,$6,$7)`,
        [JSON.stringify(payload ?? {}), provider, event, outTradeNo ?? null, providerTxnId ?? null, processed, error ?? null],
      )
    } catch (err) {
      logger.error(`[apppay] 回调留痕失败 event=${event}: ${err?.message || err}`)
    }
  }

  return {
    // ── 统一下单 ──────────────────────────────────────────────────────
    async prepay(req, res, body) {
      if (!anyConfigured()) return notConfigured(res)
      const ownerId = await authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthorized')

      const orderNo = typeof body?.order_no === 'string' ? body.order_no.trim() : ''
      const provider = body?.provider === 'alipay' ? 'alipay' : 'wechat'
      if (!orderNo) return cloudError(res, 400, '缺少 order_no', 'invalid_request')

      // 渠道就绪校验：请求的渠道未配置 → 503（不是 400，用户侧无法修复）
      if (provider === 'wechat' && !wechatConfigured()) {
        return cloudError(res, 503, '微信支付尚未开通', 'wechat_not_configured')
      }
      if (provider === 'alipay' && !alipayConfigured()) {
        return cloudError(res, 503, '支付宝尚未开通', 'alipay_not_configured')
      }

      let order
      try {
        const r = await loadOrder(orderNo, ownerId)
        if (r.error) return cloudError(res, r.error.status, r.error.message, r.error.code)
        order = r.order
      } catch (err) {
        logger.error(`[apppay] prepay 订单查询失败 order=${orderNo}: ${err?.message || err}`)
        return cloudError(res, 500, '订单查询失败，请稍后重试', 'db_error')
      }
      // 已支付/已退款的订单不允许再下单（防重复扣款）
      if (order.status === 'paid') return cloudError(res, 409, '订单已支付', 'order_already_paid')
      if (order.status === 'refunded') return cloudError(res, 409, '订单已退款', 'order_refunded')
      // 订单登记的 provider 必须与请求渠道一致（下单时 create_payment_order 已固定）
      if (order.provider && order.provider !== provider && order.provider !== 'wechat_xpay') {
        return cloudError(res, 409, '支付渠道与订单不符', 'provider_mismatch')
      }

      try {
        const prepay = provider === 'wechat'
          ? await wechatUnifiedOrder(order, ownerId)
          : { orderStr: alipayOrderStr(order) }
        return { status: 200, body: { order_no: order.order_no, provider, prepay } }
      } catch (err) {
        logger.error(`[apppay] ${provider} 下单失败 order=${orderNo}: ${err?.message || err}`)
        return cloudError(res, 502, '支付渠道暂不可用，请稍后重试', 'upstream_error')
      }
    },

    // ── 主动查单兜底（回调丢失时前端轮询 / 运维对账）──────────────────
    // 语义对齐 xpay.mjs query：本地 paid 且非 reconcile → 直接 settled；
    // 否则外呼平台查单，已支付 → settle 补发货，已退款 → revoke。
    async query(req, res, body) {
      if (!anyConfigured()) return notConfigured(res)
      const ownerId = await authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthorized')

      const orderNo = typeof body?.order_no === 'string' ? body.order_no.trim() : ''
      if (!orderNo) return cloudError(res, 400, '缺少 order_no', 'invalid_request')
      const reconcile = body?.reconcile === true

      let order
      try {
        const r = await loadOrder(orderNo, ownerId)
        if (r.error) return cloudError(res, r.error.status, r.error.message, r.error.code)
        order = r.order
      } catch (err) {
        logger.error(`[apppay] query 订单查询失败 order=${orderNo}: ${err?.message || err}`)
        return cloudError(res, 500, '订单查询失败，请稍后重试', 'db_error')
      }
      if (order.status === 'refunded') return { status: 200, body: { settled: false, status: 'refunded' } }
      if (order.status === 'paid' && !reconcile) return { status: 200, body: { settled: true, status: 'paid' } }
      if (order.status === 'cancelled') return { status: 200, body: { settled: false, status: 'cancelled' } }

      // 本地 pending：外呼平台查单
      const provider = order.provider === 'alipay' ? 'alipay' : 'wechat'
      try {
        const remote = provider === 'wechat'
          ? await wechatQueryOrder(orderNo)
          : await alipayQueryOrder(order)
        if (!remote) return { status: 200, body: { settled: false, status: 'pending' } }

        if (remote.tradeState === 'SUCCESS') {
          // 🔴 金额校验：回调/查单金额 < 订单金额 → 拒绝发权益（防 1 分钱买会员）
          if (remote.amountCents != null && remote.amountCents < Number(order.amount_cents)) {
            logger.warn(`[apppay] 查单金额不足 order=${orderNo} paid=${remote.amountCents} expect=${order.amount_cents}`)
            await logNotification({ remote }, provider, 'query_amount_mismatch', orderNo, remote.providerTxnId, false, 'amount_mismatch')
            return { status: 200, body: { settled: false, status: 'pending', code: 'amount_mismatch' } }
          }
          const r = await settle({
            outTradeNo: orderNo, ownerId, buyerId: remote.buyerId,
            productId: order.product_id, providerTxnId: remote.providerTxnId,
            provider, amountCents: remote.amountCents, paidAtSec: remote.paidAtSec,
            channelNote: `query:${provider}`,
          })
          if (r.ok) return { status: 200, body: { settled: true, status: 'paid', plan: r.result?.plan ?? 'pro' } }
          return { status: 200, body: { settled: false, status: 'pending', settling: true, code: r.code } }
        }
        if (remote.tradeState === 'REFUND' || remote.tradeState === 'CLOSED_REFUND') {
          await revoke(orderNo, remote.providerTxnId, 'refund')
          return { status: 200, body: { settled: false, status: 'refunded' } }
        }
        // NOTPAY / CLOSED / USERPAYING 等 → 仍未支付
        return { status: 200, body: { settled: false, status: 'pending' } }
      } catch (err) {
        logger.warn(`[apppay] ${provider} 查单外呼失败 order=${orderNo}: ${err?.message || err}`)
        return { status: 200, body: { settled: false, status: 'pending', retry_later: true } }
      }
    },

    // ── 微信支付结果通知（V3，微信直发，无 Bearer）──────────────────────
    // 🔴 不走 wrap()：notify 自己读原始字节（验签需逐字原文），自己写响应。
    async wechatNotify(req, res) {
      const reply = (status, obj) => {
        if (!res.writableEnded) {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(obj ? JSON.stringify(obj) : '')
        }
      }
      if (!wechatConfigured()) return reply(503, { code: 'NOT_CONFIGURED', message: '微信支付未配置' })

      const raw = await readBody(req, cfg.bodyLimitBytes)
      const bodyStr = raw.toString('utf8')
      const timestamp = req.headers['wechatpay-timestamp']
      const nonceHdr = req.headers['wechatpay-nonce']
      const signature = req.headers['wechatpay-signature']

      // ① 验签（微信平台证书公钥）—— 失败直接 400，绝不放行发权益
      const certPem = cfg.wechatPayPlatformCert
      if (!verifyWechatNotifySignature({ platformCertPem: certPem, timestamp, nonce: nonceHdr, body: bodyStr, signature })) {
        logger.warn(`[apppay] 微信回调验签失败（证书未配/签名不符）`)
        return reply(400, { code: 'SIGN_ERROR', message: '验签失败' })
      }

      let payload
      try { payload = JSON.parse(bodyStr) } catch { return reply(400, { code: 'BAD_REQUEST', message: '报文非法' }) }

      // ② 解密 resource（AES-256-GCM，APIv3 密钥）
      const decrypted = decryptWechatNotifyResource(cfg.wechatPayApiV3Key, payload?.resource)
      if (!decrypted) {
        await logNotification(payload, 'wechat', payload?.event_type || 'pay', null, null, false, 'decrypt_failed')
        return reply(400, { code: 'DECRYPT_ERROR', message: '解密失败' })
      }

      const outTradeNo = decrypted.out_trade_no
      const tradeState = decrypted.trade_state
      const providerTxnId = decrypted.transaction_id
      const amountCents = decrypted.amount?.total != null ? Number(decrypted.amount.total) : null
      const buyerId = decrypted.payer?.openid || ''
      const paidAtSec = decrypted.success_time ? Math.floor(new Date(decrypted.success_time).getTime() / 1000) : null

      // ③ 只处理成功单；其余留痕后回成功（避免微信无谓重试）
      if (tradeState !== 'SUCCESS') {
        await logNotification(decrypted, 'wechat', tradeState, outTradeNo, providerTxnId, true, null)
        return reply(200, { code: 'SUCCESS', message: '成功' })
      }

      // ④ 金额校验（防篡改/防 1 分钱买会员）
      let order = null
      try { const r = await loadOrder(outTradeNo, null); order = r.order ?? null } catch { /* 下面统一处理 */ }
      if (order && amountCents != null && amountCents < Number(order.amount_cents)) {
        logger.warn(`[apppay] 微信回调金额不足 order=${outTradeNo} paid=${amountCents} expect=${order.amount_cents}`)
        await logNotification(decrypted, 'wechat', 'pay_amount_mismatch', outTradeNo, providerTxnId, false, 'amount_mismatch')
        return reply(200, { code: 'SUCCESS', message: '成功' }) // 回成功但**不发权益**，人工对账
      }

      // ⑤ 发权益（幂等：重复回调 settle 内部去重）
      const r = await settle({
        outTradeNo, ownerId: null, buyerId, productId: order?.product_id ?? null,
        providerTxnId, provider: 'wechat', amountCents, paidAtSec, channelNote: 'notify:wechat',
      })
      const processed = r.ok
      await logNotification(decrypted, 'wechat', 'pay', outTradeNo, providerTxnId, processed, r.ok ? null : r.code)
      if (!r.ok) {
        // 业务失败回非 200 让微信重试（自愈机制）；但 settle_db_error 重试也难好，仍回失败留痕
        return reply(500, { code: 'PROCESS_ERROR', message: r.code })
      }
      logger.info(`[apppay] 微信回调核销成功 order=${outTradeNo} plan=${r.result?.plan}`)
      return reply(200, { code: 'SUCCESS', message: '成功' })
    },

    // ── 支付宝异步通知（form 表单，支付宝直发，无 Bearer）────────────────
    async alipayNotify(req, res) {
      // 支付宝要求：处理成功回纯文本 "success"，失败回 "failure"（会重试）
      const reply = (text) => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(text)
        }
      }
      if (!alipayConfigured()) return reply('failure')

      const raw = await readBody(req, cfg.bodyLimitBytes)
      // 支付宝通知是 application/x-www-form-urlencoded，值已 urlencoded
      const params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
      const sign = params.sign
      const tradeStatus = params.trade_status
      const outTradeNo = params.out_trade_no
      const providerTxnId = params.trade_no || null
      const amountYuan = params.total_amount
      const amountCents = amountYuan != null ? Math.round(Number(amountYuan) * 100) : null
      const buyerId = params.buyer_id || params.buyer_logon_id || ''

      // ① 验签（支付宝公钥）—— 失败回 failure（但不发权益）
      if (!verifyAlipayNotifySignature({ alipayPublicKeyPem: cfg.alipayPublicKey, params, sign })) {
        logger.warn(`[apppay] 支付宝回调验签失败 order=${outTradeNo}`)
        await logNotification(params, 'alipay', tradeStatus || 'unknown', outTradeNo, providerTxnId, false, 'sign_error')
        return reply('failure')
      }
      // ② app_id 校验（防串号）
      if (params.app_id && params.app_id !== cfg.alipayAppId) {
        logger.warn(`[apppay] 支付宝回调 app_id 不符 order=${outTradeNo}`)
        await logNotification(params, 'alipay', tradeStatus, outTradeNo, providerTxnId, false, 'appid_mismatch')
        return reply('failure')
      }

      // ③ 只处理交易成功；WAIT_BUYER_PAY / TRADE_CLOSED 留痕回 success（不重试）
      if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
        await logNotification(params, 'alipay', tradeStatus || 'unknown', outTradeNo, providerTxnId, true, null)
        return reply('success')
      }

      // ④ 金额校验
      let order = null
      try { const r = await loadOrder(outTradeNo, null); order = r.order ?? null } catch { /* ignore */ }
      if (order && amountCents != null && amountCents < Number(order.amount_cents)) {
        logger.warn(`[apppay] 支付宝回调金额不足 order=${outTradeNo} paid=${amountCents} expect=${order.amount_cents}`)
        await logNotification(params, 'alipay', 'amount_mismatch', outTradeNo, providerTxnId, false, 'amount_mismatch')
        return reply('success') // 回 success 但不发权益，人工对账
      }

      const paidAtSec = params.gmt_payment ? Math.floor(new Date(params.gmt_payment.replace(' ', 'T') + '+08:00').getTime() / 1000) : null
      const r = await settle({
        outTradeNo, ownerId: null, buyerId, productId: order?.product_id ?? null,
        providerTxnId, provider: 'alipay', amountCents, paidAtSec, channelNote: 'notify:alipay',
      })
      await logNotification(params, 'alipay', 'pay', outTradeNo, providerTxnId, r.ok, r.ok ? null : r.code)
      if (!r.ok) return reply('failure')
      logger.info(`[apppay] 支付宝回调核销成功 order=${outTradeNo} plan=${r.result?.plan}`)
      return reply('success')
    },
  }

  // ── 平台查单外呼（query 用）─────────────────────────────────────────
  async function wechatQueryOrder(outTradeNo) {
    const url = `https://api.mch.weixin.qq.com${WECHAT_QUERY_PATH(outTradeNo)}${cfg.wechatPayMchid}`
    const urlPath = WECHAT_QUERY_PATH(outTradeNo) + cfg.wechatPayMchid
    const timestamp = String(now())
    const nonceStr = nonce()
    const authorization = buildWechatV3AuthHeader({
      mchid: cfg.wechatPayMchid, serialNo: cfg.wechatPaySerialNo,
      privateKeyPem: cfg.wechatPayPrivateKey, method: 'GET', urlPath, body: '', timestamp, nonceStr,
    })
    const resp = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'dbee-apppay/1.0', authorization },
    })
    if (!resp.ok) { logger.warn(`[apppay] 微信查单失败 status=${resp.status}`); return null }
    const data = await resp.json()
    return {
      tradeState: data.trade_state,
      providerTxnId: data.transaction_id || null,
      amountCents: data.amount?.total != null ? Number(data.amount.total) : null,
      buyerId: data.payer?.openid || '',
      paidAtSec: data.success_time ? Math.floor(new Date(data.success_time).getTime() / 1000) : null,
    }
  }

  async function alipayQueryOrder(order) {
    // 支付宝查单：alipay.trade.query，RSA2 签名后 GET/POST 网关
    const timestamp = new Date(now() * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const params = {
      app_id: cfg.alipayAppId, method: 'alipay.trade.query', format: 'JSON',
      charset: 'utf-8', sign_type: 'RSA2', timestamp, version: '1.0',
      biz_content: JSON.stringify({ out_trade_no: order.order_no }),
    }
    const sign = rsaSign(cfg.alipayPrivateKey, alipaySignContent(params))
    const usp = new URLSearchParams(params)
    usp.append('sign', sign)
    const resp = await fetchImpl(`${ALIPAY_GATEWAY}?${usp.toString()}`, { method: 'GET' })
    if (!resp.ok) { logger.warn(`[apppay] 支付宝查单失败 status=${resp.status}`); return null }
    const data = await resp.json()
    const r = data?.alipay_trade_query_response
    if (!r) return null
    // code 10000 = 成功；trade_status 映射到统一枚举
    const tradeStatus = r.trade_status
    return {
      tradeState: tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED' ? 'SUCCESS'
        : tradeStatus === 'TRADE_CLOSED' ? 'CLOSED_REFUND' : 'NOTPAY',
      providerTxnId: r.trade_no || null,
      amountCents: r.total_amount != null ? Math.round(Number(r.total_amount) * 100) : null,
      buyerId: r.buyer_user_id || r.buyer_logon_id || '',
      paidAtSec: r.send_pay_date ? Math.floor(new Date(r.send_pay_date.replace(' ', 'T') + '+08:00').getTime() / 1000) : null,
    }
  }
}
