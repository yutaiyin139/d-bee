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

export type DeviceStatus = 'available' | 'in_progress' | 'guided' | 'planned'
export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  available: '现在可连接',
  in_progress: '接入中',
  guided: '引导查看',
  planned: '规划中',
}
export interface DeviceCatalogItem {
  key: string
  label: string
  status: DeviceStatus
  note: string
}

/**
 * 健康应用目录。status 是唯一扩展点：未来接 SDK 只改状态，不改 UI 结构。
 * 🔴 2026-11-15 用户拍板：Apple 已真机验证 → available；华为/小米资质与 SDK
 *    逐个推进中 → in_progress（零假功能，不标「现在可连接」）；vivo/OPPO 暂缓合作申请。
 */
export const HEALTH_APP_CATALOG: DeviceCatalogItem[] = [
  { key: 'apple', label: 'Apple 健康', status: 'available', note: '真同步 · iOS · 已真机验证' },
  { key: 'huawei', label: '华为运动健康', status: 'in_progress', note: '资质与 SDK 逐个推进' },
  { key: 'xiaomi', label: '小米运动健康', status: 'in_progress', note: '资质与 SDK 逐个推进' },
  { key: 'vivo', label: 'vivo 健康', status: 'guided', note: '暂缓 · 后续启动合作申请' },
  { key: 'oppo', label: 'OPPO 健康', status: 'guided', note: '暂缓 · 后续启动合作申请' },
  // WX-1~WX-3（2026-11-17）：网关解密 + 小程序主动同步已落地源码，
  // 但 status 保持 planned —— 须真机验收（上传体验版 + 对齐微信运动榜单）后才改 available（D7 零假绿）。
  { key: 'weapp', label: '微信运动', status: 'planned', note: '小程序 · 代码就绪待真机验收' },
]

/** 当前机型 vendor → 健康应用目录 key；无对应项返回空串（不显示连接按钮）。 */
export function healthCatalogKeyForVendor(vendor: string): string {
  const key = vendor === 'wechat-miniprogram' ? 'weapp' : vendor
  return HEALTH_APP_CATALOG.some((d) => d.key === key) ? key : ''
}

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

/**
 * 智能手表 · 手表端蜜蜂健康 App 绑定。
 *
 * 🔴 诚实原则：D-Bee 不直连手表硬件，只读系统健康平台（已拍板决策）。
 * 这里每个手表品牌的「绑定」= 连接其对应的系统健康应用（与 HEALTH_APP_CATALOG 同一真源），
 * 绝不提供「扫码绑定硬件」的假按钮。5 品牌顺序对齐竞品图，但状态复用真目录。
 */
export interface WatchCatalogItem {
  /** 映射到 HEALTH_APP_CATALOG 的 key */
  key: string
  /** 手表展示名（对齐竞品图顺序与措辞） */
  label: string
  /** 该手表当前的具体进度说明（杜绝「规划中」三个字敷衍） */
  statusNote: string
}
export const WATCH_CATALOG: WatchCatalogItem[] = [
  { key: 'oppo', label: 'OPPO Watch', statusNote: '合作申请暂缓 · 生态对接待启动' },
  { key: 'huawei', label: 'HUAWEI WATCH', statusNote: '资质与 SDK 逐个推进中' },
  { key: 'apple', label: 'Apple Watch', statusNote: '连接 Apple 健康后自动同步手表数据' },
  { key: 'vivo', label: 'VIVO Watch', statusNote: '合作申请暂缓 · 生态对接待启动' },
  { key: 'xiaomi', label: 'XIAOMI WATCH', statusNote: '资质与 SDK 逐个推进中' },
]

/** 智能设备页「其他」分组里的手表入口卡片文案 */
export const WATCH_SECTION_OTHER = '其他'
export const WATCH_BIND_ENTRY = '手表端蜜蜂健康App绑定'
export const WATCH_BIND_TITLE = '智能手表'
export const WATCH_BIND_HINT = '自律蜜蜂支持以下手表，连接后自动同步运动数据'
export const WATCH_BIND_NOT_BOUND = '未绑定'
export const WATCH_BIND_BOUND = '已绑定'
export const WATCH_BIND_ACTION_CONNECT = '连接'
export const WATCH_BIND_ACTION_PROGRESS = '查看进度'
export const WATCH_BIND_HC_NOTE = '安卓手表可走系统健康服务（Health Connect），一次授权读取多种手表与手环的运动数据，正在接入中。'
export const WATCH_BIND_BACK = '返回'
export const WATCH_BIND_PROGRESS_NOTE = '该品牌健康数据的接入进度可在「健康应用」一栏查看；当前请先用手动记录运动。'

/* ── 我的食物 ─────────────────────────────────────────────────── */

export const MY_FOOD_TITLE = '我的食物'
export const MY_FOOD_HINT = '这里是你存过的常吃一餐，可一键记到今天，也可删除'
export const MY_FOOD_EMPTY = '还没有保存常吃的一餐'
export const MY_FOOD_UNIT_COUNT = '项食物'
export const MY_FOOD_UNIT_KCAL = 'kcal'
/** 我的食物操作文案（两端同构，护栏取真值） */
export const MY_FOOD_ACTION_LOG = '记一餐'
export const MY_FOOD_ACTION_DELETE = '删除'
export const MY_FOOD_ACTION_DELETE_CONFIRM = '确认删除?'
export const MY_FOOD_ACTION_LOGGING = '记录中…'
export const MY_FOOD_LOGGED = (name: string, count: number): string => `已把「${name}」记入今天（${count} 项）`
export const MY_FOOD_LOG_ERROR = '记一餐失败，请重试'
export const MY_FOOD_DELETE_ERROR = '删除失败，请重试'
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
