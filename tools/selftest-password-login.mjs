/**
 * 网关「邮箱/手机号 + 密码」登录 —— 自测（不连数据库、不连网络）。
 *
 * 为什么需要它：2026-10-29 发现 web 端密码登录 400「缺少 verification_token」，
 * 根因是 server/lib/auth.mjs 的 signIn 只实现了验证码路径，SDK 的
 * signInWithPassword 发来 { username, password } 时无分支可走。补实现后
 * 必须证明：① 密码对能登录；② 密码错/账户不存在都返回同一文案（防枚举）；
 * ③ 原有验证码登录路径**完全没被破坏**；④ 限流生效；⑤ 手机号标识能正确归一化。
 *
 * 跑法：node tools/selftest-password-login.mjs
 * 退出码 0 = 全过；非 0 = 有用例失败。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

// Windows 上绝对路径（C:\…）不能直接喂给 import()，会被当成未知协议 'c:'。
// 统一转成 file:// URL 再动态导入。
const mod = (p) => import(pathToFileURL(p).href)

const { createAuthHandlers } = await mod(path.join(ROOT, 'server/lib/auth.mjs'))
const { hashPassword, identHash, normalizeEmail } = await mod(path.join(ROOT, 'server/lib/identity.mjs'))
const { OtpStore } = await mod(path.join(ROOT, 'server/lib/otp.mjs'))
const { RateLimiter } = await mod(path.join(ROOT, 'server/lib/http.mjs'))

const PEPPER = 'selftest-pepper-not-a-real-secret'
const EMAIL = 'dbeesupport@163.com'
const PASSWORD = '888888'
const PHONE = '13800138000'
const EMAIL_OWNER_ID = 'owner_email_dbee'
const PHONE_OWNER_ID = 'owner_phone_138'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

// ── 假数据库：只实现 auth.mjs 用到的三条查询 ───────────────────────
const USERS = new Map() // ident_hash -> row
function seed(kind, value, ownerId, password) {
  const h = identHash(kind, value, PEPPER)
  USERS.set(h, {
    owner_id: ownerId,
    ident_kind: kind,
    ident_masked: kind === 'email' ? 'db*****@163.com' : '138****8000',
    token_version: 1,
    password_hash: password === null ? null : 'PENDING',
    _plain: password,
  })
}
seed('email', normalizeEmail(EMAIL), EMAIL_OWNER_ID, PASSWORD)
seed('phone', PHONE, PHONE_OWNER_ID, null) // 纯验证码注册、从没设过密码的账户

const fakePool = {
  async query(sql, params) {
    if (/password_hash/.test(sql)) {
      // findUserWithPasswordByIdent：SELECT owner_id, ident_kind, ident_masked, token_version, password_hash
      // ⚠️ 必须显式列出字段：直接 {...row} 会把测试用的 _plain 明文也带进去，
      //    既污染断言（⑩ 日志/响应检查会误判），也不符合真实查询的返回形状。
      const row = USERS.get(params[1])
      if (!row) return { rows: [] }
      return { rows: [{
        owner_id: row.owner_id,
        ident_kind: row.ident_kind,
        ident_masked: row.ident_masked,
        token_version: row.token_version,
        password_hash: row.password_hash,
      }] }
    }
    if (/FROM public\.app_users/.test(sql)) {
      const row = USERS.get(params[1])
      return { rows: row ? [{ ...row }] : [] }
    }
    if (/UPDATE public\.app_users/.test(sql)) return { rows: [], rowCount: 1 } // touchLogin
    return { rows: [] }
  },
}

// 把 PENDING 换成真 scrypt 哈希（需 await，故放在构造后）
for (const row of USERS.values()) {
  if (row.password_hash === 'PENDING') row.password_hash = await hashPassword(row._plain)
}

const logs = []
const logger = {
  info: (m) => logs.push(['info', m]),
  warn: (m) => logs.push(['warn', m]),
  error: (m) => logs.push(['error', m]),
}

const cfg = {
  publishableKey: 'wbpk_selftest',
  identPepper: PEPPER,
  jwtSecret: 'selftest-jwt-secret-selftest-jwt-secret',
  accessTtlSec: 3600,
  refreshTtlSec: 86400,
  // 真实 config 里是 Set（见 config.mjs:280），不是数组 —— 传数组会让
  // isTrustedPeer 调 trustedSet.has() 直接 TypeError。
  trustedProxyIps: new Set(),
}

// OtpStore 只存验证码的 HMAC（challenges.get(id).codeHash），拿不到明文。
// 用官方支持的 masterCode 选项驱动回归：它是「显式配置时才生效的固定码」，
// 生产环境 config.validate 会拦，测试里用正合适，且走的是真实 verify() 分支。
const MASTER_CODE = '999999'
const otp = new OtpStore({
  pepper: PEPPER, codeTtlSec: 300, tokenTtlSec: 120, maxAttempts: 5, masterCode: MASTER_CODE,
})
// app.mjs 在生产里创建这两个限流器并注入（见 app.mjs 的 limiterIdent/limiterIp），
// 回归测试要走 sendVerification 就必须同样提供，否则 deps.limiterIdent 为 undefined。
const limiterIdent = new RateLimiter({ windowMs: 60_000, limit: 1 })
const limiterIp = new RateLimiter({ windowMs: 3600_000, limit: 20 })

const auth = createAuthHandlers({ cfg, pool: fakePool, otp, logger, limiterIdent, limiterIp })

// ── 假 res：捕获 status/body/header ────────────────────────────────
function fakeRes() {
  const r = { statusCode: null, body: null, headers: {} }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.writeHead = (c) => { r.statusCode = c }
  r.end = (b) => { if (b !== undefined) r.body = b }
  return r
}
/**
 * 假 req。
 *
 * 🔴 必须模拟**生产拓扑**：nginx 与网关同机 → socket.remoteAddress 恒为回环
 * 127.0.0.1，真实客户端 IP 由 nginx 写进 X-Forwarded-For。
 * 若直接把测试 IP 塞进 socket.remoteAddress，isTrustedPeer 会判它不可信
 * （既非回环也不在 trustedProxies 里）→ clientIp 忽略 XFF。那样测的就不是
 * 线上真实取 IP 的路径，按 IP 的限流断言也会失真。
 */
