/**
 * WX-1 · 微信运动步数解密端点（2026-11-17，WX-0 隐私指引已审核通过）。
 *
 *   POST /.cloud/auth/v1/werun/sync
 *        req  { code, appid, encryptedData, iv } + Bearer
 *        resp { steps, activeKcal: 0, status: 'ok'|'empty', syncedAt }
 *
 * ── 为什么只在服务端解密，且只返回当天一步数 ──────────────────────────
 *   wx.getWeRunData() 返回 encryptedData + iv，明文密钥 session_key 只在微信服务端
 *   与本次 code2session 的内存结果里。项目是 selfhost 无云开发，拿不到 cloudID，
 *   必须走密文解密（规划 §8）。解出的 stepInfoList 覆盖过去 31 天 —— 属敏感个人信息，
 *   🔴 本端点只取「北京时间当天零点」那一条 step 回传，其余明细不落库、不回传、不上传。
 *
 * ── 五条安全红线（逐条对应代码，不是口号）────────────────────────────
 *   ① 鉴权：必须 Bearer（用户态）；authOwnerIdStrict 含 token_version 校验，
 *      公开 access-key 不足以保护步数（否则任何人可解别人步数）。
 *   ② 归属绑定：code2session 的 openid 拼成 `wx:<openid>` 必须与 token 的 ownerId
 *      完全一致，否则 403 —— 防 A 用户借 B 的会话解出 B 的步数（串号）。
 *   ③ 输入白名单：只信 {code, appid, encryptedData, iv}；🔴 **绝不读 body.steps**
 *      —— 步数只来自服务端解密值，客户端伪造 steps 不影响 netKcal/可吃回额度。
 *   ④ session_key 复用 auth.exchangeWechatCode 的**同批次内存结果**：不下发前端、
 *      不进日志、不落库（不调 saveSessionKey/loadSessionKey）。每次新 code 即时换，
 *      绕开 TTL 与「重新登录换发 session_key 导致旧密文解不开」的坑（规划 §9 方案 A）。
 *   ⑤ 完整性：AES-128-CBC 解密后校验 watermark.appid === 配置 appid；
 *      iv/key 长度、padding、JSON 结构异常一律 error，不猜值、不返回半截数据。
 *
 * ── 失败映射（对齐规划 §9）───────────────────────────────────────────
 *   code 失效 40029/40163 → 401 invalid_grant（前端重新 wx.login 重试一次）
 *   归属不符 → 403 forbidden；appid 未配置 → 503（沿用 exchangeWechatCode）
 *   解密/watermark/结构异常 → 400 werun_decrypt_failed（不泄漏内部细节）
 *   当天无样本 → 200 { status:'empty', steps:0 }（不是 error，今天真的没数据）
 */
import { createDecipheriv } from 'node:crypto'
import { cloudError } from './http.mjs'

/** 微信 appid 形态：wx + 16 位小写字母数字（与 auth.mjs loginWechat 同款校验） */
const APPID_RE = /^wx[0-9a-f]{16}$/i

/**
 * 北京时间（UTC+8）「今天零点」对应的 Unix 秒级时间戳。
 *
 * 微信 stepInfoList 每条的 timestamp 是「当天零点的秒级时间戳」，以北京时间计。
 * 不能用 new Date().toISOString().slice(0,10) 拼 UTC —— 北京时间 00:00~08:00
 * 之间 UTC 仍是昨天，会取错一天。这里显式按 UTC+8 平移后取 UTC 日历日，再减回偏移。
 */
