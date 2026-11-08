/**
 * 微信虚拟支付（xpay）链路端到端自测（0046 / C2）。
 *
 * 做法与 tools/wechat-login-selftest.mjs 同构：mock pool（内存版 app_users /
 * payment_orders / xpay_transactions / entitlements）+ mock fetch（伪造
 * cgi-bin/token 与 /xpay/query_order），用 createApp() 起**真实 http.Server**，
 * 裸 fetch 打真实 HTTP 报文断言。
 *
 * 覆盖场景：
 *   · POST /params：登录+订单齐备 → 返回 {mode,signData,paySig,signature,env}，
 *     且 paySig/signature 可用 appKey/session_key 复算验证（签名公式逐字节）
 *   · /params 拒绝路径：未登录 401 / 无 session_key 409（绝不降级）/
 *     订单不存在 404 / 订单归属不符 403 / 已支付 already_paid / 畸形单号 400
 *   · signData 金额取自订单（服务端查价），客户端无法篡改
 *   · GET /notify：URL 握手 sha1 验签 → 原样回 echostr；验签失败 400
 *   · POST /notify 明文模式（XML）：deliver → settle 参数逐字段正确；
 *     重复推送幂等；unknown_product → ErrCode 1（让微信重试）；
 *     refund → revoke；未知事件 → ErrCode 0 留痕；验签失败 400
 *   · POST /notify JSON 形态：应答也是 JSON（格式一致性协议）
 *   · POST /notify 安全模式：Encrypt + msg_signature + AES-256-CBC 解密全链路
 *   · POST /query：本地 paid → settled；pending + 平台 status=2 → 按**我方订单**
 *     商品补发货；status=1 → 未支付；外呼失败 → retry_later（绝不报错）
 *   · 所有验签通过的推送都落 log_xpay_notification 留痕
 *   · appKey / session_key / EncodingAESKey 绝不进日志与响应体
 *
 * 运行：node tools/xpay-selftest.mjs
 */
import { createHmac, createCipheriv, randomBytes } from 'node:crypto'
import { createApp } from '../server/lib/app.mjs'
import { signJwt, verifyJwt } from '../server/lib/jwt.mjs'
import { encryptSessionKey } from '../server/lib/wechatSession.mjs'
import { calcPushSignature, parseWxXml } from '../server/lib/xpay.mjs'

let failed = 0
let passed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

// ── 测试凭据 ────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef'
const OFFER_ID = '1450000001'
const APP_KEY = 'testProdAppKey0123456789abcdef'
const PUSH_TOKEN = 'TestPushToken'
const PUSH_AES_KEY = 'a'.repeat(43) // EncodingAESKey 是 43 位 [A-Za-z0-9]
const SESSION_ENC_KEY = 'b'.repeat(64)
const WX_APPID = 'wxb7c7122de9c3ab1f'
const OPENID = 'oMock_user_openid_12345'
const OWNER = `wx:${OPENID}`
const MOCK_SESSION_KEY = 'sk-mock-session-key-never-leak'

const cfg = {
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
  wechatMiniSecrets: new Map([[WX_APPID, 'mocksecret']]),
  wechatApiBase: 'https://api.weixin.qq.com',
  wechatTimeoutMs: 5000,
  trustedProxyIps: new Set(),
  llmApiKey: '', llmBaseUrl: 'http://127.0.0.1:1/v1',
  llmModelText: 'x', llmModelVision: 'x', llmTimeoutMs: 5000,
  llmDailyCapPerUser: 100, llmTextDailyCapPerUser: 50,
  corsAllowedOrigins: new Set(),
  postgrestUrl: 'http://127.0.0.1:1', postgrestJwtSecret: JWT_SECRET, postgrestSchema: 'public',
  dbStatementTimeoutMs: 5000, dbPoolMax: 2,
  // ── xpay 配置（对齐 config.mjs 字段名）──
  xpayOfferId: OFFER_ID,
  xpayAppid: WX_APPID,
  xpayAppKey: APP_KEY,
  xpaySandboxAppKey: '',
  xpayEnv: 0,
  xpayPushToken: PUSH_TOKEN,
  xpayPushAesKey: PUSH_AES_KEY,
  wechatSessionEncKey: SESSION_ENC_KEY,
  xpaySessionKeyTtlHours: 72,
  xpayApiBase: 'https://api.weixin.qq.com',
  xpayTimeoutMs: 5000,
}

