/**
 * 小程序端 computeReport 供能比回归测试（P1-A，2026-11-03）。
 *
 * 起因：主工程 a977ee4 修过 report.ts 的供能比真实计算错误，但**同一份 bug
 * 在 `mini/src/lib/report.ts` 里原样存在**（两端 report.ts 是手工移植关系）。
 * P1-A 把 `numfmt` 下沉到 `@dbee/shared` 后，顺手把 mini 端也修了，本测试守住它。
 *
 * 旧代码（mini 修复前）：
 *   const avgProtein = round(sum.protein / base)   // ← 先取整
 *   const kcalEnergy = avgProtein * 4 + avgCarb * 4 + avgFat * 9
 *   const ratio = (v) => Math.round((v / kcalEnergy) * 100)
 *
 * 两个问题：
 *   ① 用「已取整的日均克数」反算比例 —— 违反「计算层保持全精度」纪律，比例本身失真；
 *   ② 三项各自 Math.round —— 合计可能是 99 或 101。
 *      实测反例（与主工程同一组）：日均蛋白/碳水/脂肪 = 23/47/26 → 18% + 37% + 46% = 101%
 *
 * 修法：用未舍入原值算，再走 balancePercents（最大余数法）配平到合计恰好 100。
 *
 * 运行：npx vitest run tools/mini-report-ratio.test.ts
 */
import { describe, expect, it } from 'vitest'
import { computeReport } from '../mini/src/lib/report'
import { shiftDate, todayKey } from '../mini/src/lib/nutrition'
import type { MealEntry } from '../mini/src/lib/api'

/** 用今天作为记录日，避免测试随日期漂移而失效 */
const D = todayKey()

function meal(p: number, c: number, f: number, kcal: number, date = D): MealEntry {
  return {
    log_date: date,
    meal_type: 'lunch',
    food_name: '测试餐',
    quantity_text: null,
    grams: 100,
    calories: kcal,
    protein_g: p,
    carb_g: c,
    fat_g: f,
    source: 'manual',
  }
}

const PROFILE = {
  id: 'u1',
  daily_calorie_target: 1800,
  protein_target_g: 90,
  carb_target_g: 200,
  fat_target_g: 60,
} as never

describe('mini computeReport · 三大营养素供能比', () => {
  it('🔴 合计恒等于 100（旧逻辑在这组数据上得 101）', () => {
    // 日均 23 / 47 / 26 —— 旧逻辑实测 18 + 37 + 46 = 101
    const report = computeReport([meal(23, 47, 26, 570)], [], PROFILE, 7)
    const total = report.proteinRatio + report.carbRatio + report.fatRatio
    expect(total, `${report.proteinRatio}+${report.carbRatio}+${report.fatRatio}`).toBe(100)
  })

  it('🔴 比例基于未舍入原值，不被日均取整污染', () => {
    // 蛋白 23.4g、碳水 47.4g、脂肪 26.4g
    // 真实供能：93.6 / 189.6 / 237.6，合计 520.8 → 17.97% / 36.4% / 45.6%
    const report = computeReport([meal(23.4, 47.4, 26.4, 570)], [], PROFILE, 7)
    const total = report.proteinRatio + report.carbRatio + report.fatRatio
    expect(total).toBe(100)
    // 旧逻辑先把日均取整成 23/47/26 再反算，会丢掉 .4 的信息
    expect(report.proteinRatio).toBe(18)
    expect(report.carbRatio).toBe(36)
    expect(report.fatRatio).toBe(46)
  })

  it('与主工程 computeReport 同输入同输出（两端一致性）', async () => {
    const { computeReport: mainCompute } = await import('../src/lib/report')
    const mainMeal = { ...meal(23, 47, 26, 570) } as never
    const main = mainCompute([mainMeal], [], PROFILE, 7)
    const mini = computeReport([meal(23, 47, 26, 570)], [], PROFILE, 7)
    expect([mini.proteinRatio, mini.carbRatio, mini.fatRatio]).toEqual([
      main.proteinRatio,
      main.carbRatio,
      main.fatRatio,
    ])
    // 日均克数保留 2 位小数（口径一致）
    expect(mini.avgProtein).toBe(main.avgProtein)
    expect(mini.avgCarb).toBe(main.avgCarb)
    expect(mini.avgFat).toBe(main.avgFat)
  })

  it('日均营养素保留 2 位小数（不再是 1 位）', () => {
    // 两个不同日期各记一次，loggedDays=2 → 日均 = 单值 23.456 → 2 位小数 23.46
    const y = shiftDate(D, -1)
    const report = computeReport(
      [meal(23.456, 47.456, 26.456, 570, y), meal(23.456, 47.456, 26.456, 570, D)],
      [],
      PROFILE,
      7,
    )
    expect(report.avgProtein).toBe(23.46)
    expect(report.avgCarb).toBe(47.46)
    expect(report.avgFat).toBe(26.46)
    // 热量仍按惯例取整
    expect(Number.isInteger(report.avgKcal)).toBe(true)
  })

  it('全 0 记录时供能比不炸（边界）', () => {
    const report = computeReport([meal(0, 0, 0, 0)], [], PROFILE, 7)
    expect(report.proteinRatio + report.carbRatio + report.fatRatio).toBe(0)
  })

  it('无记录时不炸（边界）', () => {
    const report = computeReport([], [], PROFILE, 7)
    expect(report.proteinRatio + report.carbRatio + report.fatRatio).toBe(0)
    expect(report.avgKcal).toBe(0)
  })
})