export function beijingTodayZeroSec(nowMs = Date.now()) {
  const OFFSET_MS = 8 * 3600 * 1000
  const shifted = new Date(nowMs + OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = shifted.getUTCMonth()
  const d = shifted.getUTCDate()
  // 北京当天零点 = 该 UTC 日历日 00:00 的 UTC 时间戳 − 8h
  return Math.floor((Date.UTC(y, m, d) - OFFSET_MS) / 1000)
}

/**
 * 从 stepInfoList 里挑出北京当天那一条的 step。
 * @returns {number|null} 当天步数；无当天样本返回 null
 */
export function pickTodaySteps(stepInfoList, todayZeroSec) {
  if (!Array.isArray(stepInfoList)) return null
  let hit = null
  for (const row of stepInfoList) {
    if (!row || typeof row !== 'object') continue
    // 微信给的是当天零点秒戳；个别固件会有几秒漂移，按「同一天」窗口匹配更稳，
    // 但窗口限制在 [零点, 零点+86400) 内，绝不跨天取数。
    const ts = Number(row.timestamp)
    if (!Number.isFinite(ts)) continue
    if (ts >= todayZeroSec && ts < todayZeroSec + 86400) {
      const step = Number(row.step)
      hit = Number.isFinite(step) && step >= 0 ? Math.round(step) : 0
      break
    }
  }
  return hit
}

/**
 * 构造微信运动处理器。
 * @param {object} deps
 * @param {object} deps.cfg          网关配置（wechatApiBase 等由 auth 闭包持有）
 * @param {object} deps.logger
 * @param {object} deps.auth         createAuthHandlers() 返回值（复用 exchangeWechatCode / authOwnerIdStrict）
 */
export function createWerunHandlers({ cfg, logger, auth }) {
  const { exchangeWechatCode, authOwnerIdStrict } = auth

  /**
   * POST /werun/sync —— 用户主动点击「同步微信运动」时才调（平台规范禁止自动调用）。
   */
  async function sync(req, res, body) {
    // ① Bearer 鉴权（含 token_version），公开键不够
    const ownerId = await authOwnerIdStrict(req)
    if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthenticated')

    // ② 输入白名单：只认四元组。🔴 body.steps 即便传来也绝不读取
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const appid = typeof body.appid === 'string' ? body.appid.trim() : ''
    const encryptedData = typeof body.encryptedData === 'string' ? body.encryptedData : ''
    const iv = typeof body.iv === 'string' ? body.iv : ''
    if (!code || !appid || !encryptedData || !iv) {
      return cloudError(res, 400, '同步参数不完整，请重试', 'invalid_request')
    }
    if (!APPID_RE.test(appid)) {
      return cloudError(res, 400, 'appid 格式不正确', 'invalid_request')
    }

    // ③ 同批次 code → openid + session_key（内存瞬时，不落库不下发）
    const exchanged = await exchangeWechatCode({ code, appid })
    if (!exchanged.ok) {
      // exchangeWechatCode 已按 errcode 归类：40029/40163 → 401 invalid_grant，
      // 未配置 appid → 503，微信繁忙 → 503，其余 502。原样透传前端。
      return cloudError(res, exchanged.status, exchanged.message, exchanged.code)
    }

    // ④ 归属绑定：wx:<openid> 必须与 token owner 一致，否则 403（防串号）
    const expectedOwner = `wx:${exchanged.openid}`
    if (expectedOwner !== ownerId) {
      logger.warn(`[werun] 归属不符：拒绝 owner=${ownerId} codeOpenid=${exchanged.openid} appid=${appid}`)
      return cloudError(res, 403, '微信运动归属校验失败', 'forbidden')
    }

    // ⑤ AES-128-CBC 解密。session_key 在 auth 里是微信返回的 base64 字符串，
    //    解码后必须正好 16 字节（AES-128）；iv 解码后 16 字节。任一项不符即 fail-closed。
    let plain
    try {
      const keyBuf = Buffer.from(exchanged.sessionKey, 'base64')
      const ivBuf = Buffer.from(iv, 'base64')
      const ctBuf = Buffer.from(encryptedData, 'base64')
      if (keyBuf.length !== 16 || ivBuf.length !== 16 || ctBuf.length === 0) {
        throw new Error('bad key/iv/cipher length')
      }
      // PKCS#7 自动去除；填充错误 / 密文被改会在此抛错
      const decipher = createDecipheriv('aes-128-cbc', keyBuf, ivBuf)
      plain = Buffer.concat([decipher.update(ctBuf), decipher.final()]).toString('utf8')
    } catch {
      // 🔴 不记 session_key、不记密文、不记 iv —— 只记类型与 owner，便于排查而不泄密
      logger.warn(`[werun] 解密失败 owner=${ownerId} appid=${appid}`)
      return cloudError(res, 400, '微信运动数据解密失败，请重新同步', 'werun_decrypt_failed')
    }

    // ⑥ watermark.appid 校验：防 A 小程序的密文拿到 B 小程序解
    let data
    try {
      data = JSON.parse(plain)
    } catch {
      logger.warn(`[werun] 明文非 JSON owner=${ownerId} appid=${appid}`)
      return cloudError(res, 400, '微信运动数据格式异常，请重新同步', 'werun_decrypt_failed')
    }
    if (!data || typeof data !== 'object' || data.watermark?.appid !== appid) {
      logger.warn(`[werun] watermark 不符 owner=${ownerId} appid=${appid}`)
      return cloudError(res, 400, '微信运动数据校验失败，请重新同步', 'werun_decrypt_failed')
    }

    // ⑦ 只取当天一步数；31 天明细在此作用域内用完即弃，绝不进响应/日志/库
    const steps = pickTodaySteps(data.stepInfoList, beijingTodayZeroSec())
    const status = steps == null ? 'empty' : 'ok'
    const out = {
      steps: steps == null ? 0 : steps,
      activeKcal: 0, // 微信运动只有步数，活动消耗由前端步幅法估算（零新口径）
      status,
      syncedAt: new Date().toISOString(),
    }
    logger.info(`[werun] 同步成功 owner=${ownerId} appid=${appid} status=${status} steps=${out.steps}`)
    return { status: 200, body: out }
  }

  return { sync, beijingTodayZeroSec, pickTodaySteps }
}