// ── mock pool：app_users + payment_orders + xpay_transactions + entitlements ──
function createMockPool() {
  const users = new Map()      // owner_id -> { token_version, wechat_session_key_enc, wechat_session_key_at, wechat_appid }
  const orders = new Map()     // order_no -> row（0021 列形态）
  const xtxns = new Map()      // out_trade_no -> row（模拟 settle 幂等）
  const ents = new Map()       // owner_id -> { plan, pro_until, source }
  const notifications = []     // log_xpay_notification 留痕
  const products = new Map([
    ['dbee_pro_monthly', { product_id: 'dbee_pro_monthly', plan: 'pro', months: 1, amount_cents: 1800, active: true }],
    ['dbee_pro_yearly', { product_id: 'dbee_pro_yearly', plan: 'pro', months: 12, amount_cents: 12800, active: true }],
    ['dbee_lifetime', { product_id: 'dbee_lifetime', plan: 'lifetime', months: null, amount_cents: 29800, active: true }],
  ])

  const seedUser = (ownerId, sessionKey = MOCK_SESSION_KEY, appid = WX_APPID) => {
    users.set(ownerId, {
      token_version: 1,
      wechat_session_key_enc: sessionKey ? encryptSessionKey(sessionKey, SESSION_ENC_KEY) : null,
      wechat_session_key_at: sessionKey ? new Date().toISOString() : null,
      wechat_appid: sessionKey ? appid : null,
    })
  }
  const seedOrder = (orderNo, ownerId, productId, status = 'pending') => {
    const p = products.get(productId)
    orders.set(orderNo, {
      order_no: orderNo, owner_id: ownerId, product_id: productId, plan: p?.plan ?? 'pro',
      amount_cents: p?.amount_cents ?? 1800, status, provider: 'wechat_xpay',
      provider_txn_id: null, receipt_payload: null,
    })
  }

  /** 模拟 settle_xpay_purchase 的核心语义（幂等/unknown_product/order_taken_by_other/权益） */
  const mockSettle = (p) => {
    const [outTradeNo, ownerId, openid, productId, providerTxnId, quantity,
      origPrice, actualPrice, channel, env, paidAtSec, attach] = p
    if (!outTradeNo) return { error: 'missing_out_trade_no' }
    if (!productId) return { error: 'missing_product_id' }
    const existing = xtxns.get(outTradeNo)
    if (existing) {
      if (ownerId && existing.owner_id !== ownerId) return { error: 'order_taken_by_other' }
      const e = ents.get(existing.owner_id)
      return { settled: true, duplicate: true, owner_id: existing.owner_id, plan: e?.plan ?? 'free', pro_until: e?.pro_until ?? null }
    }
    const owner = ownerId || (openid ? `wx:${openid}` : null)
    if (!owner) return { error: 'owner_unresolved' }
    const prod = products.get(productId)
    if (!prod || !prod.active) return { error: 'unknown_product' }
    xtxns.set(outTradeNo, {
      out_trade_no: outTradeNo, provider_txn_id: providerTxnId, openid: openid ?? '',
      owner_id: owner, product_id: productId, plan: prod.plan, quantity: quantity ?? 1,
      orig_price_cents: origPrice, actual_price_cents: actualPrice, channel: channel === 'apple' ? 'apple' : 'wechat',
      env, attach, paid_at: paidAtSec ? new Date(paidAtSec * 1000).toISOString() : null, revoked: false,
    })
    // 权益（模拟 SQL 的顺延/买断语义，够用即可）
    if (prod.plan === 'lifetime') {
      ents.set(owner, { plan: 'lifetime', pro_until: null, source: channel })
    } else {
      const cur = ents.get(owner)
      const months = (prod.months ?? 1) * (quantity ?? 1)
      const base = cur?.plan === 'pro' && cur.pro_until && new Date(cur.pro_until) > new Date()
        ? new Date(cur.pro_until) : new Date()
      base.setMonth(base.getMonth() + months)
      ents.set(owner, cur?.plan === 'lifetime' ? cur : { plan: 'pro', pro_until: base.toISOString(), source: channel })
    }
    // 订单置 paid
    const ord = orders.get(outTradeNo)
    if (ord && ord.owner_id === owner && ord.product_id === productId && ord.status === 'pending') {
      ord.status = 'paid'
      ord.provider_txn_id = providerTxnId ?? ord.provider_txn_id
      ord.receipt_payload = `xpay:${channel}:${providerTxnId ?? '-'}`
    }
    const e = ents.get(owner)
    return { settled: true, duplicate: false, owner_id: owner, plan: e?.plan ?? 'free', pro_until: e?.pro_until ?? null }
  }

  const mockRevoke = (outTradeNo, providerTxnId, reason) => {
    let txn = xtxns.get(outTradeNo)
    if (!txn && providerTxnId) txn = [...xtxns.values()].find((t) => t.provider_txn_id === providerTxnId)
    if (!txn) return { revoked: false, error: 'txn_not_found' }
    if (txn.revoked) return { revoked: true, duplicate: true, owner_id: txn.owner_id }
    txn.revoked = true
    txn.revoked_reason = reason
    const e = ents.get(txn.owner_id)
    if (e && e.source === txn.channel) ents.set(txn.owner_id, { plan: 'free', pro_until: null, source: null })
    const ord = orders.get(txn.out_trade_no)
    if (ord?.status === 'paid') ord.status = 'refunded'
    return { revoked: true, owner_id: txn.owner_id, plan_now: 'free' }
  }

  return {
    users, orders, xtxns, ents, notifications, products, seedUser, seedOrder,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ')
      // ── settle / revoke / log（0046 definer 函数）──
      if (/settle_xpay_purchase/.test(s)) return { rows: [{ r: mockSettle(params) }], rowCount: 1 }
      if (/revoke_xpay_purchase/.test(s)) return { rows: [{ r: mockRevoke(params[0], params[1], params[2]) }], rowCount: 1 }
      if (/log_xpay_notification/.test(s)) {
        notifications.push({ payload: JSON.parse(params[0]), event: params[1], out_trade_no: params[2], provider_txn_id: params[3], openid: params[4], processed: params[5], error: params[6] })
        return { rows: [], rowCount: 1 }
      }
      // ── app_users（token_version / session_key）──
      if (/FROM public\.app_users/.test(s) && /owner_id = \$1/.test(s)) {
        const u = users.get(params[0])
        if (/token_version/.test(s) && !/wechat_session_key/.test(s)) {
          return { rows: u ? [{ token_version: u.token_version }] : [], rowCount: u ? 1 : 0 }
        }
        return {
          rows: u ? [{ enc: u.wechat_session_key_enc, at: u.wechat_session_key_at, appid: u.wechat_appid }] : [],
          rowCount: u ? 1 : 0,
        }
      }
      // ── payment_orders ──
      if (/FROM public\.payment_orders/.test(s) && /order_no = \$1/.test(s)) {
        const o = orders.get(params[0])
        return { rows: o ? [o] : [], rowCount: o ? 1 : 0 }
      }
      if (/SELECT current_user/.test(s)) return { rows: [{ u: 'dbee_app', d: 'dbee' }], rowCount: 1 }
      throw new Error(`mock pool 未实现的 SQL: ${s.slice(0, 100)}`)
    },
    async end() {},
  }
}

// ── mock 微信外呼（cgi-bin/token + /xpay/query_order + /xpay/notify_provide_goods）──
function createWxApiMock() {
  const calls = []
  let queryOrderResponse = null // 每个用例前设置
  let provideGoodsResponse = { errcode: 0, errmsg: 'ok' }
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, body: opts.body ? String(opts.body) : null })
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (u.includes('/cgi-bin/token')) return json({ access_token: 'mock_access_token', expires_in: 7200 })
    if (u.includes('/xpay/query_order')) {
      if (u.includes('neterr')) throw new Error('mock network down')
      return json(queryOrderResponse ?? { errcode: 0, errmsg: 'ok', order: { order_id: 'X', status: 1 } })
    }
    // 🔴 发货确认接口：query 兜底路径把权益发给用户后必须调它，
    //   否则平台侧订单停在「已支付待发货」→ 资金不结算（资损）。
    if (u.includes('/xpay/notify_provide_goods')) return json(provideGoodsResponse)
    throw new Error(`mock fetch 未实现的 URL: ${u}`)
  }
  return {
    fetchImpl,
    calls,
    setQueryOrderResponse: (r) => { queryOrderResponse = r },
    setProvideGoodsResponse: (r) => { provideGoodsResponse = r },
    /** 只取某个接口的调用记录（便于按接口断言次数与 body） */
    callsOf: (frag) => calls.filter((c) => c.url.includes(frag)),
  }
}

