/**
 * 应用装配：把 config / 连接池 / OTP / 限流 / 各模块路由组装成一个 http.Server。
 *
 * 抽成工厂的唯一目的是**可测性**：tools/gateway-selftest.mjs 可以注入 mock pool
 * 起一个真实 HTTP 服务做端到端断言，而不需要连真数据库。
 * index.mjs 只负责读 env、连真库、listen。
 */
import http from 'node:http'
import { Router, RateLimiter, sendJson, cloudError, pgrstError, readJson, clientIp } from './http.mjs'
import { OtpStore } from './otp.mjs'
import { createAuthHandlers } from './auth.mjs'
import { createDbProxy } from './dbproxy.mjs'
import { createLlmHandlers } from './llm.mjs'
import { createIapHandlers } from './iap.mjs'

/**
 * @param {object} deps
 * @param {object} deps.cfg       loadConfig() 产物
 * @param {object} deps.pool      业务角色连接池（A2 反代不用它，但 healthz 用）
 * @param {object} deps.gatewayPool 身份角色连接池（app_users 读写）
 * @param {object} deps.logger
 * @param {object} [deps.otp]     可注入（自测用）
 * @param {boolean} [deps.enableDbProxy=true] 自测可关掉以免真连 PostgREST
 * @param {boolean} [deps.enableLlm=true]
 * @param {boolean} [deps.enableIap=true]
 * @param {typeof globalThis.fetch} [deps.fetchImpl] 自测注入（iap 外呼 Apple 用）
 * @returns {{server: http.Server, router: Router, otp: OtpStore, auth: object, llm: object, iap: object, limiters: object}}
 */
