/**
 * 短信/邮件发送层。
 *
 * 当前只实现 `log` provider（2026-10-22 用户拍板：先用日志+万能码，需要时再采购）。
 * 设计成 provider 表驱动，采购短信服务后**只需加一个条目**，调用方零改动。
 *
 * ⚠️ 日志里打的是**掩码手机号 + 验证码**（log 模式下验证码必须可见，否则没法登录）。
 *   这是开发期的刻意取舍。生产切真短信后：
 *   · SMS_PROVIDER 改成对应供应商，万能码留空
 *   · config.validate() 会在 DBEE_PROD=1 且 provider=log 时**拒绝启动**
 *   · 日志将只打掩码号与发送结果，不再打码
 */

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
   * 占位：采购后在此接入。签名与 log 一致，调用方无需改动。
   * 常见供应商（腾讯云 SMS / 阿里云 SMS / 云片）都是「模板 ID + 参数数组」形态，
   * 接入时把 code 作为模板参数传入即可。
   */
  async tencent() {
    return { ok: false, provider: 'tencent', error: 'SMS_PROVIDER=tencent 尚未实现（待采购后接入）' }
  },
  async aliyun() {
    return { ok: false, provider: 'aliyun', error: 'SMS_PROVIDER=aliyun 尚未实现（待采购后接入）' }
  },
}

/**
 * 发送验证码。
 * @param {object} p
 * @param {string} p.provider   'log' | 'tencent' | 'aliyun'
 * @param {'sms'|'email'} p.channel
 * @param {string} p.to         明文标识（仅用于真实发送；log 模式不打印它）
 * @param {string} p.masked     掩码，用于日志
 * @param {string} p.code
 * @param {string} p.signName
 * @param {object} p.logger     { info, warn, error }
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
