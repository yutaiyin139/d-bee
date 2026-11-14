/**
 * 健康档案 · 四端共享文案与纯展示模型（2026-11-14）。
 *
 * 口径红线（对齐拍板）：
 *  - 只复用已有 6 张表的数据，零新增字段 / 零编造 / 零空值占位卡；
 *  - 不出现体脂率、腰臀比、血糖、用药、疾病史等库里不存在的字段；
 *  - 不出现医学结论与「正常」标签，BMI 档位与免责说明复用 healthPlan.ts 真源；
 *  - 四段锚点固定：核心指标 · 健康数据 · 饮食管理 · 运动记录。
 */
import { roundTo } from './numfmt'
import { HEALTH_PLAN_BMI_DISCLAIMER } from './healthPlan'

export const HEALTH_RECORD_TITLE = '健康档案'
export const HEALTH_RECORD_ANCHORS = ['核心指标', '健康数据', '饮食管理', '运动记录'] as const
export type HealthRecordAnchor = (typeof HEALTH_RECORD_ANCHORS)[number]
export const HEALTH_RECORD_ANCHOR_ARIA = '跳转到'

/* ── 资料填写完整度（8 项，非健康评估） ─────────────────────────── */

export const HEALTH_RECORD_COMPLETION = '资料填写完整度'
export const HEALTH_RECORD_COMPLETION_NOTE = '按已填写项计算，不代表健康评估'
export const HEALTH_RECORD_COMPLETION_FIELDS = [
  '昵称', '性别', '年龄', '身高', '当前体重', '目标体重', '活动水平', '目标方向',
] as const
export interface CompletionInput {
  nickname?: string | null
  gender?: string | null
  age?: number | null
  heightCm?: number | null
  currentWeightKg?: number | null
  targetWeightKg?: number | null
  activityLevel?: string | null
  goal?: string | null
}
export interface CompletionView { filled: number; total: number; percent: number; note: string }

function filled(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'string') return v.trim().length > 0 ? 1 : 0
  return Number.isFinite(v) ? 1 : 0
}

export function buildCompletionCore(p: CompletionInput): CompletionView {
  const values: unknown[] = [p.nickname, p.gender, p.age, p.heightCm, p.currentWeightKg, p.targetWeightKg, p.activityLevel, p.goal]
  const count = values.reduce<number>((s, v) => s + filled(v), 0)
  const total = HEALTH_RECORD_COMPLETION_FIELDS.length
  return {
    filled: count,
    total,
    percent: roundTo((count / total) * 100, 0),
    note: HEALTH_RECORD_COMPLETION_NOTE,
  }
}

/* ── 四段标签与单位 ───────────────────────────────────────────── */

export const HEALTH_RECORD_LABELS = {
  height: '身高',
  weight: '体重',
  bmi: '当前 BMI',
  bmr: '基础代谢',
  targetWeight: '目标体重',
  weightTrend: '体重趋势',
  healthStatus: '连接状态',
  steps: '今日步数',
  stepGoal: '步数目标',
  activityKcal: '活动消耗',
  todayKcal: '今日热量',
  mealSplit: '各餐热量',
  macroRatio: '营养素供能比',
  water: '今日饮水',
  weekCount: '本周次数',
  weekMinutes: '累计时长',
  weekKcal: '消耗估算',
} as const
export const HEALTH_RECORD_UNITS = {
  cm: 'cm', kg: 'kg', kcal: 'kcal', g: 'g', ml: 'ml',
  step: '步', min: '分钟', times: '次', glass: '杯',
} as const
export const HEALTH_RECORD_MEAL_LABELS = ['早餐', '午餐', '晚餐', '加餐'] as const
export const HEALTH_RECORD_MACRO_LABELS = ['蛋白质', '碳水', '脂肪'] as const
export const HEALTH_RECORD_MACRO_COLORS = ['#79B98A', '#E8B95C', '#D98174'] as const

/* ── 空态与合规文案（不摆 - 单位 占位） ────────────────────────── */

export const HEALTH_RECORD_DISCLAIMER = HEALTH_PLAN_BMI_DISCLAIMER
export const HEALTH_RECORD_NO_MEDICAL = '仅展示已记录数据，不构成健康评估或医疗建议'
export const HEALTH_RECORD_EMPTY_MEAL = '今天还没有记录饮食'
export const HEALTH_RECORD_EMPTY_WEIGHT = '还没有体重记录'
export const HEALTH_RECORD_EMPTY_EXERCISE = '本周还没有运动记录'
export const HEALTH_RECORD_NOT_CONNECTED = '在 App 中连接健康应用后显示步数与活动消耗'
export const HEALTH_RECORD_LOADING = '正在读取记录…'
export const HEALTH_RECORD_LOAD_ERROR = '暂时读不到记录，请稍后再试'

/* ── 纯聚合（计算层全精度，展示层插值前舍入） ─────────────────── */

export interface MealSplitView { label: string; kcal: number }

export function buildMealSplitCore(meals: { meal_type: string; calories: number }[]): MealSplitView[] {
  const order = ['breakfast', 'lunch', 'dinner', 'snack']
  return HEALTH_RECORD_MEAL_LABELS.map((label, i) => ({
    label,
    kcal: roundTo(
      meals.reduce((s, m) => s + (m.meal_type === order[i] && Number.isFinite(m.calories) ? m.calories : 0), 0),
      0,
    ),
  }))
}

export function buildExerciseWeekCore(
  logs: { minutes: number; calories: number }[],
): { count: number; minutes: number; kcal: number } {
  return {
    count: logs.length,
    minutes: roundTo(logs.reduce((s, x) => s + (Number.isFinite(x.minutes) ? x.minutes : 0), 0), 0),
    kcal: roundTo(logs.reduce((s, x) => s + (Number.isFinite(x.calories) ? x.calories : 0), 0), 0),
  }
}

export function buildWaterCore(logs: { amount_ml: number }[]): number {
  return roundTo(logs.reduce((s, x) => s + (Number.isFinite(x.amount_ml) ? x.amount_ml : 0), 0), 0)
}

export function buildTodayKcalCore(meals: { calories: number }[]): number {
  return roundTo(meals.reduce((s, m) => s + (Number.isFinite(m.calories) ? m.calories : 0), 0), 0)
}

export function buildMacroRatioCore(meals: { protein_g: number; carb_g: number; fat_g: number }[]): number[] {
  const p = meals.reduce((s, m) => s + (Number.isFinite(m.protein_g) ? m.protein_g : 0), 0)
  const c = meals.reduce((s, m) => s + (Number.isFinite(m.carb_g) ? m.carb_g : 0), 0)
  const f = meals.reduce((s, m) => s + (Number.isFinite(m.fat_g) ? m.fat_g : 0), 0)
  const kcals = [p * 4, c * 4, f * 9]
  const total = kcals.reduce((s, x) => s + x, 0)
  if (total <= 0) return [0, 0, 0]
  return kcals.map((x) => roundTo((x / total) * 100, 0))
}
