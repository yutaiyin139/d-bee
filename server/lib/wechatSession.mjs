/**
 * 微信 session_key 的加密落库与读取（0046，2026-11-08）。
 *
 * ── 为什么需要它（与既有纪律的冲突是有意为之）──────────────────────────
 *   auth.mjs:294 原纪律明确写「session_key 拿到即弃：只返回 openid，不把
 *   session_key 传出、不落库、不记日志」。那条纪律在**只做微信登录**时是完美的
 *   最小权限实践。但虚拟支付要求：
 *
 *     signature = to_hex(hmac_sha256(session_key, signData))
 *
 *   —— 用户态签名的密钥**就是** session_key，且 signData 每次下单都不同，
 *   必须由服务端在下单那一刻现算。不落库就无法签名，虚拟支付根本无法工作。
 *
 *   折中方案（本模块）：
 *     ① AES-256-GCM 加密后存 app_users.wechat_session_key_enc（0046 列）
 *     ② 密钥 WECHAT_SESSION_ENC_KEY 只在服务器 env，不入库、不进日志
 *     ③ 只在生成签名的那一瞬间于内存解密，用完即出作用域
 *     ④ 带 TTL：超期视为不可用并要求重新登录（重新登录会换发 session_key）
 *     ⑤ 与 appid 绑定：试用/正式是两套独立小程序，session_key 不可跨用
 *
 * ── 🔴 三条不可破的红线 ────────────────────────────────────────────────
 *   1. session_key **绝不下发前端**（明文或密文都不行）。它一旦离开服务端，
 *      任何人都能伪造 signature 给任意 signData 签名 = 任意金额任意商品下单。
 *      → 本模块只 export「存」「取」，取的结果只在 xpay.mjs 内部使用。
 *   2. session_key **绝不进日志**（含 error 日志、含截断片段）。
 *      → 本模块所有日志只打 owner/appid/长度，不打值。
 *   3. 未配 WECHAT_SESSION_ENC_KEY 时**静默跳过存储**，微信登录照常可用。
 *      → 绝不能因为「支付没配全」而让登录也挂掉（登录是主路径，支付是增值）。
 *
 * 独立成模块（而非塞进 identity.mjs）的原因：auth.mjs 要写、xpay.mjs 要读，
 *   放进任一侧都会让另一侧反向依赖。本模块是叶子，无循环 import。
 */
import {
  createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash,
} from 'node:crypto'

/** 密文格式版本前缀。将来换算法（如改 KMS 托管）时靠它区分，避免存量密文读不出。 */
const PREFIX = 'v1'

/**
 * 归一化加密密钥：接受 64 位 hex（推荐）或任意字符串（取 sha256 派生 32 字节）。
 *
 * 为什么要兼容任意字符串：config.validate() 已把「非 64 位 hex」列为致命错误，
 * 但自测/本地开发常用随手写的口令。派生比直接报错更宽容，且**不会**静默降级安全性
 * （sha256 派生仍是满强度 256 位密钥）。
 *
 * @returns {Buffer|null} 未配置返回 null（调用方据此跳过）
 */
export function deriveSessionEncKey(keyHex) {
  if (typeof keyHex !== 'string' || !keyHex.trim()) return null
  const v = keyHex.trim()
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex')
  return createHash('sha256').update(v, 'utf8').digest()
}

/**
 * AES-256-GCM 加密 session_key。
 *
 * 选 GCM 而非 CBC：GCM 自带认证标签（tag），密文被篡改会在解密时直接抛错，
 * 而不是解出一串垃圾还当成功用。对「签名密钥」这种篡改即资损的数据，
 * 认证加密是必须的。
 *
 * @returns {string|null} `v1:<iv_b64>:<tag_b64>:<ct_b64>`；未配密钥返回 null
 */
