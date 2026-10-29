/**
 * A1 · auth/JWT 路由处理器。
 *
 * 端点严格对齐 SDK 实测协议（2026-10-22 逆向 @tencent-ai/workbuddy-cloud-sdk 确认，
 * **不是**计划文档 §A1 的旧假设）：
 *
 *   POST /.cloud/auth/v1/verification          发码
 *        req  { phone_number, target } | { email, usage }
 *        resp { verification_id, is_user }
 *   POST /.cloud/auth/v1/verification/verify   验码 → 一次性 verification_token
 *        req  { verification_id, verification_code }
 *        resp { verification_token }
 *   POST /.cloud/auth/v1/signin                老用户换会话
 *        req  { username, verification_token }
 *        resp { access_token, refresh_token, expires_in, sub, ... }
 *   POST /.cloud/auth/v1/signup                新用户换会话
 *        req  { verification_token, phone_number|email, password? }
 *        resp 同 signin
 *   POST /.cloud/auth/v1/token                 refresh（**不是**换会话）
 *        req  { grant_type: 'refresh_token', refresh_token }
 *   GET  /.cloud/auth/v1/user/me               当前用户
 *   POST /.cloud/auth/v1/user/signout          登出
 *
 * 会话载荷字段名对齐 SDK 的 parseSession/userFromSessionPayload：
 *   access_token / refresh_token / expires_in / sub / is_anonymous / name / avatar_url
 *   （字段名写错 SDK 会抛 "response has no access_token"）
 */
import { randomBytes } from 'node:crypto'
import { signJwt, verifyJwt, bearerFrom } from './jwt.mjs'
import {
  resolveIdent, findUserByIdent, findUserByOwnerId,
  ensureUser, touchLogin, hashPassword, normalizePhone, normalizeEmail,
  bumpTokenVersion, getTokenVersion,
} from './identity.mjs'
import { sendCode } from './sms.mjs'
import { cloudError, clientIp } from './http.mjs'

/**
 * refresh_token 用不透明随机串（而非 JWT），存内存以便登出/续期时吊销。
 * 理由：JWT 无法主动失效，登出后旧 token 仍可用到过期 —— 对认证凭证不可接受。
 * ⚠️ 与 OtpStore 同为内存态：网关重启会要求用户重新登录。单实例可接受。
 */
class RefreshStore {
  constructor({ ttlSec }) {
    this.ttlSec = ttlSec
    this.map = new Map() // token -> { ownerId, expiresAt }
    this._timer = setInterval(() => this.sweep(), 60_000)
    this._timer.unref?.()
  }
  issue(ownerId) {
    const token = `${Date.now().toString(36)}-${randomBytes(24).toString('base64url')}`
    this.map.set(token, { ownerId, expiresAt: Date.now() + this.ttlSec * 1000 })
    return token
  }
  /** 取出即删（旋转）：一次 refresh 用掉旧 token、发新 token，防重放 */
  consume(token) {
    const rec = this.map.get(token)
    if (!rec) return null
    this.map.delete(token)
    if (Date.now() >= rec.expiresAt) return null
    return rec
  }
  /** 登出：吊销该用户全部 refresh_token */
  revokeAll(ownerId) {
    let n = 0
    for (const [k, v] of this.map) if (v.ownerId === ownerId) { this.map.delete(k); n++ }
    return n
  }
  sweep(now = Date.now()) {
    for (const [k, v] of this.map) if (now >= v.expiresAt) this.map.delete(k)
  }
  get size() { return this.map.size }
  close() { clearInterval(this._timer); this.map.clear() }
}

/**
 * 构造 auth 处理器。
 * @param {object} deps { cfg, pool, otp, logger, refresh }
 */
