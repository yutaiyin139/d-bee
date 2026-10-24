/**
 * 配置加载：从环境变量读取，缺失时给**明确**的报错而不是静默用默认值。
 *
 * 加载顺序（后者不覆盖前者已存在的值）：
 *   1. process.env —— systemd EnvironmentFile / 手动 export，生产唯一来源
 *   2. 项目根 .env —— 仅本地开发便利；生产服务器上不存在此文件
 *
 * ⚠️ 不用 dotenv 包：.env 解析 20 行代码就够，少一个依赖少一个审计面。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../..')

/** 极简 .env 解析：支持 # 注释、KEY=VALUE、值两侧引号。不做变量插值。 */
export function parseEnv(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // 去掉成对引号（单/双），并处理双引号内的 \n 转义
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
      if (rawLine.trim().startsWith(key + '="')) val = val.replace(/\\n/g, '\n')
    } else {
      // 无引号时，行尾 # 之后视为注释
      const hash = val.indexOf(' #')
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    out[key] = val
  }
  return out
}

/** 加载项目根 .env（若存在）。已存在于 process.env 的键不被覆盖。 */
export function loadDotEnv(path = resolve(ROOT, '.env')) {
  if (!existsSync(path)) return {}
  const parsed = parseEnv(readFileSync(path, 'utf8'))
  let applied = 0
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v
      applied++
    }
  }
  return { path, applied, keys: Object.keys(parsed) }
}

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt
  return /^(1|true|yes|on)$/i.test(String(v).trim())
}

const int = (v, dflt) => {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : dflt
}

/**
 * 归一化配置。**启动时一次性求值**，运行期不重读 env（避免半新半旧的状态）。
 *
 * @param {object} env  默认 process.env；自测时可注入伪造 env
 */
