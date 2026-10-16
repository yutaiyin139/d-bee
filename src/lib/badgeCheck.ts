/**
 * 徽章批量检查器。
 *
 * 背景：12 枚徽章里，4 枚打卡里程碑徽章在 Dashboard 已有独立触发；其余 8 枚
 * （photo_50 / scan_30 / recipe_3 / water_10 / exercise_20 / lose_3kg /
 *  invite_3 / invite_top）原本是"死徽章"——定义了但没有触发代码。
 *
 * 本模块一次性拉取 badge_stats() 统计快照，逐项比对阈值，达标即 unlockBadge。
 * 幂等：unlock_badge 内部 UNIQUE(owner_id, badge_key) 防重复，重复调用无副作用。
 *
 * 调用时机：打开蜜糖积分中心（InviteCenter）时触发一次。放在这里而非 Dashboard
 * 每次加载，是为了避免高频页面每次进都多一次统计 RPC——徽章是低频荣誉，
 * 在用户主动查看成就时刷新一次足够。
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