export function createApp(deps) {
  const { cfg, pool, gatewayPool, logger } = deps

  const otp = deps.otp ?? new OtpStore({
    pepper: cfg.identPepper,
    codeTtlSec: cfg.otpTtlSec,
    tokenTtlSec: 120,
    maxAttempts: cfg.otpMaxAttempts,
    // 万能码只在 log 模式下生效：真短信模式若还留着万能码，等于后门
    masterCode: cfg.smsProvider === 'log' ? cfg.smsMasterCode : '',
    // 审核演示账户（⑦）：仅 DEMO_PHONE 可用 DEMO_CODE 固定码登录，
    // 与 provider 无关（log/tencent 均生效），生产也允许保留（只锁一个号）。
    demo: cfg.demoPhone && cfg.demoCode ? { phone: cfg.demoPhone, code: cfg.demoCode } : null,
  })

  const limiterIdent = new RateLimiter({ windowMs: cfg.otpResendSec * 1000, limit: 1 })
  const limiterIp = new RateLimiter({ windowMs: 3600_000, limit: cfg.otpIpHourLimit })
  const limiterApi = new RateLimiter({ windowMs: 60_000, limit: cfg.rateLimitPerMin, maxKeys: 100_000 })
  const usageLimiter = new RateLimiter({ windowMs: 86_400_000, limit: cfg.llmDailyCapPerUser, maxKeys: 200_000 })

  const auth = createAuthHandlers({ cfg, pool: gatewayPool, otp, logger, limiterIdent, limiterIp })
  const dbProxy = deps.enableDbProxy === false ? null : createDbProxy({ cfg, logger, gatewayPool })
  // LLM 用业务池（dbee_app）：0039 的 llm_gate 只授 dbee_app EXECUTE。
  // gatewayPool 用于 token_version 校验（安全审计①），与业务池分离。
  const llm = deps.enableLlm === false ? null : createLlmHandlers({ cfg, logger, usageLimiter, pool, gatewayPool })
  // IAP 走业务池（dbee_app）：核销函数 0037 只授 dbee_app EXECUTE。
  // 未配 APPLE_BUNDLE_ID 时端点自返 503（见 iap.mjs notConfigured），无需条件装配。
  const iap = deps.enableIap === false ? null : createIapHandlers({
    cfg, pool, logger, gatewayPool,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.verifyJwsImpl ? { verifyJwsImpl: deps.verifyJwsImpl } : {}),
  })

  const router = new Router()
  const A = '/.cloud/auth/v1'

  /**
   * 把「handler 返回 {status,body} 或自己写 res」统一成一种形态。
   * auth 处理器里既有 return {status,body}（成功路径），也有直接 cloudError(res,…)
   * （错误路径），包装器靠 res.writableEnded 区分二者。
   */
  const wrap = (fn) => async (req, res, ctx) => {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await ctx.readJson() : {}
    const out = await fn(req, res, body)
    if (out && typeof out === 'object' && 'status' in out && !res.writableEnded) {
      sendJson(res, out.status, out.body)
    }
  }

  router.on('POST', `${A}/verification`, wrap(auth.sendVerification))
  router.on('POST', `${A}/verification/verify`, wrap(auth.verifyCode))
  router.on('POST', `${A}/signin`, wrap(auth.signIn))
  router.on('POST', `${A}/signup`, wrap(auth.signUp))
  router.on('POST', `${A}/token`, wrap(auth.token))
  router.on('GET', `${A}/user/me`, wrap(auth.userMe))
  router.on('POST', `${A}/user/signout`, wrap(auth.signOut))

  if (llm) {
    router.on('GET', '/.cloud/llm/models', wrap(llm.listModels))
    router.on('POST', '/.cloud/llm/chat/completions', wrap(llm.chatCompletions))
  }

  if (iap) {
    // 客户端购买/恢复后回传收据 → 验签 → 幂等核销（需 Bearer）
    router.on('POST', '/.cloud/payment/apple/verify', wrap(iap.verify))
    // App Store Server Notifications V2（Apple 直发，无 Bearer，靠 JWS x5c 验签）
    router.on('POST', '/.cloud/payment/apple/notifications', wrap(iap.notifications))
  }

  // 探活：不鉴权。返回各依赖可达性，供 nginx/systemd/deploy 脚本判活
  router.on('GET', '/.cloud/healthz', async (req, res) => {
    const out = { ok: true, ts: Date.now(), db: 'skipped', otp: otp.stats }
    if (pool?.query) {
      try {
        const { rows } = await pool.query('SELECT current_user AS u, current_database() AS d')
        out.db = { ok: true, user: rows[0]?.u, database: rows[0]?.d }
      } catch (err) {
        out.ok = false
        out.db = { ok: false, error: err.message }
      }
    }
    sendJson(res, out.ok ? 200 : 503, out)
  })

  if (dbProxy) {
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD']) {
      router.onPrefix(m, '/.cloud/database/rest', (req, res, ctx) =>
        dbProxy.handle(req, res, ctx.rest, ctx.url),
      )
    }
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    } catch {
      return sendJson(res, 400, { message: 'malformed URL' })
    }
    const pathname = url.pathname

    // CORS：网关与前端同源（经 nginx），但原生端 CapacitorHttp 会带 Origin。
    // 回显具体 Origin 而非 *，且不开 allow-credentials（JWT 走 Authorization 头，不用 cookie）
    const origin = req.headers.origin
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader(
        'access-control-allow-headers',
        'authorization,content-type,x-wb-webapp-access-key,accept,prefer,x-conversation-id',
      )
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,HEAD,OPTIONS')
      res.setHeader('access-control-max-age', '600')
      res.setHeader('vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    // 全局限流（按 IP）。healthz 豁免，否则探活可能被自己的限流挡住。
    // Apple webhook 也豁免：来源是 Apple 的少数固定 IP，按 IP 限流会把
    // 同一批订阅续订通知误伤成 429，而 Apple 对非 200 会重试 → 重试风暴。
    // 该端点的安全不靠限流，靠 JWS x5c 证书链验签（见 iap.mjs）。
    // 🔴 0039：XFF 只在直连对端可信时解析（clientIp 内部判定），防伪造 XFF 绕限流。
    const ipKey = clientIp(req, { trustedProxies: cfg.trustedProxyIps })
    const rateLimitExempt =
      pathname === '/.cloud/healthz' ||
      pathname === '/.cloud/payment/apple/notifications'
    if (!rateLimitExempt) {
      const rl = limiterApi.hit(ipKey)
      if (!rl.ok) {
        res.setHeader('retry-after', String(rl.retryAfterSec))
        return cloudError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited')
      }
    }

    const ctx = { url, readJson: () => readJson(req, cfg.bodyLimitBytes) }

    try {
      const matched = router.match(req.method, pathname)
      if (!matched) {
        // 数据面用 PostgREST 错误形状，其余用 CloudError 形状（SDK 分别解析）
        if (pathname.startsWith('/.cloud/database/')) {
          return pgrstError(res, 404, `未知数据路径 ${pathname}`, { code: 'PGRST200' })
        }
        return cloudError(res, 404, `未知端点 ${pathname}`, 'not_found')
      }
      await matched.handler(req, res, { ...ctx, rest: matched.rest })
    } catch (err) {
      if (!res.writableEnded) {
        const status = err?.status || 500
        if (status >= 500) logger.error(`[http] ${req.method} ${pathname} → ${status}: ${err?.stack || err}`)
        // 5xx 不回传内部错误细节（可能含表名/SQL），只回通用文案
        sendJson(res, status, { message: status >= 500 ? '服务器内部错误' : err.message })
      } else {
        logger.error(`[http] ${req.method} ${pathname} 响应已结束后出错: ${err?.message || err}`)
      }
    } finally {
      const ms = Date.now() - started
      // 慢请求留痕；SSE 长连接天然慢，排除掉避免噪音
      if (ms > 1000 && !pathname.includes('chat/completions')) {
        logger.warn(`[http] 慢请求 ${req.method} ${pathname} ${ms}ms`)
      }
    }
  })

  return {
    server, router, otp, auth, llm, dbProxy, iap,
    limiters: { limiterIdent, limiterIp, limiterApi, usageLimiter },
  }
}
