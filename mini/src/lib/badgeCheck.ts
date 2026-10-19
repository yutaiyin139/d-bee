/**
 * 徽章批量检查器（对齐主工程 src/lib/badgeCheck.ts）。
 *
 * 12 枚徽章里，4 枚打卡里程碑徽章在首页已有独立触发；其余 8 枚
 * （photo_50 / scan_30 / recipe_3 / water_10 / exercise_20 / lose_3kg /
 *  invite_3 / invite_top）在此批量判定。
 *
 * 本模块一次性拉取 badge_stats() 统计快照，逐项比对阈值，达标即 unlockBadge。
 * 幂等：unlock_badge 内部 UNIQUE(owner_id, badge_key) 防重复，重复调用无副作用。
 *
 * 调用时机：打开蜜糖积分中心（invite 页）时触发一次。
 */

import { getBadgeStats, unlockBadge } from './api'

/** 徽章 key → 判定函数（输入统计快照，返回是否达标） */
const RULES: Record<string, (s: NonNullable<Awaited<ReturnType<typeof getBadgeStats>>>) => boolean> = {
  photo_50: (s) => s.photo_count >= 50,
  scan_30: (s) => s.barcode_count >= 30,
  recipe_3: (s) => s.recipe_count >= 3,
  water_10: (s) => s.water_days >= 10,
  exercise_20: (s) => s.exercise_count >= 20,
  lose_3kg: (s) => s.weight_lost >= 3,
  invite_3: (s) => s.invitees >= 3,
  invite_top: (s) => s.invite_settled >= 1,
}

/**
 * 检查并解锁所有统计类徽章。
 * @returns 本次新解锁的徽章 key 列表（供 UI 提示，可选）
 */
export async function checkStatBadges(): Promise<string[]> {
  const stats = await getBadgeStats()
  if (!stats) return []

  const unlocked: string[] = []
  // 串行而非并行：避免瞬时并发打云端，徽章数量少、串行耗时可忽略
  for (const [key, ok] of Object.entries(RULES)) {
    if (!ok(stats)) continue
    if (await unlockBadge(key)) unlocked.push(key)
  }
  return unlocked
}
