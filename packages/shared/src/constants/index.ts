/**
 * 会员与配额的核心常量（多端共用真相源）。
 *
 * 这是「单一真相源」：任何端（Web / iOS / Android / 微信 / 支付宝 / 抖音）
 * 都从这里引用同一份数值，禁止在各自工程里硬编码副本。
 */

/** 免费用户每日 AI 拍照识别基础次数 */
export const FREE_DAILY_AI = 3

/** 免费用户每日可用积分兑换的「AI 拍照识别」次数上限（50 积分/次） */
export const AI_REDEEM_DAILY_LIMIT = 2

/** 免费用户饮食报告可回看天数 */
export const FREE_REPORT_DAYS = 7

/** 会员饮食报告可回看天数 */
export const PRO_REPORT_DAYS = 30

/* ── 奖励规则 ───────────────────────────────────────────── */
// 产品规则（2026-10-19 调整）：每日严格「3 次免费识别 + 2 次积分兑换」。
//   - 新手完善资料 → 发 150 蜜糖积分（积分只能兑换识别，受每日 2 次上限约束）。
//   - 连续打卡 7 天 → 直接送 2 次识别（每满 7 天循环发放，7/14/21…各送 2 次），
//     少一次「兑换」点击，直接到账。
export const STREAK_BONUS_DAYS = 7 // 连续打卡每满 N 天触发一次奖励
export const STREAK_BONUS_AMOUNT = 2 // 连续打卡每满 7 天送的识别次数
export const NEWBIE_BONUS_AMOUNT = 150 // 完善资料新手奖励积分（= 3 次识别）
export const BONUS_TTL_DAYS = 7 // 识别次数奖励有效期（防囤积）

/** 消耗额度的 feature 标识（ai_usage.feature） */
export const SCAN_FEATURE = 'scan'

/* ── 定价（单位：元；最终以支付平台商品为准）────────────────── */
export const PRICE_PRO_MONTHLY = 18
export const PRICE_PRO_YEARLY = 128
export const PRICE_LIFETIME = 328

/** 订阅档位商品 ID 约定（App 内购 / 微信 / 支付宝共用） */
export const PRODUCT_IDS = {
  proMonthly: 'dbee_pro_monthly',
  proYearly: 'dbee_pro_yearly',
  lifetime: 'dbee_lifetime',
} as const

export type ProductId = keyof typeof PRODUCT_IDS

/* ── 蜜糖积分兑换价格表（单位：分）────────────────────────────── */
export const HONEY_PRICE = {
  pro1Day: 100, // 100 分 = Pro 1 天
  pro30Day: 2600, // 2600 分 = Pro 30 天
  ai1Scan: 50, // 50 分 = AI 拍照 1 次
} as const

export type HoneyRewardKind = keyof typeof HONEY_PRICE

/* ── 推送通知（P1-4）────────────────────────────────────────── */
// 通知类型枚举（多端共用真相源）
export const NOTIFY_KIND = {
  checkin: 'checkin', // 打卡提醒：每日 20:00
  water: 'water', // 饮水提醒：每 2 小时（9:00~21:00），仅当日未达标
} as const

export type NotifyKind = (typeof NOTIFY_KIND)[keyof typeof NOTIFY_KIND]

/** 打卡提醒默认触发时刻（24h，本地通知用） */
export const CHECKIN_REMINDER_HOUR = 20
export const CHECKIN_REMINDER_MINUTE = 0

/** 饮水提醒：起始/结束时刻（本地通知用） */
export const WATER_REMINDER_START_HOUR = 9
export const WATER_REMINDER_END_HOUR = 21
export const WATER_REMINDER_INTERVAL_HOURS = 2
