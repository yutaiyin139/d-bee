/**
 * 网关 A1 端到端自测（不需真数据库、不需网络）。
 *
 * 做法：注入一个 mock pool（内存实现 app_users 的查询子集），用 createApp() 起一个
 * **真实 http.Server**，然后用 fetch 走完整协议链：
 *   发码 → 验码 → signin/signup → /user/me → refresh → signout
 * 断言的是**线上 SDK 会真正看到的 HTTP 报文**，不是函数返回值。
 *
 * 运行：node tools/gateway-selftest.mjs
 */
import { createApp } from '../server/lib/app.mjs'
import { signJwt, verifyJwt } from '../server/lib/jwt.mjs'
import {
  normalizePhone, normalizeEmail, maskPhone, maskEmail,
  resolveIdent, identHash, newOwnerId, isOwnerId, safeEqualHex,
} from '../server/lib/identity.mjs'
import { OtpStore, genCode } from '../server/lib/otp.mjs'
import { RateLimiter, Router } from '../server/lib/http.mjs'

let failed = 0
let passed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

// ── mock pool：内存版 app_users ───────────────────────────────────────
// 只实现网关实际发出的 4 种 SQL（见 lib/identity.mjs），按参数化占位符分派。
function createMockPool() {
  const rows = new Map() // owner_id -> row
  const byIdent = new Map() // `${kind}:${hash}` -> owner_id
  const queries = []

  return {
    rows, byIdent, queries,
    async query(sql, params = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 60), params })
      const s = sql.replace(/\s+/g, ' ')

      if (/INSERT INTO public\.app_users/i.test(s)) {
        const [owner_id, ident_kind, ident_hash, ident_masked, password_hash, token_version] = params
        const key = `${ident_kind}:${ident_hash}`
        if (byIdent.has(key) || rows.has(owner_id)) return { rowCount: 0, rows: [] }
        const row = {
          owner_id, ident_kind, ident_hash, ident_masked, password_hash,
          created_at: new Date().toISOString(), last_login_at: null, login_count: 0,
          token_version: token_version ?? 1, // 0042：会话版本号
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
        const r = rows.get(params[0])
        return { rowCount: r ? 1 : 0, rows: r ? [r] : [] }
      }

      if (/UPDATE public\.app_users/i.test(s)) {
        const r = rows.get(params[0])
        if (/token_version = token_version \+ 1/i.test(s)) {
          // 0042：登出 bump token_version，RETURNING 新版本
          if (r) r.token_version = (r.token_version ?? 1) + 1
          return { rowCount: r ? 1 : 0, rows: r ? [{ token_version: r.token_version }] : [] }
        }
        if (r) { r.last_login_at = new Date().toISOString(); r.login_count += 1 }
        return { rowCount: r ? 1 : 0, rows: [] }
      }

      // healthz 探活查询（app.mjs 用它判断 db 连通性）
      if (/SELECT current_user/i.test(s)) {
        return { rowCount: 1, rows: [{ u: 'dbee_app', d: 'dbee' }] }
      }

      throw new Error(`mock pool 未实现的 SQL: ${s.slice(0, 80)}`)
    },
    async end() {},
  }
}

// ── 构造测试配置（不读 .env，全部显式注入）────────────────────────────
const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef'
const cfg = {
  prod: false,
  host: '127.0.0.1',
  port: 0, // 让 OS 分配空闲端口
  jwtSecret: JWT_SECRET,
  accessTtlSec: 3600,
  refreshTtlSec: 7200,
  publishableKey: 'wbpk_test_key',
  smsProvider: 'log',
  smsMasterCode: '888888',
  smsSignName: '自律蜜蜂',
  emailProvider: 'log', // email 发码通道（与 smsProvider 解耦，2026-10-27）
  emailSmtpHost: '',
  emailSmtpPort: 587,
  emailSmtpSecure: false,
  emailSmtpUser: '',
  emailSmtpPass: '',
  emailSmtpFrom: '',
  emailSmtpFromName: '自律蜜蜂',
  otpTtlSec: 300,
  otpMaxAttempts: 3,
  otpResendSec: 60,
  otpIpHourLimit: 100,
  identPepper: PEPPER,
  bodyLimitBytes: 1024 * 1024,
  rateLimitPerMin: 10000, // 自测里不想被全局限流挡住
  llmApiKey: 'sk-test',
  llmBaseUrl: 'http://127.0.0.1:1/v1', // 不可达；LLM 上游测试单独做
  llmModelText: 'deepseek-flash',
  llmModelVision: 'deepseek-flash',
  llmTimeoutMs: 5000,
  llmDailyCapPerUser: 100,
  llmTextDailyCapPerUser: 50,
  corsAllowedOrigins: new Set(), // 非生产默认空 → 回显任意 Origin（开发便利）
  postgrestUrl: 'http://127.0.0.1:1',
  postgrestJwtSecret: JWT_SECRET,
  postgrestSchema: 'public',
  dbStatementTimeoutMs: 5000,
  dbPoolMax: 2,
}

const logger = {
  info: () => {},
  warn: () => {},
  error: (...a) => console.error('    [gateway]', ...a),
}

// ══════════════════════════════════════════════════════════════════════
// Part 1 · 纯函数单测（不起服务，先确保基础件正确）
// ══════════════════════════════════════════════════════════════════════
section('identity · 手机号归一化（须与 SDK normalizePhone 语义一致）')
assert('裸号 13800000000 → 13800000000', normalizePhone('13800000000') === '13800000000')
assert('+86 138 0000 0000 → 13800000000', normalizePhone('+86 138 0000 0000') === '13800000000')
assert('+8613800000000 → 13800000000', normalizePhone('+8613800000000') === '13800000000')
assert('008613800000000 → 13800000000', normalizePhone('008613800000000') === '13800000000')
assert('138-0000-0000 → 13800000000', normalizePhone('138-0000-0000') === '13800000000')
assert('10 位 → null', normalizePhone('1380000000') === null)
assert('12 位非 86 前缀 → null', normalizePhone('23800000000') === null)
assert('非 1 开头 → null', normalizePhone('23800000000') === null)
assert('空串 → null', normalizePhone('') === null)
assert('非字符串 → null', normalizePhone(null) === null)
assert('港澳号 +852 原样透传后判非法 → null', normalizePhone('+85212345678') === null)

section('identity · 掩码（PII 不得泄露完整号）')
assert('手机掩码 138****0000', maskPhone('13800000000') === '138****0000', maskPhone('13800000000'))
assert('短号全掩', maskPhone('12345') === '***')
assert('邮箱掩码 ab***@x.com', maskEmail('abcdef@example.com').startsWith('ab') && maskEmail('abcdef@example.com').includes('@example.com'), maskEmail('abcdef@example.com'))
assert('邮箱掩码含星号', maskEmail('a@b.com').includes('*'), maskEmail('a@b.com'))
assert('非法邮箱 → ***', maskEmail('not-an-email') === '***')

section('identity · resolveIdent 二选一校验（网关不能信任客户端）')
assert('只给 phone → phone', resolveIdent({ phone: '13800000000' }).kind === 'phone')
assert('只给 email → email', resolveIdent({ email: 'A@B.com' }).value === 'a@b.com', '邮箱须转小写')
assert('两个都给 → error', !!resolveIdent({ phone: '13800000000', email: 'a@b.com' }).error)
assert('两个都不给 → error', !!resolveIdent({}).error)
assert('空串视为未给', resolveIdent({ phone: '', email: 'a@b.com' }).kind === 'email')
assert('非法手机号 → error', !!resolveIdent({ phone: '123' }).error)

section('identity · identHash（HMAC + PEPPER）')
const h1 = identHash('phone', '13800000000', PEPPER)
const h2 = identHash('phone', '13800000000', PEPPER)
const h3 = identHash('phone', '13800000001', PEPPER)
const h4 = identHash('email', '13800000000', PEPPER)
assert('同输入同哈希（可查库）', h1 === h2)
assert('不同号不同哈希', h1 !== h3)
assert('kind 参与签名（跨类型不碰撞）', h1 !== h4)
assert('哈希是 64 位 hex', /^[0-9a-f]{64}$/.test(h1))
assert('不同 PEPPER 结果不同（无 PEPPER 可穷举）', identHash('phone', '13800000000', 'other-pepper-x') !== h1)
assert('明文不出现在哈希里', !h1.includes('13800000000'))
let threw = false
try { identHash('phone', '13800000000', '') } catch { threw = true }
assert('PEPPER 为空时抛错（拒绝弱哈希）', threw)
assert('safeEqualHex 正确比对', safeEqualHex(h1, h2) === true && safeEqualHex(h1, h3) === false)
assert('safeEqualHex 长度不等不崩', safeEqualHex('abc', 'abcdef') === false)

