/**
 * 「我的」页 · 智能设备 · 我的食物 · 本周食谱 —— 四端共享文案与纯展示模型（2026-11-14）。
 *
 * 设计约束：只放无环境依赖的纯逻辑（常量 / 纯函数 / 纯类型）。
 * 禁止 import React / DOM / Capacitor / wx / fetch 封装。
 * 数值只在展示层插值这一刻舍入，统一走 numfmt.roundTo()，不自写 toFixed / Math.round(n*f)/f。
 */
import { roundTo } from './numfmt'

/* ── 「我的」页结构 ───────────────────────────────────────────── */

export const MY_PAGE_SECTION_GRID = '常用功能'
export const MY_PAGE_SECTION_LIST = '我的管理'
export const MY_PAGE_SECTION_RECORDS = '记录与设置'

export const MY_PAGE_GRID_ITEMS = [
  { key: 'personal', label: '个人信息' },
  { key: 'honey', label: '蜜糖积分' },
  { key: 'food', label: '我的食物' },
  { key: 'device', label: '智能设备' },
] as const
export type MyPageGridKey = (typeof MY_PAGE_GRID_ITEMS)[number]['key']

export const MY_PAGE_LIST_ITEMS = [
  { key: 'plan', label: '体重管理方案', arrow: '›' },
  { key: 'record', label: '健康档案', arrow: '›' },
  { key: 'week', label: '本周食谱', arrow: '›' },
  { key: 'report', label: '查看完整报告', arrow: '↗' },
] as const
export type MyPageListKey = (typeof MY_PAGE_LIST_ITEMS)[number]['key']

/** 收敛 1：账户区只承担邀请动作，积分余额归宫格「蜜糖积分」 */
export const MY_PAGE_INVITE_LABEL = '邀请好友'
export const MY_PAGE_INVITE_VIEW = '查看'
export function inviteCountText(count: number): string {
  return `已邀 ${count} 人`
}

/** 收敛 2：列表第 4 项是报告 tab 的深链，不是另一个功能 */
export const MY_PAGE_REPORT_ARIA = '查看完整报告，切换到报告页'

/** 收敛 3：4 格数值 → 今日目标只读摘要，与体重管理方案共用同一展示模型 */
export const MY_PAGE_TODAY_TITLE = '今日目标'
export const MY_PAGE_TODAY_HINT = '摘要 · 点按进方案'
export const MY_PAGE_TODAY_ARIA = '今日目标摘要，点按打开体重管理方案'
export const MY_PAGE_TODAY_LABELS = {
  calories: '每日热量预算',
  weight: '当前体重',
  protein: '蛋白质目标',
  carbFat: '碳水 / 脂肪',
} as const
export const MY_PAGE_TODAY_UNITS = { kcal: 'kcal', kg: 'kg', g: 'g' } as const

export interface TodayTargetView {
  calories: string
  weight: string
  protein: string
  carb: string
  fat: string
}

/** 入参必须是落库派生字段（HealthPlanView 的 calories/protein/carb/fat），不得传 calcTarget() 结果。 */
export function buildTodayTargetCore(input: {
  calories: number | null
  currentWeightKg: number | null
  protein: number | null
  carb: number | null
  fat: number | null
}): TodayTargetView {
  const shown = (n: number | null, decimals: number): string =>
    n == null || !Number.isFinite(n) ? '—' : String(roundTo(n, decimals))
  return {
    calories: shown(input.calories, 0),
    weight: shown(input.currentWeightKg, 1),
    protein: shown(input.protein, 0),
    carb: shown(input.carb, 0),
    fat: shown(input.fat, 0),
  }
}

/* ── 智能设备 ─────────────────────────────────────────────────── */

export type DeviceStatus = 'available' | 'guided' | 'planned'
export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  available: '现在可连接',
  guided: '引导查看',
  planned: '规划中',
}
export interface DeviceCatalogItem {
  key: string
  label: string
  status: DeviceStatus
  note: string
}

