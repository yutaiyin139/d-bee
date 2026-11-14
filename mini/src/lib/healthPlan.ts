/**
 * 健康管理方案 · mini 端适配层（2026-11-14 四端同构）。
 *
 * 文案与展示层纯函数的【单一真源】在 @dbee/shared/healthPlan.ts，主端
 * src/lib/healthPlan.ts 是同样形状的适配层；两端组件消费同一组常量与
 * buildHealthPlanViewCore()，因此四端文案、数值、口径、说明条目逐字一致。
 *
 * 本文件只负责：把 mini Profile 映射成 HealthPlanInput，并注入 mini 的 GOAL_LABELS 真源。
 * 禁止在此重算热量、禁止读取 plan_summary、禁止自写舍入。
 */
import type { HealthPlanGoalKey, HealthPlanView } from '@dbee/shared'
import { buildHealthPlanViewCore, isHealthPlanReadyCore } from '@dbee/shared'
import type { Profile } from './api'
import { GOAL_LABELS } from './nutrition'

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

/**
 * mini 端跨页面一次性引导旗标（onboarding 写 → index 读并清）。
 * reLaunch 到 tabBar 页不能带 query，故用本地存储；读到即删保证只弹一次，
 * 老用户冷启动不写旗标，天然不会被弹。
 */
export const HEALTH_PLAN_INTRO_FLAG_KEY = 'dbee_intro_plan'

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
    dailyCalorieTarget: p.daily_calorie_target,
    proteinTargetG: p.protein_target_g,
    carbTargetG: p.carb_target_g,
    fatTargetG: p.fat_target_g,
    weeklyRateKg: p.weekly_rate_kg,
    startWeightKg: p.start_weight_kg,
    currentWeightKg: p.current_weight_kg,
    targetWeightKg: p.target_weight_kg,
  })
}
