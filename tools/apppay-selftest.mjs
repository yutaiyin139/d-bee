/**
 * Android APP 支付（微信 APP 支付 V3 / 支付宝 App 支付 RSA2）链路端到端自测
 * （0047 / server/lib/apppay.mjs）。
 *
 * 做法与 tools/xpay-selftest.mjs 同构：mock pool（内存版 app_users / payment_orders /
 * app_payment_transactions / entitlements）+ mock fetch（伪造微信 V3 统一下单、查单与
 * 支付宝网关），用 createApp() 起**真实 http.Server**，裸 fetch 打真实 HTTP 报文断言。
 *
 * 🔴 为什么密码学部分不需要真实商户号：apppay.mjs 把签名 / 验签 / 加解密全部抽成
 *   **导出纯函数**，本脚本用 `generateKeyPairSync` 自造四把密钥扮演
 *   「商户私钥 / 微信（支付宝）平台私钥」，即可对正用例（正确签名→通过）与
 *   负用例（篡改→拒绝）做逐字节验证。生产上线前只需用真凭据替换 env，
 *   密码学实现本身已被本脚本覆盖。
 *
 * 覆盖场景：
 *   A. 纯函数：rsaSign/rsaVerify 正反、微信 V3 Authorization 头结构与可复算、
 *      APP 拉起二次签名原文四行顺序、AES-256-GCM 加解密对称 + 篡改/错密钥拒绝、
 *      alipaySignContent 字典序且排除 sign/sign_type、orderStr 可用应用公钥验签、
 *      支付宝通知验签正反
 *   B. POST /apppay/prepay：微信（金额/单号/notify_url 全部取自服务端订单）、
 *      支付宝（orderStr 可验签、金额=订单金额、product_code 固定值）、
 *      拒绝路径 401/400/404/403/409 already_paid/409 provider_mismatch/503 渠道未配
 *   C. POST /wechat-app/notify：验签通过 → settle 参数逐字段正确 + 订单置 paid；
 *      验签失败 → 400 且**零 settle**；解密失败 → 400；金额不足 → 回 200 但不发权益；
 *      重复回调幂等（不重复顺延）；非 SUCCESS 状态留痕回 200
 *   D. POST /alipay/notify：正确签名 → "success" + settle；验签失败 → "failure" 零 settle；
 *      app_id 不符 → "failure"；金额不足 → "success" 但不发权益；TRADE_CLOSED 留痕
 *   E. POST /apppay/query：本地 paid → settled 且**不外呼**；pending + 平台 SUCCESS →
 *      补发权益；金额不足 → 不发；REFUND → revoke；外呼失败 → retry_later（绝不报错）
 *   F. 凭据零泄漏：商户私钥 / APIv3 密钥 / 应用私钥不进日志与响应体
 *
 * 运行：node tools/apppay-selftest.mjs（或 npm run test:apppay）
 */
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto'
import { createApp } from '../server/lib/app.mjs'
import { signJwt } from '../server/lib/jwt.mjs'
import {
  alipaySignContent,
  buildAlipayOrderStr,
  decryptWechatNotifyResource,
  encryptWechatNotifyResource,
  rsaSign,
  rsaVerify,
  verifyAlipayNotifySignature,
  verifyWechatNotifySignature,
  wechatAppPaySignMessage,
} from '../server/lib/apppay.mjs'

let failed = 0
let passed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

// ── 自造密钥（扮演商户 / 平台两侧）────────────────────────────────────────
const gen = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const WX_MCH = gen()        // 微信商户 API 证书（我方）
const WX_PLATFORM = gen()   // 微信支付平台证书（微信方，用于验回调签名）
const ALI_MCH = gen()       // 支付宝应用密钥（我方）
const ALI_PLATFORM = gen()  // 支付宝公钥对应的私钥（支付宝方，用于签回调）

// ── 测试凭据 ────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef'
const APIV3_KEY = 'k'.repeat(32)                 // APIv3 密钥必须 32 字节
const WX_APPID = 'wx1234567890abcdef'             // 开放平台「移动应用」AppID
const WX_MCHID = '1900000109'
const WX_SERIAL = '5157F09EFDC096DE15EBE81A47057A72'
const ALI_APPID = '2021000100000001'
const PUBLIC_BASE = 'https://d-bee.cn'
const OWNER = '13800000001'
const BUYER_OPENID = 'oMock_payer_openid_999'

function baseCfg(over = {}) {
  return {
    prod: false,
    host: '127.0.0.1',
    port: 0,
    jwtSecret: JWT_SECRET,
    accessTtlSec: 3600,
    refreshTtlSec: 7200,
    publishableKey: 'wbpk_test_key',
    smsProvider: 'log', smsMasterCode: '888888', smsSignName: '自律蜜蜂',
    emailProvider: 'log',
    emailSmtpHost: '', emailSmtpPort: 587, emailSmtpSecure: false,
    emailSmtpUser: '', emailSmtpPass: '', emailSmtpFrom: '', emailSmtpFromName: '自律蜜蜂',
    otpTtlSec: 300, otpMaxAttempts: 3, otpResendSec: 60, otpIpHourLimit: 100,
    identPepper: 'test-pepper-0123456789abcdef0123456789abcdef',
    bodyLimitBytes: 1024 * 1024,
    rateLimitPerMin: 100000,
    wechatMiniSecrets: new Map(),
    wechatApiBase: 'https://api.weixin.qq.com',
    wechatTimeoutMs: 5000,
    trustedProxyIps: new Set(),
    llmApiKey: '', llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModelText: 'x', llmModelVision: 'x', llmTimeoutMs: 5000,
    llmDailyCapPerUser: 100, llmTextDailyCapPerUser: 50,
    corsAllowedOrigins: new Set(),
    postgrestUrl: 'http://127.0.0.1:1', postgrestJwtSecret: JWT_SECRET, postgrestSchema: 'public',
    dbStatementTimeoutMs: 5000, dbPoolMax: 2,
    // ── APP 支付配置（字段名对齐 config.mjs）──
    publicBaseUrl: PUBLIC_BASE,
    wechatPayAppId: WX_APPID,
    wechatPayMchid: WX_MCHID,
    wechatPaySerialNo: WX_SERIAL,
    wechatPayPrivateKey: WX_MCH.privateKey,
    wechatPayApiV3Key: APIV3_KEY,
    wechatPayPlatformCert: WX_PLATFORM.publicKey,
    alipayAppId: ALI_APPID,
    alipayPrivateKey: ALI_MCH.privateKey,
    alipayPublicKey: ALI_PLATFORM.publicKey,
    // xpay 与本模块并列、互不复用，本自测关掉以免污染
    xpayOfferId: '', xpayAppid: '', xpayAppKey: '', xpaySandboxAppKey: '', xpayEnv: 0,
    xpayPushToken: '', xpayPushAesKey: '', wechatSessionEncKey: '',
    xpaySessionKeyTtlHours: 72, xpayApiBase: 'https://api.weixin.qq.com', xpayTimeoutMs: 5000,
    ...over,
  }
}