// ── 起真实 HTTP 服务 ────────────────────────────────────────────────────
const logs = []
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
}
const mockPool = createMockPool()
const wxApi = createWxApiMock()
const { server } = createApp({
  cfg, pool: mockPool, gatewayPool: mockPool, logger,
  enableDbProxy: false, enableLlm: false, enableIap: false,
  xpayFetchImpl: wxApi.fetchImpl,
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const W = `${BASE}/.cloud/payment/wechat`

const jwt = (sub = OWNER, ver = 1) => signJwt({ sub, role: 'authenticated', ver }, JWT_SECRET, 3600)
const post = async (url, body, headers = {}) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  })
  return r
}
const postXml = async (url, raw, headers = {}) => {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/xml', ...headers }, body: raw })
}

// 推送 URL 签名（明文模式：signature=sha1(sort(token,ts,nonce))）
const pushQuery = (ts, nonce, extra = {}) => new URLSearchParams({ signature: calcPushSignature(PUSH_TOKEN, ts, nonce), timestamp: ts, nonce, ...extra }).toString()

// ══════════════════════════════════════════════════════════════════════
mockPool.seedUser(OWNER)

section('POST /params · 正常下单签名')
let paramsBody
{
  mockPool.seedOrder('PO20261108000001', OWNER, 'dbee_pro_monthly')
  const r = await post(`${W}/params`, { order_no: 'PO20261108000001', appid: WX_APPID }, { authorization: `Bearer ${jwt()}` })
  assert('200', r.status === 200, `实际 ${r.status}`)
  paramsBody = await r.json()
  assert('mode = short_series_goods', paramsBody.mode === 'short_series_goods')
  assert('signData 是字符串（前端须原样透传）', typeof paramsBody.signData === 'string')
  const sd = JSON.parse(paramsBody.signData)
  assert('signData.offerId = 配置值', sd.offerId === OFFER_ID)
  assert('signData.productId 取自订单', sd.productId === 'dbee_pro_monthly')
  assert('signData.goodsPrice = 订单 amount_cents（服务端查价，分）', sd.goodsPrice === 1800, String(sd.goodsPrice))
  assert('signData.outTradeNo = 订单号', sd.outTradeNo === 'PO20261108000001')
  assert('signData.currencyType = CNY', sd.currencyType === 'CNY')
  assert('signData.env = 0（现网）', sd.env === 0)
  // 🔴 签名公式逐字节复算（paySig 用 appKey；signature 用 session_key）
  const expectPaySig = createHmac('sha256', APP_KEY).update(`requestVirtualPayment&${paramsBody.signData}`, 'utf8').digest('hex')
  assert('paySig = hmac_sha256(appKey, "requestVirtualPayment&"+signData)', paramsBody.paySig === expectPaySig)
  const expectSig = createHmac('sha256', MOCK_SESSION_KEY).update(paramsBody.signData, 'utf8').digest('hex')
  assert('signature = hmac_sha256(session_key, signData)', paramsBody.signature === expectSig)
  assert('响应不含 session_key 明文', !JSON.stringify(paramsBody).includes(MOCK_SESSION_KEY))
  assert('响应不含 appKey', !JSON.stringify(paramsBody).includes(APP_KEY))
}

section('POST /params · 拒绝路径')
{
  const r1 = await post(`${W}/params`, { order_no: 'PO20261108000001', appid: WX_APPID })
  assert('无 Bearer → 401', r1.status === 401, `实际 ${r1.status}`)

  // 无 session_key → 409（绝不降级成「不带 signature 下单」，微信必拒 -15005）
  //   🔴 必须给这个用户**自己的订单**：params 的检查顺序是「订单归属 → session_key」，
  //     复用 OWNER 的订单会先撞 403 而测不到 409 这条路径。
  const NO_SK_OWNER = 'wx:oNoSession_abcdefghijklmn'
  mockPool.seedUser(NO_SK_OWNER, null)
  mockPool.seedOrder('PO20261108000020', NO_SK_OWNER, 'dbee_pro_monthly')
  const r2 = await post(`${W}/params`, { order_no: 'PO20261108000020', appid: WX_APPID },
    { authorization: `Bearer ${jwt(NO_SK_OWNER)}` })
  assert('无 session_key → 409 要求重新登录（绝不降级）', r2.status === 409, `实际 ${r2.status}`)
  const j2sk = await r2.json()
  assert('409 错误码 = session_key_expired（前端据此引导重新登录）', j2sk.error === 'session_key_expired', JSON.stringify(j2sk))
  assert('错误响应不含 session_key 相关敏感值', !JSON.stringify(j2sk).includes(MOCK_SESSION_KEY))

  mockPool.seedUser('wx:oWrongAppid_abcdefghijklmn', MOCK_SESSION_KEY, 'wx0000000000000000')
  mockPool.seedOrder('PO20261108000009', 'wx:oWrongAppid_abcdefghijklmn', 'dbee_pro_monthly')
  const r3 = await post(`${W}/params`, { order_no: 'PO20261108000009', appid: WX_APPID },
    { authorization: `Bearer ${jwt('wx:oWrongAppid_abcdefghijklmn')}` })
  assert('session_key appid 不符 → 409', r3.status === 409, `实际 ${r3.status}`)

  const r4 = await post(`${W}/params`, { order_no: 'PONOTEXIST0001', appid: WX_APPID }, { authorization: `Bearer ${jwt()}` })
  assert('订单不存在 → 404', r4.status === 404, `实际 ${r4.status}`)

  mockPool.seedOrder('PO20261108000002', 'wx:oSomeoneElse_abcdefgh', 'dbee_pro_monthly')
  const r5 = await post(`${W}/params`, { order_no: 'PO20261108000002', appid: WX_APPID }, { authorization: `Bearer ${jwt()}` })
  assert('订单归属不符 → 403', r5.status === 403, `实际 ${r5.status}`)

  mockPool.seedOrder('PO20261108000003', OWNER, 'dbee_pro_monthly', 'paid')
  const r6 = await post(`${W}/params`, { order_no: 'PO20261108000003', appid: WX_APPID }, { authorization: `Bearer ${jwt()}` })
  const j6 = await r6.json()
  assert('已支付订单 → already_paid（幂等友好）', r6.status === 200 && j6.already_paid === true, JSON.stringify(j6))

  const r7 = await post(`${W}/params`, { order_no: '_bad', appid: WX_APPID }, { authorization: `Bearer ${jwt()}` })
  assert('畸形单号（_ 开头/太短）→ 400', r7.status === 400, `实际 ${r7.status}`)

  // 🔴 价格防篡改：客户端在 body 里塞 goodsPrice 不会生效（params 只读 order_no）
  mockPool.seedOrder('PO20261108000004', OWNER, 'dbee_lifetime')
  const r8 = await post(`${W}/params`, { order_no: 'PO20261108000004', appid: WX_APPID, goodsPrice: 1, product_id: 'dbee_pro_monthly' }, { authorization: `Bearer ${jwt()}` })
  const j8 = await r8.json()
  const sd8 = JSON.parse(j8.signData)
  assert('客户端塞 price/product 无效（lifetime 29800 分照旧）', sd8.goodsPrice === 29800 && sd8.productId === 'dbee_lifetime', `${sd8.productId}/${sd8.goodsPrice}`)
}

