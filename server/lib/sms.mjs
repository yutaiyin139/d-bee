/**
 * 短信/邮件发送层。
 *
 * provider 表驱动：
 *   · `log`     —— 开发日志+万能码（仅限开发）
 *   · `tencent` —— 腾讯云真短信（2026-10-26 实现）
 *   · `smtp`    —— 通用 SMTP 邮件（2026-10-27 实现，供 email 登录验证码）
 *   · `aliyun`  —— 阿里云真短信（2026-10-29 实现，签名/模板 SMS_512482436 已审核通过）
 *
 * tencent / smtp / aliyun 实现零依赖：TC3-HMAC-SHA256、RPC HMAC-SHA1 签名、SMTP 会话
 * 均用 node:crypto / node:net 手写，不装任何云厂商 SDK —— 与本工程「只依赖 pg」的审计面原则一致。
 *
 * ⚠️ 日志纪律：
 *   · log 模式刻意打验证码（否则没法登录），仅限开发。
 *   · tencent / aliyun / smtp 模式日志只打掩码与消息 ID，**绝不打明文码**。
 *   · SMS_PROVIDER=tencent/aliyun 时 config.validate() 强制要求删掉 SMS_MASTER_CODE；
 *     DBEE_PROD=1 且 provider=log 会拒绝启动。
 */