// ── mock pool：app_users + payment_orders + app_payment_transactions + entitlements ──
function createMockPool() {
  const users = new Map()   // owner_id -> { token_version }
  const orders = new Map()  // order_no -> row（0021 列形态）
  const txns = new Map()    // out_trade_no -> row（模拟 0047 settle 幂等）
  const ents = new Map()    // owner_id -> { plan, pro_until, source }
  const notifications = []  // log_app_notification 留痕
  const settles = []        // settle_app_payment 调用记录（断言参数逐字段）
  const products = new Map([
    ['dbee_pro_monthly', { product_id: 'dbee_pro_monthly', plan: 'pro', months: 1, amount_cents: 1800, active: true }],
    ['dbee_pro_yearly', { product_id: 'dbee_pro_yearly', plan: 'pro', months: 12, amount_cents: 12800, active: true }],
    ['dbee_lifetime', { product_id: 'dbee_lifetime', plan: 'lifetime', months: null, amount_cents: 29800, active: true }],
  ])

  const seedUser = (ownerId, ver = 1) => users.set(ownerId, { token_version: ver })
  const seedOrder = (orderNo, ownerId, productId, status = 'pending', provider = 'wechat') => {
    const p = products.get(productId)
    orders.set(orderNo, {
      order_no: orderNo, owner_id: ownerId, product_id: productId, plan: p?.plan ?? 'pro',
      months: p?.months ?? null, amount_cents: p?.amount_cents ?? 1800,
      currency: 'CNY', status, provider, provider_txn_id: null,
    })
  }

  /** 模拟 0047 settle_app_payment 的核心语义（幂等 / 归属 / 商品 / 权益顺延 / 买断不降级） */
  const mockSettle = (p) => {
    const [outTradeNo, ownerId, buyerId, productId, providerTxnId, provider, amountCents, paidAtSec, channelNote] = p
    settles.push({ outTradeNo, ownerId, buyerId, productId, providerTxnId, provider, amountCents, paidAtSec, channelNote })
    if (!outTradeNo) return { error: 'missing_out_trade_no' }

    const existing = txns.get(outTradeNo)
    if (existing) {
      if (ownerId && existing.owner_id !== ownerId) return { error: 'order_taken_by_other' }
      const e = ents.get(existing.owner_id)
      return { settled: true, duplicate: true, owner_id: existing.owner_id, plan: e?.plan ?? 'free', pro_until: e?.pro_until ?? null }
    }

    const order = orders.get(outTradeNo)
    if (!order) return { error: 'order_not_found' }
    const owner = order.owner_id
    if (!owner) return { error: 'owner_unresolved' }
    if (ownerId && ownerId !== owner) return { error: 'order_taken_by_other' }

    const prod = products.get(order.product_id)
    if (!prod || !prod.active) return { error: 'unknown_product' }

    const vProvider = provider === 'alipay' ? 'alipay' : 'wechat'
    txns.set(outTradeNo, {
      out_trade_no: outTradeNo, provider_txn_id: providerTxnId, provider: vProvider,
      buyer_id: buyerId ?? '', owner_id: owner, product_id: order.product_id, plan: prod.plan,
      order_no: outTradeNo, amount_cents: order.amount_cents, callback_amount: amountCents ?? null,
      paid_at: paidAtSec ? new Date(paidAtSec * 1000).toISOString() : null, revoked: false,
    })

    // 权益：months 累加、lifetime 不降级（逐字对齐 0047 SQL 语义）
    const cur = ents.get(owner)
    if (prod.plan === 'lifetime') {
      ents.set(owner, { plan: 'lifetime', pro_until: null, source: vProvider })
    } else {
      const months = prod.months ?? 1
      const base = cur?.plan === 'pro' && cur.pro_until && new Date(cur.pro_until) > new Date()
        ? new Date(cur.pro_until) : new Date()
      base.setMonth(base.getMonth() + months)
      ents.set(owner, cur?.plan === 'lifetime' ? cur : { plan: 'pro', pro_until: base.toISOString(), source: vProvider })
    }
    if (order.status === 'pending') {
      order.status = 'paid'
      order.provider_txn_id = providerTxnId ?? order.provider_txn_id
    }
    const e = ents.get(owner)
    return { settled: true, duplicate: false, owner_id: owner, plan: e?.plan ?? 'free', pro_until: e?.pro_until ?? null }
  }

  const mockRevoke = (outTradeNo, providerTxnId, reason) => {
    let txn = txns.get(outTradeNo)
    if (!txn && providerTxnId) txn = [...txns.values()].find((t) => t.provider_txn_id === providerTxnId)
    if (!txn) return { revoked: false, error: 'txn_not_found' }
    if (txn.revoked) return { revoked: true, duplicate: true, owner_id: txn.owner_id }
    txn.revoked = true
    txn.revoked_reason = reason
    const e = ents.get(txn.owner_id)
    if (e && e.source === txn.provider) ents.set(txn.owner_id, { plan: 'free', pro_until: null, source: null })
    const ord = orders.get(txn.out_trade_no)
    if (ord?.status === 'paid') ord.status = 'refunded'
    return { revoked: true, owner_id: txn.owner_id, plan_now: 'free' }
  }

  return {
    users, orders, txns, ents, notifications, settles, products, seedUser, seedOrder,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ')
      if (/settle_app_payment/.test(s)) return { rows: [{ r: mockSettle(params) }], rowCount: 1 }
      if (/revoke_app_payment/.test(s)) return { rows: [{ r: mockRevoke(params[0], params[1], params[2]) }], rowCount: 1 }
      if (/log_app_notification/.test(s)) {
        notifications.push({
          payload: JSON.parse(params[0]), provider: params[1], event: params[2],
          out_trade_no: params[3], provider_txn_id: params[4], processed: params[5], error: params[6],
        })
        return { rows: [], rowCount: 1 }
      }
      if (/FROM public\.app_users/.test(s) && /owner_id = \$1/.test(s)) {
        const u = users.get(params[0])
        return { rows: u ? [{ token_version: u.token_version }] : [], rowCount: u ? 1 : 0 }
      }
      if (/FROM public\.payment_orders/.test(s) && /order_no = \$1/.test(s)) {
        const o = orders.get(params[0])
        return { rows: o ? [o] : [], rowCount: o ? 1 : 0 }
      }
      if (/SELECT current_user/.test(s)) return { rows: [{ u: 'dbee_app', d: 'dbee' }], rowCount: 1 }
      throw new Error(`mock pool 未实现的 SQL: ${s.slice(0, 120)}`)
    },
    async end() {},
  }
}

