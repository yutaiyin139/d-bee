/**
 * 体重管理方案 · 四端共享文案真源与展示层纯函数（2026-11-14 16:30 拍板版）。
 *
 * 设计约束（见 docs/体重管理方案-拍板版详细设计规划-2026-11-14.md）：
 *  - 只放无环境依赖的纯逻辑：常量、文案、纯函数、纯类型，禁止 import React / DOM / wx。
 *  - 禁止调 calcTarget / calcTdee：方案页只读【已落库】的派生字段，
 *    否则与首页「还可吃」浮点漂移（1650 vs 1648）。
 *  - 禁止引用 forecastGoal：那是报告页基于体重记录的趋势拟合，方案页拿不到
 *    weightSeries；两处都用会出现两个达成日。本页达成日按落库周节奏理论推算。
 *  - 禁止读取 plan_summary：AI 首次建议在改目标后不会重生成，会出现
 *    「增重增肌 + 减脂建议」自相矛盾。
 *  - 数值口径只走 numfmt.roundTo，日期只走 datefmt 的日期键函数。
 *  - 单态：goalLabel 由各端从自己的 GOAL_LABELS 真源注入，shared 不持有第三份标签副本。
 *
 * 🔴 命名纪律（用户拍板 ⑤）：用户可见文案已改为「体重管理方案」，
 *    但 HEALTH_PLAN_* 常量名、本文件名、组件名、路由一律保持不变，把重构面压到最小。
 *
 * Web / iOS / Android 共用主端组件，mini 为独立 Taro 组件；两端组件都只消费本文件的
 * 常量与 buildHealthPlanViewCore()，因此文案、数值、口径、说明条目四端逐字一致。
 */
import type { TransparencyNote } from './content/transparency'
import { roundTo } from './numfmt'
import { dateKeyFromIso, diffDateKeys, shiftDateKey } from './datefmt'

// ── 标题与命名 ────────────────────────────────────────────
export const HEALTH_PLAN_TITLE = '体重管理方案'
export const HEALTH_PLAN_INTRO_TITLE = '你的体重管理方案'

// ── 改目标确认层 ──────────────────────────────────────────
export const HEALTH_PLAN_CHANGE_WILL = '每日热量 · 三大营养素 · 每周节奏 · 目标体重 · 达成日'
export const HEALTH_PLAN_CHANGE_WONT = '历史记录 · 已出报告 · 打卡与徽章'
export const HEALTH_PLAN_EDIT_CURRENT_PREFIX = '当前方案：'
export const HEALTH_PLAN_EDIT_CONFIRM_TAIL = ' · 确认后体重管理方案会自动更新。'
export const HEALTH_PLAN_EDIT_WILL_PREFIX = '会改变：'
export const HEALTH_PLAN_EDIT_WONT_PREFIX = '不会改变：'
export const HEALTH_PLAN_UPDATED_PREFIX = '方案已更新为'

// ── 三段卡片标题 ──────────────────────────────────────────
export const HEALTH_PLAN_SECTION_BASIC = '基本信息'
export const HEALTH_PLAN_SECTION_GOAL = '体重目标'
export const HEALTH_PLAN_SECTION_DAILY = '每日方案'

// ── 卡片 1 · 基本信息 ─────────────────────────────────────
export const HEALTH_PLAN_LABEL_HEIGHT = '身高'
export const HEALTH_PLAN_LABEL_WEIGHT = '体重'
export const HEALTH_PLAN_LABEL_BMR = '基础代谢'
export const HEALTH_PLAN_LABEL_BMI = '当前 BMI'
export const HEALTH_PLAN_UNIT_CM = 'cm'
export const HEALTH_PLAN_UNIT_KG = 'kg'
export const HEALTH_PLAN_UNIT_G = 'g'
export const HEALTH_PLAN_BMI_PREFIX = '当前 BMI '
export const HEALTH_PLAN_BMI_DISCLAIMER = '通用 BMI 参考区间，仅用于理解数值，不构成健康评估或医疗建议'
export const HEALTH_PLAN_BMI_ARIA_PREFIX = '当前 BMI '
export const HEALTH_PLAN_BMI_ARIA_TAIL = '，位于通用参考区间'

