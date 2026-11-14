/**
 * 健康管理方案 · 四端共享文案真源与展示层纯函数（2026-11-14）。
 *
 * 设计约束（见 docs/健康管理方案-单态渲染与目标变更自动重算-修订-2026-11-14.md）：
 *  - 只放无环境依赖的纯逻辑：常量、文案、纯函数、纯类型，禁止 import React / DOM / wx。
 *  - 禁止调 calcTarget / calcBmr / calcTdee：方案页只读【已落库】的派生字段，
 *    否则与首页「还可吃」浮点漂移（1650 vs 1648）。
 *  - 禁止读取 plan_summary：AI 首次建议在改目标后不会重生成，会出现
 *    「增重增肌 + 减脂建议」自相矛盾。
 *  - 数值口径只走 roundTo，且只在展示层插值那一刻舍入。
 *  - 单态：goalLabel 由各端从自己的 GOAL_LABELS 真源注入，shared 不持有第三份标签副本。
 *
 * Web / iOS / Android 共用主端组件，mini 为独立 Taro 组件；两端组件都只消费本文件的
 * 常量与 buildHealthPlanViewCore()，因此文案、数值、口径、说明条目四端逐字一致。
 */
import type { TransparencyNote } from './content/transparency'
import { roundTo } from './numfmt'

// ── 标题与命名 ────────────────────────────────────────────
export const HEALTH_PLAN_TITLE = '健康管理方案'
export const HEALTH_PLAN_INTRO_TITLE = '你的健康管理方案'

// ── 改目标确认层 ──────────────────────────────────────────
export const HEALTH_PLAN_CHANGE_WILL = '每日热量 · 三大营养素 · 每周节奏 · 目标体重 · 达成日'
export const HEALTH_PLAN_CHANGE_WONT = '历史记录 · 已出报告 · 打卡与徽章'
export const HEALTH_PLAN_EDIT_CURRENT_PREFIX = '当前方案：'
export const HEALTH_PLAN_EDIT_CONFIRM_TAIL = ' · 确认后健康管理方案会自动更新。'
export const HEALTH_PLAN_EDIT_WILL_PREFIX = '会改变：'
export const HEALTH_PLAN_EDIT_WONT_PREFIX = '不会改变：'
export const HEALTH_PLAN_UPDATED_PREFIX = '方案已更新为'

// ── 方案 Sheet 内全部可见文案 ──────────────────────────────
export const HEALTH_PLAN_INTRO_HINT = '按你的身高体重与活动量计算，可在「我的 › 健康管理方案」随时调整。'
export const HEALTH_PLAN_NOTES_TITLE = '这些数字怎么来的'
export const HEALTH_PLAN_NOT_READY = '先完善身体数据，才能生成健康管理方案。'
export const HEALTH_PLAN_GO_FILL = '去完善身体数据'
export const HEALTH_PLAN_LABEL_DAILY = '每日建议摄入'
export const HEALTH_PLAN_UNIT_KCAL = 'kcal'
export const HEALTH_PLAN_LABEL_PROTEIN = '蛋白质'
export const HEALTH_PLAN_LABEL_CARB = '碳水'
export const HEALTH_PLAN_LABEL_FAT = '脂肪'
export const HEALTH_PLAN_LABEL_WEEKLY = '每周节奏'
export const HEALTH_PLAN_LABEL_START = '开始记录'
export const HEALTH_PLAN_LABEL_CHANGE = '更改目标'
export const HEALTH_PLAN_WEEKLY_KEEP = '维持当前体重'
export const HEALTH_PLAN_BAND_HINT = '近 7 天以 ±1.0 kg 为参考波动带'