// ── mock 平台外呼（微信 V3 统一下单 / 查单 + 支付宝网关查单）────────────────
function createPlatformMock() {
  const calls = []
  let wechatOrderResponse = null
  let wechatQueryResponse = null
  let alipayQueryResponse = null
  let failMode = null // 'wechat' | 'alipay' | 'network'

  const json = (obj, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => obj, text: async () => JSON.stringify(obj),
  })

  const fetchImpl = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? String(opts.body) : null, headers: opts.headers || {} })
    if (u.includes('/v3/pay/transactions/app')) {
      if (failMode === 'network') throw new Error('mock network down')
      if (failMode === 'wechat') return json({ code: 'SYSTEMERROR', message: '系统繁忙' }, 500)
      return json(wechatOrderResponse ?? { prepay_id: 'wx_mock_prepay_id_0001' })
    }
    if (u.includes('/v3/pay/transactions/out-trade-no/')) {
      if (failMode === 'network') throw new Error('mock network down')
      if (!wechatQueryResponse) return json({ code: 'ORDER_NOT_EXIST' }, 404)
      return json(wechatQueryResponse)
    }
    if (u.includes('openapi.alipay.com/gateway.do')) {
      if (failMode === 'network') throw new Error('mock network down')
      return json(alipayQueryResponse ?? { alipay_trade_query_response: { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' } })
    }
    throw new Error(`mock fetch 未实现的 URL: ${u}`)
  }

  return {
    fetchImpl, calls,
    setWechatOrderResponse: (r) => { wechatOrderResponse = r },
    setWechatQueryResponse: (r) => { wechatQueryResponse = r },
    setAlipayQueryResponse: (r) => { alipayQueryResponse = r },
    setFailMode: (m) => { failMode = m },
    reset: () => { calls.length = 0; wechatOrderResponse = null; wechatQueryResponse = null; alipayQueryResponse = null; failMode = null },
    callsOf: (frag) => calls.filter((c) => c.url.includes(frag)),
  }
}

// ── 起真实 HTTP 服务（主实例：双渠道齐备）──────────────────────────────────
const logs = []
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
}
const mockPool = createMockPool()
const platform = createPlatformMock()
const { server } = createApp({
  cfg: baseCfg(), pool: mockPool, gatewayPool: mockPool, logger,
  enableDbProxy: false, enableLlm: false, enableIap: false, enableXpay: false,
  appPayFetchImpl: platform.fetchImpl,
  appPayClock: { now: () => 1762700000 },
  appPayNonce: (() => { let n = 0; return () => `nonce${String(++n).padStart(28, '0')}` })(),
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const P = `${BASE}/.cloud/payment/apppay`
const WX_NOTIFY = `${BASE}/.cloud/payment/wechat-app/notify`
const ALI_NOTIFY = `${BASE}/.cloud/payment/alipay/notify`

// 微信渠道未配置的实例（验「渠道级 503」而不是整模块 503）
const poolWxOnly = createMockPool()
const { server: serverNoAli } = createApp({
  cfg: baseCfg({ alipayAppId: '', alipayPrivateKey: '', alipayPublicKey: '' }),
  pool: poolWxOnly, gatewayPool: poolWxOnly, logger,
  enableDbProxy: false, enableLlm: false, enableIap: false, enableXpay: false,
  appPayFetchImpl: platform.fetchImpl,
})
await new Promise((r) => serverNoAli.listen(0, '127.0.0.1', r))
const NO_ALI = `http://127.0.0.1:${serverNoAli.address().port}/.cloud/payment/apppay`

// 全未配置的实例（验整模块 503）
const poolNone = createMockPool()
const { server: serverNone } = createApp({
  cfg: baseCfg({
    wechatPayAppId: '', wechatPayMchid: '', wechatPaySerialNo: '',
    wechatPayPrivateKey: '', wechatPayApiV3Key: '', wechatPayPlatformCert: '',
    alipayAppId: '', alipayPrivateKey: '', alipayPublicKey: '',
  }),
  pool: poolNone, gatewayPool: poolNone, logger,
  enableDbProxy: false, enableLlm: false, enableIap: false, enableXpay: false,
})
await new Promise((r) => serverNone.listen(0, '127.0.0.1', r))
const NONE = `http://127.0.0.1:${serverNone.address().port}/.cloud/payment/apppay`

const jwt = (sub = OWNER, ver = 1) => signJwt({ sub, role: 'authenticated', ver }, JWT_SECRET, 3600)
const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
})
const postRaw = (url, raw, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: raw,
})

mockPool.seedUser(OWNER)