section('GET /notify · URL 握手（echostr）')
{
  const ts = '1730000000', nonce = 'nonce123', echo = 'echostr_abc123'
  const r1 = await fetch(`${W}/notify?${pushQuery(ts, nonce, { echostr: echo })}`)
  const t1 = await r1.text()
  assert('验签通过 → 200 原样回 echostr', r1.status === 200 && t1 === echo, `${r1.status} ${t1}`)
  const r2 = await fetch(`${W}/notify?signature=deadbeef&timestamp=${ts}&nonce=${nonce}&echostr=${echo}`)
  assert('验签失败 → 400', r2.status === 400, `实际 ${r2.status}`)
}

// ── 推送报文构造工具 ──
const deliverXml = (over = {}) => {
  const f = {
    ToUserName: 'gh_abc123', FromUserName: 'oWxOfficial', CreateTime: 1730000000,
    MsgType: 'event', Event: 'xpay_goods_deliver_notify',
    OpenId: OPENID, OutTradeNo: 'PO20261108000001', Env: 0,
    MchOrderNo: '4200001234202611081234567890', TransactionId: '1234567890', PaidTime: 1730000100,
    ProductId: 'dbee_pro_monthly', Quantity: 1, OrigPrice: 1800, ActualPrice: 1800, Attach: 'PO20261108000001',
    ...over,
  }
  return `<xml><ToUserName><![CDATA[${f.ToUserName}]]></ToUserName><FromUserName><![CDATA[${f.FromUserName}]]></FromUserName><CreateTime>${f.CreateTime}</CreateTime><MsgType><![CDATA[${f.MsgType}]]></MsgType><Event><![CDATA[${f.Event}]]></Event><OpenId><![CDATA[${f.OpenId}]]></OpenId><OutTradeNo><![CDATA[${f.OutTradeNo}]]></OutTradeNo><Env>${f.Env}</Env><WeChatPayInfo><MchOrderNo><![CDATA[${f.MchOrderNo}]]></MchOrderNo><TransactionId><![CDATA[${f.TransactionId}]]></TransactionId><PaidTime>${f.PaidTime}</PaidTime></WeChatPayInfo><GoodsInfo><ProductId><![CDATA[${f.ProductId}]]></ProductId><Quantity>${f.Quantity}</Quantity><OrigPrice>${f.OrigPrice}</OrigPrice><ActualPrice>${f.ActualPrice}</ActualPrice><Attach><![CDATA[${f.Attach}]]></Attach></GoodsInfo></xml>`
}
const parseReply = async (r) => {
  const t = await r.text()
  if (t.trimStart().startsWith('<')) return parseWxXml(t)
  try { return JSON.parse(t) } catch { return { raw: t } }
}

section('POST /notify · 明文模式 XML 发货')
{
  // 清幂等态，从头核销 PO...0001
  mockPool.xtxns.clear(); mockPool.ents.clear()
  mockPool.orders.get('PO20261108000001').status = 'pending'
  const ts = '1730000001', nonce = 'n1'
  const r = await postXml(`${W}/notify?${pushQuery(ts, nonce)}`, deliverXml())
  assert('HTTP 200', r.status === 200, `实际 ${r.status}`)
  const reply = await parseReply(r)
  assert('应答 XML ErrCode=0', reply.ErrCode === 0, JSON.stringify(reply))
  const txn = mockPool.xtxns.get('PO20261108000001')
  assert('settle 落 xpay_transactions', !!txn)
  assert('openid/owner 正确', txn?.openid === OPENID && txn?.owner_id === OWNER)
  assert('product 取推送报文', txn?.product_id === 'dbee_pro_monthly')
  assert('provider_txn_id = MchOrderNo', txn?.provider_txn_id === '4200001234202611081234567890')
  assert('价格取推送报文（分）', txn?.orig_price_cents === 1800 && txn?.actual_price_cents === 1800)
  assert('channel = wechat', txn?.channel === 'wechat')
  assert('paid_at 秒级时间戳转 Date', txn?.paid_at === new Date(1730000100 * 1000).toISOString())
  assert('权益发放 pro 1 个月', mockPool.ents.get(OWNER)?.plan === 'pro')
  assert('订单置 paid', mockPool.orders.get('PO20261108000001').status === 'paid')
  assert('留痕落库 processed=true', mockPool.notifications.some((n) => n.out_trade_no === 'PO20261108000001' && n.processed === true))

  // 重复推送（微信最多重试 15 次，重复是常态）→ 幂等：pro_until 不变、仍 ErrCode=0
  const untilBefore = mockPool.ents.get(OWNER).pro_until
  const r2 = await postXml(`${W}/notify?${pushQuery('1730000002', 'n2')}`, deliverXml())
  const reply2 = await parseReply(r2)
  assert('重复推送 → ErrCode=0（幂等成功）', reply2.ErrCode === 0, JSON.stringify(reply2))
  assert('重复推送不顺延权益（pro_until 不变）', mockPool.ents.get(OWNER).pro_until === untilBefore)
}

