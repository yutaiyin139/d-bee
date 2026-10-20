/**
 * 面向用户的错误文案中文化（对齐主工程 src/lib/errmsg.ts）。
 * 纯函数、零依赖，供 lib 与页面共用。
 */

const RULES: Array<[RegExp, string]> = [
  [/failed to fetch|network request failed|load failed|networkerror|net::err/i, '网络连接失败，请检查网络后重试'],
  [/timeout|timed out|etimedout|econnreset/i, '网络超时，请稍后重试'],
  [/jwt expired|token has expired|invalid claim|refresh token/i, '登录已过期，请重新登录'],
  [/invalid_grant|unauthorized|\b401\b/i, '登录校验失败，请重新登录'],
  [/invalid login credentials/i, '账号或密码不正确'],
  [/email not confirmed/i, '邮箱尚未验证，请先完成验证'],
  [/user already registered|already exists|duplicate key/i, '该记录已存在'],
  [/permission denied|row-level security|violates row-level/i, '没有操作权限'],
  [/rate limit|too many requests|over_email_send_rate_limit|too many/i, '操作过于频繁，请稍后再试'],
  [/quota|insufficient/i, '额度不足'],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, '服务暂时不可用，请稍后重试'],
  [/function .* does not exist|schema cache/i, '服务版本不匹配，请更新应用后重试'],
]

export function zh(raw: string | null | undefined, fallback: string): string {
  const msg = (raw ?? '').trim()
  if (!msg) return fallback
  for (const [re, text] of RULES) if (re.test(msg)) return text
  if (/[\u4e00-\u9fa5]/.test(msg)) return msg
  return fallback
}

export function errText(e: unknown, fallback: string): string {
  if (e instanceof Error) return zh(e.message, fallback)
  if (typeof e === 'string') return zh(e, fallback)
  return fallback
}