// ══════════════════════════════════════════════════════════════════════
section('A · 密码学纯函数（自造密钥，正 / 负用例）')
{
  const msg = 'appid\n1762700000\nnonce0001\nprepay_id_x\n'
  const sig = rsaSign(WX_MCH.privateKey, msg)
  assert('rsaSign → rsaVerify 正用例通过', rsaVerify(WX_MCH.publicKey, msg, sig))
  assert('rsaVerify 篡改原文 → false', !rsaVerify(WX_MCH.publicKey, msg + 'x', sig))
  assert('rsaVerify 换公钥 → false', !rsaVerify(WX_PLATFORM.publicKey, msg, sig))
  assert('rsaVerify 非法签名串 → false（不抛异常）', rsaVerify(WX_MCH.publicKey, msg, 'not-base64-@@@') === false)
  assert('微信 APP 拉起签名原文 = appid\\ntimestamp\\nnoncestr\\nprepayid\\n',
    wechatAppPaySignMessage('wxAPP', '1762700000', 'n1', 'pp1') === 'wxAPP\n1762700000\nn1\npp1\n')

  // AES-256-GCM 对称 + 负用例
  const plain = { out_trade_no: 'PO1', trade_state: 'SUCCESS', amount: { total: 1800 } }
  const res = encryptWechatNotifyResource(APIV3_KEY, plain, { nonce: 'abcdefghijkl', associatedData: 'transaction' })
  const back = decryptWechatNotifyResource(APIV3_KEY, res)
  assert('微信回调 AES-256-GCM 加解密对称（含 AAD）', JSON.stringify(back) === JSON.stringify(plain))
  assert('错 APIv3 密钥解密 → null（拒发权益）', decryptWechatNotifyResource('x'.repeat(32), res) === null)
  assert('APIv3 密钥非 32 字节 → null', decryptWechatNotifyResource('short', res) === null)
  const tamperedBuf = Buffer.from(res.ciphertext, 'base64'); tamperedBuf[0] ^= 0xff
  assert('密文被篡改 → null（authTag 校验拦截）',
    decryptWechatNotifyResource(APIV3_KEY, { ...res, ciphertext: tamperedBuf.toString('base64') }) === null)

  // 微信回调验签
  const ts = '1762700000', nonce = 'n1', body = '{"resource":{}}'
  const nSig = rsaSign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${body}\n`)
  assert('微信回调验签正用例（平台证书公钥）',
    verifyWechatNotifySignature({ platformCertPem: WX_PLATFORM.publicKey, timestamp: ts, nonce, body, signature: nSig }))
  assert('微信回调验签：body 被改 → false',
    !verifyWechatNotifySignature({ platformCertPem: WX_PLATFORM.publicKey, timestamp: ts, nonce, body: body + ' ', signature: nSig }))
  assert('微信回调验签：缺任一头 → false',
    !verifyWechatNotifySignature({ platformCertPem: WX_PLATFORM.publicKey, timestamp: ts, nonce, body, signature: '' }))

  // 支付宝：待签名串字典序 + 排除 sign/sign_type
  const content = alipaySignContent({ b: '2', a: '1', sign: 'zzz', sign_type: 'RSA2', empty: '' })
  assert('alipaySignContent 字典序 k=v& 且排除 sign / sign_type / 空值', content === 'a=1&b=2', content)
  const orderStr = buildAlipayOrderStr({
    appId: ALI_APPID, method: 'alipay.trade.app.pay',
    bizContent: { out_trade_no: 'PO1', total_amount: '18.00' },
    notifyUrl: `${PUBLIC_BASE}/.cloud/payment/alipay/notify`, privateKeyPem: ALI_MCH.privateKey, timestamp: '2026-11-09 12:00:00',
  })
  const usp = new URLSearchParams(orderStr)
  const signParam = usp.get('sign')
  const paramsForVerify = Object.fromEntries([...usp.entries()].filter(([k]) => k !== 'sign'))
  assert('支付宝 orderStr 的 sign 可用**应用公钥**验签通过',
    rsaVerify(ALI_MCH.publicKey, alipaySignContent(paramsForVerify), signParam))
  assert('支付宝 orderStr 篡改金额后验签失败',
    !rsaVerify(ALI_MCH.publicKey, alipaySignContent({ ...paramsForVerify, biz_content: '{"total_amount":"0.01"}' }), signParam))
  const aliParams = { app_id: ALI_APPID, out_trade_no: 'PO1', total_amount: '18.00', trade_status: 'TRADE_SUCCESS' }
  const aliSign = rsaSign(ALI_PLATFORM.privateKey, alipaySignContent(aliParams))
  assert('支付宝异步通知验签正用例（支付宝公钥）',
    verifyAlipayNotifySignature({ alipayPublicKeyPem: ALI_PLATFORM.publicKey, params: aliParams, sign: aliSign }))
  assert('支付宝通知验签：金额被改小 → false',
    !verifyAlipayNotifySignature({ alipayPublicKeyPem: ALI_PLATFORM.publicKey, params: { ...aliParams, total_amount: '0.01' }, sign: aliSign }))
  assert('支付宝通知验签：缺 sign → false', verifyAlipayNotifySignature({ alipayPublicKeyPem: ALI_PLATFORM.publicKey, params: aliParams, sign: '' }) === false)
  // 对照：同一份 createSign 手写实现与模块实现结果一致（防「算法名写错但仍能跑」）
  assert('模块 rsaSign 与手写 createSign(RSA-SHA256) 逐字节一致',
    sig === createSign('RSA-SHA256').update(msg, 'utf8').end().sign(WX_MCH.privateKey, 'base64')
      && createVerify('RSA-SHA256').update(msg, 'utf8').end().verify(WX_MCH.publicKey, sig, 'base64'))
}

// ══════════════════════════════════════════════════════════════════════
section('B · POST /apppay/prepay · 微信下单')
{
  platform.reset()
  mockPool.seedOrder('PO20261109000001', OWNER, 'dbee_pro_monthly', 'pending', 'wechat')
  const r = await postJson(`${P}/prepay`, { order_no: 'PO20261109000001', provider: 'wechat' }, { authorization: `Bearer ${jwt()}` })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const body = await r.json()
  assert('provider = wechat', body.provider === 'wechat')
  assert('order_no 原样回传（前端据此核销，不另建单）', body.order_no === 'PO20261109000001')
  const pp = body.prepay
  assert('拉起参数六字段齐备', ['partnerId', 'prepayId', 'nonceStr', 'timeStamp', 'package', 'sign'].every((k) => typeof pp[k] === 'string' && pp[k] !== ''))
  assert('package 固定为 Sign=WXPay（APP 支付形态，不是 JSAPI 的 prepay_id=）', pp.package === 'Sign=WXPay')
  assert('partnerId = 商户号', pp.partnerId === WX_MCHID)
  assert('prepayId 来自平台响应', pp.prepayId === 'wx_mock_prepay_id_0001')
  assert('sign 可用商户公钥按四行原文复算验证',
    rsaVerify(WX_MCH.publicKey, wechatAppPaySignMessage(WX_APPID, pp.timeStamp, pp.nonceStr, pp.prepayId), pp.sign))

  // 外呼报文：金额 / 单号 / notify_url 全部取自服务端订单（客户端改不了）
  const call = platform.callsOf('/v3/pay/transactions/app')[0]
  assert('统一下单外呼恰好 1 次', platform.callsOf('/v3/pay/transactions/app').length === 1)
  const sent = JSON.parse(call.body)
  assert('外呼 amount.total = 订单 amount_cents（服务端查价，分）', sent.amount.total === 1800, String(sent.amount.total))
  assert('外呼 out_trade_no = 我方业务单号（幂等键）', sent.out_trade_no === 'PO20261109000001')
  assert('外呼 notify_url = PUBLIC_BASE_URL + /wechat-app/notify', sent.notify_url === `${PUBLIC_BASE}/.cloud/payment/wechat-app/notify`)
  assert('外呼 appid / mchid 取自配置', sent.appid === WX_APPID && sent.mchid === WX_MCHID)
  assert('外呼 attach 透传 owner_id（回调交叉校验用）', sent.attach === OWNER)
  // V3 Authorization 头可复算
  const auth = call.headers.authorization
  const m = /WECHATPAY2-SHA256-RSA2048 mchid="([^"]+)",nonce_str="([^"]+)",timestamp="([^"]+)",serial_no="([^"]+)",signature="([^"]+)"/.exec(auth || '')
  assert('Authorization 头形态正确（V3 五字段）', m !== null)
  if (m) {
    const [, mchid, nonceStr, timestamp, serialNo, signature] = m
    const expectMsg = `POST\n/v3/pay/transactions/app\n${timestamp}\n${nonceStr}\n${call.body}\n`
    assert('Authorization 的 mchid / serial_no 取自配置', mchid === WX_MCHID && serialNo === WX_SERIAL)
    assert('Authorization 签名可用商户公钥按 V3 原文复算通过', rsaVerify(WX_MCH.publicKey, expectMsg, signature))
  }
  assert('响应不含商户私钥', !JSON.stringify(body).includes('PRIVATE KEY'))
  assert('响应不含 APIv3 密钥', !JSON.stringify(body).includes(APIV3_KEY))
}

section('B · POST /apppay/prepay · 支付宝下单（本地签名，零外呼）')
{
  platform.reset()
  mockPool.seedOrder('PO20261109000002', OWNER, 'dbee_pro_yearly', 'pending', 'alipay')
  const r = await postJson(`${P}/prepay`, { order_no: 'PO20261109000002', provider: 'alipay' }, { authorization: `Bearer ${jwt()}` })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const body = await r.json()
  assert('provider = alipay', body.provider === 'alipay')
  const orderStr = body.prepay.orderStr
  assert('返回 orderStr（喂 SDK payV2）', typeof orderStr === 'string' && orderStr.length > 0)
  const usp = new URLSearchParams(orderStr)
  assert('method = alipay.trade.app.pay', usp.get('method') === 'alipay.trade.app.pay')
  assert('sign_type = RSA2', usp.get('sign_type') === 'RSA2')
  assert('notify_url = PUBLIC_BASE_URL + /alipay/notify', usp.get('notify_url') === `${PUBLIC_BASE}/.cloud/payment/alipay/notify`)
  const biz = JSON.parse(usp.get('biz_content'))
  assert('biz_content.out_trade_no = 我方业务单号', biz.out_trade_no === 'PO20261109000002')
  assert('biz_content.total_amount = 订单金额换算成元两位小数', biz.total_amount === '128.00', biz.total_amount)
  assert('product_code = QUICK_MSECURITY_PAY（App 支付固定值）', biz.product_code === 'QUICK_MSECURITY_PAY')
  const verifyParams = Object.fromEntries([...usp.entries()].filter(([k]) => k !== 'sign'))
  assert('orderStr 的 sign 可用应用公钥验签通过',
    rsaVerify(ALI_MCH.publicKey, alipaySignContent(verifyParams), usp.get('sign')))
  assert('支付宝下单**零平台外呼**（本地签名即可，减少一次网络失败面）', platform.calls.length === 0)
  assert('响应不含应用私钥', !JSON.stringify(body).includes('PRIVATE KEY'))
}

section('B · POST /apppay/prepay · 拒绝路径')
{
  platform.reset()
  const r1 = await postJson(`${P}/prepay`, { order_no: 'PO20261109000001', provider: 'wechat' })
  assert('无 Bearer → 401', r1.status === 401, `实际 ${r1.status}`)

  const r2 = await postJson(`${P}/prepay`, { provider: 'wechat' }, { authorization: `Bearer ${jwt()}` })
  assert('缺 order_no → 400', r2.status === 400, `实际 ${r2.status}`)

  const r3 = await postJson(`${P}/prepay`, { order_no: 'PO_NOT_EXIST', provider: 'wechat' }, { authorization: `Bearer ${jwt()}` })
  assert('订单不存在 → 404', r3.status === 404, `实际 ${r3.status}`)

  const OTHER = '13900000002'
  mockPool.seedUser(OTHER)
  const r4 = await postJson(`${P}/prepay`, { order_no: 'PO20261109000001', provider: 'wechat' }, { authorization: `Bearer ${jwt(OTHER)}` })
  assert('订单归属不符 → 403（越权下单被拒）', r4.status === 403, `实际 ${r4.status}`)

  const r5 = await postJson(`${P}/prepay`, { order_no: 'PO20261109000001', provider: 'alipay' }, { authorization: `Bearer ${jwt()}` })
  assert('订单 provider=wechat 却请求 alipay → 409 provider_mismatch', r5.status === 409, `实际 ${r5.status}`)
  const b5 = await r5.json()
  assert('409 的 error = provider_mismatch（前端可据此提示换渠道）', b5.error === 'provider_mismatch', JSON.stringify(b5))

  mockPool.seedOrder('PO20261109000003', OWNER, 'dbee_lifetime', 'paid', 'wechat')
  const r6 = await postJson(`${P}/prepay`, { order_no: 'PO20261109000003', provider: 'wechat' }, { authorization: `Bearer ${jwt()}` })
  assert('已支付订单再下单 → 409（防重复扣款）', r6.status === 409, `实际 ${r6.status}`)

  mockPool.seedOrder('PO20261109000004', OWNER, 'dbee_lifetime', 'refunded', 'wechat')
  const r7 = await postJson(`${P}/prepay`, { order_no: 'PO20261109000004', provider: 'wechat' }, { authorization: `Bearer ${jwt()}` })
  assert('已退款订单再下单 → 409', r7.status === 409, `实际 ${r7.status}`)

  const stale = jwt(OWNER, 999) // token_version 不符（已登出/改密的旧 token）
  const r8 = await postJson(`${P}/prepay`, { order_no: 'PO20261109000001', provider: 'wechat' }, { authorization: `Bearer ${stale}` })
  assert('token_version 过期 → 401（旧 token 不能下单）', r8.status === 401, `实际 ${r8.status}`)

  assert('所有拒绝路径零平台外呼', platform.calls.length === 0, `实际 ${platform.calls.length}`)
}

section('B · POST /apppay/prepay · 未配置降级（渠道级 503，绝不说「支付成功」）')
{
  poolWxOnly.seedUser(OWNER)
  poolWxOnly.seedOrder('PO_WXONLY_1', OWNER, 'dbee_pro_monthly', 'pending', 'alipay')
  const r1 = await postJson(`${NO_ALI}/prepay`, { order_no: 'PO_WXONLY_1', provider: 'alipay' }, { authorization: `Bearer ${jwt()}` })
  assert('支付宝未配置 → 503（不是 400，用户侧无法修复）', r1.status === 503, `实际 ${r1.status}`)
  const b1 = await r1.json()
  assert('503 的 error = alipay_not_configured（cloudError 形状 = {message,error}）', b1.error === 'alipay_not_configured', JSON.stringify(b1))

  poolNone.seedUser(OWNER)
  poolNone.seedOrder('PO_NONE_1', OWNER, 'dbee_pro_monthly', 'pending', 'wechat')
  const r2 = await postJson(`${NONE}/prepay`, { order_no: 'PO_NONE_1', provider: 'wechat' }, { authorization: `Bearer ${jwt()}` })
  assert('双渠道全未配置 → 503 apppay_not_configured', r2.status === 503, `实际 ${r2.status}`)
  const b2 = await r2.json()
  assert('整模块 503 的 error = apppay_not_configured', b2.error === 'apppay_not_configured', JSON.stringify(b2))

  const r3 = await postJson(`${NONE}/query`, { order_no: 'PO_NONE_1' }, { authorization: `Bearer ${jwt()}` })
  assert('query 同样 503（前端据 null 回退 RPC，不硬失败）', r3.status === 503, `实际 ${r3.status}`)
}

// ══════════════════════════════════════════════════════════════════════
section('C · POST /wechat-app/notify · 正常回调核销')
{
  platform.reset()
  mockPool.settles.length = 0
  mockPool.notifications.length = 0
  mockPool.seedOrder('PO20261109000010', OWNER, 'dbee_pro_monthly', 'pending', 'wechat')

  const decrypted = {
    out_trade_no: 'PO20261109000010',
    transaction_id: '420000202611090000000001',
    trade_state: 'SUCCESS',
    success_time: '2026-11-09T12:00:00+08:00',
    amount: { total: 1800, payer_total: 1800, currency: 'CNY' },
    payer: { openid: BUYER_OPENID },
    attach: OWNER,
  }
  const resource = encryptWechatNotifyResource(APIV3_KEY, decrypted, { nonce: 'abcdefghijkl', associatedData: 'transaction' })
  const payload = JSON.stringify({ id: 'EV1', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource })
  const ts = '1762700000', nonce = 'notifynonce001'
  const signature = rsaSign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${payload}\n`)
  const r = await postRaw(WX_NOTIFY, payload, {
    'content-type': 'application/json',
    'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': signature,
    'wechatpay-serial': WX_SERIAL,
  })
  assert('200（微信据此停止重试）', r.status === 200, `实际 ${r.status}`)
  const rb = await r.json()
  assert('响应体 code = SUCCESS', rb.code === 'SUCCESS', JSON.stringify(rb))
  assert('settle_app_payment 恰好被调 1 次', mockPool.settles.length === 1, String(mockPool.settles.length))
  const s = mockPool.settles[0]
  assert('settle 幂等键 = out_trade_no', s.outTradeNo === 'PO20261109000010')
  assert('settle 的 owner_id 传 null（回调路径以订单归属为权威，支持代付）', s.ownerId === null, String(s.ownerId))
  assert('settle 的 buyer_id = 付款人 openid', s.buyerId === BUYER_OPENID)
  assert('settle 的 product_id 取自订单（不信回调报文）', s.productId === 'dbee_pro_monthly')
  assert('settle 的 provider = wechat', s.provider === 'wechat')
  assert('settle 的 provider_txn_id = 微信 transaction_id', s.providerTxnId === '420000202611090000000001')
  assert('settle 的金额 = 回调 amount.total（分）', s.amountCents === 1800, String(s.amountCents))
  assert('订单已置 paid', mockPool.orders.get('PO20261109000010').status === 'paid')
  assert('权益已发放（pro）', mockPool.ents.get(OWNER)?.plan === 'pro')
  assert('回调留痕 processed = true', mockPool.notifications.some((n) => n.provider === 'wechat' && n.processed === true))
  assert('回调路径零平台外呼（推模式：验签即权威，不再查单）', platform.calls.length === 0)
}

