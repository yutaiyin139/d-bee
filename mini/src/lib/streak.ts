/**
 * 打卡体系（对齐主工程 src/lib/streak.ts）。
 * 某天有 ≥1 条饮食记录即算打卡；漏记可补打。
 */
import { shiftDate } from './nutrition'

export interface StreakInfo {
  current: number
  longest: number
  total: number
  nextMilestone: number | null
  activeToday: boolean
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

  let streak7Date: string | null = null
  if (current >= 7) {
    const start = shiftDate(cursor, 1) // 连续段起点（第一天）
    const weeks = Math.floor(current / 7) // 已满的完整周数
    streak7Date = shiftDate(start, weeks * 7 - 1) // 第 weeks×7 天的日期
  }

  const nextMilestone = MILESTONES.find((m) => m > current) ?? null

  return { current, longest: Math.max(longest, current), total, nextMilestone, activeToday, streak7Date }
}