section('identity · owner_id（须与云端 19 位数字串同构）')
const ids = new Set()
for (let i = 0; i < 5000; i++) ids.add(newOwnerId())
assert('5000 次生成零碰撞', ids.size === 5000, `实际 ${ids.size}`)
assert('形态 = 19 位纯数字', [...ids].every(isOwnerId))
assert('样例符合云端形态', isOwnerId('2109869577155379200'))
assert('18 位被拒', !isOwnerId('210986957715537920'))
assert('含字母被拒', !isOwnerId('210986957715537920a'))
// 精度回归：19 位 > Number.MAX_SAFE_INTEGER，必须走字符串拼接
const anyId = newOwnerId()
assert('未丢精度（末位非全 0）', !anyId.endsWith('000000'), anyId)
assert('超出安全整数范围（证明不能用 Number 运算）', BigInt(anyId) > BigInt(Number.MAX_SAFE_INTEGER))

section('jwt · HS256 签发与校验')
const tok = signJwt({ sub: '2109869577155379200', role: 'authenticated' }, JWT_SECRET, 3600)
assert('三段式', tok.split('.').length === 3)
const v = verifyJwt(tok, JWT_SECRET)
assert('校验通过', !!v)
assert('sub 保留', v?.payload?.sub === '2109869577155379200')
assert('自动注入 iat/exp', typeof v?.payload?.iat === 'number' && typeof v?.payload?.exp === 'number')
assert('密钥不符 → null', verifyJwt(tok, 'wrong-secret-wrong-secret-wrong-sec') === null)
assert('篡改 payload → null', (() => {
  const p = tok.split('.')
  const evil = Buffer.from(JSON.stringify({ sub: '9999999999999999999', role: 'authenticated', exp: 9e9 })).toString('base64url')
  return verifyJwt(`${p[0]}.${evil}.${p[2]}`, JWT_SECRET) === null
})())
assert('alg=none 攻击 → null', (() => {
  const hdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ sub: '9999999999999999999', exp: 9e9 })).toString('base64url')
  return verifyJwt(`${hdr}.${body}.`, JWT_SECRET) === null
})())
assert('alg 改成 RS256 → null', (() => {
  const p = tok.split('.')
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  return verifyJwt(`${hdr}.${p[1]}.${p[2]}`, JWT_SECRET) === null
})())
assert('过期 token → null', verifyJwt(signJwt({ sub: 'x' }, JWT_SECRET, -10), JWT_SECRET) === null)
assert('空串/非串 → null', verifyJwt('', JWT_SECRET) === null && verifyJwt(null, JWT_SECRET) === null)
assert('垃圾串 → null', verifyJwt('not.a.jwt', JWT_SECRET) === null)
assert('两段 → null', verifyJwt('aa.bb', JWT_SECRET) === null)

section('otp · 验证码签发/校验/一次性消费')
{
  const store = new OtpStore({ pepper: PEPPER, codeTtlSec: 300, tokenTtlSec: 60, maxAttempts: 3 })
  const { verificationId, code } = store.issue({ identKind: 'phone', identValue: '13800000000', isExistingUser: false })
  assert('verificationId 有前缀', verificationId.startsWith('ver_'))
  assert('code 是 6 位数字', /^\d{6}$/.test(code), code)
  assert('内存里不存明文码', !JSON.stringify([...store.challenges.values()]).includes(`"${code}"`))
  assert('错码 → wrong_code 且剩 2 次', (() => {
    const r = store.verify({ verificationId, code: '000000' === code ? '000001' : '000000' })
    return r.ok === false && r.reason === 'wrong_code' && r.attemptsLeft === 2
  })())
  assert('再错 → 剩 1 次', store.verify({ verificationId, code: '000000' === code ? '000002' : '000000' }).attemptsLeft === 1)
  assert('第三次错 → locked 且挑战销毁', store.verify({ verificationId, code: '000000' === code ? '000003' : '000000' }).reason === 'locked')
  assert('锁定后正确码也被拒（挑战已删）', store.verify({ verificationId, code }).reason === 'not_found')

  const c2 = store.issue({ identKind: 'phone', identValue: '13800000000', isExistingUser: true })
  const ok = store.verify({ verificationId: c2.verificationId, code: c2.code })
  assert('正确码 → ok', ok.ok === true)
  assert('返回 verification_token', typeof ok.verificationToken === 'string' && ok.verificationToken.startsWith('vt_'))
  assert('带回 isExistingUser', ok.isExistingUser === true)
  assert('挑战已一次性消费', store.verify({ verificationId: c2.verificationId, code: c2.code }).reason === 'not_found')
  const consumed = store.consumeToken(ok.verificationToken)
  assert('token 可消费且带标识', consumed?.kind === 'phone' && consumed?.value === '13800000000')
  assert('token 一次性（重放失败）', store.consumeToken(ok.verificationToken) === null)
  assert('伪造 token → null', store.consumeToken('vt_deadbeef') === null)
  assert('不存在的 verificationId → not_found', store.verify({ verificationId: 'ver_nope', code: '123456' }).reason === 'not_found')
  assert('空 code → not_found', store.verify({ verificationId: c2.verificationId, code: '' }).reason === 'not_found')

  // 过期
  const c3 = store.issue({ identKind: 'email', identValue: 'a@b.com', isExistingUser: false })
  store.challenges.get(c3.verificationId).expiresAt = Date.now() - 1
  assert('过期 → expired', store.verify({ verificationId: c3.verificationId, code: c3.code }).reason === 'expired')

  // 万能码
  const m = new OtpStore({ pepper: PEPPER, masterCode: '888888' })
  const c4 = m.issue({ identKind: 'phone', identValue: '13900000000', isExistingUser: false })
  assert('万能码可用', m.verify({ verificationId: c4.verificationId, code: '888888' }).ok === true)
  const m2 = new OtpStore({ pepper: PEPPER, masterCode: '' })
  const c5 = m2.issue({ identKind: 'phone', identValue: '13900000000', isExistingUser: false })
  assert('未配万能码时 888888 无效', m2.verify({ verificationId: c5.verificationId, code: '888888' }).ok === false)
  store.close(); m.close(); m2.close()
}

section('otp · 审核演示账户（仅锁一个号，非全局后门）')
{
  const DEMO_PHONE = '13800000000'
  const DEMO_CODE = '123456'
  const d = new OtpStore({ pepper: PEPPER, demo: { phone: DEMO_PHONE, code: DEMO_CODE } })

  // 演示号发码 → 固定码（非随机）
  const c1 = d.issue({ identKind: 'phone', identValue: DEMO_PHONE, isExistingUser: false })
  assert('演示号返回固定码', c1.code === DEMO_CODE, c1.code)
  // 固定码可验证通过
  assert('演示号固定码验证通过', d.verify({ verificationId: c1.verificationId, code: DEMO_CODE }).ok === true)

  // 普通号发码仍是随机 6 位，且演示码对它无效
  const c2 = d.issue({ identKind: 'phone', identValue: '13900000000', isExistingUser: false })
  assert('普通号仍是随机码', /^\d{6}$/.test(c2.code) && c2.code !== DEMO_CODE, c2.code)
  assert('演示码对普通号无效', d.verify({ verificationId: c2.verificationId, code: DEMO_CODE }).ok === false)

  // 演示号发码后，错误码也不应把它锁死（固定码场景无暴力破解风险，但防误锁）
  const c3 = d.issue({ identKind: 'phone', identValue: DEMO_PHONE, isExistingUser: true })
  const r3 = d.verify({ verificationId: c3.verificationId, code: '999999' })
  assert('演示号错码不锁定（attempts 不递增）', r3.ok === false && r3.reason === 'wrong_code')
  assert('错一次后固定码仍可验证', d.verify({ verificationId: c3.verificationId, code: DEMO_CODE }).ok === true)

  // 邮箱不发演示码（演示只对 phone 生效）
  const c4 = d.issue({ identKind: 'email', identValue: 'a@b.com', isExistingUser: false })
  assert('邮箱仍是随机码（不享受演示）', c4.code !== DEMO_CODE)

  // 未配 demo 时（null）无演示行为
  const n = new OtpStore({ pepper: PEPPER, demo: null })
  const c5 = n.issue({ identKind: 'phone', identValue: DEMO_PHONE, isExistingUser: false })
  assert('未配 demo 时演示号也是随机码', c5.code !== DEMO_CODE)

  // demo 缺 phone 或缺 code → 整体禁用
  const n2 = new OtpStore({ pepper: PEPPER, demo: { phone: '', code: DEMO_CODE } })
  const n3 = new OtpStore({ pepper: PEPPER, demo: { phone: DEMO_PHONE, code: '' } })
  assert('缺 phone → 演示禁用', n2.demo === null)
  assert('缺 code → 演示禁用', n3.demo === null)

  d.close(); n.close(); n2.close(); n3.close()
}

