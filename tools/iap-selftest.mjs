/**
 * 网关 C1 · Apple IAP 端到端自测（不需真数据库、不需网络、不需 Mac）。
 *
 * 做法与 gateway-selftest.mjs 一致：注入 mock pool（内存实现 0037 三个 definer
 * 函数的语义）+ mock fetch（伪造 Apple verifyReceipt 响应）+ 注入式 verifyJws
 * （跳过「伪造 Apple 证书链」这一不可能步骤，专测 webhook 处理分支），
 * 用 createApp() 起一个**真实 http.Server**，再用 fetch 走完整协议链断言
 * **线上客户端会真正看到的 HTTP 报文**。
 *
 * 覆盖的攻击面（对应 iap.mjs 文件头 5 条安全边界）：
 *   · 无 Bearer / 坏 Bearer → 401
 *   · 缺收据 → 400；未配 bundleId → 503
 *   · Apple status≠0（21002/21003）→ 402
 *   · bundle_id 不匹配（别家 App 收据）→ 402 bundle_mismatch
 *   · 收据无交易 → 402 no_transaction
 *   · 沙盒收据发到生产（21007）→ 自动切换沙盒后成功
 *   · 正常购买 → settled，权益落库，订单转 paid
 *   · 同 txn 重复核销 → duplicate:true，权益不二次顺延
 *   · 换账号重放他人收据 → 409 txn_taken_by_other
 *   · 恢复购买（restore- 前缀，无订单）→ 成功
 *   · webhook SUBSCRIBED/DID_RENEW → 续订核销；REFUND → 撤销权益
 *   · webhook 验签失败 → 400；owner_unresolved → processed:false
 *
 * 运行：node tools/iap-selftest.mjs
 */
import { createApp } from '../server/lib/app.mjs'
import { signJwt } from '../server/lib/jwt.mjs'
import { createHash } from 'node:crypto'

let failed = 0
let passed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

const BUNDLE_ID = 'com.dbee.selfdiscipline'
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef'
const OWNER_A = '2109869577155379200'
const OWNER_B = '2109869577155379201'

