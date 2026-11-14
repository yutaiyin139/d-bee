/**
 * 「我的」页 · mini 端适配层（2026-11-14 四端同构）。
 * 与主端 src/lib/myPage.ts 同样形状：文案与纯展示模型真源在 @dbee/shared，
 * 本文件只负责把 mini Profile 映射成入参、注入 mini 的日期工具。
 */
import type { Profile } from './api'
import {
  buildTodayTargetCore, buildCompletionCore, buildWeekRecipeViewCore,
  type TodayTargetView, type CompletionView, type WeekDayView,
} from '@dbee/shared'
import { buildHealthPlanView } from './healthPlan'
import { todayKey, weekOf } from './nutrition'

/** 收敛 3：4 格数值只读方案页同一份落库派生字段，消除现场 calcTarget() 双口径。 */
export function buildTodayTarget(p: Profile | null): TodayTargetView {
  if (!p) {
    return buildTodayTargetCore({ calories: null, currentWeightKg: null, protein: null, carb: null, fat: null })
  }
  const v = buildHealthPlanView(p)
  return buildTodayTargetCore({
    calories: v.ready ? v.calories : null,
    currentWeightKg: p.current_weight_kg,
    protein: v.ready ? v.protein : null,
    carb: v.ready ? v.carb : null,
    fat: v.ready ? v.fat : null,
  })
}

export function buildCompletion(p: Profile): CompletionView {
  return buildCompletionCore({
    nickname: p.nickname,
    gender: p.gender,
    age: p.age,
    heightCm: p.height_cm,
    currentWeightKg: p.current_weight_kg,
    targetWeightKg: p.target_weight_kg,
    activityLevel: p.activity_level,
    goal: p.goal,
  })
}

export function currentWeekDates(): string[] {
  return weekOf(todayKey())
}

export function buildWeekRecipeView(meals: { log_date: string; calories: number }[]): WeekDayView[] {
  return buildWeekRecipeViewCore(meals, currentWeekDates())
}