section('C · POST /wechat-app/notify · 重复回调幂等（不重复顺延时长）')
{
  mockPool.settles.length = 0
  const before = mockPool.ents.get(OWNER)?.pro_until
  const decrypted = {
    out_trade_no: 'PO20261109000010', transaction_id: '420000202611090000000001',
    trade_state: 'SUCCESS', amount: { total: 1800 }, payer: { openid: BUYER_OPENID },
  }
  const resource = encryptWechatNotifyResource(APIV3_KEY, decrypted, { nonce: 'nopqrstuvwx1', associatedData: 'transaction' })
  const payload = JSON.stringify({ id: 'EV2', event_type: 'TRANSACTION.SUCCESS', resource })
  const ts = '1762700001', nonce = 'notifynonce002'
  const signature = rsaSign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${payload}\n`)
  const r = await postRaw(WX_NOTIFY, payload, {
    'content-type': 'application/json',
    'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': signature,
  })
  assert('重复回调仍 200（微信不再重试）', r.status === 200, `实际 ${r.status}`)
  const after = mockPool.ents.get(OWNER)?.pro_until
  assert('到期时间未被二次顺延（幂等）', before === after, `${before} → ${after}`)
}

section('C · POST /wechat-app/notify · 验签失败绝不发权益')
{
  mockPool.settles.length = 0
  mockPool.notifications.length = 0
  mockPool.seedOrder('PO20261109000011', OWNER, 'dbee_lifetime', 'pending', 'wechat')
  const decrypted = {
    out_trade_no: 'PO20261109000011', transaction_id: 'FAKE_TXN', trade_state: 'SUCCESS',
    amount: { total: 29800 }, payer: { openid: BUYER_OPENID },
  }
  const resource = encryptWechatNotifyResource(APIV3_KEY, decrypted, { nonce: 'abcdefghijkl', associatedData: 'transaction' })
  const payload = JSON.stringify({ id: 'EV3', event_type: 'TRANSACTION.SUCCESS', resource })
  const ts = '1762700002', nonce = 'notifynonce003'
  // 用**商户私钥**冒充平台签名（攻击者拿不到平台私钥）
  const badSig = rsaSign(WX_MCH.privateKey, `${ts}\n${nonce}\n${payload}\n`)
  const r = await postRaw(WX_NOTIFY, payload, {
    'content-type': 'application/json',
    'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': badSig,
  })
  assert('伪造签名 → 400（不是平台发的，重试也没用）', r.status === 400, `实际 ${r.status}`)
  const rb = await r.json()
  assert('400 的 code = SIGN_ERROR', rb.code === 'SIGN_ERROR', JSON.stringify(rb))
  assert('零 settle（绝不因验签异常放行发权益）', mockPool.settles.length === 0)
  assert('订单仍为 pending', mockPool.orders.get('PO20261109000011').status === 'pending')

  const r2 = await postRaw(WX_NOTIFY, payload, { 'content-type': 'application/json' })
  assert('缺签名头 → 400', r2.status === 400, `实际 ${r2.status}`)
  assert('缺签名头同样零 settle', mockPool.settles.length === 0)
}

section('C · POST /wechat-app/notify · 解密失败 / 金额不足 / 非成功状态')
{
  // 解密失败：resource 用错密钥加密
  mockPool.settles.length = 0
  {
    const bad = encryptWechatNotifyResource('w'.repeat(32), { out_trade_no: 'PO20261109000011', trade_state: 'SUCCESS' }, { nonce: 'abcdefghijkl' })
    const payload = JSON.stringify({ id: 'EV4', resource: bad })
    const ts = '1762700003', nonce = 'notifynonce004'
    const signature = rsaSign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${payload}\n`)
    const r = await postRaw(WX_NOTIFY, payload, {
      'content-type': 'application/json',
      'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': signature,
    })
    assert('APIv3 密钥不符 → 400 DECRYPT_ERROR', r.status === 400 && (await r.json()).code === 'DECRYPT_ERROR')
    assert('解密失败零 settle', mockPool.settles.length === 0)
    assert('解密失败留痕 error = decrypt_failed', mockPool.notifications.some((n) => n.error === 'decrypt_failed'))
  }
  // 金额不足：1 分钱买终身会员
  mockPool.notifications.length = 0
  {
    const res = encryptWechatNotifyResource(APIV3_KEY, {
      out_trade_no: 'PO20261109000011', transaction_id: 'FAKE_TXN_2', trade_state: 'SUCCESS', amount: { total: 1 },
    }, { nonce: 'abcdefghijkl', associatedData: 'transaction' })
    const payload = JSON.stringify({ id: 'EV5', resource: res })
    const ts = '1762700004', nonce = 'notifynonce005'
    const signature = rsaSign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${payload}\n`)
    const r = await postRaw(WX_NOTIFY, payload, {
      'content-type': 'application/json',
      'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': signature,
    })
    assert('金额不足 → 回 200（避免无谓重试）但**不发权益**', r.status === 200, `实际 ${r.status}`)
    assert('金额不足零 settle', mockPool.settles.length === 0)
    assert('订单仍为 pending', mockPool.orders.get('PO20261109000011').status === 'pending')
    assert('金额不足留痕 error = amount_mismatch（供人工对账）', mockPool.notifications.some((n) => n.error === 'amount_mismatch'))
  }
  // 非成功状态：USERPAYING
  mockPool.notifications.length = 0
  {
    const res = encryptWechatNotifyResource(APIV3_KEY, {
      out_trade_no: 'PO20261109000011', transaction_id: 'FAKE_TXN_3', trade_state: 'USERPAYING', amount: { total: 29800 },
    }, { nonce: 'abcdefghijkl', associatedData: 'transaction' })
    const payload = JSON.stringify({ id: 'EV6', resource: res })
    const ts = '1762700005', nonce = 'notifynonce006'
    const signature = rsaSign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${payload}\n`)
    const r = await postRaw(WX_NOTIFY, payload, {
      'content-type': 'application/json',
      'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': signature,
    })
    assert('USERPAYING → 200 留痕但零 settle', r.status === 200 && mockPool.settles.length === 0)
    assert('非成功状态留痕 event = USERPAYING', mockPool.notifications.some((n) => n.event === 'USERPAYING'))
  }
}

