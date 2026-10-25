/**
 * 验证码（OTP）与一次性 verification_token 的签发/校验。
 *
 * 存储策略：**纯内存 + TTL**，不落库。
 *   · 验证码是 5 分钟寿命的临时凭证，落库等于把「谁在什么时候试图登录」长期留存，
 *     违反 PIPL 最小必要；内存态天然随进程销毁。
 *   · 代价：网关重启会让**正在进行中**的登录流程失效（用户需重新发码）。
 *     单实例 systemd 下这是可接受的（重启是低频事件，且不影响已登录用户的 JWT）。
 *   · 若将来横向扩容成多实例，须换 Redis —— 见 http.mjs RateLimiter 的同款说明。
 *
 * 安全要点：
 *   · 验证码**不存明文**，存 HMAC-SHA256(code, pepper)；内存 dump / 日志泄露也拿不到码
 *   · 错误次数上限 + 一次性消费，防暴力试码（6 位数字仅 10^6 空间，不限次可穷举）
 *   · verification_token 同样一次性：用过即焚，防重放
 *   · 全部比对走常量时间
 */
import { createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto'

const hex = (b) => Buffer.from(b).toString('hex')
const eqHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** 生成 6 位数字验证码。用 randomInt（CSPRNG），不可用 Math.random。 */
export function genCode(digits = 6) {
  const n = randomInt(0, 10 ** digits)
  return String(n).padStart(digits, '0')
}

export function genId(prefix, bytes = 16) {
  return `${prefix}_${hex(randomBytes(bytes))}`
}

/**
 * 内存态临时凭证仓库。两类凭证分开存，语义不同：
 *   challenges: verificationId → 验证码挑战（发码阶段）
 *   tokens:     verificationToken → 已验码的换会话凭证（一次性）
 */
export class OtpStore {
  /**
   * @param {object} opts
   * @param {string} opts.pepper   HMAC 密钥（复用 IDENT_PEPPER 即可，二者都是服务端秘密）
   * @param {number} opts.codeTtlSec     验证码有效期（默认 300）
   * @param {number} opts.tokenTtlSec    verification_token 有效期（默认 120：验完码应立刻换会话）
   * @param {number} opts.maxAttempts    单个挑战最多试错次数（默认 5）
   * @param {string} [opts.masterCode]   万能码；仅开发/未采购短信时用，生产必须留空
   * @param {{phone:string, code:string}} [opts.demo]   审核演示账户：仅该手机号可用的固定验证码。
   *   与万能码的本质区别——它只解锁这一个号，不构成全局后门，故生产可保留。
   */
  constructor({ pepper, codeTtlSec = 300, tokenTtlSec = 120, maxAttempts = 5, masterCode = '', demo = null }) {
    if (!pepper) throw new Error('OtpStore 需要 pepper')
    this.pepper = pepper
    this.codeTtlSec = codeTtlSec
    this.tokenTtlSec = tokenTtlSec
    this.maxAttempts = maxAttempts
    this.masterCode = typeof masterCode === 'string' ? masterCode.trim() : ''
    // 演示账户：demo.phone 归一化裸号 + demo.code 固定码。任一缺失即整体禁用。
    this.demo = demo && demo.phone && demo.code ? { phone: demo.phone, code: demo.code.trim() } : null
    this.challenges = new Map()
    this.tokens = new Map()
    // 定期清理过期项，防止长期运行内存只增不减
    this._timer = setInterval(() => this.sweep(), 60_000)
    this._timer.unref?.()
  }

  _hmac(s) {
    return createHmac('sha256', this.pepper).update(String(s), 'utf8').digest('hex')
  }

  /**
   * 签发一个验证码挑战。
   * @param {{identKind:string, identValue:string, isExistingUser:boolean, ip?:string}} p
   * @returns {{verificationId:string, code:string}} code 仅供 log 模式打印，**不得**返回给客户端
   */
  issue({ identKind, identValue, isExistingUser, ip = '' }) {
    // 演示账户：发码给演示号时直接返回固定码（不走随机码），
    // 让审核员/测试人员无需真短信即可登录。仅 phone 类型生效。
    const isDemo = this.demo && identKind === 'phone' && identValue === this.demo.phone
    const code = isDemo ? this.demo.code : genCode()
    const verificationId = genId('ver')
    const now = Date.now()
    this.challenges.set(verificationId, {
      kind: identKind,
      value: identValue,
      codeHash: this._hmac(code),
      isExistingUser: isExistingUser === true,
      // 演示号跳过错误次数限制（固定码不会错）；普通号走 maxAttempts 上限
      attempts: isDemo ? Number.NEGATIVE_INFINITY : 0,
      ip,
      createdAt: now,
      expiresAt: now + this.codeTtlSec * 1000,
    })
    return { verificationId, code }
  }

  /**
   * 校验验证码。成功则**销毁挑战**并签发一次性 verification_token。
   *
   * @returns {{ok:true, verificationToken:string, isExistingUser:boolean, ident:{kind:string,value:string}}
   *          |{ok:false, reason:'not_found'|'expired'|'wrong_code'|'too_many_attempts'|'locked',
   *            retryAfterSec?:number, attemptsLeft?:number}}
   */
  verify({ verificationId, code }) {
    if (typeof verificationId !== 'string' || typeof code !== 'string' || !code.trim()) {
      return { ok: false, reason: 'not_found' }
    }
    const c = this.challenges.get(verificationId)
    if (!c) return { ok: false, reason: 'not_found' }
    const now = Date.now()
    if (now >= c.expiresAt) {
      this.challenges.delete(verificationId)
      return { ok: false, reason: 'expired' }
    }

    // 万能码优先：仅当显式配置时生效（生产环境 config.validate 会拦住）
    const isMaster = this.masterCode !== '' && eqHex(this._hmac(code.trim()), this._hmac(this.masterCode))
    if (!isMaster) {
      // 先判次数再比对：锁定后即便猜中码也拒绝，避免「无限次试到锁定边界」
      if (c.attempts >= this.maxAttempts) {
        this.challenges.delete(verificationId)
        return { ok: false, reason: 'locked' }
      }
      if (!eqHex(this._hmac(code.trim()), c.codeHash)) {
        c.attempts += 1
        const left = this.maxAttempts - c.attempts
        if (left <= 0) {
          this.challenges.delete(verificationId)
          return { ok: false, reason: 'locked' }
        }
        return { ok: false, reason: 'wrong_code', attemptsLeft: left }
      }
    }

    // 成功：挑战一次性消费（立即删除），换发 verification_token
    this.challenges.delete(verificationId)
    const verificationToken = genId('vt')
    this.tokens.set(verificationToken, {
      kind: c.kind,
      value: c.value,
      isExistingUser: c.isExistingUser,
      expiresAt: Date.now() + this.tokenTtlSec * 1000,
    })
    return {
      ok: true,
      verificationToken,
      isExistingUser: c.isExistingUser,
      ident: { kind: c.kind, value: c.value },
    }
  }

  /**
   * 消费 verification_token（signin/signup 时调用）。**一次性**：取出即删。
   * @returns {{kind:string,value:string,isExistingUser:boolean}|null}
   */
  consumeToken(verificationToken) {
    if (typeof verificationToken !== 'string' || !verificationToken) return null
    const t = this.tokens.get(verificationToken)
    if (!t) return null
    this.tokens.delete(verificationToken) // 先删再用：即便后续流程抛错也不可重放
    if (Date.now() >= t.expiresAt) return null
    return { kind: t.kind, value: t.value, isExistingUser: t.isExistingUser }
  }

  /** 该挑战还剩多久（秒），供发码频率限制判断。不存在返回 0。 */
  ageSec(verificationId) {
    const c = this.challenges.get(verificationId)
    return c ? Math.max(0, Math.round((Date.now() - c.createdAt) / 1000)) : 0
  }

  sweep(now = Date.now()) {
    for (const [k, v] of this.challenges) if (now >= v.expiresAt) this.challenges.delete(k)
    for (const [k, v] of this.tokens) if (now >= v.expiresAt) this.tokens.delete(k)
  }

  get stats() {
    return { challenges: this.challenges.size, tokens: this.tokens.size }
  }

  close() {
    clearInterval(this._timer)
    this.challenges.clear()
    this.tokens.clear()
  }
}