section('POST /notify · 异常报文与退款')
{
  // unknown_product：道具没上 payment_products → ErrCode 非 0（让微信重试，可能是迁移没跑完）
  const ts = '1730000003'
  const r1 = await postXml(`${W}/notify?${pushQuery(ts, 'n3')}`, deliverXml({ OutTradeNo: 'PO20261108000005', ProductId: 'dbee_ghost_product' }))
  const j1 = await parseReply(r1)
  assert('unknown_product → ErrCode 非 0（触发重试）', j1.ErrCode !== 0, JSON.stringify(j1))
  assert('unknown_product 留痕 processed=false + error', mockPool.notifications.some((n) => n.out_trade_no === 'PO20261108000005' && n.processed === false && n.error === 'unknown_product'))

  // 退款推送 → revoke：权益回收、订单 refunded、ErrCode=0
  const r2 = await postXml(`${W}/notify?${pushQuery('1730000004', 'n4')}`, deliverXml({
    Event: 'xpay_refund_notify', OutTradeNo: 'PO20261108000001',
  }))
  const j2 = await parseReply(r2)
  assert('refund → ErrCode=0', j2.ErrCode === 0, JSON.stringify(j2))
  assert('权益回收为 free', mockPool.ents.get(OWNER)?.plan === 'free', JSON.stringify(mockPool.ents.get(OWNER)))
  assert('订单置 refunded', mockPool.orders.get('PO20261108000001').status === 'refunded')
  assert('交易标记 revoked', mockPool.xtxns.get('PO20261108000001').revoked === true)

  // 退款先于发货到达（乱序）→ txn_not_found → ErrCode 非 0 让微信重试
  //   🔴 必须清空 MchOrderNo：revoke_xpay_purchase 在按 out_trade_no 找不到时
  //     会**按 provider_txn_id 兜底反查**（0046 设计），若沿用上面那笔的平台单号
  //     就会命中已核销交易并成功 revoke → 测不到「乱序」这条路径。
  const r3 = await postXml(`${W}/notify?${pushQuery('1730000005', 'n5')}`, deliverXml({
    Event: 'xpay_refund_notify', OutTradeNo: 'PO_NOT_DELIVERED_YET', MchOrderNo: '', TransactionId: '',
  }))
  const j3 = await parseReply(r3)
  assert('退款乱序先到 → ErrCode 非 0（重试自愈）', j3.ErrCode !== 0, JSON.stringify(j3))
  assert('乱序退款留痕 error=txn_not_found',
    mockPool.notifications.some((n) => n.out_trade_no === 'PO_NOT_DELIVERED_YET' && n.error === 'txn_not_found'))

  // 验签失败 → 400（不是微信发的，重试也没用）
  const r4 = await postXml(`${W}/notify?signature=deadbeef&timestamp=1&nonce=n`, deliverXml())
  assert('明文验签失败 → 400', r4.status === 400, `实际 ${r4.status}`)
  assert('验签失败不留痕（xpay_notifications 只收验签通过的）',
    !mockPool.notifications.some((n) => n.payload?.OutTradeNo && n.payload?.ToUserName === undefined))

  // 未知事件 → ErrCode=0 留痕（不认识的不要挡微信的路）
  const r5 = await postXml(`${W}/notify?${pushQuery('1730000006', 'n6')}`, deliverXml({ Event: 'xpay_complaint_notify', OutTradeNo: 'PO20261108000006' }))
  const j5 = await parseReply(r5)
  assert('未知/投诉事件 → ErrCode=0', j5.ErrCode === 0, JSON.stringify(j5))
  assert('未知事件也留痕', mockPool.notifications.some((n) => n.event === 'xpay_complaint_notify'))
}

section('POST /notify · JSON 形态（应答格式一致性）')
{
  const evt = {
    ToUserName: 'gh_abc123', FromUserName: 'oWxOfficial', CreateTime: 1730000000,
    MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: OPENID,
    OutTradeNo: 'PO20261108000007', Env: 0,
    WeChatPayInfo: { MchOrderNo: '420000999', TransactionId: '999', PaidTime: 1730000100 },
    GoodsInfo: { ProductId: 'dbee_lifetime', Quantity: 1, OrigPrice: 29800, ActualPrice: 29800, Attach: 'PO20261108000007' },
  }
  mockPool.seedOrder('PO20261108000007', OWNER, 'dbee_lifetime')
  const body = JSON.stringify(evt)
  const r = await post(`${W}/notify?${pushQuery('1730000007', 'n7')}`, body, { 'content-type': 'application/json' })
  const ct = r.headers.get('content-type') ?? ''
  const j = await r.json()
  assert('JSON 推送 → JSON 应答', ct.includes('application/json'), ct)
  assert('ErrCode=0', j.ErrCode === 0, JSON.stringify(j))
  assert('lifetime 买断权益', mockPool.ents.get(OWNER)?.plan === 'lifetime')
  assert('channel=wechat（无 AppleSubscriptionInfo）', mockPool.xtxns.get('PO20261108000007')?.channel === 'wechat')
}

