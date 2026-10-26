/**
 * 短信/邮件发送层。
 *
 * provider 表驱动：`log`（开发日志+万能码）与 `tencent`（腾讯云真短信，2026-10-26 实现）。
 * tencent 实现零依赖：TC3-HMAC-SHA256 签名用 node:crypto 手写，HTTP 用内置 fetch，
 * 不装 tencentcloud-sdk-nodejs —— 与本工程「只依赖 pg」的审计面原则一致。
 *
 * ⚠️ 日志纪律：
 *   · log 模式刻意打验证码（否则没法登录），仅限开发。
 *   · tencent 模式日志只打掩码号与 SendStatus（Code/SerialNo），**绝不打明文码**。
 *   · SMS_PROVIDER=tencent 时 config.validate() 强制要求删掉 SMS_MASTER_CODE；
 *     DBEE_PROD=1 且 provider=log 会拒绝启动。
 */

import { createHmac, createHash } from 'node:crypto'

/** 各 provider 实现。返回值统一为 { ok, provider, messageId?, error? } */
const PROVIDERS = {
  /** 只写日志。开发/自测用。 */
  async log({ channel, to, masked, code, signName, logger }) {
    // 刻意用醒目的框，方便在 journalctl -u dbee-gateway 里 grep
    logger.warn(
      `\n╔══ [SMS:${channel}] 开发模式：验证码只写日志，不真发 ══\n` +
        `║ 收件人 : ${masked}\n` +
        `║ 验证码 : ${code}\n` +
        `║ 签名   : ${signName}\n` +
        `╚══ 5 分钟内有效，最多试 5 次 ══`,
    )
    return { ok: true, provider: 'log' }
  },

  /**
   * 腾讯云 SMS（SendSms，2021-01-11 版 API，TC3-HMAC-SHA256 签名）。
   * 所需参数（由 auth.mjs 从 cfg 透传）：
   *   tencent.secretId / tencent.secretKey / tencent.sdkAppId /
   *   tencent.templateId / tencent.region
   * 模板约定：`您的验证码是{1}，{2}分钟内有效`——{1}=code，{2}=有效分钟。
   * 文档：https://cloud.tencent.com/document/api/382/55981（签名）/ 382/38794（SendSms）
   */
  async tencent({ to, masked, code, signName, logger, tencent, otpTtlMin }) {
    const missing = ['secretId', 'secretKey', 'sdkAppId', 'templateId'].filter((k) => !tencent?.[k])
    if (missing.length) {
      logger.error(`[SMS] tencent 凭据缺失：${missing.map((k) => `SMS_TENCENT_${k.toUpperCase()}`).join('、')}`)
      return { ok: false, provider: 'tencent', error: '短信通道未配置完整，请联系管理员' }
    }
    // 仅支持国内手机号（+86）；SendSms 的 PhoneNumberSet 要求 E.164
    const phone = to?.startsWith('+') ? to : `+86${to}`
    const payload = JSON.stringify({
      PhoneNumberSet: [phone],
      SmsSdkAppId: tencent.sdkAppId,
      SignName: signName,
      TemplateId: tencent.templateId,
      // 模板参数按位传入：{1}=验证码，{2}=有效分钟（与模板正文一一对应）
      TemplateParamSet: [String(code), String(otpTtlMin ?? 5)],
    })

    try {
      const body = await tc3Request({
        service: 'sms',
        host: 'sms.tencentcloudapi.com',
        action: 'SendSms',
        version: '2021-01-11',
        region: tencent.region || 'ap-guangzhou',
        payload,
        secretId: tencent.secretId,
        secretKey: tencent.secretKey,
      })
      // 响应形态：{ SendStatusSet: [{ SerialNo, PhoneNumber, Code, Message, ... }], RequestId }
      const status = body?.SendStatusSet?.[0]
      if (!status) {
        logger.error(`[SMS] tencent 响应无 SendStatusSet：${JSON.stringify(body).slice(0, 300)}`)
        return { ok: false, provider: 'tencent', error: '验证码发送失败，请稍后重试' }
      }
      if (status.Code !== 'Ok') {
        // 常见码：FailedOperation.PhoneNumberInBlacklist / LimitExceeded.PhoneNumberDailyLimit
        // / FailedOperation.InsufficientBalanceInSmsPackage（短信包余量不足）
        logger.error(`[SMS] tencent 发送失败 ${masked}: Code=${status.Code} Message=${status.Message}`)
        return { ok: false, provider: 'tencent', error: `验证码发送失败（${status.Code}），请稍后重试` }
      }
      logger.info(`[SMS] tencent 已发送 ${masked} SerialNo=${status.SerialNo}`)
      return { ok: true, provider: 'tencent', messageId: status.SerialNo }
    } catch (err) {
      logger.error(`[SMS] tencent 请求异常：${err?.message || err}`)
      return { ok: false, provider: 'tencent', error: '验证码发送失败，请稍后重试' }
    }
  },

  /** 占位：阿里云等采购后再实现（签名形态不同，参照 tencent 的表驱动接法）。 */
  async aliyun() {
    return { ok: false, provider: 'aliyun', error: 'SMS_PROVIDER=aliyun 尚未实现（待采购后接入）' }
  },
}