section('otp · 验证码随机性（不可用 Math.random）')
{
  const codes = new Set()
  for (let i = 0; i < 2000; i++) codes.add(genCode())
  assert('2000 个码有足够熵（>500 种）', codes.size > 500, `实际 ${codes.size} 种`)
  assert('全是 6 位数字', [...codes].every((c) => /^\d{6}$/.test(c)))
}

section('http · RateLimiter 固定窗口')
{
  const rl = new RateLimiter({ windowMs: 60_000, limit: 2 })
  assert('第 1 次通过', rl.hit('a').ok === true)
  assert('第 2 次通过', rl.hit('a').ok === true)
  assert('第 3 次拒绝', rl.hit('a').ok === false)
  assert('拒绝时给 retryAfterSec', rl.hit('a').retryAfterSec > 0)
  assert('不同 key 互不影响', rl.hit('b').ok === true)
  assert('remaining 递减', new RateLimiter({ limit: 5 }).hit('x').remaining === 4)
  rl.reset('a')
  assert('reset 后恢复', rl.hit('a').ok === true)
}

section('http · Router 精确与前缀匹配')
{
  const r = new Router()
  r.on('GET', '/x', 'exact')
  r.onPrefix('GET', '/db', 'prefix')
  assert('精确匹配', r.match('GET', '/x')?.handler === 'exact')
  assert('前缀匹配（根）', r.match('GET', '/db')?.rest === '')
  assert('前缀匹配（子路径）', r.match('GET', '/db/profiles')?.rest === '/profiles')
  assert('前缀匹配（多级）', r.match('GET', '/db/a/b')?.rest === '/a/b')
  assert('相似前缀不误匹配（/dbx）', r.match('GET', '/dbx') === null)
  assert('方法不符 → null', r.match('POST', '/x') === null)
  assert('未注册 → null', r.match('GET', '/nope') === null)
}

section('config · parseEnv')
{
  const { parseEnv } = await import('../server/lib/config.mjs')
  const env = parseEnv('# 注释\nA=1\nB="quoted value"\nC=\'sq\'\nD=val # 行尾注释\n\nE=\n')
  assert('普通值', env.A === '1')
  assert('双引号被剥', env.B === 'quoted value')
  assert('单引号被剥', env.C === 'sq')
  assert('行尾注释被剥', env.D === 'val', JSON.stringify(env.D))
  assert('空值', env.E === '')
  assert('注释行被跳过', !('＃' in env) && Object.keys(env).length === 5)
}

section('config · validate 拦住不安全配置')
{
  const { loadConfig, validate, warnings } = await import('../server/lib/config.mjs')
  const envBase = {
    JWT_SECRET: 'a'.repeat(48), IDENT_PEPPER: 'b'.repeat(48), DBEE_PWD: 'pwd',
    SMS_PROVIDER: 'log', SMS_MASTER_CODE: '888888',
  }
  // validate() 接收的是**归一化后的 cfg 对象**，不是 env —— 直接构造，
  // 这样能单独测「不安全配置被拒」而不触发 loadConfig 的抛错路径
  const cfgBase = {
    jwtSecret: 'a'.repeat(48), identPepper: 'b'.repeat(48), dbPassword: 'pwd',
    smsProvider: 'log', smsMasterCode: '888888', prod: false, accessTtlSec: 3600,
  }
  assert('完整配置无问题', validate(cfgBase).length === 0, JSON.stringify(validate(cfgBase)))
  assert('短 JWT_SECRET 被拒', validate({ ...cfgBase, jwtSecret: 'short' }).length > 0)
  assert('缺 PEPPER 被拒', validate({ ...cfgBase, identPepper: '' }).length > 0)
  assert('PEPPER=JWT_SECRET 被拒', validate({ ...cfgBase, identPepper: cfgBase.jwtSecret }).length > 0)
  assert('缺 DBEE_PWD 被拒', validate({ ...cfgBase, dbPassword: '' }).length > 0)
  assert('log 模式缺万能码被拒', validate({ ...cfgBase, smsMasterCode: '' }).length > 0)
  assert('未实现的 provider 被拒', validate({ ...cfgBase, smsProvider: 'tencent' }).length > 0)
  assert('生产 + log 短信被拒', validate({ ...cfgBase, prod: true }).length > 0)
  // 演示账户（⑦）校验：phone/code 必须成对；演示码不得等于万能码
  assert('演示账户完整配置无问题', validate({ ...cfgBase, demoPhone: '13800000000', demoCode: '123456' }).length === 0, JSON.stringify(validate({ ...cfgBase, demoPhone: '13800000000', demoCode: '123456' })))
  assert('只配 DEMO_PHONE 缺 DEMO_CODE 被拒', validate({ ...cfgBase, demoPhone: '13800000000', demoCode: '' }).length > 0)
  assert('只配 DEMO_CODE 缺 DEMO_PHONE 被拒', validate({ ...cfgBase, demoPhone: '', demoCode: '123456' }).length > 0)
  assert('演示码 = 万能码被拒（职责冲突）', validate({ ...cfgBase, demoPhone: '13800000000', demoCode: '888888' }).length > 0)
  // email 通道校验（2026-10-27）：未配 emailProvider 不报错（视为 log 占位）
  assert('未配 emailProvider → 不报错（log 占位）', validate(cfgBase).length === 0)
  assert('emailProvider=smtp 缺凭据被拒', validate({ ...cfgBase, emailProvider: 'smtp', emailSmtpHost: '', emailSmtpFrom: '' }).length > 0)
  assert('emailProvider=smtp 配齐凭据无问题', validate({ ...cfgBase, emailProvider: 'smtp', emailSmtpHost: 'smtp.example.com', emailSmtpFrom: 'noreply@example.com' }).length === 0, JSON.stringify(validate({ ...cfgBase, emailProvider: 'smtp', emailSmtpHost: 'smtp.example.com', emailSmtpFrom: 'noreply@example.com' })))
  assert('emailProvider=未知值被拒', validate({ ...cfgBase, emailProvider: 'sendgrid' }).length > 0)
  // 生产环境允许保留演示账户（只锁一个号，非全局后门）；且切真短信后
  // 不再触发「生产 + log」那条最危险的规则（tencent 未实现会另报一条，属预期）。
  assert('生产 + 真短信 + 演示账户：不触发「生产+log 万能码」规则', (() => {
    const p = validate({ ...cfgBase, prod: true, smsProvider: 'tencent', demoPhone: '13800000000', demoCode: '123456' })
    return !p.some((x) => /生产环境.*SMS_PROVIDER=log/.test(x))
  })())

  // loadConfig 的抛错路径：配置不可用时**拒绝启动**，而不是带病运行
  const expectThrow = (label, env) => {
    let threw = false
    let msg = ''
    try { loadConfig(env) } catch (e) { threw = true; msg = e.message }
    assert(label, threw, msg.split('\n')[0])
  }
  expectThrow('loadConfig: 缺 JWT_SECRET → 拒绝启动', { ...envBase, JWT_SECRET: '' })
  expectThrow('loadConfig: 缺 IDENT_PEPPER → 拒绝启动', { ...envBase, IDENT_PEPPER: '' })
  expectThrow('loadConfig: 短 JWT_SECRET → 拒绝启动', { ...envBase, JWT_SECRET: 'short' })
  expectThrow('loadConfig: 生产用开发占位符 JWT_SECRET → 拒绝启动', {
    ...envBase, DBEE_PROD: '1', JWT_SECRET: 'dev-only-change-me-before-production', IDENT_PEPPER: 'c'.repeat(48),
  })
  assert('loadConfig: 合法配置不抛', !!loadConfig(envBase))

  // TTL 解析
  assert('JWT_EXPIRES_IN=7d → 604800', loadConfig({ ...envBase, JWT_EXPIRES_IN: '7d' }).accessTtlSec === 604800)
  assert('JWT_EXPIRES_IN=900 → 900', loadConfig({ ...envBase, JWT_EXPIRES_IN: '900' }).accessTtlSec === 900)
  assert('JWT_EXPIRES_IN=12h → 43200', loadConfig({ ...envBase, JWT_EXPIRES_IN: '12h' }).accessTtlSec === 43200)
  // 🔴 安全审计①：access TTL 默认从 7 天缩短到 30 分钟（缩小被盗窗口）
  assert('JWT_EXPIRES_IN 非法 → 回退默认 30 分钟', loadConfig({ ...envBase, JWT_EXPIRES_IN: 'garbage' }).accessTtlSec === 1800)
  assert('JWT_EXPIRES_IN=0 → 回退默认（不接受 0 秒有效期）', loadConfig({ ...envBase, JWT_EXPIRES_IN: '0' }).accessTtlSec === 1800)

  // 默认值与非致命提示
  const c = loadConfig(envBase)
  assert('默认监听回环地址（不直接暴露公网）', c.host === '127.0.0.1')
  assert('默认端口 8080', c.port === 8080)
  assert('PostgREST 上游默认 3001', c.postgrestUrl === 'http://127.0.0.1:3001')
  assert('postgrestJwtSecret 默认复用 jwtSecret', c.postgrestJwtSecret === c.jwtSecret)
  assert('body 上限 32 MiB（base64 图片）', c.bodyLimitBytes === 32 * 1024 * 1024)
  assert('appleSandbox 默认 true（提审期用沙盒）', c.appleSandbox === true)
  // 🔴 安全审计④：生产环境默认关沙盒；显式开沙盒触发 validate 拦截
  // 注：用 validate(cfg) 直接测（cfgBase 形），避开 loadConfig 里
  // 「生产+log 短信」这条更早触发的规则干扰。
  const prodCfgBase = { ...cfgBase, prod: true, smsProvider: 'tencent', smsMasterCode: '' }
  assert('生产 + appleSandbox=true → validate 拦截（防沙盒收据换真会员）',
    validate({ ...prodCfgBase, appleSandbox: true }).some((x) => /APPLE_SANDBOX/.test(x)))
  // appleSandbox=false 时，不应再出现 APPLE_SANDBOX 相关拦截（tencent 缺凭据是另一条，无关沙盒）
  assert('生产 + appleSandbox=false → 不再有 APPLE_SANDBOX 拦截',
    !validate({ ...prodCfgBase, appleSandbox: false }).some((x) => /APPLE_SANDBOX/.test(x)))
  // loadConfig 层：生产环境（真短信已配齐）appleSandbox 默认 false，且默认只收 Production
  const prodEnvFull = {
    ...envBase, DBEE_PROD: '1', SMS_PROVIDER: 'tencent', SMS_MASTER_CODE: '',
    SMS_TENCENT_SECRET_ID: 'sid', SMS_TENCENT_SECRET_KEY: 'skey',
    SMS_TENCENT_SDKAPPID: '1400000000', SMS_TENCENT_TEMPLATE_ID: '123456',
  }
  const cpFull = loadConfig(prodEnvFull)
  assert('生产环境 appleSandbox 默认 false', cpFull.appleSandbox === false)
  assert('生产环境默认只收 Production', [...cpFull.appleAllowedEnvs].join(',') === 'Production', [...cpFull.appleAllowedEnvs].join(','))
  assert('缺 LLM_API_KEY 时给非致命提示', warnings({ ...c, llmApiKey: '' }).some((w) => w.includes('LLM_API_KEY')))
  assert('配了 bundleId 但缺 sharedSecret → 提示 21004 风险', warnings({ ...c, llmApiKey: 'sk-x', publishableKey: 'wbpk_x', appleBundleId: 'com.x', appleSharedSecret: '' }).some((w) => w.includes('APPLE_SHARED_SECRET')))
  assert('配齐后无提示', warnings({ ...c, llmApiKey: 'sk-x', publishableKey: 'wbpk_x', appleBundleId: 'com.x', appleSharedSecret: 'sec' }).length === 0)
}