export function loadConfig(env = process.env) {
  const require = (key, hint) => {
    const v = env[key]
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`缺少必需环境变量 ${key}${hint ? ` —— ${hint}` : ''}`)
    }
    return v.trim()
  }

  const jwtSecret = require('JWT_SECRET', '生产必须是独立随机值：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  // 拦住开发占位符跑到生产：这个值在仓库历史与文档里出现过，等于公开
  if (bool(env.DBEE_PROD, false) && /dev-only|change-me|changeme/i.test(jwtSecret)) {
    throw new Error('JWT_SECRET 仍是开发占位符，生产环境拒绝启动')
  }

  const cfg = {
    prod: bool(env.DBEE_PROD, false),
    host: env.GATEWAY_HOST?.trim() || '127.0.0.1',
    port: int(env.GATEWAY_PORT, 8080),

    // ── auth ───────────────────────────────────────────────
    jwtSecret,
    accessTtlSec: parseTtlSafe(env.JWT_EXPIRES_IN, 7 * 86400),
    refreshTtlSec: parseTtlSafe(env.JWT_REFRESH_EXPIRES_IN, 30 * 86400),
    // 前端 SDK 的 publishableKey（src/cloudConfig.ts 里的 wbpk_…）。
    // 自托管下它只是「应用标识」，不承担安全职责（真密钥是 JWT_SECRET），
    // 但仍校验它以避免误连到别的应用的网关。留空则跳过校验。
    publishableKey: env.WB_PUBLISHABLE_KEY?.trim() || '',

    smsProvider: (env.SMS_PROVIDER?.trim() || 'log').toLowerCase(),
    smsMasterCode: env.SMS_MASTER_CODE?.trim() || '',
    smsSignName: env.SMS_SIGN_NAME?.trim() || '自律蜜蜂',
    otpTtlSec: parseTtlSafe(env.OTP_TTL_SEC, 300),
    otpMaxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
    // 发码频率限制：同号 60 秒一次（与前端倒计时一致），同 IP 每小时 20 次
    otpResendSec: int(env.OTP_RESEND_SEC, 60),
    otpIpHourLimit: int(env.OTP_IP_HOUR_LIMIT, 20),

    // ── database ───────────────────────────────────────────
    dbHost: env.DBEE_HOST?.trim() || '127.0.0.1',
    dbPort: int(env.DBEE_PORT, 5432),
    dbName: env.DBEE_DB?.trim() || 'dbee',
    // 两套角色刻意分离：auth 模块能写 app_users（身份表），PostgREST 只能碰业务表。
    // 这样即便 PostgREST 被打穿也读不到身份哈希（0031 已 REVOKE，这里是第二道）。
    dbUser: env.DBEE_USER?.trim() || 'dbee_app',
    dbPassword: env.DBEE_PWD ?? '',
    dbGatewayUser: env.DBEE_GATEWAY_USER?.trim() || env.DBEE_USER?.trim() || 'dbee_app',
    dbGatewayPassword: env.DBEE_GATEWAY_PWD ?? env.DBEE_PWD ?? '',
    dbPoolMax: int(env.DBEE_POOL_MAX, 10),
    dbStatementTimeoutMs: int(env.DBEE_STMT_TIMEOUT_MS, 15000),
    // db.mjs 会读 cfg.dbSsl 决定是否开 TLS。此前**漏了在这里定义** →
    // 恒为 undefined → 即使设了 DBEE_SSL=1 也静默不生效（ssl 恒 false）。
    // 本机回环连库不需要 TLS，默认 false 是对的；补上定义是为了让开关真的可用
    // （将来把库挪到别的机器 / 跨网段时必须能打开）。
    dbSsl: bool(env.DBEE_SSL, false),
    // HMAC 身份哈希的 PEPPER。**必须**独立于 JWT_SECRET：
    // 泄露一个不至于连带泄露另一个，且轮换 JWT 密钥不会让用户身份全部失配。
    identPepper: env.IDENT_PEPPER?.trim() || '',

    // ── PostgREST 上游（A2）────────────────────────────────
    postgrestUrl: (env.POSTGREST_URL?.trim() || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
    postgrestJwtSecret: env.POSTGREST_JWT_SECRET?.trim() || jwtSecret,
    postgrestSchema: env.POSTGREST_SCHEMA?.trim() || 'public',

    // ── LLM（A3）───────────────────────────────────────────
    llmBaseUrl: (env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    llmApiKey: env.LLM_API_KEY?.trim() || '',
    llmModelText: env.LLM_MODEL_TEXT?.trim() || 'deepseek-flash',
    llmModelVision: env.LLM_MODEL_VISION?.trim() || 'deepseek-flash',
    // 视觉 provider 可独立于文本 provider：视觉识别对精度要求高、且 DeepSeek
    // 官方 flash 的视觉能力偏弱，故支持把「拍照/包装识别」单独切到阿里云 Qwen-VL。
    // 三个视觉键任一未配，则回落到 llmBaseUrl / llmApiKey / llmModelVision（同 provider）。
    llmVisionBaseUrl: (env.LLM_VISION_BASE_URL?.trim() || env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    llmVisionApiKey: (env.LLM_VISION_API_KEY?.trim() || env.LLM_API_KEY?.trim() || ''),
    llmVisionModel: env.LLM_VISION_MODEL?.trim() || env.LLM_MODEL_VISION?.trim() || 'deepseek-flash',
    // Qwen-VL 的 image detail：low 把图缩到 512 级（省 token），high/original 保留原图。
    // 食物识别需要看清细节，默认 high；低配/高并发场景可改 low。
    llmImageDetail: (env.LLM_IMAGE_DETAIL?.trim() || 'high').toLowerCase(),
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, 120000),
    // 每用户每日 AI 调用上限的兜底闸（数据库里另有 consume_ai_quota，这是防打穿的第二层）
    llmDailyCapPerUser: int(env.LLM_DAILY_CAP, 200),

    // ── Apple IAP（C1）─────────────────────────────────────
    appleBundleId: env.APPLE_BUNDLE_ID?.trim() || '',
    appleSharedSecret: env.APPLE_SHARED_SECRET?.trim() || '',
    // 沙盒环境开关：提审阶段用 true，正式上架后改 false
    appleSandbox: bool(env.APPLE_SANDBOX, true),
    appleWebhookSecret: env.APPLE_WEBHOOK_SECRET?.trim() || '',

    // ── 限流 ───────────────────────────────────────────────
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 300),
    bodyLimitBytes: int(env.BODY_LIMIT_BYTES, 32 * 1024 * 1024), // 32 MiB：base64 图片 + 富余
  }

  // 启动期就暴露配置问题，而不是等第一个请求 500
  const problems = validate(cfg)
  if (problems.length) {
    throw new Error('配置不完整：\n  - ' + problems.join('\n  - '))
  }
  return cfg
}

function parseTtlSafe(v, dflt) {
  // 延迟 require 避免循环依赖
  const n = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null
  if (n) return n
  if (typeof v !== 'string' || !v.trim()) return dflt
  const m = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(v)
  if (!m) return dflt
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's').toLowerCase()]
  const r = Number(m[1]) * mult
  return r > 0 ? r : dflt
}

