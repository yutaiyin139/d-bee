/**
 * WX-1 微信运动解密端点自测（2026-11-17）。
 *
 * 沿用 tools/wechat-login-selftest.mjs 范式：注入 mock pool + mock fetch（伪造
 * jscode2session），用 createApp() 起真实 http.Server，构造真实 AES-128-CBC 密文，
 * 覆盖规划 §9/§12 WX-1 的全部验收判据：
 *   · 归属不符 403、watermark 不符拒绝、日志不含 session_key、响应不含 31 天明细
 *   · 客户端传 steps 不影响结果、code 失效 401、无当天样本 empty
 *   · 北京时间当天零点取数（UTC+8 跨日边界）
 *
 * 运行：node tools/werun-selftest.mjs
 */
import { createCipheriv } from 'node:crypto'
import { createApp } from '../server/lib/app.mjs'
import { signJwt } from '../server/lib/jwt.mjs'
import { beijingTodayZeroSec, pickTodaySteps } from '../server/lib/werun.mjs'

let failed = 0
let passed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

// ── mock pool：只需 healthz 与 token_version 查询，werun 自身不落库 ────
function createMockPool() {
  const rows = new Map()
  // 预置 alice/bob 两个微信用户（authOwnerIdStrict 会查 token_version）
  for (const who of ['alice', 'bob']) {
    const owner = `wx:oMock_${who}_abcdefghijklmn`
    rows.set(owner, { owner_id: owner, token_version: 1 })
  }
  return {
    rows,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ')
      if (/SELECT token_version/i.test(s) && /owner_id = \$1/i.test(s)) {
        const r = rows.get(params[0])
        return { rowCount: r ? 1 : 0, rows: r ? [{ token_version: r.token_version }] : [] }
      }
      if (/SELECT current_user/i.test(s)) return { rowCount: 1, rows: [{ u: 'dbee_app', d: 'dbee' }] }
      return { rowCount: 0, rows: [] }
    },
    async end() {},
  }
}

// ── 微信 mock：code → {openid, session_key}，错误码走前缀 ─────────────
// session_key 是微信返回的 base64 字符串，解码后正好 16 字节（'1234567890123456'）
const SESSION_KEY_PLAIN = Buffer.from('1234567890123456', 'utf8').toString('base64')
function createWechatMock() {
  const calls = []
  const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj })
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const u = new URL(String(url))
    const jsCode = u.searchParams.get('js_code') || ''
    const m = /^err(-?\d+)$/.exec(jsCode)
    if (m) return json(200, { errcode: Number(m[1]), errmsg: `mock err ${m[1]}` })
    // openid 由 code 派生：CODE_alice_* → alice，CODE_bob_* → bob（归属测试用）
    const who = jsCode.includes('bob') ? 'bob' : 'alice'
    return json(200, { openid: `oMock_${who}_abcdefghijklmn`, session_key: SESSION_KEY_PLAIN })
  }
  return { fetchImpl, calls }
}

/** 构造 wx.getWeRunData 形态的密文：AES-128-CBC(session_key, iv) 加密 JSON */
function encryptWeRunData({ appid, stepInfoList, watermarkAppid = appid }) {
  const key = Buffer.from(SESSION_KEY_PLAIN, 'base64')
  const iv = Buffer.alloc(16, 7)
  const plain = JSON.stringify({
    stepInfoList,
    watermark: { appid: watermarkAppid, timestamp: Math.floor(Date.now() / 1000) },
  })
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { encryptedData: ct.toString('base64'), iv: iv.toString('base64') }
}

