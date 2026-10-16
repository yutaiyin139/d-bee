/**
 * 输入边界校验自测（独立 .mjs，不 import TS，逻辑与 src/lib/validate.ts 逐行一致）。
 * 运行：node tools/validate-selftest.mjs
 */
let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

// ── 与 src/lib/validate.ts 逐行一致的纯函数 ──────────────────────
const AGE_LIMIT = { label: '年龄', min: 1, max: 120, int: true, unit: '岁' }
const HEIGHT_LIMIT = { label: '身高', min: 100, max: 250, decimals: 1, unit: 'cm' }
const WEIGHT_LIMIT = { label: '体重', min: 20, max: 300, decimals: 1, unit: 'kg' }
const GRAMS_LIMIT = { label: '份量', min: 1, max: 5000, int: true, unit: 'g' }
const MINUTES_LIMIT = { label: '运动时长', min: 5, max: 300, int: true, unit: '分钟' }
const MAX_TARGET_WEIGHT_DIFF = 100

function sanitizeNumeric(raw, opts = {}) {
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

function rangeText(limit) {
  return `${limit.min}–${limit.max} ${limit.unit}`
}

function checkNumber(raw, limit) {
  const s = (raw ?? '').trim()
  if (s === '') return { ok: false, value: null, error: `请填写${limit.label}（${rangeText(limit)}）` }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, value: null, error: `${limit.label}请输入数字（${rangeText(limit)}）` }
  if (limit.int && !Number.isInteger(n)) return { ok: false, value: null, error: `${limit.label}请输入整数（${rangeText(limit)}）` }
  if (n < limit.min || n > limit.max)
    return { ok: false, value: null, error: `${limit.label}应在 ${rangeText(limit)} 之间，已输入 ${n}` }
  return { ok: true, value: n, error: '' }
}

function clampNumeric(raw, limit) {
  const s = sanitizeNumeric(raw, { int: limit.int, decimals: limit.decimals })
  if (s === '' || s === '.') return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  const clamped = Math.min(limit.max, Math.max(limit.min, n))
  const rounded = limit.int ? Math.round(clamped) : Math.round(clamped * 10) / 10
  return String(rounded)
}

function checkTargetWeightDiff(targetKg, currentKg) {
  if (targetKg == null || currentKg == null) return { ok: true, error: '' }
  const diff = Math.abs(targetKg - currentKg)
  if (diff > MAX_TARGET_WEIGHT_DIFF)
    return { ok: false, error: `目标体重与当前体重相差 ${Math.round(diff * 10) / 10} kg，请确认是否填错` }
  return { ok: true, error: '' }
}

function checkText(raw, rule) {
  const v = (raw ?? '').trim()
  if (v.length < rule.min) return { ok: false, value: v, error: rule.min === 0 ? '' : `${rule.label}不能为空` }
  if (v.length > rule.max) return { ok: false, value: v, error: `${rule.label}最多 ${rule.max} 个字` }
  if (rule.pattern && !rule.pattern.test(v))
    return { ok: false, value: v, error: `${rule.label}${rule.patternHint ?? '格式不正确'}` }
  return { ok: true, value: v, error: '' }
}

const isPhoneCN = (v) => /^1[3-9]\d{9}$/.test((v ?? '').trim())
const isEmail = (v) => {
  const s = (v ?? '').trim()
  if (!s || s.includes(' ')) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)
}
const isOtpCode = (v) => /^\d{4,8}$/.test((v ?? '').trim())

// ── 1. 输入过滤 ──────────────────────────────────────────────
console.log('\n[1] sanitizeNumeric 输入过程过滤')
assert('过滤 number 输入框可输入的 e/E', sanitizeNumeric('1e5', { int: true }) === '15', sanitizeNumeric('1e5', { int: true }))
assert('过滤正负号', sanitizeNumeric('-12+3', { int: true }) === '123', sanitizeNumeric('-12+3', { int: true }))
assert('整数模式去掉小数点', sanitizeNumeric('17.5', { int: true }) === '175', sanitizeNumeric('17.5', { int: true }))
assert('小数模式只保留第一个小数点', sanitizeNumeric('17.5.6') === '17.5', sanitizeNumeric('17.5.6'))
assert('小数位超限截断（1 位）', sanitizeNumeric('62.789') === '62.7', sanitizeNumeric('62.789'))
assert('空串原样返回（允许清空重输）', sanitizeNumeric('') === '')
assert('纯非法字符返回空串', sanitizeNumeric('abc', { int: true }) === '')
assert('去掉多余前导零', sanitizeNumeric('007', { int: true }) === '7', sanitizeNumeric('007', { int: true }))