export function createAuthHandlers(deps) {
  const { cfg, pool, otp, logger } = deps
  const refresh = deps.refresh ?? new RefreshStore({ ttlSec: cfg.refreshTtlSec })

  /** 校验 publishableKey（access-key）。留空则跳过。 */
  function checkAccessKey(req) {
    if (!cfg.publishableKey) return true
    const got = req.headers['x-wb-webapp-access-key']
    return typeof got === 'string' && got.trim() === cfg.publishableKey
  }

  /** 取并校验当前 access_token → ownerId；失败返回 null */
  function authOwnerId(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    if (!v) return null
    const sub = v.payload?.sub
    return typeof sub === 'string' && sub ? sub : null
  }

  /**
   * 🔴 安全审计①（token_version 强制下线）：
   * 带 token_version 校验的鉴权 —— 验签 + 验 exp 后，再比对 payload.ver 与库内
   * token_version。不一致（用户已登出/改密 bump 过版本）→ 拒绝，旧 access token
   * 立即失效。仅在 payload 含 ver 声明时才查库（向后兼容旧 token，旧 token 靠缩短
   * 后的 exp 自然过期）。
   * @returns {Promise<string|null>} ownerId 或 null
   */
  async function authOwnerIdStrict(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    if (!v) return null
    const sub = v.payload?.sub
    if (typeof sub !== 'string' || !sub) return null
    // 旧 token 无 ver 声明：不做版本校验（靠缩短后的 exp 兜底），仅验签+exp
    if (!Number.isInteger(v.payload.ver)) return sub
    try {
      const cur = await getTokenVersion(pool, sub)
      // 用户不存在 → 拒绝；版本不一致 → 拒绝（会话已被主动作废）
      if (cur == null || cur !== v.payload.ver) return null
    } catch (err) {
      // 查库失败不放大成 401 风暴：记日志后按「版本校验不可用」放行，
      // 仍受 exp 兜底（token_version 是纵深防御，不是唯一防线）
      logger.error(`[auth] token_version 查询失败，跳过版本校验: ${err?.message || err}`)
    }
    return sub
  }

  /** 组装会话载荷（字段名须与 SDK parseSession 对齐） */
  async function sessionPayload(ownerId, user, ver) {
    const accessToken = signJwt(
      {
        sub: ownerId,
        role: 'authenticated', // PostgREST 据此 SET ROLE
        // 这些是 SDK userFromSessionPayload 会读的字段
        name: user?.nickname ?? '',
        avatar_url: user?.avatar_url ?? '',
        is_anonymous: false,
        // 🔴 安全审计①：会话版本号，登出/改密时 +1，校验时比对（强制下线）
        ver: ver ?? 1,
      },
      cfg.jwtSecret,
      cfg.accessTtlSec,
    )
    const refreshToken = refresh.issue(ownerId)
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: cfg.accessTtlSec,
      token_type: 'bearer',
      sub: ownerId,
      role: 'authenticated',
      is_anonymous: false,
      name: user?.nickname ?? '',
      avatar_url: user?.avatar_url ?? '',
    }
  }

  return {
    refresh,

    /** ── 发码 ───────────────────────────────────────────── */
    async sendVerification(req, res, body) {
      if (!checkAccessKey(req)) return cloudError(res, 401, 'invalid access key', 'invalid_api_key')

      // SDK 手机传 { phone_number, target:'ANY' }；邮箱传 { email, usage:'email' }
      const ident = resolveIdent({ phone: body.phone_number, email: body.email })
      if (ident.error) return cloudError(res, 400, ident.error, 'invalid_request')

      const ip = clientIp(req, { trustedProxies: cfg.trustedProxyIps })
      // 频率限制①：同一标识 60 秒只能发一次（与前端倒计时一致）
      const rlIdent = deps.limiterIdent.hit(`${ident.kind}:${ident.value}`)
      if (!rlIdent.ok) {
        res.setHeader('retry-after', String(rlIdent.retryAfterSec))
        return cloudError(res, 429, `验证码发送过于频繁，请 ${rlIdent.retryAfterSec} 秒后重试`, 'rate_limited')
      }
      // 频率限制②：同 IP 每小时上限，防单点刷码轰炸他人
      const rlIp = deps.limiterIp.hit(ip)
      if (!rlIp.ok) {
        res.setHeader('retry-after', String(rlIp.retryAfterSec))
        return cloudError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited')
      }

      const existing = await findUserByIdent(pool, ident.kind, ident.value, cfg.identPepper)
      const isExistingUser = !!existing

      const { verificationId, code } = otp.issue({
        identKind: ident.kind,
        identValue: ident.value,
        isExistingUser,
        ip,
      })

      // 演示账户（⑦）：demo 手机号不发真短信（它拿不到），固定码由 otp.issue 直接生成。
      // 识别依据：otp.demo 命中该号。这里跳过 sendCode，避免真短信模式下 502 挡住演示登录。
      const isDemoPhone = otp.demo && ident.kind === 'phone' && ident.value === otp.demo.phone
      if (!isDemoPhone) {
        // 按通道分流 provider：phone → smsProvider；email → emailProvider（2026-10-27 解耦）
        const isEmail = ident.kind === 'email'
        const provider = isEmail ? cfg.emailProvider : cfg.smsProvider
        const sent = await sendCode({
          provider,
          channel: isEmail ? 'email' : 'sms',
          to: ident.value,
          masked: ident.masked,
          code,
          signName: cfg.smsSignName,
          // tencent provider 所需凭据与模板参数（log/smtp provider 忽略这些字段）
          tencent: {
            secretId: cfg.smsTencentSecretId,
            secretKey: cfg.smsTencentSecretKey,
            sdkAppId: cfg.smsTencentSdkAppId,
            templateId: cfg.smsTencentTemplateId,
            region: cfg.smsTencentRegion,
          },
          // aliyun provider 所需凭据（2026-10-29；log/smtp/tencent provider 忽略这些字段）
          aliyun: {
            accessKeyId: cfg.smsAliyunAccessKeyId,
            accessKeySecret: cfg.smsAliyunAccessKeySecret,
            templateCode: cfg.smsAliyunTemplateCode,
            endpoint: cfg.smsAliyunEndpoint,
          },
          // smtp provider 所需凭据（log/tencent provider 忽略这些字段）
          smtp: {
            host: cfg.emailSmtpHost,
            port: cfg.emailSmtpPort,
            secure: cfg.emailSmtpSecure,
            user: cfg.emailSmtpUser,
            pass: cfg.emailSmtpPass,
            from: cfg.emailSmtpFrom,
            fromName: cfg.emailSmtpFromName,
          },
          otpTtlMin: Math.max(1, Math.round((cfg.otpTtlSec || 300) / 60)),
          logger,
        })
        if (!sent.ok) return cloudError(res, 502, sent.error || '验证码发送失败', 'send_failed')
      }

      logger.info(`[auth] 发码${isDemoPhone ? '（演示账户，不真发）' : ''} ${ident.kind}=${ident.masked} existing=${isExistingUser} ip=${ip}`)
      // is_user 对应 SDK 的 isExistingUser（payload.is_user === true）
      return { status: 200, body: { verification_id: verificationId, is_user: isExistingUser } }
    },

    /** ── 验码 → verification_token ─────────────────────── */
    async verifyCode(req, res, body) {
      if (!checkAccessKey(req)) return cloudError(res, 401, 'invalid access key', 'invalid_api_key')
      const r = otp.verify({ verificationId: body.verification_id, code: body.verification_code })
      if (!r.ok) {
        const map = {
          not_found: [400, '验证码已失效，请重新获取', 'invalid_verification'],
          expired: [400, '验证码已过期，请重新获取', 'expired'],
          wrong_code: [400, `验证码错误${r.attemptsLeft ? `，还可尝试 ${r.attemptsLeft} 次` : ''}`, 'invalid_code'],
          locked: [429, '尝试次数过多，请重新获取验证码', 'too_many_attempts'],
          too_many_attempts: [429, '尝试次数过多，请重新获取验证码', 'too_many_attempts'],
        }
        const [status, message, code] = map[r.reason] ?? [400, '验证码校验失败', 'invalid_code']
        return cloudError(res, status, message, code)
      }
      return { status: 200, body: { verification_token: r.verificationToken } }
    },

    /** ── 老用户登录（username + verification_token）─────── */
    async signIn(req, res, body) {
      if (!checkAccessKey(req)) return cloudError(res, 401, 'invalid access key', 'invalid_api_key')
      const vt = body.verification_token
      if (typeof vt !== 'string' || !vt) return cloudError(res, 400, '缺少 verification_token', 'invalid_request')
      const consumed = otp.consumeToken(vt)
      if (!consumed) return cloudError(res, 401, '登录凭证无效或已过期，请重新验证', 'invalid_grant')

      // username 承载手机号或邮箱（SDK 登录侧共用此字段）。优先用 token 里锁定的标识，
      // 不信任 body.username —— 防止「用 A 的验证码登录 B 的账号」。
      const kind = consumed.kind
      const value = consumed.value
      const user = await findUserByIdent(pool, kind, value, cfg.identPepper)
      if (!user) {
        // token 说 isExistingUser 但库里查无此人：可能被误报，或账号已删。
        // 按新用户建号，避免用户卡死在登录页。
        const created = await ensureUser(pool, {
          kind, value,
          masked: kind === 'phone' ? maskOf(value) : maskEmailOf(value),
          pepper: cfg.identPepper,
        })
        await touchLogin(pool, created.ownerId)
        logger.info(`[auth] signin 建号（token 有效但无档案）${kind}=${maskAny(kind, value)} owner=${created.ownerId}`)
        return { status: 200, body: await sessionPayload(created.ownerId, null, 1) }
      }
      await touchLogin(pool, user.owner_id)
      logger.info(`[auth] 登录成功 ${kind}=${maskAny(kind, value)} owner=${user.owner_id}`)
      return { status: 200, body: await sessionPayload(user.owner_id, null, user.token_version) }
    },

    /** ── 新用户注册（verification_token + 标识 + 可选密码）── */
    async signUp(req, res, body) {
      if (!checkAccessKey(req)) return cloudError(res, 401, 'invalid access key', 'invalid_api_key')
      const vt = body.verification_token
      if (typeof vt !== 'string' || !vt) return cloudError(res, 400, '缺少 verification_token', 'invalid_request')
      const consumed = otp.consumeToken(vt)
      if (!consumed) return cloudError(res, 401, '注册凭证无效或已过期，请重新验证', 'invalid_grant')

      // 标识以 token 内锁定的为准；body 里的 phone_number/email 仅作交叉校验
      const kind = consumed.kind
      const value = consumed.value
      const bodyIdent = resolveIdent({ phone: body.phone_number, email: body.email })
      if (!bodyIdent.error && bodyIdent.value !== value) {
        return cloudError(res, 400, '注册标识与验证码不匹配', 'invalid_request')
      }

      let passwordHash = null
      if (body.password) {
        const pw = String(body.password)
        if (pw.length < 6) return cloudError(res, 400, '密码至少 6 位', 'weak_password')
        passwordHash = await hashPassword(pw)
      }

      const r = await ensureUser(pool, {
        kind, value,
        masked: maskAny(kind, value),
        passwordHash,
        pepper: cfg.identPepper,
      })
      await touchLogin(pool, r.ownerId)
      logger.info(`[auth] 注册${r.created ? '' : '（已存在，幂等）'} ${kind}=${maskAny(kind, value)} owner=${r.ownerId}`)
      return { status: 200, body: await sessionPayload(r.ownerId, null, 1) }
    },

    /** ── refresh ───────────────────────────────────────── */
    async token(req, res, body) {
      if (body?.grant_type !== 'refresh_token') {
        return cloudError(res, 400, 'grant_type 必须为 refresh_token', 'unsupported_grant_type')
      }
      const rt = body.refresh_token
      if (typeof rt !== 'string' || !rt) return cloudError(res, 400, '缺少 refresh_token', 'invalid_request')
      const rec = refresh.consume(rt)
      if (!rec) return cloudError(res, 401, 'refresh_token 无效或已过期', 'invalid_grant')
      // 旋转：发新 refresh_token，旧的已在 consume 时删除
      // 🔴 安全审计①：新 access token 也要带当前 token_version，保持版本链一致
      const ver = await getTokenVersion(pool, rec.ownerId)
      const accessToken = signJwt(
        { sub: rec.ownerId, role: 'authenticated', is_anonymous: false, ver: ver ?? 1 },
        cfg.jwtSecret,
        cfg.accessTtlSec,
      )
      const newRefresh = refresh.issue(rec.ownerId)
      return {
        status: 200,
        body: {
          access_token: accessToken,
          refresh_token: newRefresh,
          expires_in: cfg.accessTtlSec,
          token_type: 'bearer',
          sub: rec.ownerId,
          role: 'authenticated',
          is_anonymous: false,
        },
      }
    },

    /** ── 当前用户 ──────────────────────────────────────── */
    async userMe(req, res) {
      // 🔴 安全审计①：用 strict 鉴权（含 token_version 校验），登出/改密后
      //   旧 access token 立即失效，不能再用它读个人信息。
      const ownerId = await authOwnerIdStrict(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthenticated')
      const user = await findUserByOwnerId(pool, ownerId)
      if (!user) return cloudError(res, 401, '账号不存在', 'unauthenticated')
      // SDK parseUser 读 sub/phone_number/email/name/avatar_url/is_anonymous
      return {
        status: 200,
        body: {
          sub: user.owner_id,
          uid: user.owner_id,
          ...(user.ident_kind === 'phone' ? { phone_number: user.ident_masked, phone: user.ident_masked } : {}),
          ...(user.ident_kind === 'email' ? { email: user.ident_masked } : {}),
          name: '',
          avatar_url: '',
          is_anonymous: false,
          created_at: user.created_at,
          last_login_at: user.last_login_at,
          login_count: user.login_count,
        },
      }
    },

    /** ── 登出 ──────────────────────────────────────────── */
    async signOut(req, res) {
      const ownerId = authOwnerId(req)
      // 登出即便 token 已过期也应成功（SDK 侧无条件清本地会话）
      if (ownerId) {
        const n = refresh.revokeAll(ownerId)
        // 🔴 安全审计①：bump token_version，让该用户**已签发的 access token**
        //   也立即失效（不只是内存里的 refresh）。这是「被盗会话可主动作废」的关键。
        //   bump 失败不阻断登出（refresh 已吊销，且 access 有 exp 兜底）。
        try {
          await bumpTokenVersion(pool, ownerId)
        } catch (err) {
          logger.error(`[auth] 登出 bump token_version 失败 owner=${ownerId}: ${err?.message || err}`)
        }
        logger.info(`[auth] 登出 owner=${ownerId} 吊销 refresh=${n} + bump token_version`)
      }
      return { status: 200, body: { ok: true } }
    },

    /** 供 A2/A3 复用的鉴权辅助 */
    authOwnerId,
    authOwnerIdStrict,
    checkAccessKey,
  }
}

// ── 掩码小工具（避免在多处 import identity 的 mask 函数）──────────────
function maskAny(kind, value) {
  return kind === 'phone' ? maskOf(value) : maskEmailOf(value)
}
function maskOf(phone) {
  const p = normalizePhone(phone) || String(phone || '')
  return p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : '***'
}
function maskEmailOf(email) {
  const e = normalizeEmail(email) || String(email || '')
  const at = e.indexOf('@')
  if (at <= 0) return '***'
  const local = e.slice(0, at)
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(local.length - 2, 5)))}@${e.slice(at + 1)}`
}

export { RefreshStore }
