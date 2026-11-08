/**
 * 微信登录链路（A1~A3）端到端自测。
 *
 * 做法与 tools/gateway-selftest.mjs 同构：注入 mock pool（内存版 app_users）+
 * mock fetch（伪造微信 jscode2session），用 createApp() 起**真实 http.Server**，
 * 然后用两套客户端各打一遍：
 *   ① 裸 fetch —— 断言 SDK 会真正看到的 HTTP 报文（status / 字段形态 / 不泄密）
 *   ② 真实 SDK（createWorkBuddyCloud + createMemoryStorage）—— 断言 SDK 的
 *      parseSession / userFromSessionPayload 能吃下响应，且 session.user.id
 *      = 'wx:'+openid（这是 mini/src/lib/auth.ts cacheSession 的前提）
 *
 * 覆盖场景：
 *   · 成功登录（新用户建号 + 老用户幂等）
 *   · access-key 校验 / 参数校验（缺 code、缺 appid、畸形 appid）
 *   · 凭据未配置（appid 不在 WECHAT_MINI_SECRETS）→ 503，不外呼
 *   · 微信侧错误码分类（invalid code→401 / 频控→503 / secret 错→503 / 系统错→503）
 *   · 上游不可达 → 502；非 JSON → 502；畸形 openid → 502（不入库）
 *   · sessionPayload 同构（access_token/refresh_token/sub/role/is_anonymous…）
 *   · sub = owner_id = 'wx:'+openid；JWT 可被网关验签、含 ver
 *   · AppSecret 绝不进日志、不进响应体
 *   · /user/me 能读回微信用户；token refresh 可用
 *   · 0046 · session_key 经 AES-256-GCM 加密落库（密文可解密回原值，明文不落库不进日志）
 *
 * 运行：node tools/wechat-login-selftest.mjs
 */
import { createApp } from '../server/lib/app.mjs'
import { verifyJwt } from '../server/lib/jwt.mjs'
import { identHash } from '../server/lib/identity.mjs'
import { decryptSessionKey } from '../server/lib/wechatSession.mjs'
import { createWorkBuddyCloud, createMemoryStorage } from '@tencent-ai/workbuddy-cloud-sdk'

let failed = 0
let passed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

// ── mock pool：内存版 app_users（与 gateway-selftest 同构）─────────────
function createMockPool() {
  const rows = new Map() // owner_id -> row
  const byIdent = new Map() // `${kind}:${hash}` -> owner_id
  return {
    rows, byIdent,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ')
      if (/INSERT INTO public\.app_users/i.test(s)) {
        const [owner_id, ident_kind, ident_hash, ident_masked, password_hash, token_version] = params
        const key = `${ident_kind}:${ident_hash}`
        if (byIdent.has(key) || rows.has(owner_id)) return { rowCount: 0, rows: [] }
        const row = {
          owner_id, ident_kind, ident_hash, ident_masked, password_hash,
          created_at: new Date().toISOString(), last_login_at: null, login_count: 0,
          token_version: token_version ?? 1,
        }
        rows.set(owner_id, row)
        byIdent.set(key, owner_id)
        return { rowCount: 1, rows: [row] }
      }
      if (/FROM public\.app_users/i.test(s) && /ident_kind = \$1 AND ident_hash = \$2/i.test(s)) {
        const [kind, hash] = params
        const oid = byIdent.get(`${kind}:${hash}`)
        return { rowCount: oid ? 1 : 0, rows: oid ? [rows.get(oid)] : [] }
      }
      if (/FROM public\.app_users/i.test(s) && /owner_id = \$1/i.test(s)) {
        if (/token_version/i.test(s) && !/ident_kind/i.test(s)) {
          // getTokenVersion：SELECT token_version ... WHERE owner_id=$1
          const r = rows.get(params[0])
          return { rowCount: r ? 1 : 0, rows: r ? [{ token_version: r.token_version }] : [] }
        }
        const r = rows.get(params[0])
        return { rowCount: r ? 1 : 0, rows: r ? [r] : [] }
      }
      if (/UPDATE public\.app_users/i.test(s)) {
        const r = rows.get(params[0])
        if (/token_version = token_version \+ 1/i.test(s)) {
          if (r) r.token_version = (r.token_version ?? 1) + 1
          return { rowCount: r ? 1 : 0, rows: r ? [{ token_version: r.token_version }] : [] }
        }
        // 0046 · wechatSession.saveSessionKey 的加密落库（必须在 touchLogin 兜底分支之前
        // 拦下，否则会被误当成登录更新而虚增 login_count）
        if (/wechat_session_key_enc/i.test(s)) {
          const [ownerId, enc, appid] = params
          if (r) { r.wechat_session_key_enc = enc; r.wechat_appid = appid; r.wechat_session_key_at = new Date().toISOString() }
          return { rowCount: r ? 1 : 0, rows: [] }
        }
        if (r) { r.last_login_at = new Date().toISOString(); r.login_count += 1 }
        return { rowCount: r ? 1 : 0, rows: [] }
      }
      if (/SELECT current_user/i.test(s)) return { rowCount: 1, rows: [{ u: 'dbee_app', d: 'dbee' }] }
      throw new Error(`mock pool 未实现的 SQL: ${s.slice(0, 80)}`)
    },
    async end() {},
  }
}

