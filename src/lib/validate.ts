/**
 * 输入边界校验（统一入口）。
 *
 * 为什么需要它：历史上各输入框的校验是「各写各的」——体重打卡有 20–300 校验，
 * 而注册引导（Onboarding）的年龄/身高/体重/目标体重完全没有边界，只用一个
 * `num(v, fallback)` 静默兜底：输入身高 9999 会被原样写进数据库，并算出一个
 * 荒谬的每日热量目标。本模块把所有输入规则收敛到一处，供全站复用。
 *
 * 设计原则：
 *  1. **纯函数、零依赖** —— 便于单元测试与复用，不碰 React、不碰网络。
 *  2. **三层防护** —— 输入时过滤非法字符 → 失焦时纠正越界 → 提交时门禁拦截。
 *  3. **边界取「合理生理/物理范围」而非「宽松到不报错」** —— 宁可提示，不留脏数据。
 *
 * 注意：前端校验是「体验与数据质量」防线，不是安全防线。
 * 服务端仍应有对应的 CHECK 约束（见 db/migrations/0016-input-bounds.sql）。
 */

/* ────────────────────────── 数值规则 ────────────────────────── */

export interface NumLimit {
  /** 字段名，用于错误提示 */
  label: string
  min: number
  max: number
  /** 是否只允许整数 */
  int?: boolean
  /** 允许的小数位数（int 为 true 时忽略） */
  decimals?: number
  /** 单位，用于错误提示 */
  unit: string
}

/** 年龄：1–120 岁（整数） */
export const AGE_LIMIT: NumLimit = { label: '年龄', min: 1, max: 120, int: true, unit: '岁' }
/** 身高：100–250 cm（1 位小数） */
export const HEIGHT_LIMIT: NumLimit = { label: '身高', min: 100, max: 250, decimals: 1, unit: 'cm' }
/** 体重：20–300 kg（1 位小数） */
export const WEIGHT_LIMIT: NumLimit = { label: '体重', min: 20, max: 300, decimals: 1, unit: 'kg' }
/** 食物份量：1–5000 g（整数） */
export const GRAMS_LIMIT: NumLimit = { label: '份量', min: 1, max: 5000, int: true, unit: 'g' }
/** 运动时长：5–300 分钟（整数） */
export const MINUTES_LIMIT: NumLimit = { label: '运动时长', min: 5, max: 300, int: true, unit: '分钟' }
/** 摄入热量：1–10000 kcal（整数） */
export const KCAL_LIMIT: NumLimit = { label: '热量', min: 1, max: 10000, int: true, unit: 'kcal' }
/** 饮水量：50–3000 ml（整数） */
export const WATER_ML_LIMIT: NumLimit = { label: '饮水量', min: 50, max: 3000, int: true, unit: 'ml' }
/** 每日步数目标：1000–50000 步（整数） */
export const STEP_GOAL_LIMIT: NumLimit = { label: '步数目标', min: 1000, max: 50000, int: true, unit: '步' }

/* ────────────────────────── 文本规则 ────────────────────────── */

export interface TextRule {
  label: string
  min: number
  max: number
  /** 允许的字符集（不匹配时提示 patternHint） */
  pattern?: RegExp
  patternHint?: string
}

export const NICKNAME_RULE: TextRule = { label: '昵称', min: 1, max: 20 }
export const INVITE_CODE_RULE: TextRule = {
  label: '邀请码',
  min: 4,
  max: 8,
  pattern: /^[A-Z0-9]+$/,
  patternHint: '只能包含大写字母与数字',
}
export const RECIPE_NAME_RULE: TextRule = { label: '食谱名称', min: 1, max: 30 }
export const FOOD_KEYWORD_RULE: TextRule = { label: '搜索关键词', min: 0, max: 30 }
export const MEAL_HINT_RULE: TextRule = { label: '补充说明', min: 0, max: 60 }
export const MEAL_TEXT_RULE: TextRule = { label: '食物描述', min: 1, max: 500 }
export const PASSWORD_RULE: TextRule = { label: '密码', min: 6, max: 64 }
/** AI 问答提问：上限兼作 token 成本控制 */
export const COACH_QUESTION_RULE: TextRule = { label: '提问', min: 1, max: 300 }
/** 会员兑换码（服务端核销，此处仅限长度防误输入） */
export const REDEEM_CODE_RULE: TextRule = { label: '兑换码', min: 1, max: 32 }

/* ────────────────────────── 数值：输入过滤 ────────────────────────── */

/**
 * 输入过程中过滤非法字符，返回可直接回填 input 的字符串。
 *
 * 处理内容：去掉数字/小数点以外的字符（含 number 输入框在移动端仍可输入的
 * e/E/+/-），整数模式去掉小数点，非整数模式只保留第一个小数点并截断小数位。
 * 空串原样返回（允许用户清空后重新输入）。
 */
export function sanitizeNumeric(
  raw: string,
  opts: { int?: boolean; decimals?: number } = {},
): string {
  if (raw === '') return ''
  const { int = false, decimals = 1 } = opts

  // 只保留数字与小数点
  let s = raw.replace(/[^\d.]/g, '')
  if (s === '') return ''

  if (int) {
    s = s.replace(/\./g, '')
  } else {
    // 只保留第一个小数点
    const first = s.indexOf('.')
    if (first >= 0) {
      s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, '')
    }
    // 截断小数位
    const dot = s.indexOf('.')
    if (dot >= 0 && s.length - dot - 1 > decimals) {
      s = s.slice(0, dot + decimals + 1)
    }
  }

  // 去掉多余的前导零（保留 "0" 与 "0.x"）
  s = s.replace(/^0+(?=\d)/, '')
  return s
}