// ══════════════════════════════════════════════════════════════════════
section('D · POST /alipay/notify · 正常回调核销')
{
  platform.reset()
  mockPool.settles.length = 0
  mockPool.notifications.length = 0
  mockPool.seedOrder('PO20261109000020', OWNER, 'dbee_lifetime', 'pending', 'alipay')

  const params = {
    app_id: ALI_APPID, out_trade_no: 'PO20261109000020', trade_no: '2026110922001400000000001',
    trade_status: 'TRADE_SUCCESS', total_amount: '298.00', buyer_id: '2088000000000001',
    gmt_payment: '2026-11-09 12:00:00', notify_type: 'trade_status_sync',
  }
  const sign = rsaSign(ALI_PLATFORM.privateKey, alipaySignContent(params))
  const form = new URLSearchParams({ ...params, sign, sign_type: 'RSA2' }).toString()
  const r = await postRaw(ALI_NOTIFY, form)
  assert('200', r.status === 200, `实际 ${r.status}`)
  assert('响应体是纯文本 success（支付宝协议要求）', (await r.text()) === 'success')
  assert('settle 恰好 1 次', mockPool.settles.length === 1, String(mockPool.settles.length))
  const s = mockPool.settles[0]
  assert('settle 的 provider = alipay', s.provider === 'alipay')
  assert('settle 的 product_id 取自订单', s.productId === 'dbee_lifetime')
  assert('settle 的 provider_txn_id = 支付宝 trade_no', s.providerTxnId === '2026110922001400000000001')
  assert('金额换算正确（298.00 元 → 29800 分）', s.amountCents === 29800, String(s.amountCents))
  assert('paid_at 由 gmt_payment（东八区）换算为秒级时间戳', s.paidAtSec === Math.floor(new Date('2026-11-09T12:00:00+08:00').getTime() / 1000), String(s.paidAtSec))
  assert('订单置 paid', mockPool.orders.get('PO20261109000020').status === 'paid')
  assert('权益 = lifetime（买断）', mockPool.ents.get(OWNER)?.plan === 'lifetime')
  assert('支付宝回调零平台外呼', platform.calls.length === 0)
}