// ── mock 微信 fetch：伪造 jscode2session 响应 ─────────────────────────
// code → 预设响应表；未命中则按 code 前缀模拟各类错误。
// 记录每次外呼的 URL，用于断言「secret 不外泄到别处」「未配置的 appid 不外呼」。
function createWechatMock() {
  const calls = []
  const json = (status, obj) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  })
  const fetchImpl = async (url, init) => {
    calls.push(String(url))
    const u = new URL(String(url))
    const jsCode = u.searchParams.get('js_code') || ''
    // 网络不可达（code 以 neterr 开头）
    if (jsCode.startsWith('neterr')) throw new Error('connect ECONNREFUSED')
    // 非 JSON（code 以 badjson 开头）
    if (jsCode.startsWith('badjson')) {
      return { ok: true, status: 200, json: async () => { throw new Error('not json') } }
    }
    // 微信错误码（code 形如 err40029）
    const m = /^err(-?\d+)$/.exec(jsCode)
    if (m) return json(200, { errcode: Number(m[1]), errmsg: `mock err ${m[1]}` })
    // 畸形 openid（code 以 malformed 开头）
    if (jsCode.startsWith('malformed')) return json(200, { openid: '!!!bad openid with space!!!', session_key: 'sk-mock' })
    // 正常：openid 由 code 派生，保证同一 code → 同一 openid（幂等测试需要）
    const openid = `oMock_${jsCode.replace(/[^A-Za-z0-9]/g, '')}_abcdefghijklmn`
    return json(200, { openid, session_key: 'sk-mock-should-never-leak', unionid: 'uMock' })
  }
  return { fetchImpl, calls }
}

// ── 测试配置 ─────────────────────────────────────────────────────────
const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef'
const WX_APPID = 'wxb7c7122de9c3ab1f' // mini/project.config.json 的真实 appid 形态
const WX_SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' // 32 位 hex，模拟 AppSecret
// 0046 · session_key 加密密钥（64 位 hex = 32 字节，生产由 openssl rand -hex 32 生成）
const SESSION_ENC_KEY = 'f'.repeat(63) + 'e' // 刻意用非平凡值，防「全 0 密钥」类巧合通过
const MOCK_SESSION_KEY = 'sk-mock-should-never-leak'
const cfg = {
  prod: false,
  host: '127.0.0.1',
  port: 0,
  jwtSecret: JWT_SECRET,
  accessTtlSec: 3600,
  refreshTtlSec: 7200,
  publishableKey: 'wbpk_test_key',
  smsProvider: 'log',
  smsMasterCode: '888888',
  smsSignName: '自律蜜蜂',
  emailProvider: 'log',
  emailSmtpHost: '', emailSmtpPort: 587, emailSmtpSecure: false,
  emailSmtpUser: '', emailSmtpPass: '', emailSmtpFrom: '', emailSmtpFromName: '自律蜜蜂',
  otpTtlSec: 300, otpMaxAttempts: 3, otpResendSec: 60, otpIpHourLimit: 100,
  identPepper: PEPPER,
  bodyLimitBytes: 1024 * 1024,
  rateLimitPerMin: 100000,
  // A3 微信凭据槽位
  wechatMiniSecrets: new Map([[WX_APPID, WX_SECRET]]),
  wechatApiBase: 'https://api.weixin.qq.com',
  wechatTimeoutMs: 5000,
  // 0046：配了加密密钥 → loginWechat 会真正执行 saveSessionKey 加密落库（否则静默跳过，
  // 新代码一行都跑不到 = 假绿）。自测据此断言密文可解密回原值。
  wechatSessionEncKey: SESSION_ENC_KEY,
  trustedProxyIps: new Set(),
  llmApiKey: '', llmBaseUrl: 'http://127.0.0.1:1/v1',
  llmModelText: 'x', llmModelVision: 'x', llmTimeoutMs: 5000,
  llmDailyCapPerUser: 100, llmTextDailyCapPerUser: 50,
  corsAllowedOrigins: new Set(),
  postgrestUrl: 'http://127.0.0.1:1', postgrestJwtSecret: JWT_SECRET, postgrestSchema: 'public',
  dbStatementTimeoutMs: 5000, dbPoolMax: 2,
}

