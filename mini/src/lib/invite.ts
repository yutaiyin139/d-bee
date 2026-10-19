/**
 * 蜜糖积分常量与工具（对齐主工程 src/lib/invite.ts）。
 * HONEY_PRICE 直接从 @dbee/shared 单一真相源 re-export。
 */
import { shiftDate } from './nutrition'
import { HONEY_PRICE, type HoneyRewardKind } from '@dbee/shared'

export { HONEY_PRICE } from '@dbee/shared'
export type { HoneyRewardKind } from '@dbee/shared'

/* ── 每日打卡积分 ── */

export const CHECKIN_MEAL = 5
export const CHECKIN_WATER = 2
export const CHECKIN_EXERCISE = 2
export const CHECKIN_DAILY_CAP = 9

/* ── 连续打卡里程碑积分（与 streak.ts 的 MILESTONES 对齐）── */

export const STREAK_HONEY: Record<number, number> = {
  3: 15,
  7: 40,
  14: 80,
  21: 120,
  30: 200,
  60: 400,
  100: 800,
}

/* ── 邀约奖励 ── */

export const INVITEE_REGISTER = 100
export const INVITEE_CHECKIN = 200
export const INVITER_REGISTER = 50
export const INVITER_CHECKIN = 250
export const INVITE_CHECKIN_DAYS = 7
export const INVITE_CHECKIN_MIN = 5
export const INVITEE_PRO_DAYS = 7
export const MAX_MONTHLY_INVITE_HONEY = 3000

/* ── 积分流水原因标签（对齐 InviteCenter 的 REASON_LABEL）── */

export const REASON_LABEL: Record<string, string> = {
  checkin_meal: '记一餐',
  checkin_water: '饮水达标',
  checkin_exercise: '记录运动',
  streak_milestone: '连续打卡里程碑',
  invitee_register: '注册奖励',
  invitee_checkin: '打卡达标奖励',
  inviter_register: '邀请好友注册',
  inviter_checkin: '好友打卡达标',
  redeem: '兑换消耗',
  expire: '积分过期',
  refund: '删除记录收回',
}

/* ── 判定函数 ── */

export function checkinMealDone(mealCount: number): boolean {
  return mealCount >= 1
}

export function checkinWaterDone(waterMl: number, targetMl: number): boolean {
  return targetMl > 0 && waterMl >= targetMl
}

export function checkinExerciseDone(exerciseCount: number): boolean {
  return exerciseCount >= 1
}

export function dailyCheckinHoney(opts: {
  mealCount: number
  waterMl: number
  waterTargetMl: number
  exerciseCount: number
}): { meal: number; water: number; exercise: number; total: number } {
  const meal = checkinMealDone(opts.mealCount) ? CHECKIN_MEAL : 0
  const water = checkinWaterDone(opts.waterMl, opts.waterTargetMl) ? CHECKIN_WATER : 0
  const exercise = checkinExerciseDone(opts.exerciseCount) ? CHECKIN_EXERCISE : 0
  return { meal, water, exercise, total: meal + water + exercise }
}

export function streakMilestoneHoney(streakDays: number): number {
  return STREAK_HONEY[streakDays] ?? 0
}

/**
 * 邀约「7 日内累计 ≥5 天打卡」判定。
 * @param invitedDate 受邀（注册）日期 YYYY-MM-DD
 * @param loggedDates 该用户有饮食记录的日期集合
 */
export function inviteCheckinDone(invitedDate: string, loggedDates: string[]): boolean {
  if (!invitedDate) return false
  const set = new Set(loggedDates)
  let count = 0
  for (let i = 0; i < INVITE_CHECKIN_DAYS; i++) {
    const d = shiftDate(invitedDate, i)
    if (set.has(d)) count++
  }
  return count >= INVITE_CHECKIN_MIN
}

/** 兑换：根据种类返回消耗的积分与对应权益 */
export function honeyCost(kind: HoneyRewardKind): number {
  return HONEY_PRICE[kind]
}

/**
 * 月度邀请返佣上限校验：给定本月已累计的邀请返佣积分，判断再发 amount 是否超限。
 */
export function monthlyInviteCapOk(currentMonthlyHoney: number, amount: number): boolean {
  return currentMonthlyHoney + amount <= MAX_MONTHLY_INVITE_HONEY
}

/**
 * 积分流水时间格式化：ISO 时间 → 本地 `YYYY-MM-DD HH:mm`。
 */
export function formatHoneyTime(ts: string | number | null | undefined): string {
  if (ts == null || ts === '') return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}
