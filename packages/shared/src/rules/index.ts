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
  FREE_REPORT_DAYS,
  HONEY_PRICE,
  PRICE_LIFETIME,
  PRICE_PRO_MONTHLY,
  PRICE_PRO_YEARLY,
  type ProductId,
} from '../constants'
import { fmtNum } from '../numfmt'
import { proUntilText } from '../datefmt'

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

/**
 * 付费墙展示的商品列表（顺序即展示顺序）。
 *
 * 🔴 price **必须引用 `PRICE_*` 常量，不可写字面量**（2026-11-03 修）：
 *   此前这里写的是 `price: 18` / `128` / `298`，与 constants 的 PRICE_* 是
 *   两份互相独立的副本，改价时必然漏改一处。同一文件的 constants:84 对
 *   FREE_HONEY_PRO_ITEM 早已写明「用模板字符串从 HONEY_PRICE 取值，不硬编码
 *   数字：调价时文案自动跟随」——价格本身反而硬编码是本末倒置。
 */
export const PRODUCTS: Product[] = [
  { id: 'proMonthly', plan: 'pro', name: '月订阅', price: PRICE_PRO_MONTHLY, months: 1 },
  { id: 'proYearly', plan: 'pro', name: '年订阅', price: PRICE_PRO_YEARLY, months: 12, highlight: true },
  { id: 'lifetime', plan: 'lifetime', name: '终身买断', price: PRICE_LIFETIME },
]

/**
 * 由商品生成付费墙价格文案（如 `¥128 / 年（约 ¥10.7/月）`）。
 *
 * 🔴 为什么要把它放进 shared（2026-11-03）：
 *   此前主端 `src/pages/PaywallSheet.tsx` 另有一份硬编码的 `PRICE_TAG`：
 *     { proMonthly: '¥18 / 月', proYearly: '¥128 / 年（约 ¥10.7/月）', lifetime: '¥298 永久' }
 *   它是全仓**第三份**价格副本，且只有 Android/Web 分支在用 —— iOS 分支刻意
 *   「绝不回退硬编码价」（只用 App Store 拉到的真实价）。改价时漏改这份，就会
 *   出现「商店价 ¥20、Web 展示 ¥18」的价格不符：既误导用户，也可能被认定价格欺诈。
 *   收敛到这里后，价格只剩 `PRICE_*` 一个真相源，文案随之自动生成。
 *
 * 实现约束（与项目数值纪律一致）：
 *   · 数字一律走 `fmtNum`（全站唯一权威实现），**禁止自己写 toFixed / Math.round**；
 *   · 均摊月价保留 1 位小数、去尾随零（128/12 = 10.666… → `10.7`；120/12 → `10`）；
 *   · `months` 缺失或 ≤0 → **不编造订阅周期**，只输出 `¥128`（宁可少写，不可写错）；
 *   · `price` 非有限数 → 整体退化为占位符 `—`，与主端 iOS 分支「拉不到商店价显示 —」
 *     同一处置：不展示一个与真实扣款不符的数字。
 */
export function priceTag(p: Product): string {
  if (!Number.isFinite(p.price)) return '—'
  const price = `¥${fmtNum(p.price, 2)}`

  // 买断档：无订阅期，不谈均摊
  if (p.plan === 'lifetime') return `${price} 永久`

  const months = p.months ?? 0
  if (months <= 0) return price

  const unit = months === 1 ? '月' : months === 12 ? '年' : `${months} 个月`
  if (months === 1) return `${price} / ${unit}`

  // 非月订阅才附均摊月价，帮用户横向比较（App Store 3.1.2 的比价要求同源）
  const monthly = p.price / months
  if (!Number.isFinite(monthly)) return `${price} / ${unit}`
  return `${price} / ${unit}（约 ¥${fmtNum(monthly, 1)}/月）`
}


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

