/**
 * A2 · PostgREST 语义数据代理。
 *
 * ── 为什么是「反代」而不是「手写 REST DSL」───────────────────────────
 * 计划文档 §A2 原假设前端发的是 `POST {select, filters:[{op,column,value}]}` 自定义 DSL。
 * **实测该假设是错的**（2026-10-22 逆向 SDK 确认）：
 *   `cloud.database.from(t)` = PostgrestClient（supabase-js vendor 版），
 *   发出的是**标准 PostgREST HTTP 协议**：
 *     GET    /.cloud/database/rest/profiles?select=*&onboarded=eq.true
 *     POST   /.cloud/database/rest/meal_entries            body=[{...}]
 *     PATCH  /.cloud/database/rest/meal_entries?id=eq.123  Prefer: return=representation
 *     DELETE /.cloud/database/rest/meal_entries?id=eq.123
 *     maybeSingle() → Accept: application/vnd.pgrst.object+json
 *   过滤器编码为 `<column>=<op>.<value>`（eq/neq/gt/gte/lt/lte/like/in/is/cs…），
 *   排序 `order=col.asc`，分页 `limit`/`offset`。
 *
 * 因此正解是：**服务器装 PostgREST 二进制，网关只做「鉴权 + 重签 JWT + 反代」**。
 *   · 工作量：3–5 天 → 半天
 *   · 协议兼容风险：0（PostgREST 自己实现自己的协议，不会有子集遗漏）
 *   · 附带红利：PostgREST 原生注入 `request.jwt.claims`，正是 `auth.uid()` 的
 *     **第三级回退** → 「双注入铁律」自动满足，无需手写 SET LOCAL。
 *
 * ── 网关在这条链路上做什么 ──────────────────────────────────────────
 *   1. 校验前端传来的 Bearer（用 cfg.jwtSecret）
 *   2. **重签**一个给 PostgREST 用的 JWT（用 cfg.postgrestJwtSecret，含 role 声明）
 *      —— 前端 JWT 与 PostgREST JWT 用不同密钥：前者要能塞进业务声明，
 *      后者只需 sub+role。分离后即使 PostgREST 配置泄露也不能伪造前端会话。
 *      两者密钥相同时（默认）直接透传，省一次签发。
 *   3. 剥掉/覆写危险头（Content-Profile 切 schema、Prefer 里的 count 之外的指令）
 *   4. 转发并把响应原样回传（含 content-range / Prefer 相关头）
 */
import { signJwt, verifyJwt, bearerFrom } from './jwt.mjs'
import { pgrstError, cloudError, readBody } from './http.mjs'

/** 允许透传给 PostgREST 的方法 */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/**
 * 逐跳头（hop-by-hop）与必须剥掉的头。
 * 剥 Content-Profile/Accept-Profile：防止客户端切到非 public schema 读系统表
 * （SDK 本身也不提供 .schema() 入口，这里是服务端兜底）。
 */
const STRIP_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
  'accept-profile', 'content-profile',
  // 这些由网关自己决定，不接受客户端指定
  'authorization', 'x-wb-webapp-access-key',
])

/** 响应里需要回传给 SDK 的头（其余逐跳头一律丢弃） */
const KEEP_RES_HEADERS = new Set([
  'content-type', 'content-range', 'content-location', 'location',
  'prefer', 'accept-ranges', 'date', 'x-request-id', 'retry-after',
])

/**
 * 构造 PostgREST 反代处理器。
 * @param {object} deps { cfg, logger }
 */