// 捕获日志，用于断言「AppSecret / session_key 绝不进日志」
const logs = []
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
}

const mockPool = createMockPool()
const wechat = createWechatMock()
const { server, otp } = createApp({
  cfg, pool: mockPool, gatewayPool: mockPool, logger,
  enableDbProxy: false, enableLlm: false, enableIap: false,
  wechatFetchImpl: wechat.fetchImpl,
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const A = `${BASE}/.cloud/auth/v1`
const HDR = { 'content-type': 'application/json', 'x-wb-webapp-access-key': cfg.publishableKey }
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { ...HDR, ...headers }, body: JSON.stringify(body) })
const get = (url, headers = {}) => fetch(url, { headers: { ...HDR, ...headers } })
const LW = `${A}/login-wechat`

// ══════════════════════════════════════════════════════════════════════
// Part 1 · 裸 HTTP：报文形态与错误分类
// ══════════════════════════════════════════════════════════════════════
section('login-wechat · access-key 与参数校验')
{
  const r0 = await post(LW, { code: 'c1', appid: WX_APPID }, { 'x-wb-webapp-access-key': 'wbpk_wrong' })
  assert('错误 access-key → 401', r0.status === 401, `实际 ${r0.status}`)

  const r1 = await post(LW, { appid: WX_APPID })
  assert('缺 code → 400', r1.status === 400, `实际 ${r1.status}`)

  const r2 = await post(LW, { code: 'c1' })
  assert('缺 appid → 400', r2.status === 400, `实际 ${r2.status}`)

  const r3 = await post(LW, { code: 'c1', appid: 'not-an-appid' })
  assert('畸形 appid → 400', r3.status === 400, `实际 ${r3.status}`)
  assert('畸形 appid 不触发外呼', !wechat.calls.some((u) => u.includes('not-an-appid')))
}

