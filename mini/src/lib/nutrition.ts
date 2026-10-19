/**
 * 小程序端营养/日期/运动/饮水纯函数（对齐主工程 src/lib/nutrition.ts）。
 * 仅移植 Dashboard 所需部分，calcBmr/calcTarget 由后端/引导页处理，此处不重复。
 */

/** 本地日期 YYYY-MM-DD（避免 toISOString 时区偏移） */
export function todayKey(d: Date = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function shiftDate(key: string, days: number) {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return todayKey(dt)
}

export function formatDateShort(key: string) {
  const [, m, d] = key.split('-').map(Number)
  return `${m}月${d}日`
}

/** 某日期所在周（周日开头）的 7 个日期 key */
export function weekOf(key: string): string[] {
  const [y, m, d] = key.split('-').map(Number)
  const base = new Date(y, m - 1, d)
  const start = new Date(y, m - 1, d - base.getDay())
  return Array.from({ length: 7 }, (_, i) =>
    todayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
  )
}

/** 某月（month0 从 0 计）的日历网格，周一开头，空位为 null */
export function monthGrid(year: number, month0: number): (string | null)[] {
  const first = new Date(year, month0, 1)
  const daysInMonth = new Date(year, month0 + 1, 0).getDate()
  const lead = (first.getDay() + 6) % 7 // 周一=0
  const cells: (string | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function guessMealType(d: Date = new Date()): 'breakfast' | 'lunch' | 'dinner' | 'snack' {
  const h = d.getHours()
  if (h < 10) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

/** 每日饮水目标：约 32ml/kg，收敛 1500–3500ml 取 50 整数倍 */
export function waterTargetMl(weightKg: number | null | undefined): number {
  if (!weightKg || weightKg <= 0) return 1800
  return Math.max(1500, Math.min(3500, Math.round((weightKg * 32) / 50) * 50))
}

/** 常见运动 MET 强度 */
export const EXERCISES: { name: string; met: number }[] = [
  { name: '散步', met: 3.5 },
  { name: '快走', met: 4.3 },
  { name: '慢跑', met: 8.0 },
  { name: '骑行', met: 6.8 },
  { name: '游泳', met: 8.0 },
  { name: '跳绳', met: 11.0 },
  { name: '瑜伽', met: 3.0 },
  { name: '力量训练', met: 5.0 },
  { name: 'HIIT', met: 10.0 },
  { name: '羽毛球', met: 5.5 },
  { name: '篮球', met: 8.0 },
  { name: '爬山', met: 7.0 },
]

export const DEFAULT_WEIGHT = 60

export function exerciseKcal(name: string, minutes: number, weightKg: number | null | undefined): number {
  const met = EXERCISES.find((e) => e.name === name)?.met ?? 4.5
  const w = weightKg && weightKg > 0 ? weightKg : DEFAULT_WEIGHT
  return Math.round(((met * 3.5 * w) / 200) * minutes)
}

/* ── 目标推导（对齐主工程 calcTarget，Mifflin-St Jeor 法）── */

export const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
} as const

export const ACTIVITY_LABELS: Record<keyof typeof ACTIVITY_FACTORS, string> = {
  sedentary: '久坐，几乎不运动',
  light: '轻度活动，每周 1–3 次',
  moderate: '中度活动，每周 3–5 次',
  active: '高强度，每周 6–7 次',
  very_active: '运动员级，每天高强度',
}

export const GOAL_LABELS = {
  lose: '减脂',
  keep: '保持体重',
  gain: '增重增肌',
} as const

const KCAL_PER_KG = 7700

export function calcBmr(gender: 'male' | 'female', age: number, heightCm: number, weightKg: number) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return gender === 'male' ? base + 5 : base - 161
}

export function calcTdee(gender: 'male' | 'female', age: number, heightCm: number, weightKg: number, activity: keyof typeof ACTIVITY_FACTORS) {
  return calcBmr(gender, age, heightCm, weightKg) * ACTIVITY_FACTORS[activity]
}

export interface NutritionTarget {
  calories: number
  protein_g: number
  carb_g: number
  fat_g: number
  tdee: number
}

export function emptyTarget(): NutritionTarget {
  return { calories: 1800, protein_g: 90, carb_g: 220, fat_g: 50, tdee: 1800 }
}

/** 由档案推导每日营养目标（对齐主工程 targetFromProfile） */
export function targetFromProfile(p: { daily_calorie_target: number | null; protein_target_g: number | null; carb_target_g: number | null; fat_target_g: number | null } | null): NutritionTarget {
  if (!p || !p.daily_calorie_target) return emptyTarget()
  return {
    calories: p.daily_calorie_target,
    protein_g: p.protein_target_g ?? 0,
    carb_g: p.carb_target_g ?? 0,
    fat_g: p.fat_target_g ?? 0,
    tdee: p.daily_calorie_target,
  }
}

export function round(n: number, digits = 0): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function calcTarget(input: {
  gender: 'male' | 'female'
  age: number
  heightCm: number
  weightKg: number
  activity: keyof typeof ACTIVITY_FACTORS
  goal: 'lose' | 'keep' | 'gain'
  weeklyRateKg: number
}): NutritionTarget {
  const { gender, age, heightCm, weightKg, activity, goal, weeklyRateKg } = input
  const tdee = calcTdee(gender, age, heightCm, weightKg, activity)

  let delta = 0
  if (goal === 'lose') delta = -(weeklyRateKg * KCAL_PER_KG) / 7
  if (goal === 'gain') delta = (weeklyRateKg * KCAL_PER_KG) / 7

  const floor = gender === 'male' ? 1500 : 1200
  const calories = Math.round(Math.max(tdee + delta, floor))

  const proteinPerKg = goal === 'lose' ? 1.8 : 1.5
  let protein = Math.round(weightKg * proteinPerKg)
  const proteinCeil = Math.round((calories * 0.4) / 4)
  protein = Math.min(protein, proteinCeil)

  const fat = Math.round((calories * 0.25) / 9)
  const carb = Math.max(Math.round((calories - protein * 4 - fat * 9) / 4), 0)

  return { calories, protein_g: protein, carb_g: carb, fat_g: fat, tdee: Math.round(tdee) }
}