section('POST /notify · 安全模式（Encrypt + msg_signature + AES 解密）')
{
  // 按微信标准加密：random(16) + msg_len(4,BE) + msg + appid，AES-256-CBC，iv=key前16字节
  const encryptMsg = (msg, appid = WX_APPID) => {
    const key = Buffer.from(`${PUSH_AES_KEY}=`, 'base64')
    const msgBuf = Buffer.from(msg, 'utf8')
    const plain = Buffer.concat([randomBytes(16), Buffer.alloc(4), msgBuf, Buffer.from(appid, 'utf8')])
    plain.writeUInt32BE(msgBuf.length, 16)
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
    return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
  }
  const inner = deliverXml({ OutTradeNo: 'PO20261108000008' })
  mockPool.seedOrder('PO20261108000008', OWNER, 'dbee_pro_monthly')
  const encrypt = encryptMsg(inner)
  const ts = '1730000008', nonce = 'n8'
  const msgSig = calcPushSignature(PUSH_TOKEN, ts, nonce, encrypt)
  const qs = new URLSearchParams({ msg_signature: msgSig, timestamp: ts, nonce, encrypt_type: 'aes' }).toString()
  const r = await post(`${W}/notify?${qs}`, JSON.stringify({ Encrypt: encrypt, ToUserName: 'gh_abc123' }))
  const j = await r.json()
  assert('安全模式发货 → ErrCode=0', j.ErrCode === 0, JSON.stringify(j))
  assert('解密后正确核销', !!mockPool.xtxns.get('PO20261108000008'))

  // msg_signature 错 → 400
  const qs2 = new URLSearchParams({ msg_signature: 'deadbeef', timestamp: ts, nonce, encrypt_type: 'aes' }).toString()
  const r2 = await post(`${W}/notify?${qs2}`, JSON.stringify({ Encrypt: encrypt }))
  assert('msg_signature 错误 → 400', r2.status === 400, `实际 ${r2.status}`)

  // 密文里 appid 不符 → 解密拒收（防别家小程序的推送串台）
  const badEncrypt = encryptMsg(inner, 'wx0000000000000000')
  const msgSig3 = calcPushSignature(PUSH_TOKEN, ts, nonce, badEncrypt)
  const qs3 = new URLSearchParams({ msg_signature: msgSig3, timestamp: ts, nonce, encrypt_type: 'aes' }).toString()
  const r3 = await post(`${W}/notify?${qs3}`, JSON.stringify({ Encrypt: badEncrypt }))
  assert('密文 appid 不符 → 400（不核销）', r3.status === 400 && !mockPool.xtxns.has('PO20261108000008_'), `实际 ${r3.status}`)
}