/**
 * 「我的」页会员状态卡片的副标题（四端共用同一实现）。
 *
 * 🔴 为什么要下沉（2026-11-03，四端一致性审计）：
 *   这段四分支文案原本在两端各写一份，且已经**分叉**：
 *     · 主端 src/pages/ProfileScreen.tsx（会员状态卡片副标题）—— 四个分支齐全，额度用真实值
 *     · mini/src/pages/profile/profile.tsx      —— 只有三个分支（缺 lifetime 兑换码、
 *       缺 pro 有效期），且把剩余拍照次数**硬编码成 3**
 *   后果：mini 的付费用户在「我的」页永远看到「免费版 + 升级按钮」，免费用户额度
 *   用尽时仍显示「剩 3 次」，点了拍照才被 fail-closed 拒绝。
 *   两份副本靠人工对齐必然会漂 —— 和定价三副本（PRICE_PRO_MONTHLY / PRODUCTS[].price /
 *   PaywallSheet 的 PRICE_TAG）是同一种病，故一并收到单一真相源。
 *
 * 🔴 `aiRemaining` 的 null 语义由调用方决定，两端刻意不同（这是**对的**差异，不要抹平）：
 *   · 主端 usePlan 的 aiRemaining 在非 Pro 时恒为数字（photoQuota 各分支都设 total），
 *     故 `?? 0` 只是类型兜底，实际输出与改动前逐字一致。
 *   · mini 的 getPhotoQuota 失败时返回 degraded=true（P0-B 后补的 fail-closed 实现，
 *     比主端更严格）。此时调用方应传 `aiRemaining: null`，本函数输出「暂时读不到」
 *     而非编一个数字 —— 显示一个读不到的额度等于向用户谎报：他可能据此以为还能拍照，
 *     实际会在识别时被拒。宁可少显示，不可显示与真实额度不符的次数。
 *   主端 getPhotoQuota 在 row 为 null 时返回满额 FREE_DAILY_AI（fail-open 展示），
 *   是 P0-B 之前的旧语义；展示层这个差异有意保留。
 *
 * @param ent          会员权益（null = 读不到，按免费档展示）
 * @param aiRemaining  今日剩余拍照次数；null = 未知/读不到（见上）；Pro 传 null（不限次）
 * @param freeReportDays 免费档可看的报告天数，走常量插值不硬编码
 */
export function memberSubText(
  ent: Entitlement | null | undefined,
  aiRemaining: number | null | undefined,
  freeReportDays: number = FREE_REPORT_DAYS,
): string {
  if (isLifetime(ent)) {
    return ent?.redeemed_code ? `已通过兑换码 ${ent.redeemed_code} 永久解锁` : '全部功能已永久解锁'
  }
  if (isPro(ent)) return proUntilText(ent?.pro_until)
  const quotaText = aiRemaining == null ? '今日拍照额度暂时读不到' : `今日剩拍照 ${aiRemaining} 次`
  return `${quotaText} · 报告看近 ${freeReportDays} 天`
}

/**
 * 兑换码核销成功后的确认文案（四端共用，按**真实档位**生成）。
 *
 * 🔴 为什么绝不能写死「终身会员已生效」（2026-11-11，mini 实测反馈）：
 *   0044 迁移起 `redeem_by_code` 已支持月/年/终身三档（此前只发 lifetime）。
 *   月卡用户兑换成功却看到「终身会员已生效」= 向用户谎报他实际买到了什么，
 *   事后极易被当成欺诈投诉；这与定价三副本是同一类「副本漂移」病，故文案
 *   一律从**刷新到的真实 entitlement** 生成，日期走 datefmt 的确定性格式
 *   （不依赖各端 locale，与 proNoticeText / memberSubText 同源）。
 *
 * @param ent 兑换成功后重新拉取的权益。null = 拉取失败，但 RPC 已返回 'ok'
 *            （钱/码已核销），此时既不能谎报档位、也绝不能谎报失败，
 *            给一句不指明档位的通用确认，让用户知道「已成功」。
 */
export function redeemSuccessText(ent: Entitlement | null | undefined): string {
  if (isLifetime(ent)) return '兑换成功，终身会员已生效 🐝'
  if (isPro(ent)) return `兑换成功，会员${proUntilText(ent?.pro_until, '已生效')} 🐝`
  return '兑换成功，会员权益已生效 🐝'
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
