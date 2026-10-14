/**
 * 食物画像引擎自检。
 *
 * 打分逻辑不能靠肉眼信任 —— 这个脚本把引擎跑在全部内置食物上，
 * 打印代表性条目并断言几条必须成立的性质，改动规则后跑一次即可发现回归。
 *
 * 运行（不需要额外装包，复用 vite 自带的 esbuild）：
 *   node_modules/.bin/esbuild tools/insight-selftest.ts --bundle --platform=node --format=esm --outfile=tools/.insight-selftest.mjs
 *   node tools/.insight-selftest.mjs
 */

import { FOODS, categoryOf, foodInsight } from '../src/lib/foods'
import { analyzeProfile, analyzeEntry, nextMealAdvice, summarizeEntries } from '../src/lib/foodInsight'
import type { MealEntry } from '../src/types'

let failed = 0

function assert(label: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label} ${detail}`)
  }
}

function show(name: string) {
  const f = FOODS.find((x) => x.name === name)
  if (!f) {
    failed += 1
    console.log(`  ✗ 找不到内置食物「${name}」`)
    return null
  }
  const i = foodInsight(f)
  const tags = [
    ...i.risks.map((t) => `-${t.label}`),
    ...i.benefits.map((t) => `+${t.label}`),
  ].join(' ')
  console.log(
    `  ${String(i.score).padStart(3)}  ${f.name.padEnd(16, '　')} ${f.category.padEnd(6, '　')} ${tags}`,
  )
  return i
}

console.log('\n=== 一、代表性食物打分 ===')
const rice = show('米饭（熟）')
const apple = show('苹果')
const chips = show('薯片')
const breast = show('鸡胸肉')
const salmon = show('三文鱼')
const cola = show('可乐')
const broccoli = show('西兰花')
const egg = show('鸡蛋（全蛋）')
const youtiao = show('油条')

console.log('\n=== 二、断言 ===')
assert('白米饭落在「适量就好」区间 40–70', !!rice && rice.score >= 40 && rice.score <= 70, `实际 ${rice?.score}`)
assert('苹果属于正面食物（≥70）', !!apple && apple.score >= 70, `实际 ${apple?.score}`)
assert('薯片属于负面食物（≤35）', !!chips && chips.score <= 35, `实际 ${chips?.score}`)
assert('鸡胸肉属于正面食物（≥80）', !!breast && breast.score >= 80, `实际 ${breast?.score}`)
assert('三文鱼不判为高脂负面（≥60）', !!salmon && salmon.score >= 60, `实际 ${salmon?.score}`)
assert('西兰花为正面食物（≥75）', !!broccoli && broccoli.score >= 75, `实际 ${broccoli?.score}`)
assert('油条被识别出用油问题', !!youtiao && youtiao.risks.some((t) => t.key === 'oily_cook'))
assert('可乐被识别为含糖饮料', !!cola && cola.risks.some((t) => t.key === 'sugary_drink'), `实际 ${cola?.tags.map((t) => t.key).join(',')}`)
assert('鸡蛋被认为蛋白质来源', !!egg && egg.benefits.length > 0)

console.log('\n=== 三、全库性质检查 ===')
let minScore = 101
let maxScore = -1
let noTagCount = 0
let badTags = 0
let badScore = 0
const noTagSamples: string[] = []

for (const f of FOODS) {
  const i = foodInsight(f)
  minScore = Math.min(minScore, i.score)
  maxScore = Math.max(maxScore, i.score)
  if (i.risks.length > 3 || i.benefits.length > 3) badTags += 1
  if (i.score < 5 || i.score > 98) badScore += 1
  if (i.score < 50 && i.risks.length === 0) {
    badTags += 1
    console.log(`    ⚠ 低分但没有风险标签：${f.name} (${i.score})`)
  }
  if (i.score >= 65 && i.benefits.length === 0) {
    badTags += 1
    console.log(`    ⚠ 高分但没有益处标签：${f.name} (${i.score})`)
  }
  if (i.tags.length === 0) {
    noTagCount += 1
    if (noTagSamples.length < 8) noTagSamples.push(`${f.name}(${i.score})`)
  }
}

console.log(`  条目总数 ${FOODS.length}，分数区间 ${minScore}–${maxScore}`)
assert('没有越界分数（5–98）', badScore === 0, `${badScore} 条越界`)
assert('风险/益处标签各自不超过 3 个', badTags === 0, `${badTags} 条异常`)
assert('无标签条目占比 < 15%', noTagCount / FOODS.length < 0.15, `${noTagCount} 条（${((noTagCount / FOODS.length) * 100).toFixed(1)}%）：${noTagSamples.join('、')}`)

console.log('\n=== 四、分类反查（记录表里不存分类）===')
assert('番茄（西红柿）→ 蔬菜', categoryOf('番茄（西红柿）') === '蔬菜', categoryOf('番茄（西红柿）'))
assert('鸡胸肉（熟）→ 肉类', categoryOf('鸡胸肉（熟）') === '肉类', categoryOf('鸡胸肉（熟）'))
assert('未知食物 → 其他', categoryOf('外婆的红烧肉') === '其他', categoryOf('外婆的红烧肉'))

console.log('\n=== 五、记录条目 → 画像（含份量折算）===')
const entry = (o: Partial<MealEntry>): MealEntry => ({
  log_date: '2026-10-13',
  meal_type: 'lunch',
  food_name: 'x',
  quantity_text: null,
  grams: 100,
  calories: 100,
  protein_g: 0,
  carb_g: 0,
  fat_g: 0,
  source: 'manual',
  ...o,
})

const riceEntry = entry({ food_name: '米饭（熟）', grams: 200, calories: 232, protein_g: 5.2, carb_g: 51.8, fat_g: 0.6 })
const iRice = analyzeEntry(riceEntry, categoryOf)
console.log(`  米饭 200g：友好度 ${iRice.score}（应等于每 100g 的判定，因为按重量等比折算）`)
assert('份量折算不改变每 100g 判定', iRice.score === rice!.score, `${iRice.score} vs ${rice!.score}`)

const brokenGrams = entry({ food_name: '未知菜', grams: 1, calories: 300, protein_g: 5, carb_g: 20, fat_g: 20 })
const iBroken = analyzeEntry(brokenGrams, categoryOf)
assert('克重不可信时不报「热量密度」', !iBroken.tags.some((t) => t.key === 'dense'), iBroken.tags.map((t) => t.key).join(','))

console.log('\n=== 六、当日汇总 ===')
const day: MealEntry[] = [
  entry({ food_name: '油条', grams: 60, calories: 232, protein_g: 4.2, carb_g: 25, fat_g: 13.2 }),
  entry({ food_name: '薯片', grams: 45, calories: 248, protein_g: 1.6, carb_g: 24, fat_g: 15.5 }),
  entry({ food_name: '西兰花', grams: 200, calories: 72, protein_g: 5.8, carb_g: 7.6, fat_g: 0.8 }),
  entry({ food_name: '鸡胸肉（熟）', grams: 150, calories: 200, protein_g: 30, carb_g: 0, fat_g: 7.5 }),
]
const sum = summarizeEntries(day, categoryOf)
console.log(`  平均友好度 ${sum.avgScore}｜风险 ${sum.risks.map((t) => `${t.label}×${t.count}`).join('、')}`)
console.log(`  益处 ${sum.benefits.map((t) => `${t.label}×${t.count}`).join('、')}`)
console.log(`  结论 ${sum.verdict}`)
assert('汇总能同时给出风险与益处', sum.risks.length > 0 && sum.benefits.length > 0)
assert('汇总结论非空', sum.verdict.length > 0)

console.log('\n=== 七、下一餐建议额度 ===')
const a1 = nextMealAdvice(900, new Set(['breakfast']), new Date('2026-10-13T12:30:00'))
console.log(`  剩 900 kcal、已吃早餐、12:30 → ${a1.text}`)
assert('按剩余餐次拆分额度', a1.budget !== null && a1.budget > 0 && a1.remainingMeals >= 1)
const a2 = nextMealAdvice(-120, new Set(['breakfast', 'lunch']), new Date('2026-10-13T20:00:00'))
console.log(`  超支 120 kcal、20:00 → ${a2.text}`)
assert('超支时不给出额度并转为提醒', a2.budget === null && a2.over)

console.log(`\n${failed === 0 ? '全部通过 ✅' : `${failed} 项未通过 ❌`}\n`)
if (failed > 0) process.exitCode = 1