section('config · isOriginAllowed（安全审计⑦ CORS 白名单）')
{
  const { isOriginAllowed, warnings, loadConfig } = await import('../server/lib/config.mjs')
  // 非生产 + 空白名单 → 回显任意 Origin（开发便利，旧行为）
  const devCfg = { prod: false, corsAllowedOrigins: new Set() }
  assert('非生产空白名单：任意 Origin 放行', isOriginAllowed(devCfg, 'http://evil.example.com') === true)
  assert('非生产空白名单：capacitor 本地放行', isOriginAllowed(devCfg, 'capacitor://localhost') === true)
  assert('无 Origin 头（同源/非浏览器）→ 不涉及 CORS，返回 true', isOriginAllowed(devCfg, null) === true)

  // 生产 + 空白名单 → 拒绝所有跨域
  const prodEmpty = { prod: true, corsAllowedOrigins: new Set() }
  assert('生产空白名单：任意 Origin 拒绝', isOriginAllowed(prodEmpty, 'http://evil.example.com') === false)
  assert('生产空白名单：合法 Origin 也拒绝（未配白名单）', isOriginAllowed(prodEmpty, 'https://dbee.example.com') === false)

  // 生产 + 白名单 → 精确匹配
  const prodAllow = { prod: true, corsAllowedOrigins: new Set(['https://dbee.example.com', 'https://*.cdn.example.com']) }
  assert('白名单精确命中 → 放行', isOriginAllowed(prodAllow, 'https://dbee.example.com') === true)
  assert('白名单未命中 → 拒绝', isOriginAllowed(prodAllow, 'https://evil.example.com') === false)
  assert('通配子域命中 → 放行', isOriginAllowed(prodAllow, 'https://a.cdn.example.com') === true)
  assert('通配子域多级命中 → 放行', isOriginAllowed(prodAllow, 'https://a.b.cdn.example.com') === true)
  assert('通配不匹配裸域 → 拒绝', isOriginAllowed(prodAllow, 'https://cdn.example.com') === false)
  assert('协议不符（http vs https）→ 拒绝', isOriginAllowed(prodAllow, 'http://dbee.example.com') === false)
  assert('端口不符 → 拒绝', isOriginAllowed(prodAllow, 'https://dbee.example.com:8443') === false)
  assert('畸形 Origin → 拒绝（不抛异常）', isOriginAllowed(prodAllow, 'not-a-url') === false)
  // 大小写不敏感
  assert('host 大小写不敏感', isOriginAllowed(prodAllow, 'https://DBEE.Example.COM') === true)

  // warnings：生产未配白名单 → 提示
  const warnCfg = loadConfig({
    JWT_SECRET: 'a'.repeat(48), IDENT_PEPPER: 'b'.repeat(48), DBEE_PWD: 'pwd',
    SMS_PROVIDER: 'tencent', SMS_MASTER_CODE: '',
    SMS_TENCENT_SECRET_ID: 'sid', SMS_TENCENT_SECRET_KEY: 'skey',
    SMS_TENCENT_SDKAPPID: '1400000000', SMS_TENCENT_TEMPLATE_ID: '123456',
    DBEE_PROD: '1',
  })
  assert('生产未配 CORS 白名单 → warnings 提示',
    warnings({ ...warnCfg, corsAllowedOrigins: new Set() })
      .some((w) => w.includes('CORS_ALLOWED_ORIGINS')))
  // 生产配了白名单 → 不提示
  assert('生产配了白名单 → 无 CORS 提示',
    !warnings({ ...warnCfg, corsAllowedOrigins: new Set(['https://dbee.example.com']) })
      .some((w) => w.includes('CORS_ALLOWED_ORIGINS')))
}

// ══════════════════════════════════════════════════════════════════════
// Part 2 · 端到端 HTTP（真 server + mock pool）
// ══════════════════════════════════════════════════════════════════════
const mockPool = createMockPool()
const { server, otp } = createApp({
  cfg, pool: mockPool, gatewayPool: mockPool, logger,
  enableDbProxy: false, // 不连真 PostgREST
  enableLlm: true,
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const A = `${BASE}/.cloud/auth/v1`
const HDR = { 'content-type': 'application/json', 'x-wb-webapp-access-key': cfg.publishableKey }

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { ...HDR, ...headers }, body: JSON.stringify(body) })
const get = (url, headers = {}) => fetch(url, { headers: { ...HDR, ...headers } })

