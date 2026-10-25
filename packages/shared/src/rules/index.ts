/**
 * 会员与配额的核心规则（纯函数，多端共用）。
 *
 * 计数口径（重要）：
 *  - **只有「AI 拍照识别」消耗次数**（成功才扣、失败不扣）；手动录入、体重/饮水打卡、
 *    文字解析、包装识别均不计次。
 *  - **条码扫码识别不限次数永久免费**（走 Open Food Facts，不消耗 AI 额度）。
 *  - **AI 文字问答不限次数**，免费用户带限流保护（1 分钟最多 3 次防刷）。
 *  - 基础额度自然日 0 点重置，不累计、不结转。
 *  - 奖励额度（连续打卡 7 天 +2、完善资料 +3）带 7 天有效期，见 quota_bonus 表。
 *
 * 权益状态存在云端 entitlements 表（一人一行），换设备也生效。
 * 支付渠道（2026-10-25 拍板）：iOS 走 App 内购（StoreKit 2），Android/Web 走微信 + 支付宝。
 * 验签分支待商户号就绪后接入；资质就绪前用兑换码解锁。
 */
import type { Entitlement, UserPlan } from '../types'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  HONEY_PRICE,
  type ProductId,
} from '../constants'

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
  { id: 'proMonthly', plan: 'pro', name: '月订阅', price: 18, months: 1 },
  { id: 'proYearly', plan: 'pro', name: '年订阅', price: 128, months: 12, highlight: true },
  { id: 'lifetime', plan: 'lifetime', name: '终身买断', price: 298 },
]

/** 是否为「已解锁会员」（pro 未过期 或 lifetime） */
export function isPro(ent: Entitlement | null | undefined): boolean {
  if (!ent) return false
  if (ent.plan === 'lifetime') return true
  if (ent.plan === 'pro') {
    // 订阅档必须带有效 pro_until 才判为会员；缺失按「已过期」处理。
    // 永久解锁只走 plan='lifetime'（其 pro_until 恒为 null）。
    if (!ent.pro_until) return false
    return new Date(ent.pro_until).getTime() > Date.now()
  }
  return false
}

/** 判定当前是否终身会员 */
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

/** 由「订阅月数」算出 pro_until 过期时间（ISO 字符串） */
export function proUntilFromMonths(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString()
}

/**
 * 免费拍照额度用尽时的统一提示（多端共用文案）。
 */
export function quotaExhaustedReason(): string {
  return (
    `今日 ${FREE_DAILY_AI} 次免费拍照识别已用完（积分可再兑换 ${AI_REDEEM_DAILY_LIMIT} 次），明天 0 点重置。` +
    `升级 Pro 可无限次拍照识别。` +
    `扫条码、文字描述、手动录入、记录饮水体重运动、AI 问答都免费不限次数。`
  )
}

/* ── 拍照额度阶梯 + 反复拍照判定（多端共用纯函数）────────────────── */

/**
 * 第 4~5 次加餐拍照的窗口（1-indexed 次数，不含基础 3 次）。
 * 对应产品规则：免费 3 次 + 积分兑换每日最多 2 次（见 AI_REDEEM_DAILY_LIMIT）。
 */
export const LADDER_REDEEM_MIN = 4 // 第 4 次起进入「积分兑换引导」区间
export const LADDER_REDEEM_MAX = 5 // 第 5 次为止（= 免费 3 + 兑换 2）
export const LADDER_PRO_START = 6 // 第 6 次起直接 Pro

export type LadderKind = 'none' | 'redeem' | 'inviteOrPro' | 'pro'

export interface LadderHint {
  kind: LadderKind
  /** 本次是当日第几次拍照（1-indexed） */
  nth: number
  /** 用当前积分可兑换的拍照次数（向下取整），仅 redeem 分支有意义 */
  redeemCount: number
}

/**
 * 拍照前按「当日已成功拍照次数」分流。
 * @param todayCount 本次拍照前当日已成功拍照的次数（0-indexed：拍第 1 次时传 0）
 * @param honeyBalance 当前可用积分
 *
 * 阶梯（nth = todayCount + 1 表示本次是第几次）：
 *  - nth ≤ 3            → none（基础免费，正常拍）
 *  - nth ∈ {4, 5}       → 有积分 redeem / 无积分 inviteOrPro
 *  - nth ≥ 6            → pro（直接升级，不再兑换）
 */
export function photoLadderHint(todayCount: number, honeyBalance: number): LadderHint {
  const nth = Math.max(0, Math.floor(todayCount)) + 1
  if (nth <= FREE_DAILY_AI) {
    return { kind: 'none', nth, redeemCount: 0 }
  }
  if (nth >= LADDER_PRO_START) {
    return { kind: 'pro', nth, redeemCount: 0 }
  }
  // nth ∈ {4, 5}
  const redeemCount = Math.floor(honeyBalance / HONEY_PRICE.ai1Scan)
  if (redeemCount >= 1) {
    return { kind: 'redeem', nth, redeemCount }
  }
  return { kind: 'inviteOrPro', nth, redeemCount: 0 }
}

/* ── 反复拍照判定 ───────────────────────────────────────────── */

/** 一次识别结果的摘要（供重复比对，不依赖完整对象） */
export interface PhotoSummary {
  /** 食物名称列表 */
  names: string[]
  /** 本次识别总热量（kcal） */
  totalKcal: number
}

/** 食物名重合率阈值（Jaccard 式：交集 / 并集） */
export const DUP_NAME_OVERLAP = 0.7
/** 总热量差阈值（相对差 ≤ 10%） */
export const DUP_KCAL_DELTA = 0.1

/**
 * 判定相邻两次拍照识别结果是否「基本一致」。
 * 规则（与用户确认）：食物名重合率 ≥ 70% 且 总热量相对差 ≤ 10%。
 *
 * 重合率用「交集大小 / 并集大小」；两次都无食物名时不判重（返回 false）。
 * 热量差用 |prev-curr| / max(prev,curr,1)。
 */
export function isDuplicatePhoto(prev: PhotoSummary, curr: PhotoSummary): boolean {
  if (!prev.names.length || !curr.names.length) return false

  // 食物名重合率（归一化去空格、去重）
  const norm = (s: string) => s.trim().toLowerCase()
  const p = new Set(prev.names.map(norm))
  const c = new Set(curr.names.map(norm))
  let inter = 0
  for (const n of c) if (p.has(n)) inter++
  const union = new Set([...p, ...c]).size
  if (union === 0) return false
  const overlap = inter / union

  // 总热量相对差
  const denom = Math.max(prev.totalKcal, curr.totalKcal, 1)
  const kcalDelta = Math.abs(prev.totalKcal - curr.totalKcal) / denom

  return overlap >= DUP_NAME_OVERLAP && kcalDelta <= DUP_KCAL_DELTA
}

/** 把一次识别结果汇总成 PhotoSummary（食物名 + 总热量） */
export function summarizePhoto(items: { food_name: string; kcalPerG: number; grams: number }[]): PhotoSummary {
  const names: string[] = []
  let totalKcal = 0
  for (const it of items) {
    if (it.food_name) names.push(it.food_name)
    totalKcal += (it.kcalPerG || 0) * (it.grams || 0)
  }
  return { names, totalKcal }
}