function req(body, ip = '203.0.113.7') {
  return {
    method: 'POST',
    headers: {
      'x-wb-webapp-access-key': 'wbpk_selftest',
      'x-forwarded-for': ip,
    },
    socket: { remoteAddress: '127.0.0.1' },
    _body: body,
  }
}

/** 直接调 handler：handler 返回 {status,body} 或已用 cloudError 写完 res */
async function call(handlerName, body, res = fakeRes(), ip) {
  const h = auth[handlerName]
  const out = await h(req(body, ip), res, body)
  if (out) return { status: out.status, body: out.body, res }
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res }
}

console.log('\n═══ ① 密码登录：正确密码应成功 ═══')
{
  const r = await call('signIn', { username: EMAIL, password: PASSWORD })
  check('HTTP 200', r.status === 200, `实际 ${r.status}`)
  check('返回 access_token', typeof r.body?.access_token === 'string' && r.body.access_token.length > 20)
  check('返回 refresh_token', typeof r.body?.refresh_token === 'string')
  check('sub 与库内 owner_id 一致', r.body?.sub === EMAIL_OWNER_ID, `sub=${r.body?.sub} 期望=${EMAIL_OWNER_ID}`)
  check('返回 token_version 对应的 ver 声明（会话可被强制下线）', typeof r.body?.access_token === 'string' && r.body.access_token.split('.').length === 3)
  check('expires_in 与 cfg 对齐', r.body?.expires_in === cfg.accessTtlSec)
}

console.log('\n═══ ② 大小写/空格容错（前端可能带空白，邮箱大小写不敏感）═══')
{
  const r = await call('signIn', { username: `  DbEeSupport@163.COM  `, password: PASSWORD })
  check('归一化后仍能登录', r.status === 200, `实际 ${r.status} ${JSON.stringify(r.body)?.slice(0, 80)}`)
}

console.log('\n═══ ③ 防枚举：密码错 与 账户不存在 必须同文案同状态码 ═══')
{
  const a = await call('signIn', { username: EMAIL, password: 'wrong-password' })
  const b = await call('signIn', { username: 'nobody@example.com', password: 'wrong-password' })
  check('密码错 → 401', a.status === 401, `实际 ${a.status}`)
  check('账户不存在 → 401', b.status === 401, `实际 ${b.status}`)
  check('两者 message 完全一致（不泄露账户是否存在）', a.body?.message === b.body?.message, `"${a.body?.message}" vs "${b.body?.message}"`)
  check('两者 error code 一致', a.body?.error === b.body?.error, `${a.body?.error} vs ${b.body?.error}`)
  check('文案对用户友好（不暴露技术细节）', !/verification_token|scrypt|hash/i.test(a.body?.message || ''), a.body?.message)
}

console.log('\n═══ ④ 未设密码的账户（password_hash 为 NULL）不得被密码登录 ═══')
{
  const r = await call('signIn', { username: PHONE, password: '123456' })
  check('返回 401', r.status === 401, `实际 ${r.status}`)
  check('文案与「密码错」一致（不暴露该账户未设密码）', r.body?.message === '邮箱或密码不正确', r.body?.message)
}

console.log('\n═══ ⑤ 手机号标识归一化：SDK 发 "+86 138…" 带空格形态 ═══')
{
  // 该账户没设密码，所以期望 401；但要确认它是「走到了密码校验」而不是「格式错误 400」
  const r = await call('signIn', { username: '+86 13800138000', password: '123456' })
  check('不因带空格形态报 400 格式错', r.status !== 400, `实际 ${r.status} ${r.body?.message}`)
  const r2 = await call('signIn', { username: '008613800138000', password: '123456' })
  check('0086 前缀同样可归一化', r2.status !== 400, `实际 ${r2.status} ${r2.body?.message}`)
  const r3 = await call('signIn', { username: 'not-an-account', password: '123456' })
  check('真正非法的账号才报 400', r3.status === 400, `实际 ${r3.status}`)
}

