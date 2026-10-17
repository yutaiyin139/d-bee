import { shiftDate } from './nutrition'

/**
 * 邀约拉新 + 蜜糖积分规则引擎（纯函数，便于测试与复用）。
 *
 * 三条积分来源统一走 honey_ledger（见 api.ts 的 grantHoney）：
 *   1. 每日打卡（记餐/饮水/运动）
 *   2. 邀约（注册 + 7 日打卡达标，双向）
 *   3. 连续打卡里程碑（与 streak 里程碑联动）
 *
 * 本文件只做「判定与计算」，不碰数据库、不发请求。
 */

/* ── 每日打卡积分 ── */

export const CHECKIN_MEAL = 5 // 当日 ≥1 条饮食记录
export const CHECKIN_WATER = 2 // 当日饮水达标
export const CHECKIN_EXERCISE = 2 // 当日运动 ≥1 次
export const CHECKIN_DAILY_CAP = 9 // 每日封顶 5+2+2

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

export const INVITEE_REGISTER = 100 // 新人注册填码
export const INVITEE_CHECKIN = 200 // 新人 7 日内打卡 ≥5 天
export const INVITER_REGISTER = 50 // 邀请人：好友注册
export const INVITER_CHECKIN = 250 // 邀请人：好友 7 日达标

/** 邀约达标：受邀后 7 个自然日内、累计 ≥5 天有饮食记录 */
export const INVITE_CHECKIN_DAYS = 7
export const INVITE_CHECKIN_MIN = 5

/** 新人达标奖励附带的 Pro 天数 */
export const INVITEE_PRO_DAYS = 7

/** 单人月度邀请返佣积分上限（风控） */
export const MAX_MONTHLY_INVITE_HONEY = 3000

/* ── 兑换价格表 ── */

export const HONEY_PRICE = {
  pro1Day: 100, // 100 分 = Pro 1 天
  pro30Day: 2600, // 2600 分 = Pro 30 天
  ai1Scan: 50, // 50 分 = AI 拍照 1 次
} as const

export type HoneyRewardKind = 'pro1Day' | 'pro30Day' | 'ai1Scan'

/* ── 判定函数 ── */

/** 当日是否达成「记餐」打卡（有 ≥1 条饮食记录） */
export function checkinMealDone(mealCount: number): boolean {
  return mealCount >= 1
}

/** 当日是否达成「饮水」打卡 */
export function checkinWaterDone(waterMl: number, targetMl: number): boolean {
  return targetMl > 0 && waterMl >= targetMl
}

/** 当日是否达成「运动」打卡 */
export function checkinExerciseDone(exerciseCount: number): boolean {
  return exerciseCount >= 1
}

/**
 * 计算当日应得的打卡积分（记餐/饮水/运动三项之和，封顶 CHECKIN_DAILY_CAP）。
 * 返回每项是否达成 + 合计，供调用方逐项 grant（ref_id 区分）。
 */
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

/** 连续打卡天数对应的里程碑积分；未命中里程碑返回 0 */
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
 * 入参可能为 ISO 字符串、时间戳或空；异常/缺失时返回空串，不抛错。
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
