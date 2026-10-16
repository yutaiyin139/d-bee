/**
 * V1.2 新功能纯逻辑自测（独立 .mjs，不 import 云 SDK，避免 import.meta.env 依赖）。
 * 逻辑与 src/lib/api.ts 的 buildMealsCsv / updateMealGrams 逐行一致，验证算法正确性。
 */
let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

// ── 1) buildMealsCsv（与 api.ts 逐行一致）─────────────────────────
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
const CSV_HEADERS = ['日期','餐次','食物','份量','克数','热量(kcal)','蛋白质(g)','碳水(g)','脂肪(g)','钠(mg)','膳食纤维(g)','添加糖(g)','来源']
const MEAL_CN = { breakfast:'早餐', lunch:'午餐', dinner:'晚餐', snack:'加餐' }
function buildMealsCsv(meals) {
  const lines = [CSV_HEADERS.join(',')]
  for (const m of meals) {
    lines.push([m.log_date, MEAL_CN[m.meal_type] ?? m.meal_type, m.food_name, m.quantity_text ?? '', m.grams ?? '', m.calories, m.protein_g, m.carb_g, m.fat_g, m.sodium_mg ?? '', m.fiber_g ?? '', m.added_sugar_g ?? '', m.source].map(csvCell).join(','))
  }
  return '\ufeff' + lines.join('\r\n')
}
const meals = [
  { log_date:'2026-10-15', meal_type:'lunch', food_name:'米饭', quantity_text:'1 碗', grams:200, calories:232, protein_g:5.2, carb_g:51.8, fat_g:0.6, sodium_mg:4, fiber_g:0.6, added_sugar_g:0, source:'photo' },
  { log_date:'2026-10-15', meal_type:'snack', food_name:'薯片,含"盐"', quantity_text:null, grams:50, calories:268, protein_g:3.5, carb_g:27, fat_g:16, sodium_mg:320, fiber_g:1.5, added_sugar_g:0.5, source:'barcode' },
]
const csv = buildMealsCsv(meals)
assert('CSV 含 BOM 头', csv.charCodeAt(0) === 0xFEFF, `首码 ${csv.charCodeAt(0).toString(16)}`)
assert('CSV 含表头', csv.includes('日期,餐次,食物,份量,克数,热量(kcal)'))
assert('CSV 午餐映射', csv.includes(',午餐,米饭'))
assert('CSV 加餐映射', csv.includes(',加餐,'))
assert('CSV 特殊字符转义(逗号+引号)', csv.includes('"薯片,含""盐"""'))
assert('CSV CRLF 换行', csv.includes('\r\n'))
assert('CSV 行数=3', csv.split('\r\n').length === 3, `实际 ${csv.split('\r\n').length}`)

// ── 2) 营养等比缩放（与 api.ts updateMealGrams 逐行一致）────────────
function updateMealGramsPatch(existing, grams) {
  const g = Math.max(1, Math.round(grams))
  const baseGrams = Number(existing.grams) || 1
  const scale = g / baseGrams
  const round1 = (n) => Math.round(n * 10) / 10
  return {
    grams: g,
    quantity_text: `${g} 克`,
    calories: Math.round((Number(existing.calories) || 0) * scale),
    protein_g: round1((Number(existing.protein_g) || 0) * scale),
    carb_g: round1((Number(existing.carb_g) || 0) * scale),
    fat_g: round1((Number(existing.fat_g) || 0) * scale),
    sodium_mg: existing.sodium_mg != null ? Math.round((Number(existing.sodium_mg) || 0) * scale) : null,
    fiber_g: existing.fiber_g != null ? round1((Number(existing.fiber_g) || 0) * scale) : null,
    added_sugar_g: existing.added_sugar_g != null ? round1((Number(existing.added_sugar_g) || 0) * scale) : null,
  }
}
const src = { grams:100, calories:250, protein_g:10, carb_g:30, fat_g:8, sodium_mg:400, fiber_g:2, added_sugar_g:1 }
const half = updateMealGramsPatch(src, 50)
assert('缩放-热量减半 125', half.calories === 125, `实得 ${half.calories}`)
assert('缩放-蛋白减半 5', half.protein_g === 5)
assert('缩放-钠减半 200', half.sodium_mg === 200)
assert('缩放-份量文字更新', half.quantity_text === '50 克', half.quantity_text)
const double = updateMealGramsPatch(src, 200)
assert('缩放-热量翻倍 500', double.calories === 500)
assert('缩放-纤维翻倍 4', double.fiber_g === 4)
const zero = updateMealGramsPatch(src, 0)
assert('缩放-0克兜底为1克', zero.grams === 1)
const nullNa = updateMealGramsPatch({ grams:100, calories:100, protein_g:5, carb_g:0, fat_g:0, sodium_mg:null, fiber_g:null, added_sugar_g:null }, 50)
assert('缩放-null钠保持null', nullNa.sodium_mg === null)
assert('缩放-null纤维保持null', nullNa.fiber_g === null)

console.log(failed === 0 ? '\n=== 全部通过 ===' : `\n=== ${failed} 项失败 ===`)
process.exit(failed === 0 ? 0 : 1)