section('login-wechat · 成功登录（新用户建号）')
let firstSession
{
  const r = await post(LW, { code: 'CODE_alice_001', appid: WX_APPID })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  firstSession = j
  // sessionPayload 同构断言（SDK parseSession 要求的字段）
  assert('有 access_token（非空 string）', typeof j.access_token === 'string' && j.access_token.length > 0)
  assert('有 refresh_token（非空 string）', typeof j.refresh_token === 'string' && j.refresh_token.length > 0)
  assert('expires_in = number', typeof j.expires_in === 'number')
  assert('token_type = bearer', j.token_type === 'bearer')
  assert('role = authenticated', j.role === 'authenticated')
  assert('is_anonymous = false', j.is_anonymous === false)
  assert('sub 形如 wx:<openid>', typeof j.sub === 'string' && j.sub.startsWith('wx:oMock_'), j.sub)
  // JWT 可被网关验签、含 sub/role/ver
  const v = verifyJwt(j.access_token, JWT_SECRET)
  assert('access_token 可验签', !!v)
  assert('JWT.sub === 响应 sub', v?.payload?.sub === j.sub)
  assert('JWT.role = authenticated', v?.payload?.role === 'authenticated')
  assert('JWT.ver 为整数（token_version）', Number.isInteger(v?.payload?.ver), String(v?.payload?.ver))
  // 库里落的是 wechat 身份 + 确定性 owner_id
  const row = mockPool.rows.get(j.sub)
  assert('app_users 落库：owner_id = wx:<openid>', !!row && row.owner_id === j.sub)
  assert('ident_kind = wechat', row?.ident_kind === 'wechat', row?.ident_kind)
  assert('ident_masked 含 * 且以 wx**** 开头', String(row?.ident_masked).includes('*') && String(row?.ident_masked).startsWith('wx****'), row?.ident_masked)
  assert('ident_hash = HMAC(wechat:openid, PEPPER)',
    row?.ident_hash === identHash('wechat', j.sub.replace(/^wx:/, ''), PEPPER))
  // 外呼确实发生，且带了 secret（证明走的是真 jscode2session 形态）
  const call = wechat.calls.find((u) => u.includes('CODE_alice_001'))
  assert('触发 jscode2session 外呼', !!call)
  assert('外呼 URL 含 appid + secret + grant_type',
    call?.includes(`appid=${WX_APPID}`) && call?.includes(`secret=${WX_SECRET}`) && call?.includes('grant_type=authorization_code'))
}

section('login-wechat · 幂等（同 code 再登 = 老用户，不重复建号）')
{
  const before = mockPool.rows.size
  const r = await post(LW, { code: 'CODE_alice_001', appid: WX_APPID })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  assert('同一 openid → 同一 owner_id', j.sub === firstSession.sub, `${j.sub} vs ${firstSession.sub}`)
  assert('未新增用户行', mockPool.rows.size === before, `${before} → ${mockPool.rows.size}`)
  const row = mockPool.rows.get(j.sub)
  assert('login_count 递增（touchLogin 生效）', row.login_count >= 2, String(row.login_count))
}

section('login-wechat · 凭据未配置（未知 appid）→ 503 且不外呼')
{
  const unknownAppid = 'wxaaaaaaaaaaaaaaaa'
  const r = await post(LW, { code: 'CODE_x', appid: unknownAppid })
  assert('未知 appid → 503', r.status === 503, `实际 ${r.status}`)
  const j = await r.json()
  assert('错误码 wechat_not_configured', j.error === 'wechat_not_configured', j.error)
  assert('文案不暴露 secret/配置细节', !/secret|appid|配置/i.test(j.message), j.message)
  assert('未对未知 appid 外呼', !wechat.calls.some((u) => u.includes(unknownAppid)))
}

section('login-wechat · 微信侧错误码分类')
{
  const cases = [
    ['err40029', 401, 'invalid_grant', 'invalid code → 401（让前端重新 wx.login）'],
    ['err40163', 401, 'invalid_grant', 'code been used → 401'],
    ['err41008', 401, 'invalid_grant', 'missing code → 401'],
    ['err45011', 503, 'wechat_rate_limited', 'api freq limit → 503'],
    ['err-1', 503, 'wechat_rate_limited', 'system error(-1) → 503'],
    ['err40125', 503, 'wechat_not_configured', 'invalid appsecret → 503（不暴露原因）'],
    ['err40013', 503, 'wechat_not_configured', 'invalid appid(微信侧) → 503'],
    ['err99999', 502, 'wechat_exchange_failed', '未知错误码 → 502 兜底'],
  ]
  for (const [code, status, errCode, label] of cases) {
    const r = await post(LW, { code, appid: WX_APPID })
    const j = await r.json().catch(() => ({}))
    assert(label, r.status === status && j.error === errCode, `实际 ${r.status}/${j.error}`)
  }
}

section('login-wechat · 上游异常（网络/非JSON/畸形openid）')
{
  const r1 = await post(LW, { code: 'neterr_001', appid: WX_APPID })
  assert('网络不可达 → 502', r1.status === 502, `实际 ${r1.status}`)

  const r2 = await post(LW, { code: 'badjson_001', appid: WX_APPID })
  assert('非 JSON 响应 → 502', r2.status === 502, `实际 ${r2.status}`)

  const r3 = await post(LW, { code: 'malformed_001', appid: WX_APPID })
  assert('畸形 openid → 502', r3.status === 502, `实际 ${r3.status}`)
  assert('畸形 openid 未入库', ![...mockPool.rows.keys()].some((k) => k.includes('bad') || k.includes(' ')))
}