// 从 log 模式拿到验证码：otp 存的是 HMAC，明文码只在 issue 时返回过。
// 自测里直接读 store 拿不到明文 → 用万能码走通链路，同时单独测「真实码」路径。
const PHONE = '13800000000'

section('HTTP · access-key 校验')
{
  const r = await post(`${A}/verification`, { phone_number: PHONE, target: 'ANY' }, { 'x-wb-webapp-access-key': 'wbpk_wrong' })
  assert('错误 access-key → 401', r.status === 401, `实际 ${r.status}`)
}

section('HTTP · 发码 POST /v1/verification')
{
  const r = await post(`${A}/verification`, { phone_number: PHONE, target: 'ANY' })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  assert('返回 verification_id', typeof j.verification_id === 'string' && j.verification_id.startsWith('ver_'))
  assert('返回 is_user（SDK 读此字段）', typeof j.is_user === 'boolean')
  assert('新用户 is_user=false', j.is_user === false)
  assert('不泄露验证码', !JSON.stringify(j).match(/\b\d{6}\b/), JSON.stringify(j))
  assert('不泄露明文手机号', !JSON.stringify(j).includes(PHONE))
}

section('HTTP · 发码参数校验')
{
  const r1 = await post(`${A}/verification`, {})
  assert('缺标识 → 400', r1.status === 400)
  const r2 = await post(`${A}/verification`, { phone_number: PHONE, email: 'a@b.com' })
  assert('phone+email 同传 → 400', r2.status === 400)
  const r3 = await post(`${A}/verification`, { phone_number: '123' })
  assert('非法手机号 → 400', r3.status === 400)
  const r4 = await post(`${A}/verification`, { email: 'user@example.com', usage: 'email' })
  assert('邮箱发码 → 200', r4.status === 200, `实际 ${r4.status}`)
  const j4 = await r4.json()
  assert('邮箱发码返回 verification_id', typeof j4.verification_id === 'string' && j4.verification_id.startsWith('ver_'))
  assert('邮箱发码返回 is_user（boolean）', typeof j4.is_user === 'boolean')
}

section('HTTP · 发码频率限制（同标识 60s 一次）')
{
  const r = await post(`${A}/verification`, { phone_number: PHONE, target: 'ANY' })
  assert('立即重发 → 429', r.status === 429, `实际 ${r.status}`)
  assert('429 带 retry-after 头', Number(r.headers.get('retry-after')) > 0)
  const j = await r.json()
  assert('429 文案含等待秒数', /\d+/.test(j.message || ''), j.message)
}

section('HTTP · 验码 POST /v1/verification/verify')
let verificationToken = ''
{
  // 取最近一次挑战的明文码：从 OtpStore 内部拿不到（只存 HMAC），
  // 所以这里重新 issue 一个已知码的挑战塞进 store，模拟「用户收到短信」。
  const knownCode = '246810'
  const { verificationId } = otp.issue({ identKind: 'phone', identValue: PHONE, isExistingUser: false })
  // 覆写为已知码的哈希（等价于用户收到 246810）
  const { createHmac } = await import('node:crypto')
  otp.challenges.get(verificationId).codeHash = createHmac('sha256', PEPPER).update(knownCode).digest('hex')

  const rBad = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: '111111' })
  assert('错码 → 400', rBad.status === 400, `实际 ${rBad.status}`)
  const jBad = await rBad.json()
  assert('错码文案含剩余次数', /尝试/.test(jBad.message), jBad.message)

  const r = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: knownCode })
  assert('正确码 → 200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  assert('返回 verification_token', typeof j.verification_token === 'string' && j.verification_token.startsWith('vt_'))
  verificationToken = j.verification_token

  const r2 = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: knownCode })
  assert('同一挑战重复验 → 400（已消费）', r2.status === 400)
  const r3 = await post(`${A}/verification/verify`, { verification_id: 'ver_fake', verification_code: knownCode })
  assert('伪造 verification_id → 400', r3.status === 400)
  const r4 = await post(`${A}/verification/verify`, { verification_id: verificationId })
  assert('缺 code → 400', r4.status === 400)
}

section('HTTP · 试错锁定（maxAttempts=3）')
{
  const { verificationId } = otp.issue({ identKind: 'phone', identValue: '13700000000', isExistingUser: false })
  const s1 = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: '000001' })
  const s2 = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: '000002' })
  const s3 = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: '000003' })
  assert('前 3 次错码均 4xx', [s1.status, s2.status, s3.status].every((x) => x === 400 || x === 429))
  assert('第 3 次触发锁定 → 429', s3.status === 429, `实际 ${s3.status}`)
  const s4 = await post(`${A}/verification/verify`, { verification_id: verificationId, verification_code: '000004' })
  assert('锁定后挑战已销毁 → 400', s4.status === 400)
}

section('HTTP · 新用户注册 POST /v1/signup')
let newSession = null
let createdOwnerId = ''
{
  const P2 = '13611112222'
  // 用万能码换 token：OTP 明文码只在 issue() 时返回过一次，store 里存的是 HMAC，
  // 所以自测走「issue + 万能码 verify」这条路（log 模式万能码生效是刻意设计）。
  const issued = otp.issue({ identKind: 'phone', identValue: P2, isExistingUser: false })
  const verified = otp.verify({ verificationId: issued.verificationId, code: '888888' })
  assert('万能码在 log 模式生效', verified.ok === true)

  const r = await post(`${A}/signup`, {
    verification_token: verified.verificationToken,
    phone_number: P2,
  })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  newSession = j
  createdOwnerId = j.sub
  assert('返回 access_token（SDK parseSession 必需）', typeof j.access_token === 'string' && j.access_token.split('.').length === 3)
  assert('返回 refresh_token', typeof j.refresh_token === 'string' && j.refresh_token.length > 10)
  assert('返回 expires_in（秒）', j.expires_in === cfg.accessTtlSec)
  assert('返回 sub = owner_id', isOwnerId(j.sub), j.sub)
  assert('is_anonymous=false', j.is_anonymous === false)
  assert('token_type=bearer', j.token_type === 'bearer')
  assert('JWT 可被服务端密钥校验', !!verifyJwt(j.access_token, JWT_SECRET))
  assert('JWT sub 与响应 sub 一致', verifyJwt(j.access_token, JWT_SECRET)?.payload?.sub === j.sub)
  assert('JWT 带 role=authenticated（PostgREST 据此 SET ROLE）', verifyJwt(j.access_token, JWT_SECRET)?.payload?.role === 'authenticated')
  assert('app_users 已落库', mockPool.rows.size === 1)
  assert('库里存的是掩码不是明文', mockPool.rows.get(createdOwnerId).ident_masked === '136****2222', mockPool.rows.get(createdOwnerId).ident_masked)
  assert('库里存的是哈希不是明文', !mockPool.rows.get(createdOwnerId).ident_hash.includes(P2))
  assert('login_count=1', mockPool.rows.get(createdOwnerId).login_count === 1)

  const r2 = await post(`${A}/signup`, { verification_token: verified.verificationToken, phone_number: P2 })
  assert('token 重放 → 401', r2.status === 401, `实际 ${r2.status}`)
  const r3 = await post(`${A}/signup`, { phone_number: P2 })
  assert('缺 token → 400', r3.status === 400)
  const r4 = await post(`${A}/signup`, { verification_token: 'vt_fake', phone_number: P2 })
  assert('伪造 token → 401', r4.status === 401)
}

section('HTTP · 老用户登录 POST /v1/signin')
let oldSession = null
{
  const issued = otp.issue({ identKind: 'phone', identValue: PHONE, isExistingUser: false })
  // 先注册这个号，再用 signin 登录
  const v1 = otp.verify({ verificationId: issued.verificationId, code: '888888' })
  const rSignup = await post(`${A}/signup`, { verification_token: v1.verificationToken, phone_number: PHONE })
  assert('前置注册成功', rSignup.status === 200)

  const issued2 = otp.issue({ identKind: 'phone', identValue: PHONE, isExistingUser: true })
  const v2 = otp.verify({ verificationId: issued2.verificationId, code: '888888' })
  const r = await post(`${A}/signin`, { username: `+86 ${PHONE}`, verification_token: v2.verificationToken })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  oldSession = j
  assert('拿到会话', typeof j.access_token === 'string')
  assert('owner_id 与注册时一致（同一人不会重复建号）', j.sub === (await rSignup.json()).sub)
  assert('login_count 累加到 2', mockPool.rows.get(j.sub).login_count === 2)

  // 安全断言：不能用 A 的验证码登录 B 的账号
  const issuedA = otp.issue({ identKind: 'phone', identValue: '13500001111', isExistingUser: true })
  const vA = otp.verify({ verificationId: issuedA.verificationId, code: '888888' })
  const rEvil = await post(`${A}/signin`, { username: PHONE, verification_token: vA.verificationToken })
  const jEvil = await rEvil.json()
  assert('标识以 token 内锁定值为准，不信 body.username', jEvil.sub !== j.sub, `evil=${jEvil.sub} real=${j.sub}`)
}