// ── mock pool：内存实现 0037 的 settle/revoke/log 语义 ──────────────────
function createMockPool() {
  const txns = new Map() // transaction_id -> row
  const origIndex = new Map() // original_transaction_id -> [txn rows]
  const entitlements = new Map() // owner_id -> { plan, pro_until, source }
  const orders = new Map() // order_no -> row
  const notifications = []
  const queries = []

  // 商品表（与 0021 预置一致）
  const products = new Map([
    ['dbee_pro_monthly', { plan: 'pro', months: 1, active: true }],
    ['dbee_pro_yearly', { plan: 'pro', months: 12, active: true }],
    ['dbee_lifetime', { plan: 'lifetime', months: null, active: true }],
  ])

  const now = () => new Date().toISOString()
  const addMonths = (iso, m) => {
    const d = new Date(iso)
    d.setUTCMonth(d.getUTCMonth() + m)
    return d.toISOString()
  }
  const msToIso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString())

  /** 复刻 settle_apple_purchase 的核心分支（幂等/防重放/权益落库/订单核销） */
  function settle(args) {
    const [ownerId, orderNo, productId, txnId, origTxnId, expiresMs, purchaseMs, env, receiptSha] = args
    const existing = txns.get(txnId)
    if (existing) {
      if (ownerId != null && existing.owner_id !== ownerId) {
        return { rows: [{ r: { error: 'txn_taken_by_other' } }] }
      }
      const ent = entitlements.get(existing.owner_id)
      return { rows: [{ r: { settled: true, duplicate: true, owner_id: existing.owner_id, plan: ent?.plan ?? 'free', pro_until: ent?.pro_until ?? null } }] }
    }

    // owner 解析（webhook 续订按 original 反查首笔）
    let owner = ownerId
    if (owner == null) {
      const hist = origIndex.get(origTxnId)
      owner = hist?.[0]?.owner_id ?? null
      if (owner == null) return { rows: [{ r: { error: 'owner_unresolved' } }] }
    }

    const prod = products.get(productId)
    if (!prod || !prod.active) return { rows: [{ r: { error: 'unknown_product' } }] }

    const expires = expiresMs != null && /^\d+$/.test(expiresMs) ? msToIso(expiresMs) : null
    const row = {
      transaction_id: txnId, original_transaction_id: origTxnId ?? txnId,
      owner_id: owner, product_id: productId, plan: prod.plan, order_no: orderNo,
      expires_at: expires, purchased_at: msToIso(purchaseMs), environment: env,
      receipt_sha256: receiptSha, revoked: false, settled_at: now(),
    }
    txns.set(txnId, row)
    const oi = origIndex.get(row.original_transaction_id) ?? []
    oi.push(row)
    origIndex.set(row.original_transaction_id, oi)

    // 权益落库
    let ent = entitlements.get(owner)
    if (prod.plan === 'lifetime') {
      ent = { plan: 'lifetime', pro_until: null, source: 'apple' }
    } else if (expires) {
      const cur = ent && ent.plan === 'pro' && ent.pro_until ? ent.pro_until : now()
      const until = cur > expires ? cur : expires // GREATEST
      ent = ent?.plan === 'lifetime' ? ent : { plan: 'pro', pro_until: until, source: 'apple' }
    } else {
      const base = ent && ent.plan === 'pro' && ent.pro_until && ent.pro_until > now() ? ent.pro_until : now()
      ent = ent?.plan === 'lifetime' ? ent : { plan: 'pro', pro_until: addMonths(base, prod.months ?? 1), source: 'apple' }
    }
    entitlements.set(owner, ent)

    // 订单核销
    if (orderNo && !orderNo.startsWith('restore-')) {
      const o = orders.get(orderNo)
      if (o && o.owner_id === owner && o.product_id === productId && o.status === 'pending') {
        o.status = 'paid'
        o.provider_txn_id = txnId
        o.receipt_payload = 'sha256:' + (receiptSha ?? '')
      }
    }

    const after = entitlements.get(owner)
    return { rows: [{ r: { settled: true, duplicate: false, owner_id: owner, plan: after?.plan ?? 'free', pro_until: after?.pro_until ?? null } }] }
  }

  function revoke(args) {
    const [txnId, origTxnId, reason] = args
    let txn = txns.get(txnId)
    if (!txn && origTxnId) {
      const hist = origIndex.get(origTxnId)
      txn = hist?.[hist.length - 1]
    }
    if (!txn) return { rows: [{ r: { revoked: false, error: 'txn_not_found' } }] }
    if (txn.revoked) return { rows: [{ r: { revoked: true, duplicate: true, owner_id: txn.owner_id } }] }
    txn.revoked = true
    txn.revoked_reason = reason
    const ent = entitlements.get(txn.owner_id)
    if (ent && ent.source === 'apple') {
      entitlements.set(txn.owner_id, { plan: 'free', pro_until: null, source: null })
    }
    return { rows: [{ r: { revoked: true, owner_id: txn.owner_id, plan_now: 'free' } }] }
  }

  return {
    txns, origIndex, entitlements, orders, notifications, queries,
    async query(sql, params = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 70), params })
      const s = sql.replace(/\s+/g, ' ')

      if (/FROM public\.payment_orders WHERE order_no = \$1/i.test(s)) {
        const o = orders.get(params[0])
        return { rowCount: o ? 1 : 0, rows: o ? [o] : [] }
      }
      if (/settle_apple_purchase/i.test(s)) return settle(params)
      if (/revoke_apple_purchase/i.test(s)) return revoke(params)
      if (/log_apple_notification/i.test(s)) {
        notifications.push({ payload: params[0], transaction_id: params[1], original_transaction_id: params[2], processed: params[3], error: params[4] })
        return { rowCount: 1, rows: [] }
      }
      if (/SELECT current_user/i.test(s)) {
        return { rowCount: 1, rows: [{ u: 'dbee_app', d: 'dbee' }] }
      }
      throw new Error(`mock pool 未实现的 SQL: ${s.slice(0, 80)}`)
    },
    async end() {},
  }
}

