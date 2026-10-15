import type { Entitlement, UserPlan } from '../types'

/**
 * 会员与配额的核心规则（纯函数，便于测试与复用）。
 *
 * 三档：
 *  - free      免费：每日 3 次 AI 拍照识别，报告看近 7 天，AI 周解读每周 1 次，不能导出。
 *  - pro       订阅：pro_until 过期时间，到期自动回落 free。
 *  - lifetime  终身买断：plan='lifetime' 且 pro_until 恒 null，永久解锁。
 *
 * 计数口径（重要）：
 *  - **只有「AI 拍照识别」消耗次数**（成功才扣、失败不扣）；手动录入、体重/饮水打卡、
 *    文字解析、包装识别均不计次。
 *  - **条码扫码识别不限次数永久免费**（走 Open Food Facts，不消耗 AI 额度）。
 *  - **AI 文字问答（问问小蜜）不限次数**，但免费用户带限流保护（1 分钟最多 3 次防刷）。
 *  - **长文本 AI 复盘（报告「本期解读」）与个性化完整膳食计划为会员专属**。
 *  - 基础额度自然日 0 点重置，不累计、不结转到次日。
 *  - 识别失败（模糊/非食物/解析报错）不消耗额度（由调用方 refund 实现）。
 *  - 奖励额度（连续打卡 7 天 +2、完善资料 +3）带 7 天有效期，见 quota_bonus 表。
 *
 * 权益状态存在云端 entitlements 表（一人一行），换设备也生效。
 * 真实支付（微信 / 支付宝 / App 内购）待企业资质就绪后接入；在此之前用兑换码解锁。
 */

export const FREE_DAILY_AI = 3
export const FREE_REPORT_DAYS = 7
export const PRO_REPORT_DAYS = 30

/** 奖励额度规则 */
export const STREAK_BONUS_DAYS = 7 // 连续打卡 N 天触发奖励
export const STREAK_BONUS_AMOUNT = 2 // 连续打卡奖励次数
export const NEWBIE_BONUS_AMOUNT = 3 // 完善资料新手奖励次数
export const BONUS_TTL_DAYS = 7 // 奖励有效期（防囤积）

export const SCAN_FEATURE = 'scan'

/* ── 定价（单位：元；最终以支付平台商品为准）────────────────────────── */
export const PRICE_PRO_MONTHLY = 18
export const PRICE_PRO_YEARLY = 128
export const PRICE_LIFETIME = 328

/** 订阅档位（App 内购 / 微信 / 支付宝商品 ID 约定） */
export const PRODUCT_IDS = {
  proMonthly: 'dbee_pro_monthly',
  proYearly: 'dbee_pro_yearly',
  lifetime: 'dbee_lifetime',
} as const

export type ProductId = keyof typeof PRODUCT_IDS

export interface Product {
  id: ProductId
  /** 归属档位：订阅商品解锁 pro，买断商品解锁 lifetime */
  plan: 'pro' | 'lifetime'
  name: string
  price: number
  /** pro 商品的订阅时长（月），lifetime 忽略 */
  months?: number
  /** 是否最推荐（UI 高亮） */
  highlight?: boolean
}

/** 付费墙展示的商品列表（顺序即展示顺序） */
export const PRODUCTS: Product[] = [
  { id: 'proMonthly', plan: 'pro', name: '月订阅', price: PRICE_PRO_MONTHLY, months: 1 },
  { id: 'proYearly', plan: 'pro', name: '年订阅', price: PRICE_PRO_YEARLY, months: 12, highlight: true },
  { id: 'lifetime', plan: 'lifetime', name: '终身买断', price: PRICE_LIFETIME },
]

/* ── 兑换码（客户端校验；接入真实支付后此列表下线，勿带进 App Store 提审包）── */
export const REDEEM_CODES = ['DBEE-PRO-2026', 'MIFENG-VIP', 'BEE2026']

/** 是否为「已解锁会员」（pro 未过期 或 lifetime） */
export function isPro(ent: Entitlement | null | undefined): boolean {
  if (!ent) return false
  if (ent.plan === 'lifetime') return true
  if (ent.plan === 'pro') {
    if (ent.pro_until) return new Date(ent.pro_until).getTime() > Date.now()
    return true
  }
  return false
}

/** 判定当前是否终身会员（用于 UI 区分「永久」标识） */
export function isLifetime(ent: Entitlement | null | undefined): boolean {
  return !!ent && ent.plan === 'lifetime'
}

/** 当前会员档位（含过期回落后的归一化结果） */
export function effectivePlan(ent: Entitlement | null | undefined): UserPlan {
  if (!ent) return 'free'
  if (ent.plan === 'lifetime') return 'lifetime'
  if (ent.plan === 'pro') return isPro(ent) ? 'pro' : 'free'
  return 'free'
}

/** 本周一（用于周配额：usage_date 存周一日期） */
export function mondayOf(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const shift = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - shift)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

export function codeIsValid(raw: string): boolean {
  return REDEEM_CODES.includes(normalizeCode(raw))
}

/** 由「订阅月数」算出 pro_until 过期时间（ISO 字符串） */
export function proUntilFromMonths(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString()
}

/**
 * 免费拍照额度用尽时的统一提示。
 * 必须同时讲清：
 * 1）什么时候恢复（按本地自然日计，次日 0 点自动重置）
 * 2）额度是怎么算的（只有拍照识别消耗，其他都不扣）
 * 3）哪些功能不受影响（手动记录、文字解析、条码、体重饮水运动都不扣）
 */
export function quotaExhaustedReason(): string {
  return (
    `今日 ${FREE_DAILY_AI} 次免费拍照识别已用完，明天 0 点自动重置。` +
    `升级 Pro 可无限次拍照识别。` +
    `扫条码、文字描述、手动录入、记录饮水体重运动、AI 问答都免费不限次数。`
  )
}