/** 四段低饱和色阶：与 --bg #fbf8f1 同色温，避免高饱和营销感。 */
export interface BmiBand {
  key: 'thin' | 'standard' | 'heavy' | 'obese'
  label: string
  color: string
}
export const HEALTH_PLAN_BMI_BANDS: BmiBand[] = [
  { key: 'thin', label: '偏瘦', color: '#8FB8D9' },
  { key: 'standard', label: '标准', color: '#79B98A' },
  { key: 'heavy', label: '偏重', color: '#E8B95C' },
  { key: 'obese', label: '超重', color: '#D98174' },
]

// ── 卡片 2 · 体重目标 ─────────────────────────────────────
export const HEALTH_PLAN_LABEL_PROGRESS = '目标进度'
export const HEALTH_PLAN_LABEL_START_W = '起始'
export const HEALTH_PLAN_LABEL_TARGET_W = '目标'
export const HEALTH_PLAN_LABEL_EXPECT_LOSE = '期望减重'
export const HEALTH_PLAN_LABEL_EXPECT_GAIN = '期望增重'
export const HEALTH_PLAN_LABEL_EXPECT_KEEP = '本周体重'
export const HEALTH_PLAN_LABEL_REMAIN_LOSE = '还需减重'
export const HEALTH_PLAN_LABEL_REMAIN_GAIN = '还需增重'
export const HEALTH_PLAN_LABEL_REMAIN_KEEP = '参考波动带'
export const HEALTH_PLAN_KEEP_BAND_VALUE = '±1.0 kg'
export const HEALTH_PLAN_LABEL_GOAL_DATE = '预计'
export const HEALTH_PLAN_TIMELINE_ARROW = ' → '
export const HEALTH_PLAN_TIMELINE_NOTE = '按当前每周节奏推算 · 实际进度会随记录变化'
export const HEALTH_PLAN_TIMELINE_NOTE_KEEP = '保持体重不设目标值与达成日，以波动带观察稳定性'
export const HEALTH_PLAN_TIMELINE_NO_START = '补充起始信息后显示进度'
export const HEALTH_PLAN_TIMELINE_NO_RATE = '按当前节奏暂无法推算'
export const HEALTH_PLAN_TIMELINE_REACHED = '已达成目标体重'
export const HEALTH_PLAN_TIMELINE_TOO_FAR = '按当前节奏推算时间过长'
export const HEALTH_PLAN_TIMELINE_KEEP = '维持当前体重，不设达成日'

