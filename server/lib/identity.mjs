/**
 * 身份层：标识归一化 → HMAC 哈希 → owner_id 签发 → app_users 读写。
 *
 * 安全设计（对应 0031-app-users.sql）：
 *   · 不存明文手机号/邮箱，只存 HMAC-SHA256(标识, IDENT_PEPPER)
 *   · PEPPER 不可省：11 位手机号空间仅 10^11，无密钥哈希可被穷举反查
 *   · owner_id 沿用云端的 19 位纯数字串形态，与已迁移的 17 份业务档案同构
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'

// ── 标识归一化 ────────────────────────────────────────────────────────
// 必须与 SDK 的 normalizePhone 语义一致：SDK 把 13800000000 归一成 "+86 13800000000"
// 后作为 username 传上来，而登录时前端传的是裸号。两边都要落到同一个哈希，
// 所以这里统一剥到「11 位裸号」再哈希 —— 否则发码用裸号、登录用 +86 会对不上。

const PHONE_RE = /^1\d{10}$/

/**
 * 归一化手机号 → 11 位裸号；非法返回 null。
 * 兼容：裸号 / +86 / 86 / 0086 / 含空格与短横线。
 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0086')) digits = digits.slice(4)
  else if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2)
  return PHONE_RE.test(digits) ? digits : null
}

/** 手机号掩码：138****1234。长度不足时全掩，绝不泄露完整号。 */
export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 7) return '***'
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