section('安全 · AppSecret 与 session_key 绝不外泄')
{
  const allLogs = logs.map(([, m]) => m).join('\n')
  assert('日志不含 AppSecret', !allLogs.includes(WX_SECRET))
  assert('日志不含 session_key 值', !allLogs.includes('sk-mock-should-never-leak'))
  // 响应体里也不应出现 secret / session_key
  const r = await post(LW, { code: 'CODE_leak_check', appid: WX_APPID })
  const text = await r.text()
  assert('响应体不含 AppSecret', !text.includes(WX_SECRET))
  assert('响应体不含 session_key', !text.includes('sk-mock-should-never-leak') && !text.includes('session_key'))
}

section('0046 · session_key AES-256-GCM 加密落库（虚拟支付签名前置）')
{
  // 用全新 code 触发一次登录，确认 saveSessionKey 真正写入了密文
  const r = await post(LW, { code: 'CODE_xpay_sk_001', appid: WX_APPID })
  const j = await r.json()
  assert('登录 200', r.status === 200, `实际 ${r.status}`)
  const row = mockPool.rows.get(j.sub)
  const enc = row?.wechat_session_key_enc
  assert('app_users.wechat_session_key_enc 已写入', typeof enc === 'string' && enc.length > 0)
  assert('密文带 v1: 前缀', typeof enc === 'string' && enc.startsWith('v1:'), String(enc).slice(0, 6))
  assert('落库的是密文而非明文', typeof enc === 'string' && !enc.includes(MOCK_SESSION_KEY))
  // 用同一密钥能解密回原 session_key —— 证明「服务端下单时可现算 signature」
  assert('密文可解密回原 session_key', decryptSessionKey(enc, SESSION_ENC_KEY) === MOCK_SESSION_KEY,
    decryptSessionKey(enc, SESSION_ENC_KEY) || '<null>')
  // appid 与 session_key 绑定（试用/正式两套小程序不可跨用）
  assert('wechat_appid 同步落库', row?.wechat_appid === WX_APPID, String(row?.wechat_appid))
  assert('wechat_session_key_at 已记录', !!row?.wechat_session_key_at)
  // 错误密钥解不出（换密钥 = 存量密文作废，前端提示重新登录）
  assert('错误密钥 → 解密返回 null', decryptSessionKey(enc, 'a'.repeat(64)) === null)
  // 篡改密文（GCM tag 认证）→ 解密返回 null 而非垃圾
  //   🔴 必须篡改 ct 段的**首字符**：base64 每 4 字符解 3 字节，首字符的 6 位全部
  //      进入第一个字节；若改末字符，其低位可能是 base64 填充位，解码字节不变 →
  //      密文实际没被改 → GCM 反而校验通过（这是测试写法的坑，不是代码 bug）。
  if (typeof enc === 'string' && enc.startsWith('v1:')) {
    const parts = enc.split(':')
    const ct = parts[3]
    const flip = (c) => (c === 'A' ? 'B' : 'A') // 首字符必为 [A-Za-z0-9+/]，翻转必改变解码字节
    const tampered = [parts[0], parts[1], parts[2], flip(ct[0]) + ct.slice(1)].join(':')
    assert('密文被篡改 → 解密返回 null（GCM 认证）', decryptSessionKey(tampered, SESSION_ENC_KEY) === null)
  }
}

section('login-wechat · /user/me 读回微信用户 + token refresh')
{
  const r = await post(LW, { code: 'CODE_bob_002', appid: WX_APPID })
  const j = await r.json()
  const me = await get(`${A}/user/me`, { authorization: `Bearer ${j.access_token}` })
  assert('/user/me → 200', me.status === 200, `实际 ${me.status}`)
  const mej = await me.json()
  assert('/user/me sub = wx:<openid>', mej.sub === j.sub, `${mej.sub}`)
  assert('/user/me is_anonymous = false', mej.is_anonymous === false)

  // refresh
  const rf = await post(`${A}/token`, { grant_type: 'refresh_token', refresh_token: j.refresh_token })
  assert('refresh → 200', rf.status === 200, `实际 ${rf.status}`)
  const rfj = await rf.json()
  assert('refresh 后 sub 不变', rfj.sub === j.sub, `${rfj.sub}`)
  assert('refresh 签发新 access_token', typeof rfj.access_token === 'string' && rfj.access_token !== j.access_token)
}

