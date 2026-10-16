/**
 * 蜜糖积分规则引擎自测（独立 .mjs，不 import TS，逻辑与 src/lib/invite.ts 逐行一致）。
 */
let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

// ── 与 src/lib/invite.ts 逐行一致的纯函数 ─────────────────────────
const CHECKIN_MEAL = 5
const CHECKIN_WATER = 2
const CHECKIN_EXERCISE = 2
const CHECKIN_DAILY_CAP = 9

const STREAK_HONEY = { 3: 15, 7: 40, 14: 80, 21: 120, 30: 200, 60: 400, 100: 800 }

const INVITEE_REGISTER = 100
const INVITEE_CHECKIN = 200
const INVITER_REGISTER = 50
const INVITER_CHECKIN = 250
const INVITE_CHECKIN_DAYS = 7
const INVITE_CHECKIN_MIN = 5

const HONEY_PRICE = { pro1Day: 100, pro30Day: 2600, ai1Scan: 50 }
const MAX_MONTHLY_INVITE_HONEY = 3000

function shiftDate(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d + delta)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}

function checkinMealDone(c) { return c >= 1 }
function checkinWaterDone(ml, t) { return t > 0 && ml >= t }
function checkinExerciseDone(c) { return c >= 1 }

function dailyCheckinHoney(o) {
  const meal = checkinMealDone(o.mealCount) ? CHECKIN_MEAL : 0
  const water = checkinWaterDone(o.waterMl, o.waterTargetMl) ? CHECKIN_WATER : 0
  const exercise = checkinExerciseDone(o.exerciseCount) ? CHECKIN_EXERCISE : 0
  return { meal, water, exercise, total: meal + water + exercise }
}

function streakMilestoneHoney(d) { return STREAK_HONEY[d] ?? 0 }

function inviteCheckinDone(invitedDate, loggedDates) {
  if (!invitedDate) return false
  const set = new Set(loggedDates)
  let count = 0
  for (let i = 0; i < INVITE_CHECKIN_DAYS; i++) {
    if (set.has(shiftDate(invitedDate, i))) count++
  }
  return count >= INVITE_CHECKIN_MIN
}

function honeyCost(k) { return HONEY_PRICE[k] }
function monthlyInviteCapOk(cur, amount) { return cur + amount <= MAX_MONTHLY_INVITE_HONEY }

// ── 断言 ──────────────────────────────────────────────────────
console.log('== 每日打卡积分 ==')
let r = dailyCheckinHoney({ mealCount: 1, waterMl: 2000, waterTargetMl: 2000, exerciseCount: 1 })
assert('记餐+饮水+运动全达成 = 9 分', r.total === 9 && r.meal === 5 && r.water === 2 && r.exercise === 2, `实得 ${r.total}`)
r = dailyCheckinHoney({ mealCount: 0, waterMl: 0, waterTargetMl: 2000, exerciseCount: 0 })
assert('全未达成 = 0 分', r.total === 0)
r = dailyCheckinHoney({ mealCount: 3, waterMl: 1500, waterTargetMl: 2000, exerciseCount: 1 })
assert('记3餐也只算5分、饮水未达标=0、运动=2 → 7分', r.total === 7 && r.meal === 5 && r.water === 0 && r.exercise === 2, `实得 ${r.total}`)
assert('每日封顶常量 = 9', CHECKIN_DAILY_CAP === 9)

console.log('== 连续打卡里程碑积分 ==')
assert('3天=15', streakMilestoneHoney(3) === 15)
assert('7天=40', streakMilestoneHoney(7) === 40)
assert('100天=800', streakMilestoneHoney(100) === 800)
assert('5天(非里程碑)=0', streakMilestoneHoney(5) === 0)

console.log('== 邀约达标判定（7日累计≥5天）==')
const invited = '2026-10-01'
assert('7日内5天 → 达标', inviteCheckinDone(invited, ['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05']) === true)
assert('7日内4天 → 未达标', inviteCheckinDone(invited, ['2026-10-01','2026-10-02','2026-10-03','2026-10-04']) === false)
assert('第8天(超窗口)不计 → 未达标', inviteCheckinDone(invited, ['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-08']) === false)
assert('无受邀日期 → 未达标', inviteCheckinDone('', ['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05']) === false)

console.log('== 兑换价格 ==')
assert('Pro 1 天 = 100', honeyCost('pro1Day') === 100)
assert('Pro 30 天 = 2600', honeyCost('pro30Day') === 2600)
assert('AI 1 次 = 50', honeyCost('ai1Scan') === 50)

console.log('== 月度返佣上限 ==')
assert('未超限', monthlyInviteCapOk(2700, 250) === true)
assert('超限', monthlyInviteCapOk(2900, 250) === false)

console.log('== 邀约奖励常量 ==')
assert('新人100/达标200/邀请人50/邀请人250',
  INVITEE_REGISTER === 100 && INVITEE_CHECKIN === 200 && INVITER_REGISTER === 50 && INVITER_CHECKIN === 250)

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 个失败'}`)
process.exit(failed > 0 ? 1 : 0)