// ── mock Apple verifyReceipt ────────────────────────────────────────────
// 按请求里的 receipt-data 内容决定返回，模拟「不同收据 → 不同结果」。
function makeReceiptResponse({ status = 0, bundleId = BUNDLE_ID, environment = 'Production', transactions = [], inApp = [] } = {}) {
  return {
    status,
    environment,
    receipt: { bundle_id: bundleId, in_app: inApp },
    latest_receipt_info: transactions,
  }
}

/** 造一个 mock fetch：根据 receipt-data 前缀路由到不同响应 */
function createMockFetch(routes) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    const key = String(body['receipt-data'] ?? '')
    const handler = routes[key] ?? routes['*']
    if (!handler) throw new Error(`mock fetch 未配置收据路由: ${key.slice(0, 20)}`)
    const resp = typeof handler === 'function' ? handler(url, body) : handler
    return {
      status: resp.httpStatus ?? 200,
      text: async () => JSON.stringify(resp.body ?? resp),
    }
  }
}

// ── 测试配置 ────────────────────────────────────────────────────────────
const baseCfg = {
  prod: false, host: '127.0.0.1', port: 0,
  jwtSecret: JWT_SECRET, accessTtlSec: 3600, refreshTtlSec: 7200,
  publishableKey: '', smsProvider: 'log', smsMasterCode: '888888', smsSignName: '自律蜜蜂',
  otpTtlSec: 300, otpMaxAttempts: 3, otpResendSec: 60, otpIpHourLimit: 1000,
  identPepper: 'test-pepper-0123456789abcdef0123456789abcdef',
  bodyLimitBytes: 4 * 1024 * 1024, rateLimitPerMin: 100000,
  llmApiKey: '', llmBaseUrl: 'http://127.0.0.1:1/v1', llmModelText: 'x', llmModelVision: 'x',
  llmTimeoutMs: 5000, llmDailyCapPerUser: 100,
  postgrestUrl: 'http://127.0.0.1:1', postgrestJwtSecret: JWT_SECRET, postgrestSchema: 'public',
  dbStatementTimeoutMs: 5000, dbPoolMax: 2,
  // ── Apple IAP ──
  appleBundleId: BUNDLE_ID,
  appleSharedSecret: 'shared-secret-test',
  appleSandbox: false,
  appleWebhookSecret: '',
}

const logger = { info: () => {}, warn: () => {}, error: (...a) => console.error('    [iap]', ...a) }

