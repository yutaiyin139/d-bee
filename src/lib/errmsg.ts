/**
 * 面向用户的错误文案中文化。
 *
 * 背景：云端 SDK 与浏览器网络层的报错都是英文原文，形如
 *   "Failed to fetch"、"JWT expired"、"permission denied for table meal_entries"、
 *   "invalid_grant"、"duplicate key value violates unique constraint ..."
 * 直接透传给用户既看不懂、也不知道该做什么。
 *
 * 策略：只做「已知英文 → 中文可操作提示」的映射，未命中一律回落到调用方
 * 传入的中文兜底（各业务点自带语义，比通用文案更准确）。
 * 已是中文的报错（AI 侧全是中文）原样保留，不做二次改写。
 *
 * 纯函数、零依赖，可在 lib 与页面两侧共用。
 */

/** 已知英文报错 → 中文可操作提示（顺序敏感：更具体的规则放前面） */
const RULES: Array<[RegExp, string]> = [
  // 网络层
  [/failed to fetch|network request failed|load failed|networkerror|net::err/i, '网络连接失败，请检查网络后重试'],
  [/timeout|timed out|etimedout|econnreset/i, '网络超时，请稍后重试'],

  // 登录态
  [/jwt expired|token has expired|invalid claim|refresh token/i, '登录已过期，请重新登录'],
  [/invalid_grant|unauthorized|\b401\b/i, '登录校验失败，请重新登录'],
  [/invalid login credentials/i, '账号或密码不正确'],
  [/email not confirmed/i, '邮箱尚未验证，请先完成验证'],
  [/user already registered|already exists|duplicate key/i, '该记录已存在'],

  // 权限
  [/permission denied|row-level security|violates row-level/i, '没有操作权限'],

  // 频控
  [/rate limit|too many requests|over_email_send_rate_limit|too many/i, '操作过于频繁，请稍后再试'],

  // 额度
  [/quota|insufficient/i, '额度不足'],

  // 服务端
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, '服务暂时不可用，请稍后重试'],
  [/function .* does not exist|schema cache/i, '服务版本不匹配，请更新应用后重试'],
]

/** 把任意英文错误文案翻译成中文；无法识别时回落到调用方兜底 */
export function zh(raw: string | null | undefined, fallback: string): string {
  const msg = (raw ?? '').trim()
  if (!msg) return fallback
  for (const [re, text] of RULES) if (re.test(msg)) return text
  // 已含中文（AI 侧报错、自建文案）原样透传
  if (/[\u4e00-\u9fa5]/.test(msg)) return msg
  return fallback
}

/** 从任意 catch 到的值里取用户可读文案 */
export function errText(e: unknown, fallback: string): string {
  if (e instanceof Error) return zh(e.message, fallback)
  if (typeof e === 'string') return zh(e, fallback)
  return fallback
}