// ══════════════════════════════════════════════════════════════════════
// Part 2 · 真实 SDK 客户端（最强验证：SDK 亲自 parseSession）
// ══════════════════════════════════════════════════════════════════════
section('真实 SDK · signInWithWechat → session.user.id = wx:<openid>')
{
  const sdk = createWorkBuddyCloud({
    endpoint: BASE,
    publishableKey: cfg.publishableKey,
    storage: createMemoryStorage(),
  })
  const { data, error } = await sdk.auth.signInWithWechat('CODE_sdk_carol_003', WX_APPID)
  assert('SDK 无 error', !error, error ? `${error.kind}: ${error.message}` : '')
  assert('SDK 返回 session', !!data)
  assert('session.user.id 形如 wx:<openid>', typeof data?.user?.id === 'string' && data.user.id.startsWith('wx:oMock_'), data?.user?.id)
  assert('session.user.isAnonymous = false', data?.user?.isAnonymous === false)
  assert('session.accessToken 非空', typeof data?.accessToken === 'string' && data.accessToken.length > 0)

  // 复刻 mini/src/lib/auth.ts cacheSession 的提取逻辑，验证 mini 端零改动可用
  const uid = data.user.id
  const openid = uid.replace(/^wx:/, '')
  assert('mini cacheSession: openid 提取正确', openid.startsWith('oMock_') && !openid.includes('wx:'), openid)

  // SDK 侧应能读回当前会话
  const sess = await sdk.auth.getSession()
  assert('SDK getSession 拿到已登录会话', !!sess?.data?.user || !!sess?.user, JSON.stringify(sess).slice(0, 80))
}

section('真实 SDK · 微信侧错误 → error 归一（不抛异常）')
{
  const sdk = createWorkBuddyCloud({
    endpoint: BASE,
    publishableKey: cfg.publishableKey,
    storage: createMemoryStorage(),
  })
  const { data, error } = await sdk.auth.signInWithWechat('err40029', WX_APPID)
  assert('invalid code → SDK 返回 error（非 session）', !!error && !data)
  assert('error.kind = unauthenticated（401 归类）', error?.kind === 'unauthenticated', error?.kind)

  const r2 = await sdk.auth.signInWithWechat('neterr_002', WX_APPID)
  assert('上游不可达 → SDK error.kind = backend-unavailable', r2.error?.kind === 'backend-unavailable', r2.error?.kind)
}

section('真实 SDK · 缺 code/appid 被 SDK 前置拦下（不外呼）')
{
  const sdk = createWorkBuddyCloud({
    endpoint: BASE,
    publishableKey: cfg.publishableKey,
    storage: createMemoryStorage(),
  })
  const before = wechat.calls.length
  const r1 = await sdk.auth.signInWithWechat('', WX_APPID)
  assert('空 code → SDK 本地拒绝（invalid-request）', r1.error?.kind === 'invalid-request', r1.error?.kind)
  const r2 = await sdk.auth.signInWithWechat('c', '')
  assert('空 appid → SDK 本地拒绝（invalid-request）', r2.error?.kind === 'invalid-request', r2.error?.kind)
  assert('SDK 前置校验未产生外呼', wechat.calls.length === before)
}

// ── 收尾 ──────────────────────────────────────────────────────────────
server.close()
otp.close()
await mockPool.end?.()

console.log(`\n${'═'.repeat(58)}`)
console.log(`  通过 ${passed} · 失败 ${failed}`)
console.log('═'.repeat(58))
if (failed > 0) {
  console.error(`\n❌ ${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n✅ 微信登录链路 A1~A3 自测全过（裸 HTTP + 真实 SDK 双验证）')
process.exit(0)