/** 起一个真实 HTTP 服务，返回 { url, token(owner), pool, close } */
async function startServer({ cfg = baseCfg, routes = {}, verifyJwsImpl } = {}) {
  const pool = createMockPool()
  const fetchImpl = createMockFetch(routes)
  const { server } = createApp({
    cfg, pool, gatewayPool: pool, logger,
    enableDbProxy: false, enableLlm: false,
    fetchImpl, verifyJwsImpl,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}`
  const token = (owner) => signJwt({ sub: owner, role: 'authenticated' }, JWT_SECRET, 3600)
  return { url, pool, token, close: () => new Promise((r) => server.close(r)) }
}

async function post(url, path, body, token) {
  const resp = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await resp.json() } catch { /* 空体 */ }
  return { status: resp.status, body: json }
}

// ══════════════════════════════════════════════════════════════════════
// 运行
// ══════════════════════════════════════════════════════════════════════
const RECEIPT_OK = 'RECEIPT_VALID_MONTHLY'
const RECEIPT_BAD_BUNDLE = 'RECEIPT_OTHER_APP'
const RECEIPT_EMPTY = 'RECEIPT_NO_TXN'
const RECEIPT_SANDBOX = 'RECEIPT_SANDBOX'
const RECEIPT_LIFETIME = 'RECEIPT_LIFETIME'

const TXN_MONTHLY = '1000000111111111'
const TXN_RENEW = '1000000222222222' // 同 original 的续订交易
const ORIG_TXN = '1000000111111111'
const TXN_LIFETIME = '1000000333333333'
const futureMs = Date.now() + 30 * 86400 * 1000

const routes = {
  [RECEIPT_OK]: { body: makeReceiptResponse({
    transactions: [{ transaction_id: TXN_MONTHLY, original_transaction_id: ORIG_TXN, product_id: 'dbee_pro_monthly', expires_date_ms: String(futureMs), purchase_date_ms: String(Date.now()) }],
  }) },
  [RECEIPT_BAD_BUNDLE]: { body: makeReceiptResponse({
    bundleId: 'com.evil.otherapp',
    transactions: [{ transaction_id: '9999', product_id: 'dbee_pro_monthly', expires_date_ms: String(futureMs) }],
  }) },
  [RECEIPT_EMPTY]: { body: makeReceiptResponse({ transactions: [], inApp: [] }) },
  [RECEIPT_SANDBOX]: (url) => ({ body: url.includes('sandbox')
    ? makeReceiptResponse({ environment: 'Sandbox', transactions: [{ transaction_id: TXN_MONTHLY, original_transaction_id: ORIG_TXN, product_id: 'dbee_pro_monthly', expires_date_ms: String(futureMs) }] })
    : makeReceiptResponse({ status: 21007 }) }), // 生产端点回 21007 → 触发切沙盒
  [RECEIPT_LIFETIME]: { body: makeReceiptResponse({
    inApp: [{ transaction_id: TXN_LIFETIME, original_transaction_id: TXN_LIFETIME, product_id: 'dbee_lifetime' }],
  }) },
  '*': { body: makeReceiptResponse({ status: 21002 }) },
}

console.log('网关 Apple IAP 自测（C1 · verifyReceipt + webhook）\n')

// ── 未配 bundleId → 503 ──
section('配置缺失 · APPLE_BUNDLE_ID 未配')
{
  const s = await startServer({ cfg: { ...baseCfg, appleBundleId: '' }, routes })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK }, s.token(OWNER_A))
  assert('verify → 503 iap_not_configured', r.status === 503 && r.body?.error === 'iap_not_configured', `status=${r.status}`)
  const w = await post(s.url, '/.cloud/payment/apple/notifications', { signedPayload: 'x.y.z' })
  assert('notifications → 503', w.status === 503)
  await s.close()
}

// ── 鉴权 ──
section('鉴权 · Bearer 必须有效')
{
  const s = await startServer({ routes })
  const noAuth = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK })
  assert('无 Bearer → 401', noAuth.status === 401 && noAuth.body?.error === 'unauthorized', `status=${noAuth.status}`)
  const badAuth = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK }, 'not.a.jwt')
  assert('坏 Bearer → 401', badAuth.status === 401)
  const noReceipt = await post(s.url, '/.cloud/payment/apple/verify', {}, s.token(OWNER_A))
  assert('缺收据 → 400 missing_receipt', noReceipt.status === 400 && noReceipt.body?.error === 'missing_receipt')
  await s.close()
}

// ── Apple status≠0 ──
section('验签 · Apple 状态码')
{
  const s = await startServer({ routes })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: 'RECEIPT_GARBAGE' }, s.token(OWNER_A))
  assert('21002 收据损坏 → 402 apple_status_21002', r.status === 402 && r.body?.error === 'apple_status_21002', `status=${r.status} err=${r.body?.error}`)
  await s.close()
}

// ── bundle_id 钉扎 ──
section('安全 · bundle_id 钉扎（防别家 App 收据换会员）')
{
  const s = await startServer({ routes })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_BAD_BUNDLE }, s.token(OWNER_A))
  assert('别家 bundle → 402 bundle_mismatch', r.status === 402 && r.body?.error === 'bundle_mismatch', `status=${r.status} err=${r.body?.error}`)
  assert('未写权益', s.pool.entitlements.size === 0)
  await s.close()
}

// ── 收据无交易 ──
section('边界 · 收据合法但无可核销交易')
{
  const s = await startServer({ routes })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_EMPTY }, s.token(OWNER_A))
  assert('空交易 → 402 no_transaction', r.status === 402 && r.body?.error === 'no_transaction')
  await s.close()
}

// ── 沙盒/生产自动切换 ──
section('沙盒 · 21007 自动切沙盒端点')
{
  const s = await startServer({ routes })
  const orderNo = 'PO-SANDBOX-1'
  s.pool.orders.set(orderNo, { owner_id: OWNER_A, product_id: 'dbee_pro_monthly', status: 'pending', order_no: orderNo })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_SANDBOX, order_no: orderNo }, s.token(OWNER_A))
  assert('21007 → 切沙盒后核销成功', r.status === 200 && r.body?.settled === true, `status=${r.status} body=${JSON.stringify(r.body)}`)
  assert('订单转 paid', s.pool.orders.get(orderNo).status === 'paid')
  await s.close()
}

// ── 正常购买（带订单）──
section('正常购买 · 月订阅核销')
{
  const s = await startServer({ routes })
  const orderNo = 'PO-OK-1'
  s.pool.orders.set(orderNo, { owner_id: OWNER_A, product_id: 'dbee_pro_monthly', status: 'pending', order_no: orderNo })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK, order_no: orderNo, provider_txn_id: TXN_MONTHLY }, s.token(OWNER_A))
  assert('→ 200 settled', r.status === 200 && r.body?.settled === true && r.body?.duplicate === false)
  assert('plan=pro', r.body?.plan === 'pro')
  assert('返回 transaction_id 与 Apple 一致', r.body?.transaction_id === TXN_MONTHLY)
  const ent = s.pool.entitlements.get(OWNER_A)
  assert('权益落库 plan=pro source=apple', ent?.plan === 'pro' && ent?.source === 'apple')
  assert('pro_until ≈ Apple expires', Math.abs(new Date(ent.pro_until).getTime() - futureMs) < 5000, ent.pro_until)
  assert('订单 paid + provider_txn_id', s.pool.orders.get(orderNo).status === 'paid' && s.pool.orders.get(orderNo).provider_txn_id === TXN_MONTHLY)
  assert('交易记入幂等表', s.pool.txns.has(TXN_MONTHLY))
  await s.close()
}

// ── 买断（in_app，无 expires）──
section('正常购买 · 终身买断')
{
  const s = await startServer({ routes })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_LIFETIME, provider_txn_id: TXN_LIFETIME }, s.token(OWNER_A))
  assert('→ 200 settled plan=lifetime', r.status === 200 && r.body?.plan === 'lifetime', JSON.stringify(r.body))
  const ent = s.pool.entitlements.get(OWNER_A)
  assert('lifetime + pro_until=null', ent?.plan === 'lifetime' && ent?.pro_until == null)
  await s.close()
}

// ── 幂等：同 owner 同 txn 重复 ──
section('幂等 · 同交易重复核销不二次顺延')
{
  const s = await startServer({ routes })
  const orderNo = 'PO-DUP-1'
  s.pool.orders.set(orderNo, { owner_id: OWNER_A, product_id: 'dbee_pro_monthly', status: 'pending', order_no: orderNo })
  await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK, order_no: orderNo }, s.token(OWNER_A))
  const until1 = s.pool.entitlements.get(OWNER_A).pro_until
  const r2 = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK, order_no: orderNo }, s.token(OWNER_A))
  assert('第二次 → duplicate:true', r2.status === 200 && r2.body?.duplicate === true)
  const until2 = s.pool.entitlements.get(OWNER_A).pro_until
  assert('pro_until 未被二次顺延', until1 === until2, `${until1} vs ${until2}`)
  await s.close()
}

// ── 防重放：换账号重放他人收据 ──
section('防重放 · 换账号重放他人收据')
{
  const s = await startServer({ routes })
  // A 先核销
  await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK }, s.token(OWNER_A))
  // B 用同一收据重放
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK }, s.token(OWNER_B))
  assert('→ 409 txn_taken_by_other', r.status === 409 && r.body?.error === 'txn_taken_by_other', `status=${r.status} err=${r.body?.error}`)
  assert('B 未获得权益', !s.pool.entitlements.has(OWNER_B))
  await s.close()
}

// ── 恢复购买（restore- 前缀，无订单）──
section('恢复购买 · restore- 前缀无订单路径')
{
  const s = await startServer({ routes })
  const r = await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK, order_no: `restore-${TXN_MONTHLY}`, provider_txn_id: TXN_MONTHLY }, s.token(OWNER_A))
  assert('→ 200 settled', r.status === 200 && r.body?.settled === true)
  assert('交易 owner=A', s.pool.txns.get(TXN_MONTHLY).owner_id === OWNER_A)
  assert('order_no 为 restore- 前缀', s.pool.txns.get(TXN_MONTHLY).order_no === `restore-${TXN_MONTHLY}`)
  await s.close()
}

// ── webhook：验签失败 ──
section('Webhook · JWS 验签失败拒收')
{
  const s = await startServer({ routes, verifyJwsImpl: () => { throw new Error('bad signature') } })
  const r = await post(s.url, '/.cloud/payment/apple/notifications', { signedPayload: 'x.y.z' })
  assert('→ 400 invalid_signature', r.status === 400 && r.body?.error === 'invalid_signature')
  assert('未落通知表', s.pool.notifications.length === 0)
  await s.close()
}

// ── webhook：bundleId 不匹配 ──
section('Webhook · bundleId 钉扎')
{
  const s = await startServer({ routes, verifyJwsImpl: (jws) => {
    if (jws.includes('TXN')) return { productId: 'dbee_pro_monthly', transactionId: TXN_RENEW, originalTransactionId: ORIG_TXN }
    return { notificationType: 'DID_RENEW', data: { bundleId: 'com.evil.x', signedTransactionInfo: 'TXN' } }
  } })
  const r = await post(s.url, '/.cloud/payment/apple/notifications', { signedPayload: 'outer' })
  assert('→ 400 bundle_mismatch', r.status === 400 && r.body?.error === 'bundle_mismatch')
  await s.close()
}

// ── webhook：SUBSCRIBED（owner_unresolved：用户从未客户端核销）──
section('Webhook · SUBSCRIBED 但 owner 未解析')
{
  const s = await startServer({ routes, verifyJwsImpl: (jws) => {
    if (jws.includes('TXN')) return { productId: 'dbee_pro_monthly', transactionId: 'T-NEW', originalTransactionId: 'ORIG-NEW', expiresDate: futureMs }
    return { notificationType: 'SUBSCRIBED', data: { bundleId: BUNDLE_ID, signedTransactionInfo: 'TXN' } }
  } })
  const r = await post(s.url, '/.cloud/payment/apple/notifications', { signedPayload: 'outer' })
  assert('→ 200 但 processed=false（owner_unresolved）', r.status === 200 && r.body?.processed === false, JSON.stringify(r.body))
  assert('通知已留痕 error=owner_unresolved', s.pool.notifications.at(-1)?.error === 'owner_unresolved')
  await s.close()
}

// ── webhook：DID_RENEW 续订（先客户端核销建立 owner，再续订）──
section('Webhook · DID_RENEW 续订顺延（owner 由首笔反查）')
{
  const s = await startServer({ routes })
  // 先客户端核销建立 original → owner 映射
  await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK }, s.token(OWNER_A))
  const until1 = s.pool.entitlements.get(OWNER_A).pro_until
  // 注入式 verifyJws：外层通知 + 内层交易（续订，新 transaction_id、同 original、更晚 expires）
  const renewExpires = futureMs + 30 * 86400 * 1000
  const s2 = s // 复用同一 server 的 pool，但需要重建带 verifyJwsImpl 的 server
  await s.close()

  // 重新起一个带注入验签的 server，并预置首笔交易（模拟已核销状态）
  const s3 = await startServer({ routes, verifyJwsImpl: (jws) => {
    if (jws.includes('TXN')) return { productId: 'dbee_pro_monthly', transactionId: TXN_RENEW, originalTransactionId: ORIG_TXN, expiresDate: renewExpires }
    return { notificationType: 'DID_RENEW', data: { bundleId: BUNDLE_ID, signedTransactionInfo: 'TXN' } }
  } })
  // 手动预置首笔核销（等价于客户端已 verify 过）
  s3.pool.query(`SELECT public.settle_apple_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [OWNER_A, null, 'dbee_pro_monthly', ORIG_TXN, ORIG_TXN, String(futureMs), String(Date.now()), 'Production', null])
  const untilBefore = s3.pool.entitlements.get(OWNER_A).pro_until
  const r = await post(s3.url, '/.cloud/payment/apple/notifications', { signedPayload: 'outer' })
  assert('→ 200 processed=true', r.status === 200 && r.body?.processed === true, JSON.stringify(r.body))
  const untilAfter = s3.pool.entitlements.get(OWNER_A).pro_until
  assert('续订后 pro_until 顺延', new Date(untilAfter).getTime() > new Date(untilBefore).getTime(), `${untilBefore} → ${untilAfter}`)
  assert('续订交易记入幂等表', s3.pool.txns.has(TXN_RENEW))
  await s3.close()
}

