/**
 * 拍照额度阶梯 + 反复拍照判定（纯函数，前端与自测共用单一真相来源）。
 *
 * 两个职责：
 *  1. photoLadderHint —— 按「单日总拍照次数」分阶梯提示
 *  2. isDuplicatePhoto —— 相邻两次拍照识别结果是否「基本一致」（反复拍照）
 *
 * 本文件只做判定，不碰 UI、不发请求、不读存储。
 */

import { HONEY_PRICE } from './invite'

/* ── 需求 1：单日拍照次数阶梯 ───────────────────────────────────── */

/** 免费基础额度（与 entitlement.ts FREE_DAILY_AI 对齐） */
export const FREE_DAILY_AI = 3

/** 第 4~5 次加餐拍照的窗口（1-indexed 次数，不含基础 3 次） */
export const LADDER_REDEEM_MIN = 4 // 第 4 次起进入「积分兑换引导」区间
export const LADDER_REDEEM_MAX = 5 // 第 5 次为止
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

/* ── 需求 2：反复拍照判定 ──────────────────────────────────────── */

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