section('POST /query · 主动查单兜底')
{
  // ① 本地已 paid → 直接 settled（不外呼）
  const callsBefore = wxApi.calls.length
  const r1 = await post(`${W}/query`, { order_no: 'PO20261108000007' }, { authorization: `Bearer ${jwt()}` })
  const j1 = await r1.json()
  assert('本地 paid → settled:true 且不外呼', j1.settled === true && wxApi.calls.length === callsBefore, JSON.stringify(j1))

  // ② 本地 pending + 平台 status=2（已支付待发货）→ 按我方订单商品补发货
  //   🔴 用**独立用户**：上一节 OWNER 已买断 lifetime，而「lifetime 不降级」
  //     是 0046 的正确行为 —— 在它身上断言「变成 pro」必然失败。
  const YEARLY_OWNER = 'wx:oYearlyBuyer_abcdefghijklmn'
  const YEARLY_OPENID = 'oYearlyBuyer_abcdefghijklmn'
  mockPool.seedUser(YEARLY_OWNER)
  mockPool.seedOrder('PO20261108000010', YEARLY_OWNER, 'dbee_pro_yearly')
  wxApi.setQueryOrderResponse({
    errcode: 0, errmsg: 'ok',
    order: {
      order_id: 'PO20261108000010', create_time: 1730000000, update_time: 1730000100,
      status: 2, biz_type: 0, order_fee: 12800, paid_fee: 12800, order_type: 0,
      paid_time: 1730000100, env_type: 1, left_fee: 12800,
      wx_order_id: 'WXORDER123', channel_order_id: 'CH123', wxpay_order_id: 'WXPAY123', biz_meta: 'PO20261108000010',
    },
  })
  const r2 = await post(`${W}/query`, { order_no: 'PO20261108000010' }, { authorization: `Bearer ${jwt(YEARLY_OWNER)}` })
  const j2 = await r2.json()
  assert('status=2 → 补发货 settled:true', j2.settled === true, JSON.stringify(j2))
  const txn10 = mockPool.xtxns.get('PO20261108000010')
  assert('商品取我方订单（pro_yearly，非平台报文——平台返回体无商品字段）', txn10?.product_id === 'dbee_pro_yearly')
  assert('openid 由 JWT sub 推导（平台返回体无 openid 字段）', txn10?.openid === YEARLY_OPENID, String(txn10?.openid))
  assert('权益 12 个月 pro', mockPool.ents.get(YEARLY_OWNER)?.plan === 'pro', JSON.stringify(mockPool.ents.get(YEARLY_OWNER)))
  // 到期时间 ≈ now + 12 个月（容差 2 天，防跨月长度差异）
  {
    const until = new Date(mockPool.ents.get(YEARLY_OWNER)?.pro_until).getTime()
    const expect = new Date()
    expect.setMonth(expect.getMonth() + 12)
    assert('pro_until ≈ now+12月', Math.abs(until - expect.getTime()) < 2 * 86400_000,
      `${new Date(until).toISOString()} vs ${expect.toISOString()}`)
  }
  assert('provider_txn_id 优先 wxpay_order_id', txn10?.provider_txn_id === 'WXPAY123', String(txn10?.provider_txn_id))
  assert('paid_time 取平台报文', txn10?.paid_at === new Date(1730000100 * 1000).toISOString())
  assert('订单置 paid', mockPool.orders.get('PO20261108000010').status === 'paid')
  assert('lifetime 用户不受本次核销影响（不降级）', mockPool.ents.get(OWNER)?.plan === 'lifetime')
  // 外呼报文核验：POST body 三字段、pay_sig=uri&body、access_token 在 query
  const qCall = wxApi.calls.filter((c) => c.url.includes('/xpay/query_order')).pop()
  assert('query_order body = {openid,env,order_id}（参数名是 order_id 不是 out_trade_no）',
    JSON.stringify(JSON.parse(qCall.body)) === JSON.stringify({ openid: YEARLY_OPENID, env: 0, order_id: 'PO20261108000010' }), qCall.body)
  const qUrl = new URL(qCall.url)
  const expectPaySig = createHmac('sha256', APP_KEY).update(`/xpay/query_order&${qCall.body}`, 'utf8').digest('hex')
  assert('pay_sig = hmac(appKey, uri+"&"+原始body)', qUrl.searchParams.get('pay_sig') === expectPaySig)
  assert('access_token 在 query（mock token 接口被调过）', qUrl.searchParams.get('access_token') === 'mock_access_token')
  assert('URL 不含 appKey 明文', !qCall.url.includes(APP_KEY))

  // ②a 🔴 资金结算闸门：status=2（已支付待发货）补发权益后，必须调
  //   notify_provide_goods 把平台侧订单置为「已发货」，否则订单挂起、资金不结算
  //   —— 用户拿到会员而我方收不到钱（推送丢失场景下最隐蔽的资损）。
  const pgCalls = wxApi.callsOf('/xpay/notify_provide_goods')
  assert('status=2 补发货后调用了 notify_provide_goods（否则平台不结算）', pgCalls.length === 1, `${pgCalls.length} 次`)
  // 🔴 用 pgCalls[0] ?? {} 兜底：红验证时（调用被关掉）数组为空，
  //   若直接 .body 会 TypeError 崩掉整个脚本，后面几十项断言全部静默不跑
  //   —— 那就是「一次破坏只看见一个红灯」的假象，掩盖其余断言是否有效。
  const pgCall = pgCalls[0] ?? {}
  assert('notify_provide_goods body = {order_id, env}（官方只这两个业务字段）',
    JSON.stringify(JSON.parse(pgCall.body ?? 'null')) === JSON.stringify({ order_id: 'PO20261108000010', env: 0 }), String(pgCall.body))
  {
    const pgUrl = new URL(pgCall.url ?? 'http://mock.invalid/?pay_sig=')
    const expectSig = createHmac('sha256', APP_KEY)
      .update(`/xpay/notify_provide_goods&${pgCall.body ?? ''}`, 'utf8').digest('hex')
    assert('notify_provide_goods 的 pay_sig 用自己的 uri（不是 query_order 的）',
      pgUrl.searchParams.get('pay_sig') === expectSig, String(pgUrl.searchParams.get('pay_sig')).slice(0, 16))
  }

  // ②a-2 status=4（平台已确认发货）→ **不得**重复调（官方：推送成功后不需调此接口）
  const PG_OWNER = 'wx:oProvideGoods_abcdefghijkl'
  mockPool.seedUser(PG_OWNER)
  mockPool.seedOrder('PO20261108000020', PG_OWNER, 'dbee_pro_monthly')
  wxApi.setQueryOrderResponse({
    errcode: 0, errmsg: 'ok',
    order: { order_id: 'PO20261108000020', status: 4, order_fee: 1800, paid_fee: 1800, paid_time: 1730000200, order_type: 0 },
  })
  const pgBefore = wxApi.callsOf('/xpay/notify_provide_goods').length
  const rPg4 = await post(`${W}/query`, { order_no: 'PO20261108000020' }, { authorization: `Bearer ${jwt(PG_OWNER)}` })
  const jPg4 = await rPg4.json()
  assert('status=4 已发货 → 权益照旧补齐（幂等）', jPg4.settled === true, JSON.stringify(jPg4))
  assert('status=4 → 不再调 notify_provide_goods（平台已确认，重复调无意义）',
    wxApi.callsOf('/xpay/notify_provide_goods').length === pgBefore, `${wxApi.callsOf('/xpay/notify_provide_goods').length - pgBefore} 次多余调用`)

  // ②a-3 🔴 order_type=7（iOS 走 Apple 支付）→ 不调：官方限定「只能通知现金单」，
  //   Apple 侧结算链路独立（自然月后 45~60 天），我方无权替其确认发货。
  const APPLE_OWNER = 'wx:oAppleProvide_abcdefghijkl'
  mockPool.seedUser(APPLE_OWNER)
  mockPool.seedOrder('PO20261108000021', APPLE_OWNER, 'dbee_pro_monthly')
  wxApi.setQueryOrderResponse({
    errcode: 0, errmsg: 'ok',
    order: { order_id: 'PO20261108000021', status: 2, order_fee: 1800, paid_fee: 1800, paid_time: 1730000300, order_type: 7 },
  })
  const pgBefore2 = wxApi.callsOf('/xpay/notify_provide_goods').length
  const rPgA = await post(`${W}/query`, { order_no: 'PO20261108000021' }, { authorization: `Bearer ${jwt(APPLE_OWNER)}` })
  const jPgA = await rPgA.json()
  assert('Apple 单（order_type=7）status=2 → 权益仍发放', jPgA.settled === true, JSON.stringify(jPgA))
  assert('Apple 单 → 不调 notify_provide_goods（只能通知现金单）',
    wxApi.callsOf('/xpay/notify_provide_goods').length === pgBefore2, `${wxApi.callsOf('/xpay/notify_provide_goods').length - pgBefore2} 次多余调用`)
  assert('Apple 单 channel 记为 apple（退款须走 Apple，不可用微信退款）',
    mockPool.xtxns.get('PO20261108000021')?.channel === 'apple', String(mockPool.xtxns.get('PO20261108000021')?.channel))

  // ②a-4 notify_provide_goods 失败**不影响用户权益**（权益已落库），只留痕
  mockPool.seedOrder('PO20261108000022', PG_OWNER, 'dbee_pro_yearly')
  wxApi.setProvideGoodsResponse({ errcode: 48001, errmsg: 'api unauthorized' })
  wxApi.setQueryOrderResponse({
    errcode: 0, errmsg: 'ok',
    order: { order_id: 'PO20261108000022', status: 2, order_fee: 12800, paid_fee: 12800, paid_time: 1730000400, order_type: 0 },
  })
  const rPgF = await post(`${W}/query`, { order_no: 'PO20261108000022' }, { authorization: `Bearer ${jwt(PG_OWNER)}` })
  const jPgF = await rPgF.json()
  assert('发货确认接口报错 → 仍回 settled:true（用户权益优先，绝不因结算问题报错给用户）',
    jPgF.settled === true && jPgF.paid === true, JSON.stringify(jPgF))
  assert('发货确认失败有 error 级留痕（运维据此人工补发货）',
    logs.some((l) => l[0] === 'error' && l[1].includes('notify_provide_goods 失败') && l[1].includes('PO20261108000022')))
  wxApi.setProvideGoodsResponse({ errcode: 0, errmsg: 'ok' })

  // ②b 🔴 reconcile 语义：paid 订单默认**不外呼**（省配额），传 reconcile=true 才外呼对账
  const callsAfterSettle = wxApi.calls.length
  const r2b = await post(`${W}/query`, { order_no: 'PO20261108000010' }, { authorization: `Bearer ${jwt(YEARLY_OWNER)}` })
  const j2b = await r2b.json()
  assert('paid 订单默认查询不外呼（防 268490015 频率限制）',
    j2b.settled === true && wxApi.calls.length === callsAfterSettle, `${wxApi.calls.length - callsAfterSettle} 次外呼`)
  wxApi.setQueryOrderResponse({ errcode: 0, errmsg: 'ok', order: { order_id: 'PO20261108000010', status: 4, order_type: 0, paid_time: 1730000100 } })
  const r2c = await post(`${W}/query`, { order_no: 'PO20261108000010', reconcile: true }, { authorization: `Bearer ${jwt(YEARLY_OWNER)}` })
  const j2c = await r2c.json()
  assert('reconcile=true → 强制外呼对账（status=4 幂等 duplicate）',
    wxApi.calls.length > callsAfterSettle && j2c.settled === true, `${wxApi.calls.length - callsAfterSettle} 次外呼 ${JSON.stringify(j2c)}`)

  // ③ 平台 status=1（未支付）→ paid:false，前端继续等
  mockPool.seedOrder('PO20261108000011', OWNER, 'dbee_pro_monthly')
  wxApi.setQueryOrderResponse({ errcode: 0, errmsg: 'ok', order: { order_id: 'PO20261108000011', status: 1 } })
  const r3 = await post(`${W}/query`, { order_no: 'PO20261108000011' }, { authorization: `Bearer ${jwt()}` })
  const j3 = await r3.json()
  assert('status=1 → paid:false settled:false', j3.paid === false && j3.settled === false, JSON.stringify(j3))

  // ④ 🔴 reconcile=true + 平台 status=8（用户退款完成）→ revoke 防御
  //   这是「退款推送丢失」的唯一自愈路径：本地 status 停在 paid，只有强制
  //   外呼对账才能发现平台已退款。用独立用户，避免污染 OWNER 的 lifetime 态。
  const REFUND_OWNER = 'wx:oRefunded_abcdefghijklmno'
  mockPool.seedUser(REFUND_OWNER)
  mockPool.seedOrder('PO20261108000012', REFUND_OWNER, 'dbee_pro_monthly', 'paid')
  mockPool.ents.set(REFUND_OWNER, { plan: 'pro', pro_until: new Date(Date.now() + 86400_000).toISOString(), source: 'wechat' })
  mockPool.xtxns.set('PO20261108000012', {
    out_trade_no: 'PO20261108000012', owner_id: REFUND_OWNER, channel: 'wechat',
    revoked: false, product_id: 'dbee_pro_monthly', provider_txn_id: null, openid: 'oRefunded_abcdefghijklmno',
  })
  wxApi.setQueryOrderResponse({ errcode: 0, errmsg: 'ok', order: { order_id: 'PO20261108000012', status: 8, order_type: 1, refund_fee: 1800 } })
  const r4 = await post(`${W}/query`, { order_no: 'PO20261108000012', reconcile: true }, { authorization: `Bearer ${jwt(REFUND_OWNER)}` })
  const j4 = await r4.json()
  assert('reconcile + status=8 → refunded:true', j4.refunded === true, JSON.stringify(j4))
  assert('权益回收为 free（退款推送丢失时的唯一自愈路径）', mockPool.ents.get(REFUND_OWNER)?.plan === 'free',
    JSON.stringify(mockPool.ents.get(REFUND_OWNER)))
  assert('订单置 refunded', mockPool.orders.get('PO20261108000012').status === 'refunded')
  // 不传 reconcile 时 paid 订单提前返回 settled（不会去发现退款）—— 这正是开关的意义
  mockPool.seedOrder('PO20261108000014', REFUND_OWNER, 'dbee_pro_monthly', 'paid')
  const r4b = await post(`${W}/query`, { order_no: 'PO20261108000014' }, { authorization: `Bearer ${jwt(REFUND_OWNER)}` })
  const j4b = await r4b.json()
  assert('不传 reconcile → paid 订单直接 settled（前端轮询语义）', j4b.settled === true && j4b.paid === true, JSON.stringify(j4b))

  // ⑤ 外呼异常 → retry_later（绝不 5xx/报错 —— 用户可能刚付完钱）
  wxApi.setQueryOrderResponse(null)
  const origFetch = wxApi.fetchImpl
  mockPool.seedOrder('PO20261108000013', OWNER, 'dbee_pro_monthly')
  wxApi.setQueryOrderResponse({ errcode: -1, errmsg: 'system error' })
  const r5 = await post(`${W}/query`, { order_no: 'PO20261108000013' }, { authorization: `Bearer ${jwt()}` })
  const j5 = await r5.json()
  assert('平台系统错误 → retry_later:true 且 HTTP 200', r5.status === 200 && j5.retry_later === true, JSON.stringify(j5))

  // ⑥ 未登录 → 401
  const r6 = await post(`${W}/query`, { order_no: 'PO20261108000013' })
  assert('query 无 Bearer → 401', r6.status === 401, `实际 ${r6.status}`)
}

section('安全 · 凭据绝不外泄')
{
  const allLogs = logs.map(([, m]) => m).join('\n')
  assert('日志不含 appKey', !allLogs.includes(APP_KEY))
  assert('日志不含 session_key 值', !allLogs.includes(MOCK_SESSION_KEY))
  assert('日志不含 access_token 值', !allLogs.includes('mock_access_token'))
  assert('日志不含 EncodingAESKey', !allLogs.includes(PUSH_AES_KEY))
}

server.close()
console.log(`\n${'═'.repeat(58)}\n  通过 ${passed} · 失败 ${failed}\n${'═'.repeat(58)}`)
if (failed) {
  console.log('\n❌ xpay 自测存在失败项')
  process.exit(1)
}
console.log('\n✅ 微信虚拟支付链路（params/notify/query）自测全过')