/** 健康应用目录。status 是唯一扩展点：未来接 SDK 只改状态，不改 UI 结构。 */
export const HEALTH_APP_CATALOG: DeviceCatalogItem[] = [
  { key: 'apple', label: 'Apple 健康', status: 'available', note: '真同步 · iOS' },
  { key: 'huawei', label: '华为运动健康', status: 'available', note: '真同步 · 安卓' },
  { key: 'xiaomi', label: '小米运动健康', status: 'available', note: '真同步 · 安卓' },
  { key: 'vivo', label: 'vivo 健康', status: 'guided', note: '引导查看对应健康应用' },
  { key: 'oppo', label: 'OPPO 健康', status: 'guided', note: '引导查看对应健康应用' },
  { key: 'weapp', label: '微信运动', status: 'planned', note: '小程序 · 规划中' },
]

/** 后续支持的硬件：全部 planned，零可点连接动作、零假功能。 */
export const FUTURE_DEVICE_CATALOG: DeviceCatalogItem[] = [
  { key: 'body-fat-scale', label: '智能体脂秤', status: 'planned', note: '后续支持' },
  { key: 'nutrition-scale', label: '智能营养秤', status: 'planned', note: '后续支持' },
  { key: 'jump-rope', label: '智能跳绳', status: 'planned', note: '后续支持' },
  { key: 'band', label: '智能腕带', status: 'planned', note: '后续支持' },
  { key: 'third-party-scale', label: '第三方智能秤', status: 'planned', note: '后续支持' },
  { key: 'glucose-app', label: '血糖仪应用', status: 'planned', note: '后续支持' },
]

export const SMART_DEVICE_TITLE = '智能设备'
export const SMART_DEVICE_SECTION_APPS = '健康应用 · 现在可连接'
export const SMART_DEVICE_SECTION_STATUS = '连接状态'
export const SMART_DEVICE_SECTION_FUTURE = '更多设备 · 后续支持'
export const SMART_DEVICE_WEB_HINT = '在 App 中可连接健康应用'
export const SMART_DEVICE_NOT_CONNECTED = '暂未连接健康应用'
export const SMART_DEVICE_CONNECTED = '已连接'
export const SMART_DEVICE_LABEL_STEPS = '今日步数'
export const SMART_DEVICE_LABEL_ACTIVITY = '活动消耗'
export const SMART_DEVICE_FUTURE_NOTE = '仅列出目录，暂不提供连接'

/* ── 我的食物 ─────────────────────────────────────────────────── */

export const MY_FOOD_TITLE = '我的食物'
export const MY_FOOD_HINT = '记录饮食时可一键复记常吃的一餐'
export const MY_FOOD_EMPTY = '还没有保存常吃的一餐'
export const MY_FOOD_UNIT_COUNT = '项食物'
export const MY_FOOD_UNIT_KCAL = 'kcal'
export interface MyFoodView { name: string; itemCount: number; calories: number }

export function buildMyFoodViewCore(
  recipes: { name: string; items: { calories: number }[] }[],
): MyFoodView[] {
  return recipes.map((r) => ({
    name: r.name,
    itemCount: r.items.length,
    calories: roundTo(r.items.reduce((s, it) => s + (Number.isFinite(it.calories) ? it.calories : 0), 0), 0),
  }))
}

/* ── 本周食谱（已记录餐次汇总，不是推荐食谱） ─────────────────── */

export const WEEK_RECIPE_TITLE = '本周食谱'
export const WEEK_RECIPE_SUBTITLE = '本周已记录餐次汇总'
export const WEEK_RECIPE_EMPTY = '本周还没有记录饮食'
export const WEEK_RECIPE_UNIT_MEAL = '餐'
export const WEEK_RECIPE_UNIT_KCAL = 'kcal'
export const WEEK_RECIPE_LABEL_TOTAL = '本周合计'
export const WEEK_RECIPE_LABEL_MEALS = '记录餐次'
export const WEEK_RECIPE_LABEL_KCAL = '记录热量'
export interface WeekDayView { date: string; label: string; count: number; kcal: number }

export function buildWeekRecipeViewCore(
  meals: { log_date: string; calories: number }[],
  weekDates: string[],
): WeekDayView[] {
  return weekDates.map((d) => {
    const rows = meals.filter((m) => m.log_date === d)
    return {
      date: d,
      label: d.slice(5).replace('-', '/'),
      count: rows.length,
      kcal: roundTo(rows.reduce((s, m) => s + (Number.isFinite(m.calories) ? m.calories : 0), 0), 0),
    }
  })
}
