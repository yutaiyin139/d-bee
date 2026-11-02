/**
 * computeReport 供能比回归测试。
 *
 * 起因（2026-11-02）：用户要求「营养素数据保留两位小数，并确保计算逻辑没有错误」。
 * 审查时发现 report.ts 的供能比存在**真实的计算逻辑错误**，与展示无关：
 *
 *   旧代码：
 *     const avgProtein = round(sum.protein / base)   // ← 先取整
 *     const kcalEnergy = avgProtein * 4 + avgCarb * 4 + avgFat * 9
 *     const ratio = (v) => Math.round((v / kcalEnergy) * 100)
 *
 *   两个问题：
 *   ① 用「已取整的日均克数」反算比例 —— 违反「计算层保持全精度」纪律，比例本身失真；
 *   ② 三项各自 Math.round —— 合计可能是 99 或 101。
 *      实测反例：日均蛋白/碳水/脂肪 = 23/47/26 → 18% + 37% + 46% = 101%
 *
 *   修法：用未舍入原值算，再走 balancePercents（最大余数法）配平到合计恰好 100。
 *
 * 运行：npx vitest run tools/report-ratio.test.ts
 */
import { describe, expect, it } from 'vitest'
import { computeReport } from '../src/lib/report'
import type { MealEntry } from '../src/types'

const D = '2026-11-01'

function meal(p: number, c: number, f: number, kcal: number): MealEntry {
  return {
    log_date: D,
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

describe('computeReport · 三大营养素供能比', () => {
  it('🔴 合计恒等于 100（旧逻辑在这组数据上得 101）', () => {
    // 日均 23 / 47 / 26 —— 旧逻辑实测 18 + 37 + 46 = 101
    const report = computeReport([meal(23, 47, 26, 570)], [], PROFILE, 7)
    const total = report.proteinRatio + report.carbRatio + report.fatRatio
    expect(total, `${report.proteinRatio}+${report.carbRatio}+${report.fatRatio}`).toBe(100)
  })

  it('🔴 比例基于未舍入原值，不被日均取整污染', () => {
    // 蛋白 23.4g、碳水 47.4g、脂肪 26.4g
    // 真实供能：93.6 / 189.6 / 237.6，合计 520.8 → 17.97% / 36.4% / 45.6%
    // 若先取整成 23/47/26 再算，比例会明显偏移
    const report = computeReport([meal(23.4, 47.4, 26.4, 570)], [], PROFILE, 7)
    expect(report.proteinRatio).toBe(18)
    expect(report.carbRatio).toBe(36)
    expect(report.fatRatio).toBe(46)
    expect(report.proteinRatio + report.carbRatio + report.fatRatio).toBe(100)
  })

  it('跨多天聚合：日均按「有记录的天数」算，比例仍合计 100', () => {
    const report = computeReport([meal(23, 47, 26, 570), meal(31, 55, 19, 699)], [], PROFILE, 7)
    expect(report.loggedDays).toBe(1) // 两条记录同一天
    expect(report.proteinRatio + report.carbRatio + report.fatRatio).toBe(100)
  })

  it('边界：无任何记录时三项为 0，不产生 NaN', () => {
    const report = computeReport([], [], PROFILE, 7)
    expect(report.loggedDays).toBe(0)
    expect(report.proteinRatio).toBe(0)
    expect(report.carbRatio).toBe(0)
    expect(report.fatRatio).toBe(0)
    expect(Number.isNaN(report.proteinRatio)).toBe(false)
  })

  it('边界：全为 0 营养素时不除零', () => {
    const report = computeReport([meal(0, 0, 0, 0)], [], PROFILE, 7)
    expect(report.proteinRatio + report.carbRatio + report.fatRatio).toBe(0)
  })

  it('随机数据下合计恒为 100（fuzz）', () => {
    for (let i = 0; i < 500; i++) {
      const p = Math.random() * 120
      const c = Math.random() * 400
      const f = Math.random() * 150
      const report = computeReport([meal(p, c, f, p * 4 + c * 4 + f * 9)], [], PROFILE, 7)
      const total = report.proteinRatio + report.carbRatio + report.fatRatio
      expect(total, `p=${p} c=${c} f=${f} → ${report.proteinRatio}/${report.carbRatio}/${report.fatRatio}`).toBe(100)
    }
  })

  it('🔴 日均营养素克数保留 2 位小数（用户要求）', () => {
    // 蛋白 11.666…、碳水 5.833…、脂肪 32 —— 两天里只有一天有记录，日均 = 原值
    const report = computeReport([meal(11.666666666666666, 5.833333333333333, 32, 542)], [], PROFILE, 7)
    expect(report.avgProtein).toBe(11.67)
    expect(report.avgCarb).toBe(5.83)
    expect(report.avgFat).toBe(32)
    // 不得残留 15 位小数
    expect(String(report.avgProtein).match(/\d+\.\d{3,}/)).toBeNull()
  })

  it('日均热量仍取整（kcal 惯例，不加小数位）', () => {
    const report = computeReport([meal(23, 47, 26, 570.4)], [], PROFILE, 7)
    expect(Number.isInteger(report.avgKcal)).toBe(true)
    expect(report.avgKcal).toBe(570)
  })
})