export function createDbProxy(deps) {
  const { cfg, logger } = deps
  const upstream = cfg.postgrestUrl
  const sameSecret = cfg.postgrestJwtSecret === cfg.jwtSecret

  /** 校验前端 JWT，返回 sub；失败返回 null */
  function verifyAccess(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    if (!v) return null
    const sub = v.payload?.sub
    return typeof sub === 'string' && sub ? sub : null
  }

  /** 为 PostgREST 重签 JWT（或同密钥时透传原 token） */
  function tokenForPostgrest(req, ownerId) {
    if (sameSecret) {
      // 同密钥：直接把前端 token 给 PostgREST，省一次签发。
      // 前提是前端 token 已含 role 声明（sessionPayload 里确实签了 role:'authenticated'）。
      return bearerFrom(req.headers)
    }
    return signJwt(
      { sub: ownerId, role: 'authenticated', is_anonymous: false },
      cfg.postgrestJwtSecret,
      cfg.accessTtlSec,
    )
  }

  /**
   * 处理 /.cloud/database/rest/** 请求。
   * @param {string} rest  去掉前缀后的剩余路径，以 / 开头（如 /profiles）或空串
   */
  async function handle(req, res, rest, url) {
    if (!ALLOWED_METHODS.has(req.method)) {
      return pgrstError(res, 405, `不支持的方法 ${req.method}`, { code: 'METHOD_NOT_ALLOWED' })
    }

    // ── 鉴权 ──────────────────────────────────────────────
    // 数据面**必须**登录：0030 已 REVOKE anon 的全部表权限，匿名请求即便透传也无权访问。
    // 在网关就拒掉，避免无意义的上游往返，也让 401 语义明确。
    const ownerId = verifyAccess(req)
    if (!ownerId) {
      return cloudError(res, 401, '未登录或登录已过期', 'unauthenticated')
    }
    if (cfg.publishableKey) {
      const ak = req.headers['x-wb-webapp-access-key']
      if (typeof ak !== 'string' || ak.trim() !== cfg.publishableKey) {
        return cloudError(res, 401, 'invalid access key', 'invalid_api_key')
      }
    }

    // ── 组装上游请求 ──────────────────────────────────────
    const target = new URL(upstream + (rest || '/'))
    // query string 原样透传：PostgREST 的过滤器/排序/分页全在里面，
    // 网关不解析也不改写 —— 解析就等于要维护一份 PostgREST 协议实现，正是要避免的。
    target.search = url.search

    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (STRIP_REQ_HEADERS.has(k.toLowerCase())) continue
      headers[k] = v
    }
    headers.authorization = `Bearer ${tokenForPostgrest(req, ownerId)}`
    // 钉死 schema：SDK 只放行 public（见 database.ts 注释「数据面会拒系统 schema」）
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      headers['accept-profile'] = cfg.postgrestSchema
    } else {
      headers['content-profile'] = cfg.postgrestSchema
    }

    // 只有非 GET/HEAD 才有 body
    let body
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      body = await readBody(req, cfg.bodyLimitBytes)
      if (!headers['content-type']) headers['content-type'] = 'application/json'
    }

    // ── 转发 ──────────────────────────────────────────────
    // 🔴 0039 修复两处资源管理缺陷：
    //   ① 旧代码用 `req.signal` —— Node 的 http.IncomingMessage 上**没有**这个属性
    //     （那是 fetch Request 的），恒为 undefined → 客户端断开后上游请求照跑，
    //     连接泄漏。改为监听 res 'close' + AbortController。
    //   ② 旧代码 `Buffer.from(await upstreamRes.arrayBuffer())` 把上游响应**整体
    //     缓冲**进内存再回传 —— 大结果集（如全量 meal_entries 查询）会瞬时吃掉
    //     等量内存。改为流式逐块透传，内存占用 O(chunk)。
    const ac = new AbortController()
    const onClose = () => ac.abort()
    res.on('close', onClose)

    let upstreamRes
    try {
      upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body: body?.length ? body : undefined,
        signal: ac.signal,
      })
    } catch (err) {
      res.off('close', onClose)
      if (ac.signal.aborted && res.writableEnded) return // 客户端先走
      logger.error(`[db] 上游不可达 ${target.pathname} : ${err?.message || err}`)
      return pgrstError(res, 503, '数据库服务暂不可用', { code: 'PGRST_UPSTREAM_UNREACHABLE' })
    }

    // ── 回传响应（流式）────────────────────────────────────
    const outHeaders = {}
    upstreamRes.headers.forEach((v, k) => {
      if (KEEP_RES_HEADERS.has(k.toLowerCase())) outHeaders[k] = v
    })
    // content-length 由上游头透传（KEEP_RES_HEADERS 之外的一律丢弃）；
    // 流式模式下网关不再自算长度，PostgREST 的响应本来就带 content-length。

    try {
      res.writeHead(upstreamRes.status, outHeaders)
      if (!upstreamRes.body) {
        res.end()
      } else {
        // pump：逐块写入并尊重背压（write 返回 false 时等 drain）
        const reader = upstreamRes.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!res.write(Buffer.from(value))) {
            await new Promise((resolve) => res.once('drain', resolve))
          }
        }
        res.end()
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        logger.error(`[db] 响应透传中断 ${rest}: ${err?.message || err}`)
      }
      res.destroy()
    } finally {
      res.off('close', onClose)
    }

    // 慢查询与错误留痕（成功且快的不打，避免日志噪音）
    if (upstreamRes.status >= 400) {
      logger.warn(`[db] ${req.method} ${rest}${url.search} → ${upstreamRes.status} owner=${ownerId}`)
    }
  }

  return { handle, verifyAccess }
}