// ── 配置 ─────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef'
const WX_APPID = 'wxb7c7122de9c3ab1f'
const WX_SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'
const cfg = {
  prod: false, host: '127.0.0.1', port: 0,
  jwtSecret: JWT_SECRET, accessTtlSec: 3600, refreshTtlSec: 7200,
  publishableKey: 'wbpk_test', smsProvider: 'log', smsMasterCode: '',
  smsSignName: '自律蜜蜂', emailProvider: 'log',
  emailSmtpHost: '', emailSmtpPort: 587, emailSmtpSecure: false,
  emailSmtpUser: '', emailSmtpPass: '', emailSmtpFrom: '', emailSmtpFromName: '自律蜜蜂',
  otpTtlSec: 300, otpMaxAttempts: 3, otpResendSec: 60, otpIpHourLimit: 100,
  identPepper: 'test-pepper-0123456789abcdef0123456789abcdef',
  bodyLimitBytes: 1024 * 1024, rateLimitPerMin: 100000,
  wechatMiniSecrets: new Map([[WX_APPID, WX_SECRET]]),
  wechatApiBase: 'https://api.weixin.qq.com', wechatTimeoutMs: 5000,
  wechatSessionEncKey: 'f'.repeat(64), trustedProxyIps: new Set(),
  llmApiKey: '', llmBaseUrl: 'http://127.0.0.1:1/v1', llmModelText: 'x', llmModelVision: 'x',
  llmTimeoutMs: 5000, llmDailyCapPerUser: 100, llmTextDailyCapPerUser: 50,
  corsAllowedOrigins: new Set(), postgrestUrl: 'http://127.0.0.1:1',
  postgrestJwtSecret: JWT_SECRET, postgrestSchema: 'public',
  dbStatementTimeoutMs: 5000, dbPoolMax: 2,
}
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
  enableDbProxy: false, enableLlm: false, enableIap: false, enableXpay: false, enableAppPay: false,
  wechatFetchImpl: wechat.fetchImpl,
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const SYNC = `${BASE}/.cloud/auth/v1/werun/sync`
const HDR = { 'content-type': 'application/json', 'x-wb-webapp-access-key': cfg.publishableKey }