// ── 卡片 3 · 每日方案 ─────────────────────────────────────
export const HEALTH_PLAN_INTRO_HINT = '按你的身高体重与活动量计算，可在「我的 › 体重管理方案」随时调整。'
export const HEALTH_PLAN_NOTES_TITLE = '这些数字怎么来的'
export const HEALTH_PLAN_NOT_READY = '先完善身体数据，才能生成体重管理方案。'
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
    label: 'BMI 参考带怎么来的',
    text: '按成人通用参考区间划分，仅用于理解数值，不构成健康评估或医疗建议；BMI 不区分肌肉与脂肪，运动人群可能被高估。',
  },
  {
    label: '第 N 天与预计达成日怎么来的',
    text: '第 N 天从当前方案生效日起算，更改目标后会重新计数。预计达成日按落库的每周节奏推算，实际进度会随体重记录变化，不是承诺；报告页另有基于实际记录的趋势推算。',
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
export type PlanTimelineState = 'ok' | 'no_start' | 'no_rate' | 'reached' | 'too_far' | 'keep'

/** 方案页只需要这些字段；各端把自己的 Profile 映射成这个结构。 */
export interface HealthPlanInput {
  goal: HealthPlanGoalKey
  /** 由各端 GOAL_LABELS[goal] 注入，避免 shared 再存一份标签副本 */
  goalLabel: string
  gender: 'male' | 'female' | null
  age: number | null
  heightCm: number | null
  dailyCalorieTarget: number | null
  proteinTargetG: number | null
  carbTargetG: number | null
  fatTargetG: number | null
  weeklyRateKg: number | null
  startWeightKg: number | null
  currentWeightKg: number | null
  targetWeightKg: number | null
  /** 当前方案生效日（profiles.plan_started_at，0050 新增并回填 created_at） */
  planStartedAt: string | null
  /** 由各端 todayKey() 注入，让本纯函数完全确定性、可测 */
  todayKey: string
}

export interface PlanTimeline {
  state: PlanTimelineState
  dayIndex: number | null
  /** 组件直接渲染，避免在两端各拼一次字符串 */
  dayLabel: string
  startDateLabel: string | null
  goalDateLabel: string | null
  timelineText: string
  timeNote: string
}

export interface HealthPlanBasic {
  heightCm: number | null
  weightKg: number | null
  bmrKcal: number | null
  bmi: number | null
  band: BmiBand | null
  bands: BmiBand[]
  /** 指示器落在第几段的中心（12.5 / 37.5 / 62.5 / 87.5），色带的非色彩编码之一 */
  bandPositionPct: number | null
  ariaLabel: string
}

export interface HealthPlanGoalView {
  startWeight: number | null
  targetWeight: number | null
  expectLabel: string
  expectValue: string
  remainLabel: string
  remainValue: string
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
  basic: HealthPlanBasic
  timeline: PlanTimeline
  goals: HealthPlanGoalView
}

// ── 纯函数 ────────────────────────────────────────────────

/** 空档案兜底：emptyTarget() 的 1800 kcal 不得被当成真实方案展示。 */
export function isHealthPlanReadyCore(
  input: Pick<HealthPlanInput, 'dailyCalorieTarget'>,
): boolean {
  return input.dailyCalorieTarget != null && input.dailyCalorieTarget > 0
}

/**
 * Mifflin-St Jeor，与两端 nutrition.ts 的 calcBmr 同式；输出只用于展示，不参与目标口径。
 * 🔴 计算层保持全精度，舍入只在构建 HealthPlanView 展示模型时做（见下方 basic）。
 */
export function calcBmrCore(
  gender: 'male' | 'female' | null,
  age: number | null,
  heightCm: number | null,
  weightKg: number | null,
): number | null {
  if (gender !== 'male' && gender !== 'female') return null
  if (age == null || heightCm == null || weightKg == null) return null
  if (age <= 0 || heightCm <= 0 || weightKg <= 0) return null
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return gender === 'male' ? base + 5 : base - 161
}

export function calcBmiCore(heightCm: number | null, weightKg: number | null): number | null {
  if (heightCm == null || weightKg == null || heightCm <= 0 || weightKg <= 0) return null
  const m = heightCm / 100
  return weightKg / (m * m)
}

/** 成人通用参考区间；档位只用中性区间词，不做健康判断。 */
export function bmiBandOf(bmi: number | null): BmiBand | null {
  if (bmi == null || !Number.isFinite(bmi)) return null
  if (bmi < 18.5) return HEALTH_PLAN_BMI_BANDS[0]
  if (bmi < 24) return HEALTH_PLAN_BMI_BANDS[1]
  if (bmi < 28) return HEALTH_PLAN_BMI_BANDS[2]
  return HEALTH_PLAN_BMI_BANDS[3]
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

/**
 * 第 N 天 + 预计达成日。
 * 只用落库字段与日期键纯函数，不引用 forecastGoal / weightSeries，不编造任何数值。
 */
export function buildPlanTimelineCore(input: {
  planStartedAt: string | null
  todayKey: string
  goal: HealthPlanGoalKey
  currentWeightKg: number | null
  targetWeightKg: number | null
  weeklyRateKg: number | null
}): PlanTimeline {
  const startKey = dateKeyFromIso(input.planStartedAt)
  const diff = startKey ? diffDateKeys(startKey, input.todayKey) : null
  const dayIndex = diff == null ? null : Math.max(1, diff + 1)
  const dayLabel = dayIndex == null ? '' : `第 ${dayIndex} 天`
  const startDateLabel = startKey

  const base = (state: PlanTimelineState, timelineText: string, timeNote: string): PlanTimeline => ({
    state, dayIndex, dayLabel, startDateLabel, goalDateLabel: null, timelineText, timeNote,
  })

  if (input.goal === 'keep') {
    const text = startDateLabel ? `${startDateLabel} · ${HEALTH_PLAN_TIMELINE_KEEP}` : HEALTH_PLAN_TIMELINE_KEEP
    return base('keep', text, HEALTH_PLAN_TIMELINE_NOTE_KEEP)
  }
  if (startKey == null) return base('no_start', HEALTH_PLAN_TIMELINE_NO_START, HEALTH_PLAN_TIMELINE_NOTE)

  const current = input.currentWeightKg
  const target = input.targetWeightKg
  const rate = input.weeklyRateKg
  if (current == null || target == null || rate == null || !Number.isFinite(rate) || rate <= 0) {
    return base('no_rate', HEALTH_PLAN_TIMELINE_NO_RATE, HEALTH_PLAN_TIMELINE_NOTE)
  }
  const remaining = Math.abs(target - current)
  if (remaining < 0.1) return base('reached', HEALTH_PLAN_TIMELINE_REACHED, HEALTH_PLAN_TIMELINE_NOTE)

  const daysNeeded = Math.ceil((remaining / rate) * 7)
  if (daysNeeded <= 0 || daysNeeded > 3 * 365) {
    return base('too_far', HEALTH_PLAN_TIMELINE_TOO_FAR, HEALTH_PLAN_TIMELINE_NOTE)
  }
  const goalDateLabel = shiftDateKey(input.todayKey, daysNeeded)
  if (goalDateLabel == null) return base('no_rate', HEALTH_PLAN_TIMELINE_NO_RATE, HEALTH_PLAN_TIMELINE_NOTE)

  return {
    state: 'ok',
    dayIndex,
    dayLabel,
    startDateLabel,
    goalDateLabel,
    timelineText: `${startKey}${HEALTH_PLAN_TIMELINE_ARROW}${HEALTH_PLAN_LABEL_GOAL_DATE} ${goalDateLabel}`,
    timeNote: HEALTH_PLAN_TIMELINE_NOTE,
  }
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

  // 卡片 1：全部来自落库字段 + 纯函数，缺数据不编造
  const bmrKcal = calcBmrCore(input.gender, input.age, input.heightCm, current)
  const bmi = calcBmiCore(input.heightCm, current)
  const band = bmiBandOf(bmi)
  const bandIndex = band ? HEALTH_PLAN_BMI_BANDS.findIndex((b) => b.key === band.key) : -1
  // 展示层插值那一刻才舍入：计算层纯函数保持全精度
  const bmiShown = bmi == null ? null : roundTo(bmi, 1)
  const bmrShown = bmrKcal == null ? null : roundTo(bmrKcal, 0)
  const basic: HealthPlanBasic = {
    heightCm: input.heightCm,
    weightKg: current,
    bmrKcal: bmrShown,
    bmi: bmiShown,
    band,
    bands: HEALTH_PLAN_BMI_BANDS,
    bandPositionPct: bandIndex >= 0 ? (bandIndex + 0.5) * 25 : null,
    ariaLabel: bmiShown == null || band == null
      ? '暂无 BMI 数据'
      : `${HEALTH_PLAN_BMI_ARIA_PREFIX}${bmiShown}，${band.label}${HEALTH_PLAN_BMI_ARIA_TAIL}`,
  }

  // 卡片 2：双卡 + 时间轴
  const expectLabel = goal === 'lose'
    ? HEALTH_PLAN_LABEL_EXPECT_LOSE
    : goal === 'gain' ? HEALTH_PLAN_LABEL_EXPECT_GAIN : HEALTH_PLAN_LABEL_EXPECT_KEEP
  const remainLabel = goal === 'lose'
    ? HEALTH_PLAN_LABEL_REMAIN_LOSE
    : goal === 'gain' ? HEALTH_PLAN_LABEL_REMAIN_GAIN : HEALTH_PLAN_LABEL_REMAIN_KEEP
  const expectValue = goal === 'keep'
    ? (current == null ? '—' : `${roundTo(current, 1)} kg`)
    : (start == null || targetWeight == null ? '—' : `${roundTo(Math.abs(targetWeight - start), 1)} kg`)
  const remainValue = goal === 'keep'
    ? HEALTH_PLAN_KEEP_BAND_VALUE
    : (current == null || targetWeight == null ? '—' : `${roundTo(Math.abs(targetWeight - current), 1)} kg`)

  const timeline = buildPlanTimelineCore({
    planStartedAt: input.planStartedAt,
    todayKey: input.todayKey,
    goal,
    currentWeightKg: current,
    targetWeightKg: targetWeight,
    weeklyRateKg: input.weeklyRateKg,
  })

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
    basic,
    timeline,
    goals: { startWeight: start, targetWeight, expectLabel, expectValue, remainLabel, remainValue },
  }
}