/** 返回问题清单（空数组 = 配置可用）。区分「致命」与「警告」。 */
export function validate(cfg) {
  const problems = []
  if (cfg.jwtSecret.length < 32) {
    problems.push('JWT_SECRET 太短（<32 字符），HS256 密钥应至少 32 字节')
  }
  if (!cfg.identPepper) {
    problems.push('缺少 IDENT_PEPPER —— app_users 的身份哈希需要它，否则 11 位手机号可被穷举反查')
  }
  if (cfg.identPepper && cfg.identPepper === cfg.jwtSecret) {
    problems.push('IDENT_PEPPER 不应与 JWT_SECRET 相同 —— 两个密钥职责不同，须独立')
  }
  if (!cfg.dbPassword) {
    problems.push('缺少 DBEE_PWD（数据库密码）')
  }
  if (cfg.smsProvider !== 'log') {
    // 非 log 模式意味着要真发短信；当前只实现了 log，其余供应商待采购后再接
    problems.push(`SMS_PROVIDER=${cfg.smsProvider} 尚未实现，当前只支持 log（日志+万能码）`)
  }
  if (cfg.smsProvider === 'log' && !cfg.smsMasterCode) {
    problems.push('SMS_PROVIDER=log 时必须配 SMS_MASTER_CODE（万能验证码），否则无人能登录')
  }
  if (cfg.prod && cfg.smsProvider === 'log') {
    // 这是最危险的一条：万能码 = 任何人可登录任何账号。放在末尾以便最醒目
    problems.push('生产环境（DBEE_PROD=1）仍用 SMS_PROVIDER=log —— 万能码意味着任何人可登录任何账号')
  }
  return problems.filter(Boolean)
}

/** 启动时的非致命提示（打印但不阻断） */
export function warnings(cfg) {
  const w = []
  if (!cfg.llmApiKey) w.push('LLM_API_KEY 未配置 —— A3 的 LLM 代理将返回 503')
  if (!cfg.publishableKey) w.push('WB_PUBLISHABLE_KEY 未配置 —— 跳过 access-key 校验（内网部署可接受）')
  if (!cfg.appleBundleId) w.push('APPLE_BUNDLE_ID 未配置 —— C1 的 IAP 验签不可用')
  if (cfg.appleBundleId && !cfg.appleSharedSecret) {
    w.push('APPLE_SHARED_SECRET 未配置 —— 自动续期订阅商品验签会返回 21004（买断商品不受影响）')
  }
  if (cfg.prod && cfg.accessTtlSec > 30 * 86400) w.push('access token 有效期超过 30 天，偏长')
  return w
}