section('D · POST /alipay/notify · 拒绝路径（验签 / app_id / 金额 / 状态）')
{
  // 验签失败
  mockPool.settles.length = 0
  mockPool.notifications.length = 0
  mockPool.seedOrder('PO20261109000021', OWNER, 'dbee_pro_monthly', 'pending', 'alipay')
  {
    const params = {
      app_id: ALI_APPID, out_trade_no: 'PO20261109000021', trade_no: 'FAKE_ALI_1',
      trade_status: 'TRADE_SUCCESS', total_amount: '18.00',
    }
    const badSign = rsaSign(ALI_MCH.privateKey, alipaySignContent(params)) // 用我方私钥冒充支付宝
    const r = await postRaw(ALI_NOTIFY, new URLSearchParams({ ...params, sign: badSign, sign_type: 'RSA2' }).toString())
    assert('伪造签名 → 回 failure（支付宝会重试，但绝不发权益）', (await r.text()) === 'failure')
    assert('验签失败零 settle', mockPool.settles.length === 0)
    assert('验签失败留痕 error = sign_error', mockPool.notifications.some((n) => n.error === 'sign_error'))
  }
  // app_id 不符（串号攻击）
  mockPool.notifications.length = 0
  {
    const params = {
      app_id: '2021000999999999', out_trade_no: 'PO20261109000021', trade_no: 'FAKE_ALI_2',
      trade_status: 'TRADE_SUCCESS', total_amount: '18.00',
    }
    const sign = rsaSign(ALI_PLATFORM.privateKey, alipaySignContent(params))
    const r = await postRaw(ALI_NOTIFY, new URLSearchParams({ ...params, sign, sign_type: 'RSA2' }).toString())
    assert('app_id 不符 → failure', (await r.text()) === 'failure')
    assert('app_id 不符零 settle', mockPool.settles.length === 0)
    assert('app_id 不符留痕 error = appid_mismatch', mockPool.notifications.some((n) => n.error === 'appid_mismatch'))
  }
  // 金额不足
  mockPool.notifications.length = 0
  {
    const params = {
      app_id: ALI_APPID, out_trade_no: 'PO20261109000021', trade_no: 'FAKE_ALI_3',
      trade_status: 'TRADE_SUCCESS', total_amount: '0.01',
    }
    const sign = rsaSign(ALI_PLATFORM.privateKey, alipaySignContent(params))
    const r = await postRaw(ALI_NOTIFY, new URLSearchParams({ ...params, sign, sign_type: 'RSA2' }).toString())
    assert('金额不足 → 回 success（止住重试）但不发权益', (await r.text()) === 'success')
    assert('金额不足零 settle', mockPool.settles.length === 0)
    assert('订单仍 pending', mockPool.orders.get('PO20261109000021').status === 'pending')
    assert('金额不足留痕 error = amount_mismatch', mockPool.notifications.some((n) => n.error === 'amount_mismatch'))
  }
  // 非成功状态
  mockPool.notifications.length = 0
  {
    const params = {
      app_id: ALI_APPID, out_trade_no: 'PO20261109000021', trade_no: 'FAKE_ALI_4',
      trade_status: 'WAIT_BUYER_PAY', total_amount: '18.00',
    }
    const sign = rsaSign(ALI_PLATFORM.privateKey, alipaySignContent(params))
    const r = await postRaw(ALI_NOTIFY, new URLSearchParams({ ...params, sign, sign_type: 'RSA2' }).toString())
    assert('WAIT_BUYER_PAY → success 留痕、零 settle', (await r.text()) === 'success' && mockPool.settles.length === 0)
    assert('留痕 event = WAIT_BUYER_PAY', mockPool.notifications.some((n) => n.event === 'WAIT_BUYER_PAY'))
  }
}

// ══════════════════════════════════════════════════════════════════════
section('E · POST /apppay/query · 本地 paid 直接定论（不外呼）')
{
  platform.reset()
  mockPool.settles.length = 0
  const r = await postJson(`${P}/query`, { order_no: 'PO20261109000010' }, { authorization: `Bearer ${jwt()}` })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const b = await r.json()
  assert('settled = true / status = paid', b.settled === true && b.status === 'paid', JSON.stringify(b))
  assert('本地已 paid → **零平台外呼**（省一次网络往返，也避免平台限频）', platform.calls.length === 0)
  assert('不重复调 settle', mockPool.settles.length === 0)
}

section('E · POST /apppay/query · pending + 平台已支付 → 补发权益（回调丢失兜底）')
{
  // 🔴 用独立用户：OWNER 在 D 节已买断 lifetime，而「lifetime 不降级 + revoke 只清
  //   同 source 权益」是 0047 的刻意语义，混用会让断言测到错误的东西。
  const OWNER_E = '13800000010'
  mockPool.seedUser(OWNER_E)
  platform.reset()
  mockPool.settles.length = 0
  mockPool.seedOrder('PO20261109000030', OWNER_E, 'dbee_pro_yearly', 'pending', 'wechat')
  platform.setWechatQueryResponse({
    trade_state: 'SUCCESS', transaction_id: '420000202611090000000099',
    amount: { total: 12800 }, payer: { openid: BUYER_OPENID }, success_time: '2026-11-09T13:00:00+08:00',
  })
  const r = await postJson(`${P}/query`, { order_no: 'PO20261109000030' }, { authorization: `Bearer ${jwt(OWNER_E)}` })
  const b = await r.json()
  assert('settled = true', b.settled === true, JSON.stringify(b))
  assert('status = paid 且回传 plan', b.status === 'paid' && b.plan === 'pro', JSON.stringify(b))
  assert('外呼微信查单恰好 1 次', platform.callsOf('/v3/pay/transactions/out-trade-no/').length === 1)
  const s = mockPool.settles[0]
  assert('补发货的 owner_id = JWT sub（查单路径带登录态）', s.ownerId === OWNER_E)
  assert('补发货的 channel_note = query:wechat（与 notify 路径可区分对账）', s.channelNote === 'query:wechat')
  assert('补发货金额取自平台查单结果', s.amountCents === 12800, String(s.amountCents))
  assert('订单置 paid', mockPool.orders.get('PO20261109000030').status === 'paid')
  assert('权益已发放（pro，12 个月）', mockPool.ents.get(OWNER_E)?.plan === 'pro')
  // 查单请求也带 V3 签名
  const call = platform.callsOf('/v3/pay/transactions/out-trade-no/')[0]
  const m = /WECHATPAY2-SHA256-RSA2048 .*nonce_str="([^"]+)",timestamp="([^"]+)".*signature="([^"]+)"/.exec(call.headers.authorization || '')
  assert('查单外呼 Authorization 可复算验签（GET + 空 body）',
    m !== null && rsaVerify(WX_MCH.publicKey, `GET\n${new URL(call.url).pathname}${new URL(call.url).search}\n${m[2]}\n${m[1]}\n\n`, m[3]))
}

