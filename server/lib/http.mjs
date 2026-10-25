/**
 * HTTP 工具层：读 body、发 JSON、路由匹配、限流。
 * 只用 node:http，不引 express。
 */

/** 读取请求体（带上限，防 OOM）。超限直接 413。 */
export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)))
    req.on('error', reject)
  })
}

/** 读 body 并按 JSON 解析。空 body → {}；非法 JSON → 400。 */
export async function readJson(req, limitBytes) {
  const buf = await readBody(req, limitBytes)
  if (!buf.length) return {}
  try {
    const v = JSON.parse(buf.toString('utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    // 网关不缓存任何响应：认证/数据请求被中间层缓存会串号
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * PostgREST 风格错误体（SDK 的 processResponse 直接把它当 error 对象用）。
 * 字段须与 PostgREST 一致：message/details/hint/code，否则前端 errmsg.ts 取不到文案。
 */
export function pgrstError(res, status, message, { code = '', details = '', hint = '' } = {}) {
  sendJson(res, status, { message, details, hint, code })
}

/** 统一的 CloudError 体（auth 模块用；SDK 的 normalizeHttpError 会读 error/message） */
export function cloudError(res, status, message, code) {
  const payload = { message }
  if (code) payload.error = code
  sendJson(res, status, payload)
}

/**
 * 判断直连对端是否是「可信代理」（🔴 0039 XFF 信任边界修复）。
 *
 * 此前无条件信任 X-Forwarded-For 的**第一段** —— 而 XFF 是客户端可自由伪造的
 * 请求头：攻击者带上 `X-Forwarded-For: 8.8.8.8` 即可让按 IP 的限流/风控
 * 每次换一个「身份」，OTP 同 IP 每小时 20 次、API 每分钟限流全部形同虚设。
 *
 * 正确口径：**只有直连对端本身可信（回环 = 同机 nginx，或显式配置的代理 IP）时，
 * 才解析它转发来的 XFF**；对端不可信 → 它的 XFF 是伪造，直接用 socket 地址。
 * 生产拓扑是 nginx(同机) → 127.0.0.1:8080，直连对端恒为回环，语义不变。
 */
export function isTrustedPeer(remoteAddress, trustedSet) {
  if (!remoteAddress) return false
  const ip = remoteAddress.replace(/^::ffff:/, '')
  if (ip === '127.0.0.1' || ip === '::1') return true
  return trustedSet ? trustedSet.has(ip) : false
}

/**
 * 取客户端 IP。
 * @param {object} req
 * @param {{trustedProxies?: Set<string>}} [opts] 可信代理 IP 集合（来自 cfg.trustedProxyIps）
 */
export function clientIp(req, opts = {}) {
  const remote = req.socket?.remoteAddress
  if (isTrustedPeer(remote, opts.trustedProxies)) {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim()
    const real = req.headers['x-real-ip']
    if (typeof real === 'string' && real.trim()) return real.trim()
  }
  return remote || 'unknown'
}

/**
 * 固定窗口限流器。
 *
 * 为什么用固定窗口而不是滑动窗口/令牌桶：这里只需挡住「同号狂发验证码」和
 * 「单 IP 刷接口」两类滥用，固定窗口 20 行代码就够，且内存占用可精确预估。
 * 代价是窗口边界可能放过 2 倍突发 —— 对这个场景可接受。
 *
 * ⚠️ 单进程内存态。多实例部署时限流会各算各的；真要横向扩容须换 Redis。
 *    当前设计是单实例 systemd，不引入 Redis 依赖（价格低廉原则）。
 */
export class RateLimiter {
  constructor({ windowMs = 60_000, limit = 60, maxKeys = 50_000 } = {}) {
    this.windowMs = windowMs
    this.limit = limit
    this.maxKeys = maxKeys
    this.buckets = new Map() // key -> { count, resetAt }
  }

  /**
   * @returns {{ok: boolean, remaining: number, retryAfterSec: number}}
   */
  hit(key, weight = 1) {
    const now = Date.now()
    let b = this.buckets.get(key)
    if (!b || now >= b.resetAt) {
      // 简单防膨胀：超过上限就清掉已过期的键（不做 LRU，够用且 O(n) 极少触发）
      if (this.buckets.size >= this.maxKeys) this.sweep(now)
      b = { count: 0, resetAt: now + this.windowMs }
      this.buckets.set(key, b)
    }
    b.count += weight
    const ok = b.count <= this.limit
    return {
      ok,
      remaining: Math.max(0, this.limit - b.count),
      retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    }
  }

  /** 主动清除某 key（例如验证成功后清掉该手机号的发码计数） */
  reset(key) {
    this.buckets.delete(key)
  }

  sweep(now) {
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k)
    }
  }

  get size() {
    return this.buckets.size
  }
}

/**
 * 极简路由：按 method + 精确路径 或 前缀 匹配。
 * 不用正则路由树 —— 端点总数不到 20 个，Map 查表最快也最好读。
 */
export class Router {
  constructor() {
    this.exact = new Map() // "METHOD /path" -> handler
    this.prefix = [] // { method, prefix, handler } 按声明顺序
  }

  on(method, path, handler) {
    this.exact.set(`${method} ${path}`, handler)
    return this
  }

  /** 前缀路由：handler 会收到去掉前缀后的剩余路径（以 / 开头或为空串） */
  onPrefix(method, prefix, handler) {
    this.prefix.push({ method, prefix, handler })
    return this
  }

  /** @returns {{handler, rest, matched}|null} matched='exact'|'prefix' */
  match(method, pathname) {
    const h = this.exact.get(`${method} ${pathname}`)
    if (h) return { handler: h, rest: '', matched: 'exact' }
    for (const r of this.prefix) {
      if (r.method !== method) continue
      if (pathname === r.prefix) return { handler: r.handler, rest: '', matched: 'prefix' }
      if (pathname.startsWith(r.prefix + '/')) {
        return { handler: r.handler, rest: pathname.slice(r.prefix.length), matched: 'prefix' }
      }
    }
    return null
  }
}
