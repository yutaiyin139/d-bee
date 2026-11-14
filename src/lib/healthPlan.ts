/**
 * 体重管理方案 · Web/iOS/Android 主端适配层（2026-11-14 四端同构）。
 *
 * 文案与展示层纯函数的【单一真源】已下沉 @dbee/shared/healthPlan.ts，
 * mini 端 mini/src/lib/healthPlan.ts 用同样的形状做适配，两端组件消费同一份常量与
 * buildHealthPlanViewCore()，因此四端文案、数值、口径、说明条目逐字一致。
 *
 * 本文件只负责：把主端 Profile 映射成 HealthPlanInput，并注入本端 GOAL_LABELS 真源
 * 与 todayKey()。禁止在此重算热量、禁止读取 plan_summary、禁止自写舍入与日期运算。
 */
import type { Profile } from '../types'
import type { HealthPlanGoalKey, HealthPlanView } from '@dbee/shared'
import { buildHealthPlanViewCore, isHealthPlanReadyCore } from '@dbee/shared'
import { GOAL_LABELS, todayKey } from './nutrition'

export {
  HEALTH_PLAN_TITLE,
  HEALTH_PLAN_INTRO_TITLE,
  HEALTH_PLAN_CHANGE_WILL,
  HEALTH_PLAN_CHANGE_WONT,
  HEALTH_PLAN_EDIT_CURRENT_PREFIX,
  HEALTH_PLAN_EDIT_CONFIRM_TAIL,
  HEALTH_PLAN_EDIT_WILL_PREFIX,
  HEALTH_PLAN_EDIT_WONT_PREFIX,
  HEALTH_PLAN_UPDATED_PREFIX,
  HEALTH_PLAN_SECTION_BASIC,
  HEALTH_PLAN_SECTION_GOAL,
  HEALTH_PLAN_SECTION_DAILY,
  HEALTH_PLAN_LABEL_HEIGHT,
  HEALTH_PLAN_LABEL_WEIGHT,
  HEALTH_PLAN_LABEL_BMR,
  HEALTH_PLAN_LABEL_BMI,
  HEALTH_PLAN_UNIT_CM,
  HEALTH_PLAN_UNIT_KG,
  HEALTH_PLAN_UNIT_G,
  HEALTH_PLAN_BMI_PREFIX,
  HEALTH_PLAN_BMI_DISCLAIMER,
  HEALTH_PLAN_BMI_BANDS,
  HEALTH_PLAN_LABEL_PROGRESS,
  HEALTH_PLAN_LABEL_START_W,
  HEALTH_PLAN_LABEL_TARGET_W,
  HEALTH_PLAN_LABEL_GOAL_DATE,
  HEALTH_PLAN_LABEL_EXPECT_KEEP,
  HEALTH_PLAN_LABEL_REMAIN_KEEP,
  HEALTH_PLAN_TIMELINE_ARROW,
  HEALTH_PLAN_INTRO_HINT,
  HEALTH_PLAN_NOTES_TITLE,
  HEALTH_PLAN_NOT_READY,
  HEALTH_PLAN_GO_FILL,
  HEALTH_PLAN_LABEL_DAILY,
  HEALTH_PLAN_UNIT_KCAL,
  HEALTH_PLAN_LABEL_PROTEIN,
  HEALTH_PLAN_LABEL_CARB,
  HEALTH_PLAN_LABEL_FAT,
  HEALTH_PLAN_LABEL_WEEKLY,
  HEALTH_PLAN_LABEL_START,
  HEALTH_PLAN_LABEL_CHANGE,
  HEALTH_PLAN_WEEKLY_KEEP,
  HEALTH_PLAN_BAND_HINT,
  HEALTH_PLAN_NOTES,
} from '@dbee/shared'
export type { HealthPlanView, HealthPlanGoalKey as GoalKey } from '@dbee/shared'

/** 空档案兜底：emptyTarget() 的 1800 kcal 不得被当成真实方案展示。 */
export function isHealthPlanReady(p: Profile | null): boolean {
  return !!p && isHealthPlanReadyCore({ dailyCalorieTarget: p.daily_calorie_target })
}

/** 稳定把 profile.goal 收敛到三目标之一，不新增第四种目标。 */
function readGoal(p: Profile): HealthPlanGoalKey {
  const g = p.goal
  return g === 'lose' || g === 'keep' || g === 'gain' ? g : 'lose'
}

/** 按 profile.goal 产出【唯一一态】的展示模型，只读落库字段。 */
export function buildHealthPlanView(p: Profile): HealthPlanView {
  const goal = readGoal(p)
  return buildHealthPlanViewCore({
    goal,
    goalLabel: GOAL_LABELS[goal],
    gender: p.gender,
    age: p.age,
    heightCm: p.height_cm,
    dailyCalorieTarget: p.daily_calorie_target,
    proteinTargetG: p.protein_target_g,
    carbTargetG: p.carb_target_g,
    fatTargetG: p.fat_target_g,
    weeklyRateKg: p.weekly_rate_kg,
    startWeightKg: p.start_weight_kg,
    currentWeightKg: p.current_weight_kg,
    targetWeightKg: p.target_weight_kg,
    planStartedAt: p.plan_started_at ?? null,
    todayKey: todayKey(),
  })
}