section('HTTP · GET /v1/user/me')
{
  const r = await get(`${A}/user/me`, { authorization: `Bearer ${oldSession.access_token}` })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  assert('sub = owner_id', j.sub === oldSession.sub)
  assert('uid 同值（SDK parseUser 两者都读）', j.uid === oldSession.sub)
  assert('phone_number 返回掩码（不泄露明文）', j.phone_number === '138****0000', j.phone_number)
  assert('is_anonymous=false', j.is_anonymous === false)
  assert('不带 email 字段（手机注册）', j.email === undefined)

  const r2 = await get(`${A}/user/me`)
  assert('无 token → 401', r2.status === 401)
  const r3 = await get(`${A}/user/me`, { authorization: 'Bearer garbage.token.here' })
  assert('垃圾 token → 401', r3.status === 401)
  const r4 = await get(`${A}/user/me`, { authorization: `Bearer ${oldSession.access_token.slice(0, -4)}AAAA` })
  assert('篡改签名 → 401', r4.status === 401)
  // 用别人的 sub 伪造 token（攻击者不知道密钥，此处模拟「密钥泄露但 sub 不存在」）
  const fakeTok = signJwt({ sub: '9999999999999999999', role: 'authenticated' }, JWT_SECRET, 600)
  const r5 = await get(`${A}/user/me`, { authorization: `Bearer ${fakeTok}` })
  assert('签名有效但库里无此人 → 401', r5.status === 401, `实际 ${r5.status}`)
  const expiredTok = signJwt({ sub: oldSession.sub, role: 'authenticated' }, JWT_SECRET, -100)
  const r6 = await get(`${A}/user/me`, { authorization: `Bearer ${expiredTok}` })
  assert('过期 token → 401', r6.status === 401)
}

section('HTTP · refresh POST /v1/token')
{
  const r = await post(`${A}/token`, { grant_type: 'refresh_token', refresh_token: oldSession.refresh_token })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  assert('返回新 access_token', typeof j.access_token === 'string')
  assert('access_token 已更换（旋转）', j.access_token !== oldSession.access_token)
  assert('返回新 refresh_token', typeof j.refresh_token === 'string' && j.refresh_token !== oldSession.refresh_token)
  assert('sub 不变', j.sub === oldSession.sub)
  assert('新 refresh 可用', (await post(`${A}/token`, { grant_type: 'refresh_token', refresh_token: j.refresh_token })).status === 200)

  const r2 = await post(`${A}/token`, { grant_type: 'refresh_token', refresh_token: oldSession.refresh_token })
  assert('旧 refresh_token 重放 → 401', r2.status === 401, `实际 ${r2.status}`)
  const r3 = await post(`${A}/token`, { grant_type: 'password', refresh_token: 'x' })
  assert('错误 grant_type → 400', r3.status === 400)
  const r4 = await post(`${A}/token`, { grant_type: 'refresh_token' })
  assert('缺 refresh_token → 400', r4.status === 400)
  const r5 = await post(`${A}/token`, { grant_type: 'refresh_token', refresh_token: 'fake-token' })
  assert('伪造 refresh_token → 401', r5.status === 401)
}

section('HTTP · 登出 POST /v1/user/signout')
{
  const r = await post(`${A}/user/signout`, {}, { authorization: `Bearer ${oldSession.access_token}` })
  assert('200', r.status === 200)
  const r2 = await post(`${A}/user/signout`, {})
  assert('无 token 也能登出（SDK 侧无条件清本地）', r2.status === 200)
  // 登出后 refresh_token 应被吊销
  const issued = otp.issue({ identKind: 'phone', identValue: PHONE, isExistingUser: true })
  const v = otp.verify({ verificationId: issued.verificationId, code: '888888' })
  const login = await (await post(`${A}/signin`, { username: PHONE, verification_token: v.verificationToken })).json()
  await post(`${A}/user/signout`, {}, { authorization: `Bearer ${login.access_token}` })
  const r3 = await post(`${A}/token`, { grant_type: 'refresh_token', refresh_token: login.refresh_token })
  assert('登出后 refresh_token 已吊销 → 401', r3.status === 401, `实际 ${r3.status}`)
}

section('HTTP · 登出后旧 access token 立即失效（安全审计① token_version）')
{
  // 新登录拿一个带 ver 声明的 access token
  const issued = otp.issue({ identKind: 'phone', identValue: PHONE, isExistingUser: true })
  const v = otp.verify({ verificationId: issued.verificationId, code: '888888' })
  const login = await (await post(`${A}/signin`, { username: PHONE, verification_token: v.verificationToken })).json()
  const at = login.access_token
  // 登出前：/user/me 应 200（token 有效）
  const before = await get(`${A}/user/me`, { authorization: `Bearer ${at}` })
  assert('登出前 /user/me → 200', before.status === 200, `实际 ${before.status}`)
  // 登出（bump token_version）
  await post(`${A}/user/signout`, {}, { authorization: `Bearer ${at}` })
  // 登出后：同一 access token 应因 token_version 不匹配而 401（而不仅是靠 exp）
  const after = await get(`${A}/user/me`, { authorization: `Bearer ${at}` })
  assert('登出后旧 access token → 401（token_version 强制下线）', after.status === 401, `实际 ${after.status}`)
  // 校验 access token 里确实带 ver 声明（否则上面的 401 只是巧合，不是版本校验）
  const payload = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString())
  assert('access token 含 ver 声明', Number.isInteger(payload.ver), `ver=${payload.ver}`)
}

section('HTTP · 未注册路径与 CORS')
{
  const r = await get(`${BASE}/.cloud/auth/v1/nope`)
  assert('未知 auth 路径 → 404 CloudError 形状', r.status === 404 && !!(await r.json()).message)
  const r2 = await get(`${BASE}/.cloud/database/rest/profiles`)
  assert('数据面（本测已禁用反代）→ 404 PGRST 形状', r2.status === 404 && !!(await r2.json()).code)
  const r3 = await fetch(BASE, { method: 'OPTIONS', headers: { origin: 'http://150.158.51.106' } })
  assert('OPTIONS 预检 → 204', r3.status === 204)
  assert('非生产空白名单：回显具体 Origin（非通配）', r3.headers.get('access-control-allow-origin') === 'http://150.158.51.106')
  assert('允许 authorization 头', (r3.headers.get('access-control-allow-headers') || '').includes('authorization'))
  assert('不开 allow-credentials', r3.headers.get('access-control-allow-credentials') === null)
}

section('HTTP · CORS 白名单（安全审计⑦，生产环境拒绝未授权 Origin）')
{
  const corsPool = createMockPool()
  const corsCfg = {
    ...cfg,
    prod: true,
    corsAllowedOrigins: new Set(['https://dbee.example.com']),
  }
  const corsApp = createApp({ cfg: corsCfg, pool: corsPool, gatewayPool: corsPool, logger, enableDbProxy: false, enableLlm: false })
  await new Promise((r) => corsApp.server.listen(0, '127.0.0.1', r))
  const CB = `http://127.0.0.1:${corsApp.server.address().port}/.cloud/healthz`

  // 白名单命中 → 回显该 Origin
  const ok = await fetch(CB, { headers: { origin: 'https://dbee.example.com' } })
  assert('白名单命中 → 回显 allow-origin', ok.headers.get('access-control-allow-origin') === 'https://dbee.example.com')

  // 白名单未命中 → 不设 allow-origin（浏览器会阻断跨域读）
  const evil = await fetch(CB, { headers: { origin: 'https://evil.example.com' } })
  assert('白名单未命中 → 不设 allow-origin', evil.headers.get('access-control-allow-origin') === null)

  // 无 Origin 头（同源/非浏览器）→ 请求正常，不涉及 CORS
  const noOrigin = await fetch(CB)
  assert('无 Origin → 请求正常（不设 allow-origin 也不影响）', noOrigin.status === 200 && noOrigin.headers.get('access-control-allow-origin') === null)

  corsApp.server.close()
  corsApp.otp.close()
  await corsPool.end?.()
}

