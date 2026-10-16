/** 运动健康对接 · 纯逻辑自测（estimateActivityKcal 步数换算 + eat-back 比例） */
let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

// 与 src/lib/health/index.ts 逐行一致
function estimateActivityKcal(steps, weightKg, heightCm) {
  const s = Math.max(0, Math.round(steps || 0))
  if (s <= 0 || !weightKg || weightKg <= 0) return 0
  const strideM = heightCm && heightCm > 0 ? (heightCm / 100) * 0.45 : 0.72
  const km = (s * strideM) / 1000
  return Math.round(km * weightKg * 0.75)
}
const RATIO = 0.5

// 身高 170cm、体重 70kg：步幅 0.765m
// 10000 步 = 7.65km，消耗 = 7.65 * 70 * 0.75 = 401.6 → 402
assert('10000步/70kg/170cm ≈ 402 kcal', estimateActivityKcal(10000, 70, 170) === 402, `实得 ${estimateActivityKcal(10000, 70, 170)}`)

// 缺体重 → 0（安全兜底）
assert('缺体重返回 0', estimateActivityKcal(10000, null, 170) === 0)
assert('体重为 0 返回 0', estimateActivityKcal(10000, 0, 170) === 0)

// 0 步 → 0
assert('0 步返回 0', estimateActivityKcal(0, 70, 170) === 0)
assert('负步数兜底 0', estimateActivityKcal(-500, 70, 170) === 0)

// 缺身高用默认步幅 0.72m：10000 步 = 7.2km，消耗 = 7.2*70*0.75 = 378
assert('缺身高默认步幅 ≈ 378', estimateActivityKcal(10000, 70, null) === 378, `实得 ${estimateActivityKcal(10000, 70, null)}`)

// eat-back：活动消耗 402 * 50% = 201 计入「可吃回」
const eatback = Math.round(estimateActivityKcal(10000, 70, 170) * RATIO)
assert('50% eat-back = 201', eatback === 201, `实得 ${eatback}`)

// 身高 180cm、体重 90kg：步幅 0.81m，10000 步 = 8.1km，消耗 = 8.1*90*0.75 = 546.75 → 547
assert('180cm/90kg ≈ 547', estimateActivityKcal(10000, 90, 180) === 547, `实得 ${estimateActivityKcal(10000, 90, 180)}`)

console.log(failed === 0 ? '\n=== 全部通过 ===' : `\n=== ${failed} 项失败 ===`)
process.exit(failed === 0 ? 0 : 1)