// ── webhook：REFUND 撤销权益 ──
section('Webhook · REFUND 撤销权益')
{
  const s = await startServer({ routes })
  // 先购买
  await post(s.url, '/.cloud/payment/apple/verify', { receipt: RECEIPT_OK }, s.token(OWNER_A))
  assert('购买前 plan=pro', s.pool.entitlements.get(OWNER_A)?.plan === 'pro')
  await s.close()

  // 退款通知（复用同一 routes；注入验签返回 REFUND + 被退交易）
  const s2 = await startServer({ routes, verifyJwsImpl: (jws) => {
    if (jws.includes('TXN')) return { productId: 'dbee_pro_monthly', transactionId: TXN_MONTHLY, originalTransactionId: ORIG_TXN }
    return { notificationType: 'REFUND', subtype: 'REFUND_DUE_TO_APP_ISSUE', data: { bundleId: BUNDLE_ID, signedTransactionInfo: 'TXN' } }
  } })
  // 预置该交易为已核销（owner=A, source=apple）
  s2.pool.query(`SELECT public.settle_apple_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [OWNER_A, null, 'dbee_pro_monthly', TXN_MONTHLY, ORIG_TXN, String(futureMs), String(Date.now()), 'Production', null])
  const r = await post(s2.url, '/.cloud/payment/apple/notifications', { signedPayload: 'outer' })
  assert('→ 200 processed=true', r.status === 200 && r.body?.processed === true, JSON.stringify(r.body))
  const ent = s2.pool.entitlements.get(OWNER_A)
  assert('退款后权益撤销 plan=free', ent?.plan === 'free' && ent?.source == null)
  assert('交易标记 revoked', s2.pool.txns.get(TXN_MONTHLY).revoked === true)
  await s2.close()
}

// ── webhook：未知类型仅留痕 ──
section('Webhook · 其他通知类型仅留痕')
{
  const s = await startServer({ routes, verifyJwsImpl: () => ({ notificationType: 'EXPIRED', data: { bundleId: BUNDLE_ID } }) })
  const r = await post(s.url, '/.cloud/payment/apple/notifications', { signedPayload: 'outer' })
  assert('→ 200 processed=true', r.status === 200 && r.body?.processed === true)
  // mock pool 存的是 JSON 字符串（与真库 jsonb 入参对应），解析后取字段
  assert('留痕 notification_type=EXPIRED', JSON.parse(s.pool.notifications.at(-1)?.payload ?? '{}')?.notificationType === 'EXPIRED')
  await s.close()
}

// ── 汇总 ──
console.log(`\n${'═'.repeat(60)}`)
console.log(`  通过 ${passed} · 失败 ${failed}`)
console.log('═'.repeat(60))
process.exit(failed === 0 ? 0 : 1)
