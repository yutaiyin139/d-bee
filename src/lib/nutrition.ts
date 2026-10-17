import type { Profile } from '../types'

/** 活动系数（Mifflin-St Jeor 法） */
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

/** 1 kg 脂肪 ≈ 7700 kcal */
const KCAL_PER_KG = 7700

export function calcBmr(gender: 'male' | 'female', age: number, heightCm: number, weightKg: number) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return gender === 'male' ? base + 5 : base - 161
}

export function calcTdee(gender: 'male' | 'female', age: number, heightCm: number, weightKg: number, activity: keyof typeof ACTIVITY_FACTORS) {
  return calcBmr(gender, age, heightCm, weightKg) * ACTIVITY_FACTORS[activity]
}

export interface TargetInput {
  gender: 'male' | 'female'
  age: number
  heightCm: number
  weightKg: number
  activity: keyof typeof ACTIVITY_FACTORS
  goal: 'lose' | 'keep' | 'gain'
  weeklyRateKg: number
}

export interface NutritionTarget {
  calories: number
  protein_g: number
  carb_g: number
  fat_g: number
  tdee: number
}

/**
 * 由身体数据 + 目标推导每日热量与三大营养素目标。
 * 热量下限做保护：男性不低于 1500，女性不低于 1200，避免极端节食。
 */
export function calcTarget(input: TargetInput): NutritionTarget {
  const { gender, age, heightCm, weightKg, activity, goal, weeklyRateKg } = input
  const tdee = calcTdee(gender, age, heightCm, weightKg, activity)

  let delta = 0
  if (goal === 'lose') delta = -(weeklyRateKg * KCAL_PER_KG) / 7
  if (goal === 'gain') delta = (weeklyRateKg * KCAL_PER_KG) / 7

  const floor = gender === 'male' ? 1500 : 1200
  const calories = Math.round(Math.max(tdee + delta, floor))

  // 蛋白质：减脂期提高至 1.8g/kg，其余 1.5g/kg；不超过总热量 40%
  const proteinPerKg = goal === 'lose' ? 1.8 : 1.5
  let protein = Math.round(weightKg * proteinPerKg)
  const proteinCeil = Math.round((calories * 0.4) / 4)
  protein = Math.min(protein, proteinCeil)

  // 脂肪：占总热量 25%
  const fat = Math.round((calories * 0.25) / 9)

  // 碳水：剩余热量
  const carb = Math.max(Math.round((calories - protein * 4 - fat * 9) / 4), 0)

  return { calories, protein_g: protein, carb_g: carb, fat_g: fat, tdee: Math.round(tdee) }
}

export function emptyTarget(): NutritionTarget {
  return { calories: 1800, protein_g: 90, carb_g: 220, fat_g: 50, tdee: 1800 }
}

export function targetFromProfile(p: Profile | null): NutritionTarget {
  if (!p || !p.daily_calorie_target) return emptyTarget()
  return {
    calories: p.daily_calorie_target,
    protein_g: p.protein_target_g ?? 0,
    carb_g: p.carb_target_g ?? 0,
    fat_g: p.fat_target_g ?? 0,
    tdee: p.daily_calorie_target,
  }
}

/** 按本地时区取 YYYY-MM-DD，避免 toISOString 的时区偏移 */
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

/** 短日期：10月13日（用于顶部日期导航） */
export function formatDateShort(key: string) {
  const [, m, d] = key.split('-').map(Number)
  return `${m}月${d}日`
}

/** 某日期所在周（周日开头）的 7 个日期 key，用于首页周历 */
export function weekOf(key: string): string[] {
  const [y, m, d] = key.split('-').map(Number)
  const base = new Date(y, m - 1, d)
  const start = new Date(y, m - 1, d - base.getDay())
  return Array.from({ length: 7 }, (_, i) =>
    todayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
  )
}

/** 根据当前时间推测用户正在吃哪一餐 */
export function guessMealType(d: Date = new Date()): 'breakfast' | 'lunch' | 'dinner' | 'snack' {
  const h = d.getHours()
  if (h < 10) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

export function round(n: number, digits = 0) {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/* ── 饮水 ── */

/** 每日饮水目标：约 32ml/kg，收敛到 1500–3500ml 并取 50 的整数倍 */
export function waterTargetMl(weightKg: number | null | undefined): number {
  if (!weightKg || weightKg <= 0) return 1800
  return Math.max(1500, Math.min(3500, Math.round((weightKg * 32) / 50) * 50))
}

/* ── 运动消耗（MET 估算法）── */

/** 常见运动的 MET 强度，用于估算消耗：kcal = MET × 3.5 × 体重kg ÷ 200 × 分钟 */
/** steps=true 表示「步数型」运动（走路/跑步等），Apple 健康的活动能量已含，iOS 已连接时手动记录需去重 */
export const EXERCISES: { name: string; met: number; steps?: boolean }[] = [
  { name: '散步', met: 3.5, steps: true },
  { name: '快走', met: 4.3, steps: true },
  { name: '慢跑', met: 8.0, steps: true },
  { name: '骑行', met: 6.8, steps: true },
  { name: '游泳', met: 8.0 },
  { name: '跳绳', met: 11.0 },
  { name: '瑜伽', met: 3.0 },
  { name: '力量训练', met: 5.0 },
  { name: 'HIIT', met: 10.0 },
  { name: '羽毛球', met: 5.5 },
  { name: '篮球', met: 8.0 },
  { name: '爬山', met: 7.0, steps: true },
]

export const DEFAULT_WEIGHT = 60

export function exerciseKcal(name: string, minutes: number, weightKg: number | null | undefined): number {
  const met = EXERCISES.find((e) => e.name === name)?.met ?? 4.5
  const w = weightKg && weightKg > 0 ? weightKg : DEFAULT_WEIGHT
  return Math.round(((met * 3.5 * w) / 200) * minutes)
}

/** 某运动是否「步数型」（走路/跑步等，Apple 健康活动能量已含） */
export function isStepExercise(name: string): boolean {
  return EXERCISES.find((e) => e.name === name)?.steps === true
}

/** 月历：把某月补齐成「周一开头」的 6×7 网格（含前后月补位，值为 null） */
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