/* ────────────────────────── 数值：校验与纠正 ────────────────────────── */

export interface NumCheck {
  ok: boolean
  value: number | null
  error: string
}

/** 该规则的取值范围描述，如「1–120 岁」 */
export function rangeText(limit: NumLimit): string {
  return `${limit.min}–${limit.max} ${limit.unit}`
}

/**
 * 校验一个数值输入。
 * 空串、非数字、越界、非整数（当 int 为 true）都会返回 ok=false 并带上中文提示。
 */
export function checkNumber(raw: string, limit: NumLimit): NumCheck {
  const s = (raw ?? '').trim()
  if (s === '') {
    return { ok: false, value: null, error: `请填写${limit.label}（${rangeText(limit)}）` }
  }
  const n = Number(s)
  if (!Number.isFinite(n)) {
    return { ok: false, value: null, error: `${limit.label}请输入数字（${rangeText(limit)}）` }
  }
  if (limit.int && !Number.isInteger(n)) {
    return { ok: false, value: null, error: `${limit.label}请输入整数（${rangeText(limit)}）` }
  }
  if (n < limit.min || n > limit.max) {
    return { ok: false, value: null, error: `${limit.label}应在 ${rangeText(limit)} 之间，已输入 ${n}` }
  }
  return { ok: true, value: n, error: '' }
}

/**
 * 失焦时把越界值夹到边界，返回用于回填 input 的字符串。
 * 合法值原样返回（仅做小数位规整），空串与非法值返回 ''。
 */
export function clampNumeric(raw: string, limit: NumLimit): string {
  const s = sanitizeNumeric(raw, { int: limit.int, decimals: limit.decimals })
  if (s === '' || s === '.') return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  const clamped = Math.min(limit.max, Math.max(limit.min, n))
  const rounded = limit.int ? Math.round(clamped) : Math.round(clamped * 10) / 10
  return String(rounded)
}

/**
 * 数值 + 单位的展示格式化（去掉多余的 .0）。
 */
export function formatNum(n: number | null | undefined, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const r = Math.round(n * 10 ** decimals) / 10 ** decimals
  return Number.isInteger(r) ? String(r) : r.toFixed(decimals)
}

/* ────────────────────────── 文本校验 ────────────────────────── */

export interface TextCheck {
  ok: boolean
  value: string
  error: string
}

/** 校验一个文本输入（长度 + 字符集）。会先 trim。 */
export function checkText(raw: string, rule: TextRule): TextCheck {
  const v = (raw ?? '').trim()
  if (v.length < rule.min) {
    return {
      ok: false,
      value: v,
      error: rule.min === 0 ? '' : `${rule.label}不能为空`,
    }
  }
  if (v.length > rule.max) {
    return { ok: false, value: v, error: `${rule.label}最多 ${rule.max} 个字` }
  }
  if (rule.pattern && !rule.pattern.test(v)) {
    return { ok: false, value: v, error: `${rule.label}${rule.patternHint ?? '格式不正确'}` }
  }
  return { ok: true, value: v, error: '' }
}

/* ────────────────────────── 交叉校验 ────────────────────────── */

/** 目标体重与当前体重的最大允许差值（kg），超出视为误输入 */
export const MAX_TARGET_WEIGHT_DIFF = 100

/**
 * 目标体重合理性：除各自的 20–300 边界外，还要与当前体重「不脱节」。
 * 例如当前 62kg 却填目标 250kg，多半是打错单位或手指误触。
 */
export function checkTargetWeightDiff(
  targetKg: number | null,
  currentKg: number | null,
): { ok: boolean; error: string } {
  if (targetKg == null || currentKg == null) return { ok: true, error: '' }
  const diff = Math.abs(targetKg - currentKg)
  if (diff > MAX_TARGET_WEIGHT_DIFF) {
    return {
      ok: false,
      error: `目标体重与当前体重相差 ${formatNum(diff)} kg，请确认是否填错`,
    }
  }
  return { ok: true, error: '' }
}

/* ────────────────────────── 业务格式校验 ────────────────────────── */

/** 中国大陆手机号：11 位、1 开头、第二位 3–9 */
export function isPhoneCN(v: string): boolean {
  return /^1[3-9]\d{9}$/.test((v ?? '').trim())
}

/** 邮箱：宽松但拒绝明显非法（无 @、无域名点、含空格） */
export function isEmail(v: string): boolean {
  const s = (v ?? '').trim()
  if (!s || s.includes(' ')) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)
}

/** 短信/邮箱验证码：4–8 位数字（各家长度不一，不做过严限制） */
export function isOtpCode(v: string): boolean {
  const s = (v ?? '').trim()
  return /^\d{4,8}$/.test(s)
}

/** 把校验错误统一成一行提示；无错误返回空串 */
export function firstError(...errors: Array<string | undefined | null>): string {
  for (const e of errors) if (e) return e
  return ''
}