section('HTTP · healthz（不鉴权，供探活）')
{
  const r = await get(`${BASE}/.cloud/healthz`)
  assert('200', r.status === 200)
  const j = await r.json()
  assert('ok=true', j.ok === true)
  assert('db 连通（mock）', j.db?.ok === true)
  assert('返回 otp 存量统计', typeof j.otp?.challenges === 'number')
}

section('HTTP · 响应头安全基线')
{
  const r = await get(`${A}/user/me`, { authorization: `Bearer ${newSession.access_token}` })
  assert('no-store（认证响应不得被缓存）', (r.headers.get('cache-control') || '').includes('no-store'))
}

section('HTTP · LLM /models 契约（前端 pickModel 依赖）')
{
  const r = await get(`${BASE}/.cloud/llm/models`, { authorization: `Bearer ${newSession.access_token}` })
  assert('200', r.status === 200, `实际 ${r.status}`)
  const j = await r.json()
  const list = Array.isArray(j) ? j : j.data
  assert('返回数组形状（SDK 两种都接受）', Array.isArray(list) && list.length > 0)
  // 目录里同时有文本模型（supportsImages=false）与视觉模型（supportsImages=true）。
  // pickModel(needVision=true) 只取 supportsImages===true 的那条，故契约须断言「视觉模型」，
  // 而非 list[0]（list[0] 是文本模型）。文本模型单独断言 isDefault。
  const textModel = list.find((x) => x.supportsImages === false)
  const visionModel = list.find((x) => x.supportsImages === true)
  assert('存在文本模型', !!textModel)
  assert('文本模型 id = deepseek-flash（旧 ID 已退役）', textModel?.id === 'deepseek-flash', textModel?.id)
  assert('文本模型 isDefault === true（pickModel 优先取）', textModel?.isDefault === true)
  assert('🔴 存在视觉模型且 supportsImages === true（缺此字段拍照识别必坏）', !!visionModel)
  assert('视觉模型 id 合法（文本/视觉双列）', typeof visionModel?.id === 'string' && visionModel.id.length > 0, visionModel?.id)
  assert('视觉模型 enabled 未被过滤', visionModel?.enabled !== false && visionModel?.disabled !== true)
  assert('不含退役模型 ID', !list.some((x) => /deepseek-chat|deepseek-reasoner/.test(x.id)))
  const r2 = await get(`${BASE}/.cloud/llm/models`)
  assert('未登录 → 401', r2.status === 401)
}

section('HTTP · LLM chat/completions 入参校验')
{
  const H = { authorization: `Bearer ${newSession.access_token}` }
  const r = await post(`${BASE}/.cloud/llm/chat/completions`, { messages: [] }, H)
  assert('空 messages → 400', r.status === 400, `实际 ${r.status}`)
  assert('错误体是 OpenAI 形状（SDK httpError 解析 .error.message）', !!(await r.json()).error?.message)
  const r2 = await post(`${BASE}/.cloud/llm/chat/completions`, {}, H)
  assert('缺 messages → 400', r2.status === 400)
  const r3 = await post(`${BASE}/.cloud/llm/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] }, H)
  // 上游不可达（llmBaseUrl 指向 127.0.0.1:1）→ 502，而不是挂住或 500 泄漏栈
  assert('上游不可达 → 502', r3.status === 502, `实际 ${r3.status}`)
  const j3 = await r3.json()
  assert('502 文案不泄漏内部细节', !/ECONNREFUSED|127\.0\.0\.1|stack/i.test(j3.error?.message || ''), j3.error?.message)
  const r4 = await post(`${BASE}/.cloud/llm/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] })
  assert('未登录 → 401', r4.status === 401)
}