// ── 腾讯云 TC3-HMAC-SHA256 签名（手写，零依赖） ────────────────────────
// 流程：拼规范请求串 → 拼待签串 → 派生密钥三级 HMAC → Authorization 头。
// 参考官方签名文档 v3（https://cloud.tencent.com/document/api/382/55981）。

function hmacSha256(key, msg) {
  return createHmac('sha256', key).update(msg).digest()
}

/** SignedHeaders 常量：与官方 NodeJS demo 逐字一致（只签 content-type 与 host）。
 *  x-tc-action 仍会发送但不纳入签名——官方 demo 明确如此且验证通过，
 *  少签一个头可降低因头值大小写/trim 规则理解偏差导致签名不匹配的风险。 */
const SIGNED_HEADERS = 'content-type;host'

async function tc3Request({ service, host, action, version, region, payload, secretId, secretKey }) {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10) // UTC 日期 YYYY-MM-DD
  const hashedPayload = createHash('sha256').update(payload).digest('hex')

  // 1) 规范请求串（POST + / + 空 query + 头 + signed headers + payload hash）
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8\nhost:${host}\n`,
    SIGNED_HEADERS,
    hashedPayload,
  ].join('\n')

  // 2) 待签字符串
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  // 3) 派生签名密钥：SecretKey → date → service → tc3_request
  const secretDate = hmacSha256(`TC3${secretKey}`, date)
  const secretService = hmacSha256(secretDate, service)
  const secretSigning = hmacSha256(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex')

  // 4) Authorization
  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`

  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': region,
    },
    body: payload,
    signal: AbortSignal.timeout(10_000), // 发短信必须快失败，别把登录接口拖挂
  })
  const json = await res.json()
  // 传输层错误（限频/签名错/参数错）在 Response.Error；业务结果在 Response.SendStatusSet
  if (json?.Response?.Error) {
    const e = json.Response.Error
    throw new Error(`${e.Code}: ${e.Message} (RequestId=${json.Response.RequestId})`)
  }
  return json?.Response ?? {}
}

/**
 * 发送验证码。
 * @param {object} p
 * @param {string} p.provider   'log' | 'tencent' | 'aliyun'
 * @param {'sms'|'email'} p.channel
 * @param {string} p.to         明文标识（tencent 模式真发；log 模式不打印它）
 * @param {string} p.masked     掩码，用于日志
 * @param {string} p.code
 * @param {string} p.signName
 * @param {object} p.logger     { info, warn, error }
 * @param {object} [p.tencent]  腾讯云凭据 { secretId, secretKey, sdkAppId, templateId, region }
 * @param {number} [p.otpTtlMin] 验证码有效分钟（模板参数 {2}）
 */
export async function sendCode(p) {
  const impl = PROVIDERS[p.provider] ?? PROVIDERS.log
  try {
    return await impl(p)
  } catch (err) {
    // 发送失败不能把栈打给客户端；记日志后返回统一错误
    p.logger?.error?.(`[SMS] 发送异常 provider=${p.provider}: ${err?.message || err}`)
    return { ok: false, provider: p.provider, error: '验证码发送失败，请稍后重试' }
  }
}

/** 可用的 provider 列表（自检/诊断用） */
export const AVAILABLE_PROVIDERS = Object.keys(PROVIDERS)