// ── 2. 边界判定 ──────────────────────────────────────────────
console.log('\n[2] checkNumber 边界判定')
assert('身高下界内 (100) 通过', checkNumber('100', HEIGHT_LIMIT).ok)
assert('身高下界外 (99) 拦截', !checkNumber('99', HEIGHT_LIMIT).ok)
assert('身高上界内 (250) 通过', checkNumber('250', HEIGHT_LIMIT).ok)
assert('身高上界外 (251) 拦截', !checkNumber('251', HEIGHT_LIMIT).ok)
assert('荒谬身高 9999 被拦截', !checkNumber('9999', HEIGHT_LIMIT).ok)
assert('体重 0 被拦截', !checkNumber('0', WEIGHT_LIMIT).ok)
assert('体重 300 通过', checkNumber('300', WEIGHT_LIMIT).ok)
assert('年龄 3.5 非整数被拦截', !checkNumber('3.5', AGE_LIMIT).ok)
assert('年龄 120 通过', checkNumber('120', AGE_LIMIT).ok)
assert('年龄 121 拦截', !checkNumber('121', AGE_LIMIT).ok)
assert('空串给出「请填写」提示', checkNumber('', AGE_LIMIT).error.includes('请填写'))
assert('非数字给出「请输入数字」提示', checkNumber('abc', AGE_LIMIT).error.includes('请输入数字'))

// ── 3. 失焦纠正 ──────────────────────────────────────────────
console.log('\n[3] clampNumeric 失焦纠正')
assert('身高 9999 → 250', clampNumeric('9999', HEIGHT_LIMIT) === '250', clampNumeric('9999', HEIGHT_LIMIT))
assert('身高 50 → 100', clampNumeric('50', HEIGHT_LIMIT) === '100', clampNumeric('50', HEIGHT_LIMIT))
assert('体重 5 → 20', clampNumeric('5', WEIGHT_LIMIT) === '20', clampNumeric('5', WEIGHT_LIMIT))
assert('年龄 200 → 120', clampNumeric('200', AGE_LIMIT) === '120', clampNumeric('200', AGE_LIMIT))
assert('合法值原样（含小数）', clampNumeric('62.5', WEIGHT_LIMIT) === '62.5', clampNumeric('62.5', WEIGHT_LIMIT))
assert('空串返回空串（不误填最小值）', clampNumeric('', WEIGHT_LIMIT) === '')
assert('份量 99999 → 5000', clampNumeric('99999', GRAMS_LIMIT) === '5000', clampNumeric('99999', GRAMS_LIMIT))
assert('运动时长 400 → 300', clampNumeric('400', MINUTES_LIMIT) === '300', clampNumeric('400', MINUTES_LIMIT))

// ── 4. 交叉校验 ──────────────────────────────────────────────
console.log('\n[4] checkTargetWeightDiff 目标体重合理性')
assert('62 → 55 合理', checkTargetWeightDiff(55, 62).ok)
assert('62 → 58.5 合理', checkTargetWeightDiff(58.5, 62).ok)
assert('62 → 250 拦截（差 188kg）', !checkTargetWeightDiff(250, 62).ok)
assert('62 → 100 通过（差 38kg，增肌场景）', checkTargetWeightDiff(100, 62).ok)
assert('缺值时不报错', checkTargetWeightDiff(null, 62).ok)

// ── 5. 文本校验 ──────────────────────────────────────────────
console.log('\n[5] checkText 文本校验')
const NICKNAME_RULE = { label: '昵称', min: 1, max: 20 }
const INVITE_CODE_RULE = { label: '邀请码', min: 4, max: 8, pattern: /^[A-Z0-9]+$/, patternHint: '只能包含大写字母与数字' }
const MEAL_TEXT_RULE = { label: '食物描述', min: 1, max: 500 }
assert('昵称 20 字通过', checkText('一二三四五六七八九十一二三四五六七八九十', NICKNAME_RULE).ok)
assert('昵称 21 字拦截', !checkText('一二三四五六七八九十一二三四五六七八九十一', NICKNAME_RULE).ok)
assert('昵称空串拦截', !checkText('', NICKNAME_RULE).ok)
assert('邀请码小写拦截', !checkText('abcd1234', INVITE_CODE_RULE).ok)
assert('邀请码长度不足拦截', !checkText('AB1', INVITE_CODE_RULE).ok)
assert('邀请码合法通过', checkText('AB12CD', INVITE_CODE_RULE).ok)
assert('食物描述 500 字通过', checkText('好'.repeat(500), MEAL_TEXT_RULE).ok)
assert('食物描述 501 字拦截', !checkText('好'.repeat(501), MEAL_TEXT_RULE).ok)

// ── 6. 账号格式 ──────────────────────────────────────────────
console.log('\n[6] 账号格式校验')
assert('手机号 13800138000 合法', isPhoneCN('13800138000'))
assert('手机号 12 开头拦截', !isPhoneCN('12800138000'))
assert('手机号 10 位拦截', !isPhoneCN('1380013800'))
assert('手机号带空格拦截', !isPhoneCN('138 0013 8000'))
assert('邮箱合法', isEmail('a@b.com'))
assert('邮箱无域名点拦截', !isEmail('a@b'))
assert('邮箱含空格拦截', !isEmail('a b@c.com'))
assert('验证码 6 位合法', isOtpCode('123456'))
assert('验证码 3 位拦截', !isOtpCode('123'))
assert('验证码含字母拦截', !isOtpCode('12345a'))

// ── 汇总 ─────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}\n`)
process.exit(failed === 0 ? 0 : 1)