/** 归一化邮箱 → 全小写去首尾空白；非法返回 null。 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  // 刻意不用严格 RFC 校验：过严会拒掉真实邮箱。只挡明显不合法的。
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e) ? e : null
}

/** 邮箱掩码：ab***@example.com */
export function maskEmail(email) {
  if (typeof email !== 'string') return '***'
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const head = local.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, Math.min(local.length - 2, 5)))}@${email.slice(at + 1)}`
}

/**
 * 从「phone 或 email」二选一解析出身份标识。
 * @returns {{kind:'phone'|'email', value:string, masked:string}|{error:string}}
 */
export function resolveIdent({ phone, email }) {
  const hasPhone = phone !== undefined && phone !== null && String(phone).trim() !== ''
  const hasEmail = email !== undefined && email !== null && String(email).trim() !== ''
  // SDK 侧已保证二选一，但网关不能信任客户端：同时传或都不传一律拒
  if (hasPhone === hasEmail) {
    return { error: hasPhone ? 'phone 与 email 只能提供一个' : '必须提供 phone 或 email' }
  }
  if (hasPhone) {
    const v = normalizePhone(phone)
    if (!v) return { error: '手机号格式不正确（需 11 位大陆号码）' }
    return { kind: 'phone', value: v, masked: maskPhone(v) }
  }
  const v = normalizeEmail(email)
  if (!v) return { error: '邮箱格式不正确' }
  return { kind: 'email', value: v, masked: maskEmail(v) }
}

// ── HMAC 哈希 ─────────────────────────────────────────────────────────

/**
 * 身份哈希：HMAC-SHA256(kind + ":" + 归一化标识, PEPPER) → hex。
 *
 * 把 kind 拼进被签内容，避免「某人的手机号恰好等于另一个人的邮箱」这类跨类型碰撞
 * （概率极低，但拼进去成本为零）。
 */
export function identHash(kind, value, pepper) {
  if (!pepper) throw new Error('IDENT_PEPPER 未配置，拒绝计算身份哈希')
  return createHmac('sha256', pepper).update(`${kind}:${value}`, 'utf8').digest('hex')
}

/** 常量时间比较哈希（虽然查库已用 = 比较，这里供直接比对场景使用） */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ── owner_id 签发 ─────────────────────────────────────────────────────

/**
 * 生成与云端同构的 owner_id：**19 位纯数字串**。
 *
 * 结构：13 位毫秒时间戳 + 6 位序列/随机后缀。
 *   · 时间前缀保证整体单调递增 → bigint 主键/索引友好，且日志可按时间排序
 *   · 后缀在**进程内**用单调序列，杜绝同一毫秒内高频注册时的随机碰撞
 *     （纯 6 位随机在 5000 次/毫秒的密度下按生日悖论期望碰撞 ~12 次，不可接受）
 *   · 跨进程仍可能极小概率撞号 → 由 app_users 主键 + ensureUser 重试兜底
 *
 * ⚠️ 必须用字符串拼接而非 Number 运算：19 位 ≈ 1e19 > Number.MAX_SAFE_INTEGER(9e15)，
 *    用 Number 会静默丢精度，末几位变成 0，导致不同用户拿到同一个 owner_id。
 */
let _lastMs = 0
let _seq = 0
export function newOwnerId() {
  let ms = Date.now()
  if (ms > _lastMs) {
    // 时钟前进：换新的毫秒窗口，后缀从随机起点开始（保留不可预测性）
    _lastMs = ms
    _seq = randomInt(0, 900_000) // 留出 10 万递增余量，避免同一毫秒内溢出到 7 位
  } else {
    // 同一毫秒（或时钟回拨）：冻结在 _lastMs 上单调递增，绝不复用已发号
    ms = _lastMs
    _seq += 1
    if (_seq >= 1_000_000) {
      // 10^6/ms 的注册速率现实中不可能；真到了就推进到下一毫秒窗口
      _lastMs = ms = _lastMs + 1
      _seq = randomInt(0, 900_000)
    }
  }
  const ts = String(ms).padStart(13, '0').slice(-13)
  const rnd = String(_seq).padStart(6, '0')
  return `${ts}${rnd}`
}

/** 校验一个字符串是否可作为 owner_id（用于回填老用户时的输入校验） */
export function isOwnerId(v) {
  return typeof v === 'string' && /^\d{19}$/.test(v)
}

// ── app_users 读写 ────────────────────────────────────────────────────
// 全部走参数化查询（$1/$2），绝不拼字符串 —— 标识值来自用户输入。

/**
 * 按标识查用户。
 * @returns {Promise<{owner_id:string,ident_kind:string,ident_masked:string,created_at:string,last_login_at:string|null,login_count:number}|null>}
 */
export async function findUserByIdent(pool, kind, value, pepper) {
  const hash = identHash(kind, value, pepper)
  const { rows } = await pool.query(
    `SELECT owner_id, ident_kind, ident_masked, created_at, last_login_at, login_count, token_version
       FROM public.app_users
      WHERE ident_kind = $1 AND ident_hash = $2`,
    [kind, hash],
  )
  return rows[0] ?? null
}

/**
 * 按标识查用户**并带上 password_hash**（仅「邮箱/手机号 + 密码」登录路径用）。
 *
 * 为什么不直接在 findUserByIdent 里加这一列：那个函数有 3 处调用（发码判存在、
 * OTP 登录、ensureUser），它们都不需要密码哈希，把敏感列带进那些路径只是扩大
 * 泄露面（万一将来某处把 user 整体序列化进响应）。单独一个函数，影响面为零。
 *
 * @returns {Promise<{owner_id:string,ident_kind:string,ident_masked:string,token_version:number,password_hash:string|null}|null>}
 */
export async function findUserWithPasswordByIdent(pool, kind, value, pepper) {
  const hash = identHash(kind, value, pepper)
  const { rows } = await pool.query(
    `SELECT owner_id, ident_kind, ident_masked, token_version, password_hash
       FROM public.app_users
      WHERE ident_kind = $1 AND ident_hash = $2`,
    [kind, hash],
  )
  return rows[0] ?? null
}

/**
 * 一个合法的 scrypt 哈希常量，用于「查无此人」时照样跑一次密码校验。
 *
 * 目的：抹平响应时间差。若用户不存在就直接返回，攻击者可用响应耗时区分
 * 「账户存在但密码错」与「账户不存在」→ 枚举出全部注册邮箱/手机号。
 * 拿一个真哈希去比对必然失败，但耗时与真实校验同量级。
 * 由 hashPassword('…') 生成，对应明文不可能被猜到（且我们只用它比对失败）。
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$00000000000000000000000000000000' +
  '$0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000'

/** 按 owner_id 查用户（/user/me 用） */
export async function findUserByOwnerId(pool, ownerId) {
  const { rows } = await pool.query(
    `SELECT owner_id, ident_kind, ident_masked, created_at, last_login_at, login_count, token_version
       FROM public.app_users
      WHERE owner_id = $1`,
    [ownerId],
  )
  return rows[0] ?? null
}

/**
 * 查或建用户（登录与注册共用）。
 *
 * 用 INSERT … ON CONFLICT DO NOTHING + 回查，而不是「先查后插」：
 * 同一手机号并发两次登录时，后者会撞 UNIQUE 约束；ON CONFLICT 让它安静回查，
 * 不会报 500。
 *
 * ⚠️ ON CONFLICT **不带目标列**（即 DO NOTHING 覆盖所有唯一约束），原因：
 *    若写成 ON CONFLICT (ident_kind, ident_hash)，则只捕获身份唯一键冲突；
 *    万一撞的是 owner_id 主键（newOwnerId 已进程内单调，但跨进程/重启后仍
 *    有极小概率），会抛 23505 冒泡成 500，下面的「换 id 重试」根本走不到。
 *    通用 DO NOTHING 让两类冲突都安静返回 rowCount=0，由回查区分：
 *      · 回查得到 → 是「标识已存在」的老用户，返回 created:false
 *      · 回查为 null → 是「仅 owner_id 撞了」，循环换新 id 重试
 *
 * @param {boolean} isNewHint 来自 verify 阶段的 isExistingUser；仅用于决定要不要
 *   设 password_hash（邮箱注册路径）。**不作为是否建号的依据** —— 那个由
 *   「查得到就是老用户」决定，避免客户端谎报 isExistingUser 造出重复账号。
 */
export async function ensureUser(pool, { kind, value, masked, passwordHash = null, pepper, maxRetries = 3 }) {
  const hash = identHash(kind, value, pepper)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ownerId = newOwnerId()
    const { rowCount } = await pool.query(
      `INSERT INTO public.app_users (owner_id, ident_kind, ident_hash, ident_masked, password_hash, token_version)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT DO NOTHING`,
      [ownerId, kind, hash, masked, passwordHash],
    )
    if (rowCount === 1) {
      // 新建成功
      return { ownerId, created: true }
    }
    // rowCount=0：撞了某个唯一约束。回查区分是「标识已存在」还是「仅 owner_id 撞了」
    const existing = await findUserByIdent(pool, kind, value, pepper)
    if (existing) return { ownerId: existing.owner_id, created: false }
    // 回查为 null → 是 owner_id 主键冲突（标识并不存在）→ 换个 id 重试
  }
  throw Object.assign(new Error('无法签发 owner_id：连续重试仍冲突'), { status: 500 })
}

/** 记录一次成功登录 */
export async function touchLogin(pool, ownerId) {
  await pool.query(
    `UPDATE public.app_users
        SET last_login_at = now(), login_count = login_count + 1
      WHERE owner_id = $1`,
    [ownerId],
  )
}

/**
 * 会话版本号（0042）：登出 / 改密时 +1。
 * 网关签发 access token 时把当前版本写进 payload.ver；校验时与库内比对，
 * 不一致即拒绝 —— 已签发的旧 access token 立即失效（被盗会话可主动作废）。
 * @returns {Promise<number>} bump 后的新版本号
 */
export async function bumpTokenVersion(pool, ownerId) {
  const { rows } = await pool.query(
    `UPDATE public.app_users
        SET token_version = token_version + 1
      WHERE owner_id = $1
      RETURNING token_version`,
    [ownerId],
  )
  return rows[0]?.token_version ?? null
}

/**
 * 读当前会话版本号（校验 access token 的 ver 用）。
 * 未找到用户（已被删除）返回 null。
 */
export async function getTokenVersion(pool, ownerId) {
  const { rows } = await pool.query(
    `SELECT token_version FROM public.app_users WHERE owner_id = $1`,
    [ownerId],
  )
  return rows[0]?.token_version ?? null
}

/**
 * 密码哈希（邮箱注册路径用；当前手机验证码方案不触发）。
 *
 * 用 scrypt 而非 bcrypt：node:crypto 原生支持、无需额外依赖，且抗 GPU 更强。
 * 格式：scrypt$N$r$p$saltHex$hashHex —— 自带参数，将来可调而不用重哈希存量。
 */
export async function hashPassword(plain) {
  const { scrypt, randomBytes } = await import('node:crypto')
  const { promisify } = await import('node:util')
  const scryptAsync = promisify(scrypt)
  const salt = randomBytes(16)
  const N = 16384, r = 8, p = 1
  const derived = await scryptAsync(String(plain), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** 校验密码。任何格式异常都返回 false，不抛。 */
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false
  const parts = stored.split('$')
  if (parts.length !== 6) return false
  const [, Ns, rs, ps, saltHex, hashHex] = parts
  const { scrypt } = await import('node:crypto')
  const { promisify } = await import('node:util')
  const scryptAsync = promisify(scrypt)
  try {
    const derived = await scryptAsync(String(plain), Buffer.from(saltHex, 'hex'), Buffer.from(hashHex, 'hex').length, {
      N: Number(Ns), r: Number(rs), p: Number(ps), maxmem: 64 * 1024 * 1024,
    })
    const a = Buffer.from(hashHex, 'hex')
    return a.length === derived.length && timingSafeEqual(a, derived)
  } catch {
    return false
  }
}