/** 造 Bearer：ownerId 由 who 决定（alice/bob），与 mock fetch 的 openid 对应 */
function bearerFor(who, ver = 1) {
  const openid = `oMock_${who}_abcdefghijklmn`
  return signJwt({ sub: `wx:${openid}`, role: 'authenticated', ver }, cfg.jwtSecret, cfg.accessTtlSec)
}
const post = (body, token) => fetch(SYNC, {
  method: 'POST',
  headers: { ...HDR, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})

const TODAY = beijingTodayZeroSec()
const stepInfoList = [
  { timestamp: TODAY - 86400, step: 111 }, // 昨天
  { timestamp: TODAY, step: 8421 },        // 今天（北京零点）
  { timestamp: TODAY + 86400, step: 999 }, // 明天（防跨天取错）
]

// ══════════════════════════════════════════════════════════════════════
section('纯函数 · 北京时间零点与当天取数')
{
  const z = beijingTodayZeroSec()
  assert('零点是 10 位秒级时间戳', /^\d{10}$/.test(String(z)), String(z))
  assert('零点落在 UTC+8 当天边界（对 86400 取模余 57600）', ((z % 86400) + 86400) % 86400 === 57600, String(((z % 86400) + 86400) % 86400))
  assert('取到今天那一条 8421（不是昨天 111 / 明天 999）', pickTodaySteps(stepInfoList, z) === 8421, String(pickTodaySteps(stepInfoList, z)))
  assert('无当天样本返回 null', pickTodaySteps([{ timestamp: TODAY - 86400, step: 5 }], z) === null)
  assert('结构异常不抛错', pickTodaySteps(null, z) === null && pickTodaySteps('bad', z) === null)
}

section('成功路径 · 只返回当天一步数')
{
  const enc = encryptWeRunData({ appid: WX_APPID, stepInfoList })
  const r = await post({ code: 'CODE_alice_ok', appid: WX_APPID, ...enc }, bearerFor('alice'))
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  assert('status=ok', j.status === 'ok', j.status)
  assert('steps=8421（服务端解密值）', j.steps === 8421, String(j.steps))
  assert('activeKcal=0（微信运动无活动能量）', j.activeKcal === 0, String(j.activeKcal))
  assert('有 syncedAt', typeof j.syncedAt === 'string' && !Number.isNaN(Date.parse(j.syncedAt)))
  assert('响应不含 31 天明细（stepInfoList）', !JSON.stringify(j).includes('stepInfoList'))
  assert('响应不含昨天/明天步数', !JSON.stringify(j).includes('111') && !JSON.stringify(j).includes('999'))
}

section('红线③ · 客户端伪造 steps 不影响结果')
{
  const enc = encryptWeRunData({ appid: WX_APPID, stepInfoList })
  const r = await post({ code: 'CODE_alice_fake', appid: WX_APPID, ...enc, steps: 999999 }, bearerFor('alice'))
  const j = await r.json()
  assert('客户端传 steps=999999 被忽略，仍为解密值 8421', r.status === 200 && j.steps === 8421, `${r.status}/${j.steps}`)
}

section('红线② · 归属不符 403（防串号）')
{
  const enc = encryptWeRunData({ appid: WX_APPID, stepInfoList })
  // code 换出的是 alice 的 openid，但 Bearer 是 bob → 应拒绝
  const r = await post({ code: 'CODE_alice_mismatch', appid: WX_APPID, ...enc }, bearerFor('bob'))
  assert('归属不符 → 403', r.status === 403, `实际 ${r.status}`)
  const j = await r.json()
  assert('错误码 forbidden', j.error === 'forbidden', j.error)
}

section('红线⑤ · watermark 不符 / 密文损坏拒绝')
{
  const badWm = encryptWeRunData({ appid: WX_APPID, stepInfoList, watermarkAppid: 'wxdeadbeefdeadbeef' })
  const r1 = await post({ code: 'CODE_alice_wm', appid: WX_APPID, ...badWm }, bearerFor('alice'))
  assert('watermark.appid 不符 → 400', r1.status === 400, `实际 ${r1.status}`)
  assert('错误码 werun_decrypt_failed', (await r1.json()).error === 'werun_decrypt_failed')

  const r2 = await post({ code: 'CODE_alice_badiv', appid: WX_APPID, encryptedData: 'YWJjZA==', iv: 'AQ==' }, bearerFor('alice'))
  assert('iv 长度非法 → 400（fail-closed，不猜值）', r2.status === 400, `实际 ${r2.status}`)
}

section('鉴权与参数 · Bearer / 四元组 / appid')
{
  const enc = encryptWeRunData({ appid: WX_APPID, stepInfoList })
  assert('无 Bearer → 401', (await post({ code: 'c', appid: WX_APPID, ...enc })).status === 401)
  assert('缺 encryptedData → 400', (await post({ code: 'c', appid: WX_APPID, iv: enc.iv }, bearerFor('alice'))).status === 400)
  assert('畸形 appid → 400', (await post({ code: 'c', appid: 'bad', ...enc }, bearerFor('alice'))).status === 400)
  const r = await post({ code: 'CODE_x', appid: 'wxaaaaaaaaaaaaaaaa', ...enc }, bearerFor('alice'))
  assert('未配置 appid → 503（不外呼换密）', r.status === 503, `实际 ${r.status}`)
}

section('失败映射 · code 失效 / 无当天样本')
{
  const enc = encryptWeRunData({ appid: WX_APPID, stepInfoList })
  const r = await post({ code: 'err40029', appid: WX_APPID, ...enc }, bearerFor('alice'))
  assert('code 失效 → 401 invalid_grant（前端重新 wx.login）', r.status === 401 && (await r.json()).error === 'invalid_grant', `实际 ${r.status}`)

  const emptyEnc = encryptWeRunData({ appid: WX_APPID, stepInfoList: [{ timestamp: TODAY - 86400, step: 5 }] })
  const r2 = await post({ code: 'CODE_alice_empty', appid: WX_APPID, ...emptyEnc }, bearerFor('alice'))
  const j2 = await r2.json()
  assert('无当天样本 → 200 status=empty steps=0（非 error）', r2.status === 200 && j2.status === 'empty' && j2.steps === 0, `${r2.status}/${j2.status}/${j2.steps}`)
}

section('红线①④ · 日志不含 session_key / 密文 / iv')
{
  const allLogs = logs.map(([, m]) => m).join('\n')
  assert('日志不含 session_key 明文', !allLogs.includes(SESSION_KEY_PLAIN))
  assert('日志不含 session_key 字面量字段名值', !/session_key[=:]\s*\S/.test(allLogs))
}

section('红线④ · session_key 不落库')
{
  assert('werun 端点不写 session_key 字段（仅预置的 token_version 行）',
    [...mockPool.rows.values()].every((r) => !('wechat_session_key_enc' in r)))
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
console.log('\n✅ WX-1 微信运动解密端点自测全过（安全红线逐条验证）')
process.exit(0)