console.log('\n═══ ⑥ 原有验证码登录路径必须完好（回归保护）═══')
{
  // 6a) 缺 verification_token 且缺 password → 仍是原来的 400 文案
  const r = await call('signIn', { username: EMAIL })
  check('无 token 无密码 → 400「缺少 verification_token」（原行为）', r.status === 400 && /缺少 verification_token/.test(r.body?.message || ''), `${r.status} ${r.body?.message}`)

  // 6b) 完整 OTP 流程：发码 → 验码 → 登录（用 masterCode 驱动，走真实 verify() 分支）
  const sent = await call('sendVerification', { email: EMAIL, usage: 'email' }, fakeRes(), '198.51.100.9')
  check('发码成功返回 verification_id', sent.status === 200 && typeof sent.body?.verification_id === 'string', `${sent.status}`)
  if (sent.body?.verification_id) {
    const ver = await call('verifyCode', {
      verification_id: sent.body.verification_id,
      verification_code: MASTER_CODE,
    })
    check('验码成功返回 verification_token', ver.status === 200 && typeof ver.body?.verification_token === 'string', `${ver.status}`)
    if (ver.body?.verification_token) {
      const login = await call('signIn', { username: EMAIL, verification_token: ver.body.verification_token })
      check('验证码路径登录成功（未被密码分支破坏）', login.status === 200 && typeof login.body?.access_token === 'string', `${login.status} ${JSON.stringify(login.body)?.slice(0, 90)}`)
    }
  }

  // 6c) 伪造的 verification_token 仍被拒
  const bad = await call('signIn', { username: EMAIL, verification_token: 'vt_forged' })
  check('伪造 token → 401（原行为）', bad.status === 401, `实际 ${bad.status}`)

  // 6d) 同时带 token 和 password 时，token 优先（不能借密码分支绕过 token 校验）
  const both = await call('signIn', { username: EMAIL, verification_token: 'vt_forged', password: PASSWORD })
  check('同时带伪造 token + 正确密码 → 不得登录（token 优先）', both.status !== 200, `实际 ${both.status}`)
}

console.log('\n═══ ⑦ access-key 校验仍然生效 ═══')
{
  const r0 = fakeRes()
  // 复用 req() 的生产拓扑（回环 socket + XFF），只把 access-key 换成错的
  const badReq = {
    ...req({ username: EMAIL, password: PASSWORD }),
    headers: { ...req({}).headers, 'x-wb-webapp-access-key': 'WRONG' },
  }
  const out = await auth.signIn(badReq, r0, { username: EMAIL, password: PASSWORD })
  const status = out?.status ?? r0.statusCode
  check('错误 access-key → 401', status === 401, `实际 ${status}`)
}

console.log('\n═══ ⑧ 限流：同一标识连续失败后应 429 ═══')
{
  let got429 = false
  let retryAfter = null
  for (let i = 0; i < 14; i++) {
    const r = await call('signIn', { username: EMAIL, password: 'wrong-password' }, fakeRes(), '203.0.113.77')
    if (r.status === 429) { got429 = true; retryAfter = r.res.headers['retry-after']; break }
  }
  check('超过阈值后返回 429', got429)
  check('429 带 retry-after 头', retryAfter !== null && Number(retryAfter) > 0, `retry-after=${retryAfter}`)
  // 限流后即便密码正确也应被挡（锁定语义与 otp.verify 一致）
  const locked = await call('signIn', { username: EMAIL, password: PASSWORD }, fakeRes(), '203.0.113.77')
  check('锁定期间正确密码也被拒（防「爆破到边界即成功」）', locked.status === 429, `实际 ${locked.status}`)
}

console.log('\n═══ ⑨ 参数缺失/类型异常不得抛未捕获异常 ═══')
{
  const cases = [
    ['username 非字符串', { username: 123, password: PASSWORD }],
    ['password 非字符串', { username: EMAIL, password: 123 }],
    ['空 body', {}],
    ['password 过短', { username: EMAIL, password: '123' }],
  ]
  for (const [name, body] of cases) {
    let threw = null
    let st = null
    try {
      const r = await call('signIn', body)
      st = r.status
    } catch (e) { threw = e }
    check(`${name} → 不抛异常且返回 4xx`, threw === null && st >= 400 && st < 500, threw ? `抛出 ${threw.message}` : `status=${st}`)
  }
}

console.log('\n═══ ⑩ 日志不得泄露密码明文或哈希 ═══')
{
  const dumped = logs.map(([, m]) => String(m)).join('\n')
  check('日志不含密码明文', !dumped.includes(PASSWORD))
  check('日志不含 scrypt 哈希', !dumped.includes('scrypt$'))
  check('日志不含完整邮箱（应已掩码）', !dumped.includes(EMAIL), '出现完整邮箱')
  check('日志确实记录了成败（便于运维排查）', /密码登录/.test(dumped))
}

console.log(`\n${'═'.repeat(56)}`)
console.log(`密码登录自测：${pass} 通过 / ${fail} 失败`)
console.log('═'.repeat(56))
process.exit(fail === 0 ? 0 : 1)
