/**
 * 极简 HS256 JWT —— 只用 node:crypto，不引 jsonwebtoken。
 *
 * 为什么手写：整个签发/校验逻辑不到 80 行，而 jsonwebtoken 会带进 6 个传递依赖。
 * 自托管网关的密钥管理面越小越好审计（符合「技术可控」原则）。
 *
 * ⚠️ 只做 HS256。刻意**不接受**请求里指定的 alg：alg 混淆攻击
 *   （把 alg 改成 "none" 或 RS256→HS256 拿公钥当密钥）是 JWT 最经典的漏洞，
 *   这里从设计上就没有这个入口。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const B64URL = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromB64url = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/** 解析秒数式时长："7d" / "12h" / "900s" / 900 → 秒。无效则回退默认值。 */
export function parseTtl(v, fallbackSec) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
  if (typeof v !== 'string') return fallbackSec
  const m = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(v)
  if (!m) return fallbackSec
  const n = Number(m[1])
  const unit = (m[2] || 's').toLowerCase()
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit]
  return n > 0 ? n * mult : fallbackSec
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest()
}

/**
 * 签发 JWT。
 * @param {object} payload 业务声明；`iat`/`exp` 由本函数注入，传入的同名字段会被覆盖
 * @param {string} secret  HMAC 密钥（来自 JWT_SECRET）
 * @param {number} ttlSec  有效期（秒）
 */
export function signJwt(payload, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000)
  const header = B64URL(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = B64URL(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }))
  const data = `${header}.${body}`
  return `${data}.${B64URL(sign(data, secret))}`
}

/**
 * 校验 JWT。任何失败都返回 null，不抛异常（调用方统一按未认证处理）。
 *
 * @returns {{payload: object}|null}
 */
export function verifyJwt(token, secret, opts = {}) {
  if (typeof token !== 'string' || token === '') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts

  // 1. 签名校验（先于一切解析：不验签就读 payload 是最常见的实现错误）
  let got
  try {
    got = fromB64url(sig)
  } catch {
    return null
  }
  const want = sign(`${header}.${body}`, secret)
  // 长度不等时 timingSafeEqual 会抛，先挡住；比较本身是常量时间，防计时侧信道
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null

  // 2. header 必须是 HS256（拒绝 alg 混淆）
  try {
    const h = JSON.parse(fromB64url(header).toString('utf8'))
    if (h?.alg !== 'HS256') return null
  } catch {
    return null
  }

  // 3. payload 解析 + 过期校验
  let payload
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === 'number' && now >= payload.exp) return null
  // 允许少量时钟漂移（服务器与网关 NTP 不同步时不至于全员掉线）
  const leeway = opts.leewaySec ?? 30
  if (typeof payload.nbf === 'number' && now + leeway < payload.nbf) return null

  return { payload }
}

/** 从 Authorization 头取 Bearer token。大小写不敏感、容忍多余空白。 */
export function bearerFrom(headers) {
  const raw = headers?.authorization || headers?.Authorization
  if (typeof raw !== 'string') return null
  const m = /^\s*bearer\s+(.+?)\s*$/i.exec(raw)
  return m ? m[1] : null
}
