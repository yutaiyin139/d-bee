import { shiftDate } from './nutrition'

/**
 * 打卡体系：某天有 ≥1 条饮食记录即算打卡。
 * 「漏记可补打」：用户随时可以把日期切回去补记（今日页的日期切换已支持），
 * 因此这里只看事实数据，不要求按时间顺序。
 */

export interface StreakInfo {
  /** 连续打卡天数（今天没记则从昨天起算，段位保留到今天结束） */
  current: number
  /** 历史最长连续 */
  longest: number
  /** 累计打卡天数 */
  total: number
  /** 下一个里程碑（3/7/14/21/30/60/100），已达成全部则返回 null */
  nextMilestone: number | null
  /** 当前连续是否包含今天 */
  activeToday: boolean
  /** 当前连续段达到第 7 天时的日期（YYYY-MM-DD）；当前连续不足 7 天则 null。
   *  用于「连续打卡 7 天奖励」的去重：同一连续段的第 7 天日期固定，断签重来才会变。 */
  streak7Date: string | null
}

export const MILESTONES = [3, 7, 14, 21, 30, 60, 100]

export function computeStreak(loggedDates: string[], today: string): StreakInfo {
  const set = new Set(loggedDates)
  const sorted = [...set].sort()
  const total = set.size

  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const d of sorted) {
    run = prev !== null && shiftDate(prev, 1) === d ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = d
  }

  const activeToday = set.has(today)
  let current = 0
  let cursor = activeToday ? today : shiftDate(today, -1)
  while (set.has(cursor)) {
    current += 1
    cursor = shiftDate(cursor, -1)
  }

  // 当前连续段的第 7 天日期：从连续段起点（cursor 的下一天）往后推 6 天
  let streak7Date: string | null = null
  if (current >= 7) {
    const start = shiftDate(cursor, 1)
    streak7Date = shiftDate(start, 6)
  }

  const nextMilestone = MILESTONES.find((m) => m > current) ?? null

  return { current, longest: Math.max(longest, current), total, nextMilestone, activeToday, streak7Date }
}
