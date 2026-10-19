/**
 * 输入边界校验（对齐主工程 src/lib/validate.ts 的数值部分）。
 * 纯函数、零依赖，供 Onboarding 与各输入框复用。
 */

export interface NumLimit {
  label: string
  min: number
  max: number
  int?: boolean
  decimals?: number
  unit: string
}

export const AGE_LIMIT: NumLimit = { label: '年龄', min: 1, max: 120, int: true, unit: '岁' }
export const HEIGHT_LIMIT: NumLimit = { label: '身高', min: 100, max: 250, decimals: 1, unit: 'cm' }
export const WEIGHT_LIMIT: NumLimit = { label: '体重', min: 20, max: 300, decimals: 1, unit: 'kg' }
export const STEP_GOAL_LIMIT: NumLimit = { label: '步数目标', min: 1000, max: 50000, int: true, unit: '步' }

/* ── 文本规则 ── */

export interface TextRule {
  label: string
  min: number
  max: number
  pattern?: RegExp
  patternHint?: string
}

export const NICKNAME_RULE: TextRule = { label: '昵称', min: 1, max: 20 }

export interface TextCheck {
  ok: boolean
  value: string
  error: string
}

export function checkText(raw: string, rule: TextRule): TextCheck {
  const v = (raw ?? '').trim()
  if (v.length < rule.min) {
    return { ok: false, value: v, error: rule.min === 0 ? '' : `${rule.label}不能为空` }
  }
  if (v.length > rule.max) {
    return { ok: false, value: v, error: `${rule.label}最多 ${rule.max} 个字` }
  }
  if (rule.pattern && !rule.pattern.test(v)) {
    return { ok: false, value: v, error: `${rule.label}${rule.patternHint ?? '格式不正确'}` }
  }
  return { ok: true, value: v, error: '' }
}

export function firstError(...errors: Array<string | undefined | null>): string {
  for (const e of errors) if (e) return e
  return ''
}

export function rangeText(limit: NumLimit): string {
  return `${limit.min}–${limit.max} ${limit.unit}`
}

export interface NumCheck {
  ok: boolean
  value: number | null
  error: string
}

export function sanitizeNumeric(raw: string, opts: { int?: boolean; decimals?: number } = {}): string {
  if (raw === '') return ''
  const { int = false, decimals = 1 } = opts
  let s = raw.replace(/[^\d.]/g, '')
  if (s === '') return ''
  if (int) {
    s = s.replace(/\./g, '')
  } else {
    const first = s.indexOf('.')
    if (first >= 0) s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, '')
    const dot = s.indexOf('.')
    if (dot >= 0 && s.length - dot - 1 > decimals) s = s.slice(0, dot + decimals + 1)
  }
  s = s.replace(/^0+(?=\d)/, '')
  return s
}

export function checkNumber(raw: string, limit: NumLimit): NumCheck {
  const s = (raw ?? '').trim()
  if (s === '') return { ok: false, value: null, error: `请填写${limit.label}（${rangeText(limit)}）` }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, value: null, error: `${limit.label}请输入数字（${rangeText(limit)}）` }
  if (limit.int && !Number.isInteger(n)) return { ok: false, value: null, error: `${limit.label}请输入整数（${rangeText(limit)}）` }
  if (n < limit.min || n > limit.max) return { ok: false, value: null, error: `${limit.label}应在 ${rangeText(limit)} 之间，已输入 ${n}` }
  return { ok: true, value: n, error: '' }
}

export function clampNumeric(raw: string, limit: NumLimit): string {
  const s = sanitizeNumeric(raw, { int: limit.int, decimals: limit.decimals })
  if (s === '' || s === '.') return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  const clamped = Math.min(limit.max, Math.max(limit.min, n))
  const rounded = limit.int ? Math.round(clamped) : Math.round(clamped * 10) / 10
  return String(rounded)
}

export function formatNum(n: number | null | undefined, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const r = Math.round(n * 10 ** decimals) / 10 ** decimals
  return Number.isInteger(r) ? String(r) : r.toFixed(decimals)
}

export const MAX_TARGET_WEIGHT_DIFF = 100

export function checkTargetWeightDiff(targetKg: number | null, currentKg: number | null): { ok: boolean; error: string } {
  if (targetKg == null || currentKg == null) return { ok: true, error: '' }
  const diff = Math.abs(targetKg - currentKg)
  if (diff > MAX_TARGET_WEIGHT_DIFF) {
    return { ok: false, error: `目标体重与当前体重相差 ${formatNum(diff)} kg，请确认是否填错` }
  }
  return { ok: true, error: '' }
}