section('E · POST /apppay/query · 平台金额不足 / 未支付 / 退款 / 外呼失败')
{
  const OWNER_E2 = '13800000011'
  mockPool.seedUser(OWNER_E2)
  // 金额不足
  platform.reset()
  mockPool.settles.length = 0
  mockPool.seedOrder('PO20261109000031', OWNER_E2, 'dbee_lifetime', 'pending', 'wechat')
  platform.setWechatQueryResponse({ trade_state: 'SUCCESS', transaction_id: 'T_LOW', amount: { total: 1 } })
  {
    const r = await postJson(`${P}/query`, { order_no: 'PO20261109000031' }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    const b = await r.json()
    assert('查单金额不足 → settled=false 且 code=amount_mismatch', b.settled === false && b.code === 'amount_mismatch', JSON.stringify(b))
    assert('金额不足零 settle（防 1 分钱买会员）', mockPool.settles.length === 0)
  }
  // 未支付
  platform.reset()
  {
    platform.setWechatQueryResponse({ trade_state: 'NOTPAY', amount: { total: 29800 } })
    const r = await postJson(`${P}/query`, { order_no: 'PO20261109000031' }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    const b = await r.json()
    assert('NOTPAY → settled=false / status=pending（前端提示「权益到账中」而非报错）', b.settled === false && b.status === 'pending', JSON.stringify(b))
    assert('NOTPAY 零 settle', mockPool.settles.length === 0)
  }
  // 退款 → revoke
  platform.reset()
  mockPool.seedOrder('PO20261109000032', OWNER_E2, 'dbee_pro_monthly', 'pending', 'wechat')
  {
    // 先让这笔单核销成功，再模拟平台退款
    platform.setWechatQueryResponse({ trade_state: 'SUCCESS', transaction_id: 'T_REFUND', amount: { total: 1800 } })
    await postJson(`${P}/query`, { order_no: 'PO20261109000032' }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    assert('前置：该单已核销为 paid', mockPool.orders.get('PO20261109000032').status === 'paid')
    assert('前置：权益 source = wechat（revoke 只清同渠道权益）', mockPool.ents.get(OWNER_E2)?.source === 'wechat')
    platform.reset()
    platform.setWechatQueryResponse({ trade_state: 'REFUND', transaction_id: 'T_REFUND', amount: { total: 1800 } })
    const r = await postJson(`${P}/query`, { order_no: 'PO20261109000032', reconcile: true }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    const b = await r.json()
    assert('REFUND → status=refunded', b.status === 'refunded', JSON.stringify(b))
    assert('退款后订单置 refunded', mockPool.orders.get('PO20261109000032').status === 'refunded')
    assert('退款后权益被撤销（plan 回 free）', mockPool.ents.get(OWNER_E2)?.plan === 'free', String(mockPool.ents.get(OWNER_E2)?.plan))
  }
  // 已退款订单再查
  {
    const r = await postJson(`${P}/query`, { order_no: 'PO20261109000032' }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    const b = await r.json()
    assert('已退款订单查询 → settled=false / refunded（不再尝试补发）', b.settled === false && b.status === 'refunded', JSON.stringify(b))
  }
  // 外呼失败：绝不报错（已扣款报错 = 资损级 UX 事故）
  platform.reset()
  mockPool.settles.length = 0
  mockPool.seedOrder('PO20261109000033', OWNER_E2, 'dbee_pro_monthly', 'pending', 'alipay')
  {
    platform.setFailMode('network')
    const r = await postJson(`${P}/query`, { order_no: 'PO20261109000033' }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    assert('外呼网络失败 → HTTP 200（不是 5xx）', r.status === 200, `实际 ${r.status}`)
    const b = await r.json()
    assert('外呼失败 → settled=false + retry_later=true（前端提示稍后，绝不报「支付失败」）',
      b.settled === false && b.retry_later === true, JSON.stringify(b))
    assert('外呼失败零 settle', mockPool.settles.length === 0)
  }
  // 支付宝查单成功路径（网关协议差异：form + code 10000）
  platform.reset()
  mockPool.settles.length = 0
  {
    platform.setAlipayQueryResponse({
      alipay_trade_query_response: {
        code: '10000', trade_status: 'TRADE_SUCCESS', trade_no: 'ALI_Q_1',
        total_amount: '18.00', buyer_user_id: '2088000000000002', send_pay_date: '2026-11-09 14:00:00',
      },
    })
    const r = await postJson(`${P}/query`, { order_no: 'PO20261109000033' }, { authorization: `Bearer ${jwt(OWNER_E2)}` })
    const b = await r.json()
    assert('支付宝查单成功 → settled=true', b.settled === true, JSON.stringify(b))
    assert('支付宝补发货 provider = alipay', mockPool.settles[0]?.provider === 'alipay')
    const q = platform.callsOf('gateway.do')[0]
    assert('支付宝查单外呼带 RSA2 签名且可验签', (() => {
      const usp = new URL(q.url).searchParams
      const sign = usp.get('sign')
      const rest = Object.fromEntries([...usp.entries()].filter(([k]) => k !== 'sign'))
      return usp.get('method') === 'alipay.trade.query' && rsaVerify(ALI_MCH.publicKey, alipaySignContent(rest), sign)
    })())
  }
}

section('E · POST /apppay/query · 鉴权与归属')
{
  platform.reset()
  const r1 = await postJson(`${P}/query`, { order_no: 'PO20261109000010' })
  assert('无 Bearer → 401', r1.status === 401, `实际 ${r1.status}`)
  const r2 = await postJson(`${P}/query`, {}, { authorization: `Bearer ${jwt()}` })
  assert('缺 order_no → 400', r2.status === 400, `实际 ${r2.status}`)
  const OTHER = '13900000003'
  mockPool.seedUser(OTHER)
  const r3 = await postJson(`${P}/query`, { order_no: 'PO20261109000010' }, { authorization: `Bearer ${jwt(OTHER)}` })
  assert('查他人订单 → 403', r3.status === 403, `实际 ${r3.status}`)
  assert('鉴权/归属失败零外呼', platform.calls.length === 0)
}

// ══════════════════════════════════════════════════════════════════════
section('F · 凭据零泄漏（私钥 / APIv3 密钥不进日志与响应）')
{
  const allLogs = logs.map(([, m]) => m).join('\n')
  assert('日志不含微信商户私钥', !allLogs.includes('PRIVATE KEY'))
  assert('日志不含 APIv3 密钥', !allLogs.includes(APIV3_KEY))
  assert('日志不含支付宝应用私钥内容片段', !allLogs.includes(ALI_MCH.privateKey.slice(40, 90)))
  assert('日志不含 JWT 密钥', !allLogs.includes(JWT_SECRET))
}

// ── 收尾 ────────────────────────────────────────────────────────────────
server.close(); serverNoAli.close(); serverNone.close()
console.log(`\n${failed === 0 ? '✅' : '❌'} apppay-selftest: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
