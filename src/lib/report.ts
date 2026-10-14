import { MEAL_LABELS, MEAL_ORDER } from '../types'
import type { MealEntry, MealType, Profile, WeightLog } from '../types'
import { round, shiftDate, targetFromProfile, todayKey } from './nutrition'

/**
 * 报告聚合：把区间内的饮食记录压成一份可直接展示、也可喂给模型的统计结果。
 * 所有计算都在前端完成，模型只负责解读，避免把原始记录整段发给模型。
 */

export interface DayStat {
  date: string
  kcal: number
  protein: number
  carb: number
  fat: number
  count: number
}

export interface ReportData {
  days: number
  rangeStart: string
  rangeEnd: string
  /** 有记录的天数 */
  loggedDays: number
  daily: DayStat[]
  avgKcal: number
  targetKcal: number
  /** 落在目标 ±10% 内的天数 */
  onTargetDays: number
  /** 超出目标 10% 以上的天数 */
  overDays: number
  avgProtein: number
  avgCarb: number
  avgFat: number
  proteinTarget: number
  /** 三大营养素供能比（百分数，合计约 100） */
  proteinRatio: number
  carbRatio: number
  fatRatio: number
  mealSplit: { name: string; kcal: number }[]
  topFoods: { name: string; count: number; kcal: number }[]
  /** 区间内体重变化（正数为增重），无记录返回 null */
  weightChange: number | null
  weightSeries: { date: string; weight: number }[]
}

/** 生成含今天的连续 N 天日期，升序 */
export function rangeDays(days: number): string[] {
  const end = todayKey()
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(shiftDate(end, -i))
  return out
}

export function computeReport(
  meals: MealEntry[],
  weights: WeightLog[],
  profile: Profile | null,
  days: number,
): ReportData {
  const target = targetFromProfile(profile)
  const dates = rangeDays(days)
  const start = dates[0]
  const end = dates[dates.length - 1]
  const inRange = new Set(dates)

  const byDate = new Map<string, DayStat>()
  for (const d of dates) byDate.set(d, { date: d, kcal: 0, protein: 0, carb: 0, fat: 0, count: 0 })

  const foodCount = new Map<string, { count: number; kcal: number }>()
  const mealKcal: Record<MealType, number> = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 }

  for (const m of meals) {
    if (!inRange.has(m.log_date)) continue
    const d = byDate.get(m.log_date)
    if (!d) continue
    const kcal = Number(m.calories) || 0
    d.kcal += kcal
    d.protein += Number(m.protein_g) || 0
    d.carb += Number(m.carb_g) || 0
    d.fat += Number(m.fat_g) || 0
    d.count += 1

    const key = m.meal_type in mealKcal ? (m.meal_type as MealType) : 'snack'
    mealKcal[key] += kcal

    // 只统计具体食物，跳过明显的合并项
    const name = (m.food_name || '').trim()
    if (name) {
      const prev = foodCount.get(name) ?? { count: 0, kcal: 0 }
      prev.count += 1
      prev.kcal += kcal
      foodCount.set(name, prev)
    }
  }

  const daily = dates.map((d) => byDate.get(d)!)
  const logged = daily.filter((d) => d.count > 0)
  const loggedDays = logged.length

  const sum = logged.reduce(
    (acc, d) => {
      acc.kcal += d.kcal
      acc.protein += d.protein
      acc.carb += d.carb
      acc.fat += d.fat
      return acc
    },
    { kcal: 0, protein: 0, carb: 0, fat: 0 },
  )

  // 日均按「有记录的天数」算，否则漏记的日子会把均值拉低，误导用户
  const base = Math.max(loggedDays, 1)
  const avgKcal = round(sum.kcal / base)
  const avgProtein = round(sum.protein / base)
  const avgCarb = round(sum.carb / base)
  const avgFat = round(sum.fat / base)

  const kcalEnergy = avgProtein * 4 + avgCarb * 4 + avgFat * 9
  const ratio = (v: number) => (kcalEnergy > 0 ? Math.round((v / kcalEnergy) * 100) : 0)

  const onTargetDays = logged.filter(
    (d) => d.kcal >= target.calories * 0.9 && d.kcal <= target.calories * 1.1,
  ).length
  const overDays = logged.filter((d) => d.kcal > target.calories * 1.1).length

  const topFoods = Array.from(foodCount.entries())
    .map(([name, v]) => ({ name, count: v.count, kcal: Math.round(v.kcal / Math.max(v.count, 1)) }))
    .sort((a, b) => b.count - a.count || b.kcal - a.kcal)
    .slice(0, 5)

  const weightSeries = weights
    .filter((w) => w.log_date >= start && w.log_date <= end)
    .map((w) => ({ date: w.log_date, weight: Number(w.weight_kg) }))
    .filter((w) => Number.isFinite(w.weight))
    .sort((a, b) => a.date.localeCompare(b.date))

  const weightChange =
    weightSeries.length >= 2
      ? round(weightSeries[weightSeries.length - 1].weight - weightSeries[0].weight, 1)
      : null

  return {
    days,
    rangeStart: start,
    rangeEnd: end,
    loggedDays,
    daily,
    avgKcal,
    targetKcal: target.calories,
    onTargetDays,
    overDays,
    avgProtein,
    avgCarb,
    avgFat,
    proteinTarget: target.protein_g,
    proteinRatio: ratio(avgProtein * 4),
    carbRatio: ratio(avgCarb * 4),
    fatRatio: ratio(avgFat * 9),
    mealSplit: MEAL_ORDER.map((m) => ({
      name: MEAL_LABELS[m],
      kcal: Math.round(mealKcal[m] / base),
    })),
    topFoods,
    weightChange,
    weightSeries,
  }
}

