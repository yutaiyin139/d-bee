/**
 * 「我的」页 · Web/iOS/Android 主端适配层（2026-11-14 四端同构）。
 *
 * 文案与纯展示模型的单一真源在 @dbee/shared/myPage.ts + healthRecord.ts；
 * mini/src/lib/myPage.ts 是同样形状的适配层。本文件只负责把主端 Profile
 * 映射成入参、注入本端日期工具，禁止自写舍入 / 重算热量 / 读取 plan_summary。
 */
import type { Profile } from '../types'
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