section('安全 · mock pool 只收到参数化查询（无字符串拼接）')
{
  const bad = mockPool.queries.filter((q) => /'|"|13[0-9]{9}/.test(q.sql))
  assert('SQL 文本里不含内联值', bad.length === 0, bad.map((b) => b.sql).join(' | '))
  assert('所有查询都带 params 数组', mockPool.queries.every((q) => Array.isArray(q.params)))
  const leaked = mockPool.queries.filter((q) => JSON.stringify(q.params).includes('888888'))
  assert('验证码从未进入 SQL 参数', leaked.length === 0)
}

// ══════════════════════════════════════════════════════════════════════
// Part 3 · 审核演示账户端到端（真 server + 演示号 + 固定码）
// ══════════════════════════════════════════════════════════════════════
section('HTTP · 演示账户发码→验码→注册全链（固定码，不发真短信）')
{
  const demoPhone = '13800001111'
  const demoCode = '654321'
  const demoPool = createMockPool()
  const demoCfg = { ...cfg, demoPhone, demoCode }
  const demoApp = createApp({ cfg: demoCfg, pool: demoPool, gatewayPool: demoPool, logger, enableDbProxy: false, enableLlm: false })
  await new Promise((r) => demoApp.server.listen(0, '127.0.0.1', r))
  const DB = `http://127.0.0.1:${demoApp.server.address().port}/.cloud/auth/v1`
  const dpost = (url, body) => fetch(url, { method: 'POST', headers: HDR, body: JSON.stringify(body) })

  // 演示号发码 → 200（不发真短信，直接返回固定码挑战）
  const r1 = await dpost(`${DB}/verification`, { phone_number: demoPhone, target: 'ANY' })
  assert('演示号发码 200', r1.status === 200, `实际 ${r1.status}`)
  const j1 = await r1.json()
  assert('返回 verification_id', typeof j1.verification_id === 'string')

  // 用固定码验码 → 拿到 verification_token
  const r2 = await dpost(`${DB}/verification/verify`, { verification_id: j1.verification_id, verification_code: demoCode })
  assert('固定码验码 200', r2.status === 200, `实际 ${r2.status}`)
  const j2 = await r2.json()
  assert('返回 verification_token', typeof j2.verification_token === 'string')

  // 用该 token 注册 → 拿到会话（审核员可完成登录）
  const r3 = await dpost(`${DB}/signup`, { verification_token: j2.verification_token, phone_number: demoPhone })
  assert('演示号注册 200', r3.status === 200, `实际 ${r3.status}`)
  const j3 = await r3.json()
  assert('拿到 access_token', typeof j3.access_token === 'string' && j3.access_token.split('.').length === 3)

  // 固定码不能用于其他号（非全局后门）
  const r4 = await dpost(`${DB}/verification`, { phone_number: '13900002222', target: 'ANY' })
  const j4 = await r4.json()
  const r5 = await dpost(`${DB}/verification/verify`, { verification_id: j4.verification_id, verification_code: demoCode })
  assert('固定码对非演示号无效（400）', r5.status === 400, `实际 ${r5.status}`)

  demoApp.server.close()
  demoApp.otp.close()
  await demoPool.end?.()
}

// ══════════════════════════════════════════════════════════════════════
// Part 4 · LLM 服务端权益闸门（0039 P0-C）+ 包装识别兜底 + 输入限制
// ══════════════════════════════════════════════════════════════════════
// 主 app 的 mockPool 没有 connect()，withUserIdentity 会抛错 → 闸门 fail-open，
// 拒绝/兜底路径测不到。这里用可编程 gatePool（llm_gate 返回什么由测试指定）
// 起第二个 app，逐分支覆盖。上游仍指向不可达地址：
//   502 = 闸门放行后走到了 fetch；402 = 被闸门/兜底限额拦下。

/** 可编程 pool：connect() 返回 mock client，llm_gate 的应答由 mode 决定 */
function createGatePool() {
  const state = { mode: { allowed: true, pro: false }, calls: 0 }
  return {
    state,
    setMode(m) { state.mode = m },
    async connect() {
      if (state.mode === 'connect-throw') throw new Error('pool down')
      return {
        async query(sql) {
          if (/llm_gate/.test(sql)) {
            state.calls += 1
            if (state.mode === 'query-throw') throw new Error('db error')
            if (state.mode === 'malformed') return { rows: [{ g: 'not-an-object' }] }
            return { rows: [{ g: state.mode }] }
          }
          return { rows: [], rowCount: 0 } // BEGIN / set_config / COMMIT
        },
        release() {},
      }
    },
    async query() { return { rows: [], rowCount: 0 } },
    async end() {},
  }
}

section('HTTP · LLM 闸门（llm_gate）与包装识别兜底')
{
  const gatePool = createGatePool()
  const gateCfg = { ...cfg, llmGateEnabled: true, llmPackageDailyCap: 2, llmVisionModel: 'deepseek-flash' }
  const gateApp = createApp({ cfg: gateCfg, pool: gatePool, gatewayPool: gatePool, logger, enableDbProxy: false, enableLlm: true })
  await new Promise((r) => gateApp.server.listen(0, '127.0.0.1', r))
  const G = `http://127.0.0.1:${gateApp.server.address().port}/.cloud/llm/chat/completions`
  const GH = { authorization: `Bearer ${signJwt({ sub: '7777777777777777777', role: 'authenticated' }, JWT_SECRET, 600)}` }
  const visionMsg = {
    role: 'user',
    content: [
      { type: 'text', text: '这是什么食物' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }
  const gpost = (body, headers = GH) => post(G, body, headers)

  // ① 闸门放行（有 claim 可核销）→ 走到上游 → 502（上游不可达）
  gatePool.setMode({ allowed: true, pro: false, claim_id: 1 })
  let r = await gpost({ messages: [visionMsg] })
  assert('视觉+闸门放行 → 502（到达上游）', r.status === 502, `实际 ${r.status}`)
  assert('llm_gate 被调用', gatePool.state.calls === 1, `calls=${gatePool.state.calls}`)

  // ② 文本请求 → 不调闸门（llmGate 内部 wantVision=false 直接放行）
  const callsBefore = gatePool.state.calls
  r = await gpost({ messages: [{ role: 'user', content: '你好' }] })
  assert('文本请求 → 502（到达上游）', r.status === 502, `实际 ${r.status}`)
  assert('文本请求不触发 llm_gate', gatePool.state.calls === callsBefore)

  // ③ Pro 放行 → 502
  gatePool.setMode({ allowed: true, pro: true })
  r = await gpost({ messages: [visionMsg] })
  assert('视觉+Pro → 502（到达上游）', r.status === 502, `实际 ${r.status}`)

  // ④ 无 claim（quota_not_claimed）→ 落入包装识别兜底：cap=2，前 2 次放行
  gatePool.setMode({ allowed: false, pro: false, reason: 'quota_not_claimed' })
  r = await gpost({ messages: [visionMsg] })
  assert('兜底第 1/2 次 → 502（放行到上游）', r.status === 502, `实际 ${r.status}`)
  r = await gpost({ messages: [visionMsg] })
  assert('兜底第 2/2 次 → 502（放行到上游）', r.status === 502, `实际 ${r.status}`)
  r = await gpost({ messages: [visionMsg] })
  assert('兜底第 3 次 → 402 quota_exhausted', r.status === 402, `实际 ${r.status}`)
  const j = await r.json()
  assert('402 错误码 = quota_exhausted', j.error?.code === 'quota_exhausted', JSON.stringify(j.error))
  assert('402 带 retry-after', Number(r.headers.get('retry-after')) > 0)

  // ⑤ 非兜底类拒绝（unauthenticated）→ 直接 402，不走兜底
  gatePool.setMode({ allowed: false, pro: false, reason: 'unauthenticated' })
  r = await gpost({ messages: [visionMsg] })
  assert('闸门硬拒绝 → 402（不兜底）', r.status === 402, `实际 ${r.status}`)

  // ⑥ 🔴 安全审计③：fail-closed —— 查询异常 / 返回畸形 → 拒绝（503），不阻塞但也不白烧钱
  gatePool.setMode('query-throw')
  r = await gpost({ messages: [visionMsg] })
  assert('llm_gate 查询异常 → fail-closed 503', r.status === 503, `实际 ${r.status}`)
  {
    const jj = await r.json()
    assert('503 错误码 = gate_unavailable', jj.error?.code === 'gate_unavailable', JSON.stringify(jj.error))
  }
  gatePool.setMode('malformed')
  r = await gpost({ messages: [visionMsg] })
  assert('llm_gate 返回畸形 → fail-closed 503', r.status === 503, `实际 ${r.status}`)
  gatePool.setMode('connect-throw')
  r = await gpost({ messages: [visionMsg] })
  assert('pool.connect 异常 → fail-closed 503', r.status === 503, `实际 ${r.status}`)

  // ⑥b 文本请求不经过 llm_gate（wantVision=false），库异常也不影响文本
  gatePool.setMode('query-throw')
  r = await gpost({ messages: [{ role: 'user', content: '你好' }] })
  assert('库异常时文本请求仍可走（502 到达上游，不因视觉闸门被拒）', r.status === 502, `实际 ${r.status}`)

  // ⑦ 输入限制：图片数超限（默认 4）→ 400 input_too_large，且不消耗兜底额度
  gatePool.setMode({ allowed: false, pro: false, reason: 'quota_not_claimed' })
  const manyImages = {
    role: 'user',
    content: Array.from({ length: 5 }, () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })),
  }
  r = await gpost({ messages: [manyImages] })
  assert('5 张图 → 400 input_too_large', r.status === 400, `实际 ${r.status}`)
  assert('400 错误码正确', (await r.json()).error?.code === 'input_too_large')

  // ⑧ 消息条数超限（默认 60）→ 400
  const manyMsgs = Array.from({ length: 61 }, (_, i) => ({ role: 'user', content: `m${i}` }))
  r = await gpost({ messages: manyMsgs })
  assert('61 条消息 → 400', r.status === 400, `实际 ${r.status}`)

  gateApp.server.close()
  gateApp.otp.close()
  await gatePool.end?.()
}

section('HTTP · LLM 闸门开关（llmGateEnabled=false 时不查库）')
{
  const gatePool = createGatePool()
  gatePool.setMode({ allowed: false, pro: false, reason: 'quota_not_claimed' })
  const offApp = createApp({ cfg: { ...cfg, llmGateEnabled: false }, pool: gatePool, gatewayPool: gatePool, logger, enableDbProxy: false, enableLlm: true })
  await new Promise((r) => offApp.server.listen(0, '127.0.0.1', r))
  const r = await post(
    `http://127.0.0.1:${offApp.server.address().port}/.cloud/llm/chat/completions`,
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] },
    { authorization: `Bearer ${signJwt({ sub: '8888888888888888888', role: 'authenticated' }, JWT_SECRET, 600)}` },
  )
  assert('闸门关闭 → 视觉请求直达上游 502', r.status === 502, `实际 ${r.status}`)
  assert('闸门关闭时不调 llm_gate', gatePool.state.calls === 0)
  offApp.server.close()
  offApp.otp.close()
}

section('HTTP · 文本独立降额（安全审计③：文本不再共用 200/日）')
{
  const textPool = createGatePool()
  // 文本请求 wantVision=false，不经过 llm_gate，也不走视觉 usageLimiter
  const textCfg = { ...cfg, llmGateEnabled: true, llmTextDailyCapPerUser: 2, llmDailyCapPerUser: 100 }
  const textApp = createApp({ cfg: textCfg, pool: textPool, gatewayPool: textPool, logger, enableDbProxy: false, enableLlm: true })
  await new Promise((r) => textApp.server.listen(0, '127.0.0.1', r))
  const T = `http://127.0.0.1:${textApp.server.address().port}/.cloud/llm/chat/completions`
  const TH = { authorization: `Bearer ${signJwt({ sub: '6666666666666666666', role: 'authenticated' }, JWT_SECRET, 600)}` }
  const tpost = () => post(T, { messages: [{ role: 'user', content: '你好' }] }, TH)

  // 文本日限额 2：前 2 次放行（到达上游 → 502），第 3 次 429
  const r1 = await tpost()
  assert('文本第 1/2 次 → 502（到达上游）', r1.status === 502, `实际 ${r1.status}`)
  const r2 = await tpost()
  assert('文本第 2/2 次 → 502（到达上游）', r2.status === 502, `实际 ${r2.status}`)
  const r3 = await tpost()
  assert('文本第 3 次 → 429（独立降额生效，不是 200/日）', r3.status === 429, `实际 ${r3.status}`)
  assert('429 错误码 = rate_limited', (await r3.json()).error?.code === 'rate_limited')

  // 视觉请求不受文本限额影响（走独立的 usageLimiter 100/日）
  const vpost = () => post(T, {
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
  }, TH)
  textPool.setMode({ allowed: true, pro: false, claim_id: 1 })
  const v1 = await vpost()
  assert('文本额度用尽后，视觉请求仍走独立额度（闸门放行 → 502）', v1.status === 502, `实际 ${v1.status}`)

  textApp.server.close()
  textApp.otp.close()
  await textPool.end?.()
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
console.log('\n✅ 网关 A1 自测全过（纯函数 + 端到端 HTTP）')
process.exit(0)
