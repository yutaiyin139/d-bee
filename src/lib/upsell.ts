/**
 * 转化钩子（upsell）——克制版。
 *
 * 背景：免费用户每天 3 次拍照额度。与其在用户第 4 次拍照被拦下、体验受挫时才
 * 弹付费墙，不如在第 3 次拍照刚尝到 AI 识别甜头的那一刻轻提示一句升级。
 *
 * 克制约束（避免骚扰，守住「不做过度设计」）：
 *   1. 只在「第 3 次（最后一次免费额度）拍照成功」后触发一次；
 *   2. 每周最多显示 1 次；
 *   3. 用户可永久关闭（dismiss），关掉后不再出现。
 *
 * 状态存 kv（跨会话），键：upsell.dismissed（'1'=永久关闭）、upsell.lastWeek（周序号）。
 * 本模块只做「判定」，不碰 UI、不发请求；是否弹、怎么弹由调用方决定。
 */

import { kvGet, kvSet } from './kv'

/** 免费拍照额度（与 entitlement.ts 的 FREE_DAILY_AI 对齐） */
const FREE_DAILY_AI = 3

/** 当前「周序号」（跨年用 ISO 周年份+周号，避免元旦周重复误判） */
function isoWeekKey(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${week}`
}

/**
 * 判定是否应该显示升级轻提示。
 * @param pro 是否已是会员（会员不提示）
 * @param remaining 本次拍照后的剩余额度（-1 表示未知，仍按「已用完」处理）
 */
export async function shouldShowUpsell(pro: boolean, remaining: number | null): Promise<boolean> {
  if (pro) return false

  // 永久关闭
  const dismissed = (await kvGet('upsell.dismissed', '0')) === '1'
  if (dismissed) return false

  // 本周已显示过
  const week = isoWeekKey()
  const lastWeek = await kvGet('upsell.lastWeek', '')
  if (lastWeek === week) return false

  // 额度还剩则说明还没用完最后一次，不提示（等真正用完）
  // remaining === 0 或 null（未知）都视为已用完
  if (remaining !== null && remaining > 0) return false

  return true
}

/** 记录「本周已显示」 */
export async function markUpsellShown(): Promise<void> {
  await kvSet('upsell.lastWeek', isoWeekKey())
}

/** 记录「永久关闭」 */
export async function dismissUpsell(): Promise<void> {
  await kvSet('upsell.dismissed', '1')
}

export { FREE_DAILY_AI }