import { createHmac, createHash, randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

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

  /**
   * 通用 SMTP 邮件发送（供 email 登录验证码，2026-10-27 实现）。
   *
   * 零依赖：直接用 node:net（明文/STARTTLS 升级 node:tls）走 SMTP 会话。
   * 兼容任意 SMTP 发信方：企业邮箱、QQ 邮箱、163、阿里企业邮、Resend/SendGrid 的 SMTP 网关等。
   *
   * 所需参数（由 auth.mjs 从 cfg 透传）：
   *   smtp.host / smtp.port / smtp.secure / smtp.user / smtp.pass / smtp.from / smtp.fromName
   *   · secure=true 走 SMTPS（端口通常 465），false 走 25/587（587 自动 STARTTLS）
   *   · user/pass 走 AUTH LOGIN；二者都留空则匿名发信（内网中继场景）
   *
   * 邮件正文为固定模板，验证码用 {1}、有效分钟用 {2} 内插。
   */
  async smtp({ to, masked, code, logger, smtp, otpTtlMin }) {
    const missing = ['host', 'port', 'from'].filter((k) => !smtp?.[k])
    if (missing.length) {
      logger.error(`[SMTP] 邮件凭据缺失：${missing.map((k) => `EMAIL_SMTP_${k.toUpperCase()}`).join('、')}`)
      return { ok: false, provider: 'smtp', error: '邮件通道未配置完整，请联系管理员' }
    }
    // 明文验证码只进发送内容，日志一律打掩码
    const subject = '【自律蜜蜂】登录验证码'
    const html = [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#333">',
      '  <p style="font-size:15px;margin:0 0 16px">你好，</p>',
      '  <p style="font-size:15px;margin:0 0 16px">你的登录验证码是：</p>',
      `  <div style="font-size:32px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;background:#fff7e6;border-radius:10px;color:#c07a00">${code}</div>`,
      `  <p style="font-size:13px;color:#888;margin:16px 0 0">验证码 ${otpTtlMin ?? 5} 分钟内有效，请勿泄露给他人。</p>`,
      '  <p style="font-size:13px;color:#aaa;margin:24px 0 0">若非本人操作，请忽略本邮件。</p>',
      '</div>',
    ].join('')

    const message = [
      `From: ${smtp.fromName ? `=?UTF-8?B?${Buffer.from(smtp.fromName).toString('base64')}?=` : ''} <${smtp.from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      '',
      '.',
    ].join('\r\n')

    try {
      await sendSmtp({ ...smtp, to, message, logger })
      logger.info(`[SMTP] 邮件已发送 ${masked}`)
      return { ok: true, provider: 'smtp', messageId: 'smtp' }
    } catch (err) {
      logger.error(`[SMTP] 邮件发送失败 ${masked}: ${err?.message || err}`)
      return { ok: false, provider: 'smtp', error: '验证码发送失败，请稍后重试' }
    }
  },

  /**
   * 阿里云 SMS（SendSms，RPC 风格 API，Version=2017-05-25，HMAC-SHA1 签名）。
   * 所需参数（由 auth.mjs 从 cfg 透传）：
   *   aliyun.accessKeyId / aliyun.accessKeySecret / aliyun.templateCode /
   *   aliyun.endpoint（默认 dysmsapi.aliyuncs.com）
   * 模板约定：SMS_512482436 形如「您的验证码为${code}，该验证码${ttl}分钟内有效」——
   *   TemplateParam 传 JSON 串 {"code":"...","ttl":"..."}。
   *   ⚠️ 变量名（code/ttl）必须与控制台审核通过的模板正文**逐字一致**，
   *      否则返回 isv.TEMPLATE_PARAMS_ILLEGAL；若模板变量名不同，改这里即可。
   * 文档：https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
   *      签名：https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
   *      （RPC 签名算法：参数排序 → 百分号编码 → StringToSign → HMAC-SHA1）
   */
  async aliyun({ to, masked, code, signName, logger, aliyun, otpTtlMin }) {
    const missing = ['accessKeyId', 'accessKeySecret', 'templateCode'].filter((k) => !aliyun?.[k])
    if (missing.length) {
      logger.error(`[SMS] aliyun 凭据缺失：${missing.map((k) => `SMS_ALIYUN_${k.toUpperCase()}`).join('、')}`)
      return { ok: false, provider: 'aliyun', error: '短信通道未配置完整，请联系管理员' }
    }
    // 国内手机号：阿里云 PhoneNumbers 接受 11 位裸号；带 +86 前缀也兼容（剥掉）
    const phone = (to || '').replace(/^\+?86/, '')
    // TemplateParam 是 JSON 串；变量名须与模板正文一致（见上方模板约定）
    const templateParam = JSON.stringify({
      code: String(code),
      ttl: String(otpTtlMin ?? 5),
    })

    try {
      const body = await aliyunRpcRequest({
        host: aliyun.endpoint || 'dysmsapi.aliyuncs.com',
        action: 'SendSms',
        version: '2017-05-25',
        accessKeyId: aliyun.accessKeyId,
        accessKeySecret: aliyun.accessKeySecret,
        bizParams: {
          PhoneNumbers: phone,
          SignName: signName,
          TemplateCode: aliyun.templateCode,
          TemplateParam: templateParam,
        },
      })
      // 响应形态：{ Code: "OK", Message: "OK", RequestId, BizId }
      if (body?.Code !== 'OK') {
        // 常见码：isv.BUSINESS_LIMIT_CONTROL（限频）/ isv.SMS_SIGNATURE_ILLEGAL /
        //   isv.TEMPLATE_PARAMS_ILLEGAL（模板变量名不匹配）/ isv.AMOUNT_NOT_ENOUGH（余额不足）
        logger.error(`[SMS] aliyun 发送失败 ${masked}: Code=${body?.Code} Message=${body?.Message} RequestId=${body?.RequestId || ''}`)
        return { ok: false, provider: 'aliyun', error: `验证码发送失败（${body?.Code || 'unknown'}），请稍后重试` }
      }
      logger.info(`[SMS] aliyun 已发送 ${masked} BizId=${body?.BizId} RequestId=${body?.RequestId}`)
      return { ok: true, provider: 'aliyun', messageId: body?.BizId }
    } catch (err) {
      logger.error(`[SMS] aliyun 请求异常：${err?.message || err}`)
      return { ok: false, provider: 'aliyun', error: '验证码发送失败，请稍后重试' }
    }
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

// ── 阿里云 RPC 签名（HMAC-SHA1，手写，零依赖） ────────────────────────
// 与腾讯云 TC3 不同：阿里云旧版 RPC API 把**全部参数**（含公共参数）放 query，
// 按字典序排序 → 逐个百分号编码 → 拼 canonicalized query → 组 StringToSign →
// 以 `AccessKeySecret + "&"` 为密钥做 HMAC-SHA1 → Base64，签名本身也作为一个参数。
// 参考：https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature

/** 阿里云专用百分号编码：在 encodeURIComponent 基础上再修正三处
 *  （RFC 3986 与阿里云签名规范的差异）：空格须为 %20（非 +）、
 *  `*` 须编码为 %2A、`~` 须还原为字面量（%7E → ~）。 */
function aliyunEncode(v) {
  return encodeURIComponent(String(v))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

async function aliyunRpcRequest({ host, action, version, accessKeyId, accessKeySecret, bizParams }) {
  // 1) 公共参数（RPC 签名要求：Format/Version/AccessKeyId/SignatureMethod/
  //    Timestamp/SignatureVersion/SignatureNonce；Signature 稍后补）
  const params = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), // UTC，形如 2026-10-29T01:02:03Z
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Action: action,
    ...bizParams,
  }

  // 2) 按 key 字典序排序，逐个编码后拼 canonicalized query string
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(params[k])}`)
    .join('&')

  // 3) StringToSign = HTTPMethod + "&" + encode("/") + "&" + encode(canonical)
  //    （GET 请求，Path 固定为 "/"，两者都要再编码一次）
  const stringToSign = `GET&${aliyunEncode('/')}&${aliyunEncode(canonical)}`

  // 4) 签名密钥 = AccessKeySecret + "&"；HMAC-SHA1 后 Base64
  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64')

  // 5) 发起 GET：canonical + Signature（Signature 值同样要百分号编码）
  const url = `https://${host}/?${canonical}&Signature=${aliyunEncode(signature)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Host: host, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000), // 发短信必须快失败，别把登录接口拖挂
  })
  const json = await res.json().catch(() => ({}))
  // HTTP 4xx/5xx 时阿里云把错误放在 { Code, Message, RequestId, HostId }；
  // 200 时业务成功/失败也在 Code（OK / isv.*）。统一透传给上层判 Code。
  if (!res.ok && !json?.Code) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json
}

/**
 * 发送验证码。
 * @param {object} p
 * @param {string} p.provider   'log' | 'tencent' | 'smtp' | 'aliyun'
 * @param {'sms'|'email'} p.channel
 * @param {string} p.to         明文标识（tencent 模式真发；log 模式不打印它）
 * @param {string} p.masked     掩码，用于日志
 * @param {string} p.code
 * @param {string} p.signName
 * @param {object} p.logger     { info, warn, error }
 * @param {object} [p.tencent]  腾讯云凭据 { secretId, secretKey, sdkAppId, templateId, region }
 * @param {object} [p.aliyun]   阿里云凭据 { accessKeyId, accessKeySecret, templateCode, endpoint }
 * @param {object} [p.smtp]     SMTP 凭据 { host, port, secure, user, pass, from, fromName }
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

// ── SMTP 会话（零依赖：node:net + node:tls）────────────────────────────
// 流程：连接（secure 直接 TLS，否则明文/STARTTLS）→ EHLO → 可选 AUTH LOGIN →
//       MAIL FROM → RCPT TO → DATA → QUIT。每条命令等一行响应（3 位码 + 文本）。

/**
 * 发送一封邮件（SMTP）。不依赖 nodemailer，手写最小会话。
 * @param {object} o { host, port, secure, user, pass, from, to, message, logger }
 */
function sendSmtp({ host, port, secure, user, pass, from, to, message, logger }) {
  return new Promise((resolve, reject) => {
    const portNum = Number(port) || (secure ? 465 : 587)
    const onError = (err) => {
      try { sock.destroy() } catch {}
      reject(err)
    }

    let sock
    let buf = ''
    // 到达的响应行先进 FIFO 队列；readLine 从队里取（避免「行在 waiter 就绪前到达被丢弃」）
    const pending = []
    const waiters = [] // 等待中的 readLine 回调

    const pump = () => {
      // 队里有行且有人在等 → 派发；否则留队待取
      while (pending.length && waiters.length) {
        const line = pending.shift()
        const w = waiters.shift()
        w(line)
      }
    }

    const feed = (chunk) => {
      buf += chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        pending.push(line)
      }
      pump()
    }

    const readLine = (timeoutMs = 15_000) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`SMTP 响应超时（${host}:${portNum}）`)), timeoutMs)
        waiters.push((line) => { clearTimeout(t); res(line) })
        pump()
      })

    const cmd = async (c, expect) => {
      sock.write(c + '\r\n')
      const line = await readLine()
      const code = Number(line.slice(0, 3))
      if (!Number.isFinite(code) || (expect && code !== expect)) {
        throw new Error(`SMTP ${c.split(' ')[0]} 失败：${line}`)
      }
      return { code, line }
    }

    const readMulti = async () => {
      // 多行响应：250- 开头为续行，250 结尾为终行
      const out = []
      for (;;) {
        const line = await readLine()
        out.push(line)
        if (line.length < 4 || line[3] !== '-') break
      }
      return out.join('\n')
    }

    // SNI：只有域名需要 servername；host 是 IP 时设置它违反 RFC 6066
    //（Node 会告警「Setting the TLS ServerName to an IP address」并忽略）。
    // 🔴 rejectUnauthorized 恒为 true：绝不关闭证书校验（关了等于把授权码交给中间人）。
    //   生产连 SMTP 服务商（当前 smtp.163.com）用公共 CA 签发证书，Node 默认信任库即可验证。
    const tlsBase = net.isIP(host)
      ? { rejectUnauthorized: true }
      : { servername: host, rejectUnauthorized: true }

    const plainConnect = () => {
      sock = net.connect({ host, port: portNum })
      sock.setTimeout(20_000, () => onError(new Error('SMTP 连接超时')))
      sock.on('data', feed)
      sock.on('error', onError)
      sock.on('connect', () => runSession().then(resolve).catch(onError))
    }

    const tlsConnect = () => {
      sock = tls.connect({ host, port: portNum, ...tlsBase })
      sock.setTimeout(20_000, () => onError(new Error('SMTP TLS 握手超时')))
      sock.on('data', feed)
      sock.on('error', onError)
      sock.on('secureConnect', () => runSession().then(resolve).catch(onError))
    }

    /**
     * 鉴权：按 EHLO 公告的能力协商（139/QQ/163 各支持不同子集）。
     * 优先 LOGIN（兼容性最好，交互可见），服务器只公告 PLAIN 时退回 PLAIN。
     * 认证失败（535）会被上层捕获并给出明确日志，不会静默。
     */
    const authenticate = async (caps) => {
      const wantLogin = !caps || /\bAUTH\b[^\r\n]*\bLOGIN\b/i.test(caps)
      if (wantLogin) {
        await cmd('AUTH LOGIN', 334)
        await cmd(Buffer.from(user).toString('base64'), 334)
        await cmd(Buffer.from(pass).toString('base64'), 235)
        return
      }
      // AUTH PLAIN：单条命令带 \0user\0pass（base64）
      const blob = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
      await cmd(`AUTH PLAIN ${blob}`, 235)
    }

    async function runSession() {
      try {
        await readLine() // 服务器 greeting（220）
        sock.write('EHLO dbee-gateway\r\n')
        let caps = await readMulti() // EHLO 多行能力公告
        // 仅当服务器公告支持 STARTTLS 时才升级（有些中继/25 端口不支持）。
        // 🔴 465 端口走 secure=true，直接 TLS 直连，不进这个分支。
        if (!secure && /\bSTARTTLS\b/i.test(caps)) {
          await cmd('STARTTLS', 220)
          const old = sock
          sock = tls.connect({ socket: old, ...tlsBase })
          sock.setTimeout(20_000, () => onError(new Error('SMTP STARTTLS 升级超时')))
          sock.on('data', feed)
          sock.on('error', onError)
          await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej) })
          // 升级后须重新 EHLO：能力集可能变（部分服务器明文期不公告 AUTH）
          sock.write('EHLO dbee-gateway\r\n')
          caps = await readMulti()
        }
        if (user && pass) await authenticate(caps)
        await cmd(`MAIL FROM:<${from}>`, 250)
        await cmd(`RCPT TO:<${to}>`, 250)
        await cmd('DATA', 354)
        sock.write(message + '\r\n')
        // DATA 结束（message 已以 .\r\n 结尾）后服务器回 250 表示接收成功，须先消费再 QUIT
        {
          const line = await readLine()
          const code = Number(line.slice(0, 3))
          if (code !== 250) throw new Error(`SMTP DATA 结束失败：${line}`)
        }
        await cmd('QUIT', 221)
        try { sock.end() } catch {}
        resolve(true)
      } catch (err) {
        onError(err)
      }
    }

    if (secure) tlsConnect()
    else plainConnect()
  })
}