// ── 透明化说明（四端共用，组件不得另写副本）──────────────────
export const HEALTH_PLAN_NOTES: TransparencyNote[] = [
  {
    label: '每日热量怎么来的',
    text: '按你填写的性别、年龄、身高、体重与活动水平估算每日消耗，再按目标方向留出缺口或盈余；减脂另有安全下限。',
  },
  {
    label: '三大营养素怎么来的',
    text: '蛋白质按体重与目标方向估算，脂肪按热量占比分配，碳水取剩余热量。',
  },
  {
    label: '改目标后会怎样',
    text: `确认后会重新计算并自动更新方案。${HEALTH_PLAN_CHANGE_WILL} 会改变；${HEALTH_PLAN_CHANGE_WONT} 不会改变。`,
  },
  {
    label: '这不是医疗建议',
    text: '以上为自我记录用的估算值，不构成医疗诊断或治疗建议；身体不适请咨询专业人士。',
  },
]

// ── 类型 ──────────────────────────────────────────────────
export type HealthPlanGoalKey = 'lose' | 'keep' | 'gain'

/** 方案页只需要这些字段；各端把自己的 Profile 映射成这个结构。 */
export interface HealthPlanInput {
  goal: HealthPlanGoalKey
  /** 由各端 GOAL_LABELS[goal] 注入，避免 shared 再存一份标签副本 */
  goalLabel: string
  dailyCalorieTarget: number | null
  proteinTargetG: number | null
  carbTargetG: number | null
  fatTargetG: number | null
  weeklyRateKg: number | null
  startWeightKg: number | null
  currentWeightKg: number | null
  targetWeightKg: number | null
}

export interface HealthPlanView {
  ready: boolean
  goal: HealthPlanGoalKey
  goalLabel: string
  calories: number
  protein: number
  carb: number
  fat: number
  weeklyLabel: string
  hasProgress: boolean
  progressText: string
  progressPct: number
  targetWeight: number | null
  notes: TransparencyNote[]
}

/** 空档案兜底：emptyTarget() 的 1800 kcal 不得被当成真实方案展示。 */
export function isHealthPlanReadyCore(
  input: Pick<HealthPlanInput, 'dailyCalorieTarget'>,
): boolean {
  return input.dailyCalorieTarget != null && input.dailyCalorieTarget > 0
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

/**
 * 按 goal 产出【唯一一态】的展示模型。
 * 组件不得持有本地目标态，改目标写库后由父级 profile 变化触发重渲染即自动切换。
 */
export function buildHealthPlanViewCore(input: HealthPlanInput): HealthPlanView {
  const { goal, goalLabel } = input
  const rate = input.weeklyRateKg ?? 0
  const weeklyLabel = goal === 'keep'
    ? HEALTH_PLAN_WEEKLY_KEEP
    : `${goal === 'lose' ? '−' : '+'}${roundTo(rate, 1)} kg / 周`

  const start = input.startWeightKg
  const current = input.currentWeightKg
  // 保持体重不设目标体重 / 进度 / 达成日，改用参考波动带
  const targetWeight = goal !== 'keep' ? input.targetWeightKg : null
  const hasProgress = targetWeight != null && current != null
  let progressText = HEALTH_PLAN_BAND_HINT
  let progressPct = 0
  if (hasProgress && targetWeight != null && current != null) {
    const diff = roundTo(Math.abs(targetWeight - current), 1)
    progressText = `当前 ${roundTo(current, 1)} kg · 目标 ${roundTo(targetWeight, 1)} kg · 还差 ${diff} kg`
    if (start != null && targetWeight !== start) {
      // 口径：从起始体重走向目标体重的完成度，不用无口径的「状态分」
      progressPct = clampPct(roundTo(((start - current) / (start - targetWeight)) * 100, 0))
    }
  }

  return {
    ready: isHealthPlanReadyCore(input),
    goal,
    goalLabel,
    calories: input.dailyCalorieTarget ?? 0,
    protein: input.proteinTargetG ?? 0,
    carb: input.carbTargetG ?? 0,
    fat: input.fatTargetG ?? 0,
    weeklyLabel,
    hasProgress,
    progressText,
    progressPct,
    targetWeight,
    notes: HEALTH_PLAN_NOTES,
  }
}
