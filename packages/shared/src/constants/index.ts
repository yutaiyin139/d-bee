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

/* ── 奖励额度规则 ─────────────────────────────────────────── */
export const STREAK_BONUS_DAYS = 7 // 连续打卡 N 天触发奖励
export const STREAK_BONUS_AMOUNT = 2 // 连续打卡奖励次数
export const NEWBIE_BONUS_AMOUNT = 3 // 完善资料新手奖励次数
export const BONUS_TTL_DAYS = 7 // 奖励有效期（防囤积）

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