export function encryptSessionKey(plain, keyHex) {
  const key = deriveSessionEncKey(keyHex)
  if (!key) return null
  if (typeof plain !== 'string' || !plain) return null

  const iv = randomBytes(12) // GCM 标准 96-bit nonce；每次随机，绝不复用
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

/**
 * 解密 session_key。
 *
 * 🔴 失败一律返回 null，**不抛**：调用方（下单路径）把 null 解释为
 *   「需要重新登录」，返回可读错误。若在这里抛异常，会冒到网关顶层变成 500，
 *   用户只看到「服务器错误」而不知道该重新登录 —— 排查成本天差地别。
 *
 * @returns {string|null}
 */
export function decryptSessionKey(enc, keyHex) {
  const key = deriveSessionEncKey(keyHex)
  if (!key) return null
  if (typeof enc !== 'string' || !enc) return null

  const parts = enc.split(':')
  if (parts.length !== 4 || parts[0] !== PREFIX) return null // 版本不符/格式损坏
  try {
    const iv = Buffer.from(parts[1], 'base64')
    const tag = Buffer.from(parts[2], 'base64')
    const ct = Buffer.from(parts[3], 'base64')
    // iv/tag 长度不对时 createCipheriv/setAuthTag 会抛，统一被下面 catch 收
    if (iv.length !== 12 || tag.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(ct), decipher.final()])
    const plain = out.toString('utf8')
    return plain || null
  } catch {
    return null // 密文被篡改 / 换过密钥 → 视为不可用，要求重新登录
  }
}

/**
 * 定长比较，防时序侧信道。用于 appid 校验（虽然 appid 不算秘密，
 * 但支付链路上任何比较都统一走定长，避免将来复用出漏洞）。
 */
export function safeStrEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 登录成功后写入 session_key（auth.mjs loginWechat 调用）。
 *
 * 🔴 **绝不抛异常**：写库失败（列不存在=0046 未应用、连接抖动）绝不能让
 *   微信登录失败。登录是主路径，虚拟支付是增值能力 —— 顺序不能颠倒。
 *   失败只 warn（且不打值），支付路径后续自然降级为「需要重新登录」。
 *
 * @returns {Promise<boolean>} 是否成功写入（false 不影响登录）
 */
export async function saveSessionKey(pool, { ownerId, appid, sessionKey, keyHex, logger }) {
  const enc = encryptSessionKey(sessionKey, keyHex)
  if (!enc) return false // 未配加密密钥：按红线③静默跳过
  if (!ownerId || !appid) return false
  try {
    await pool.query(
      `UPDATE public.app_users
          SET wechat_session_key_enc = $2,
              wechat_session_key_at  = now(),
              wechat_appid           = $3
        WHERE owner_id = $1`,
      [ownerId, enc, appid],
    )
    return true
  } catch (err) {
    // 只打消息不打值；0046 未应用时会报 column does not exist，这是预期降级
    logger?.warn?.(`[wechat-session] session_key 落库失败 owner=${ownerId}: ${err?.message || err}`)
    return false
  }
}

/**
 * 读取可用 session_key（xpay.mjs 生成签名时调用）。
 *
 * 三重校验，任一不过即返回 null（→ 前端提示重新登录）：
 *   ① appid 必须与存的时候一致（试用/正式两套小程序，session_key 不可跨用）
 *   ② 未超 TTL（微信未承诺有效期，但重新登录会换发；超期签名可能已被微信判失效）
 *   ③ 密文能正常解密（换过 WECHAT_SESSION_ENC_KEY 或密文损坏 → null）
 *
 * @returns {Promise<string|null>}
 */
export async function loadSessionKey(pool, { ownerId, appid, keyHex, ttlHours = 72, logger }) {
  if (!ownerId) return null
  try {
    const { rows } = await pool.query(
      `SELECT wechat_session_key_enc AS enc,
              wechat_session_key_at  AS at,
              wechat_appid           AS appid
         FROM public.app_users
        WHERE owner_id = $1`,
      [ownerId],
    )
    const row = rows?.[0]
    if (!row?.enc) return null

    // ① appid 绑定校验
    if (appid && row.appid && !safeStrEqual(row.appid, appid)) {
      logger?.warn?.(`[wechat-session] appid 不符 owner=${ownerId} stored=${row.appid} got=${appid}`)
      return null
    }

    // ② TTL 校验（列为 NULL 视为不可判定 → 保守拒绝，要求重新登录）
    const at = row.at ? new Date(row.at).getTime() : NaN
    if (!Number.isFinite(at)) return null
    const ttlMs = Math.max(1, Number(ttlHours) || 72) * 3600_000
    if (Date.now() - at > ttlMs) return null

    // ③ 解密
    return decryptSessionKey(row.enc, keyHex)
  } catch (err) {
    logger?.warn?.(`[wechat-session] session_key 读取失败 owner=${ownerId}: ${err?.message || err}`)
    return null
  }
}