/** 体重变化的好坏取决于目标：减脂时下降是好事，增重时相反 */
export function weightTrendTone(change: number | null, goal: string): 'good' | 'warn' | 'flat' {
  if (change === null || Math.abs(change) < 0.1) return 'flat'
  if (goal === 'keep') return 'flat'
  const down = change < 0
  const wantDown = goal === 'lose'
  return down === wantDown ? 'good' : 'warn'
}

/* ── 目标达成预测（线性回归外推）── */

export interface Forecast {
  state: 'reached' | 'ok' | 'insufficient' | 'wrong_direction'
  /** 预计还需几周（向上取整） */
  weeks: number | null
  /** 预计达标日期 */
  date: string | null
  /** 每周体重变化（负为下降） */
  slopePerWeek: number | null
}

/**
 * 用区间内体重记录做最小二乘拟合，外推到达目标体重的日期。
 * 结论一定是「基于现有记录的推算」，展示时要带上这个语境。
 */
export function forecastGoal(
  series: { date: string; weight: number }[],
  goal: 'lose' | 'keep' | 'gain',
  targetWeightKg: number | null,
): Forecast {
  if (goal === 'keep' || targetWeightKg == null) return { state: 'insufficient', weeks: null, date: null, slopePerWeek: null }
  if (series.length < 3) return { state: 'insufficient', weeks: null, date: null, slopePerWeek: null }

  const t0 = new Date(series[0].date.replace(/-/g, '/')).getTime()
  const spanDays = (new Date(series[series.length - 1].date.replace(/-/g, '/')).getTime() - t0) / 86400000
  if (spanDays < 4) return { state: 'insufficient', weeks: null, date: null, slopePerWeek: null }

  const xs = series.map((w) => (new Date(w.date.replace(/-/g, '/')).getTime() - t0) / 86400000)
  const ys = series.map((w) => w.weight)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  if (den <= 0) return { state: 'insufficient', weeks: null, date: null, slopePerWeek: null }

  const slopePerDay = num / den
  const slopePerWeek = round(slopePerDay * 7, 2)
  const remaining = targetWeightKg - ys[n - 1]
  if (Math.abs(remaining) < 0.1) return { state: 'reached', weeks: 0, date: series[n - 1].date, slopePerWeek }

  // 方向校验：要降但趋势在涨（或反之），且趋势明显（|slope| >= 0.05kg/周）
  const goingRight = goal === 'lose' ? slopePerDay < 0 : slopePerDay > 0
  const remainingRight = goal === 'lose' ? remaining < 0 : remaining > 0
  if (!remainingRight) return { state: 'reached', weeks: 0, date: null, slopePerWeek }
  if (!goingRight && Math.abs(slopePerWeek) >= 0.05) {
    return { state: 'wrong_direction', weeks: null, date: null, slopePerWeek }
  }
  if (Math.abs(slopePerDay) < 1e-4) return { state: 'insufficient', weeks: null, date: null, slopePerWeek }

  const daysNeeded = Math.round(remaining / slopePerDay)
  if (daysNeeded <= 0 || daysNeeded > 3 * 365) {
    return { state: 'insufficient', weeks: null, date: null, slopePerWeek }
  }
  const lastDate = series[n - 1].date
  return { state: 'ok', weeks: Math.ceil(daysNeeded / 7), date: shiftDate(lastDate, daysNeeded), slopePerWeek }
}

/* ── 周月对比 ── */

export interface MonthCompare {
  thisMonthAvg: number | null
  lastMonthAvg: number | null
  /** 变化百分数（正为本月吃得更多） */
  deltaPct: number | null
}

/** 本自然月（截至今天）与上个自然月的日均摄入对比 */
export function monthCompareFromMeals(meals: MealEntry[], today: string): MonthCompare {
  const [y, m] = today.split('-').map(Number)
  const monthKey = (date: string) => date.slice(0, 7)
  const thisKey = `${y}-${String(m).padStart(2, '0')}`
  const prev = new Date(y, m - 2, 1)
  const lastKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`

  const sum = new Map<string, { kcal: number; days: Set<string> }>()
  for (const key of [thisKey, lastKey]) sum.set(key, { kcal: 0, days: new Set() })
  for (const meal of meals) {
    const bucket = sum.get(monthKey(meal.log_date))
    if (!bucket) continue
    bucket.kcal += Number(meal.calories) || 0
    bucket.days.add(meal.log_date)
  }

  const avg = (key: string) => {
    const b = sum.get(key)!
    return b.days.size > 0 ? round(b.kcal / b.days.size) : null
  }

  const thisMonthAvg = avg(thisKey)
  const lastMonthAvg = avg(lastKey)
  const deltaPct =
    thisMonthAvg != null && lastMonthAvg != null && lastMonthAvg > 0
      ? Math.round(((thisMonthAvg - lastMonthAvg) / lastMonthAvg) * 100)
      : null

  return { thisMonthAvg, lastMonthAvg, deltaPct }
}

/* ── 日历热力 ── */

export type DayTone = 'empty' | 'under' | 'on' | 'over'

/** 当天摄入相对预算的着色：达标 ±10%、超出 >110%、记录了但偏少 <90% */
export function dayTone(kcal: number, logged: boolean, target: number): DayTone {
  if (!logged || target <= 0) return 'empty'
  if (kcal > target * 1.1) return 'over'
  if (kcal >= target * 0.9) return 'on'
  return 'under'
}

/** 汇总区间内每天的总摄入（供日历使用） */
export function kcalByDate(meals: MealEntry[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const m of meals) {
    map.set(m.log_date, (map.get(m.log_date) ?? 0) + (Number(m.calories) || 0))
  }
  return map
}
