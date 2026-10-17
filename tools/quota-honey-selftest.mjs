/**
 * 拍照阶梯 + 蜜糖积分 + 反复拍照判定逻辑自测。
 *
 * 直接 import 真实 TS 模块（经 esbuild 打包运行，见 quota-honey-selftest.run.mjs），
 * 覆盖：单日拍照次数阶梯分流 / 积分兑换边界 / 反复拍照判定 / 时间格式化 / 打卡积分。
 *
 * 运行：node tools/quota-honey-selftest.run.mjs
 */
import {
  photoLadderHint,
  isDuplicatePhoto,
  summarizePhoto,
  FREE_DAILY_AI,
  LADDER_REDEEM_MIN,
  LADDER_REDEEM_MAX,
  LADDER_PRO_START,
} from '../src/lib/photoGuard'
import { formatHoneyTime, honeyCost, dailyCheckinHoney, streakMilestoneHoney, CHECKIN_DAILY_CAP } from '../src/lib/invite'

let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

console.log('== 阶梯常量 ==')
assert('基础=3', FREE_DAILY_AI === 3)
assert('兑换窗口=4~5', LADDER_REDEEM_MIN === 4 && LADDER_REDEEM_MAX === 5)
assert('Pro 起点=6', LADDER_PRO_START === 6)

console.log('== 第 1~3 次：基础免费（kind=none）==')
assert('第1次(todayCount=0)', photoLadderHint(0, 0).kind === 'none' && photoLadderHint(0, 0).nth === 1)
assert('第2次(todayCount=1)', photoLadderHint(1, 0).kind === 'none' && photoLadderHint(1, 0).nth === 2)
assert('第3次(todayCount=2)', photoLadderHint(2, 999).kind === 'none' && photoLadderHint(2, 999).nth === 3)

console.log('== 第 4~5 次：有积分 redeem / 无积分 inviteOrPro ==')
assert('第4次有积分50 → redeem', photoLadderHint(3, 50).kind === 'redeem' && photoLadderHint(3, 50).nth === 4)
assert('第4次 redeemCount=1', photoLadderHint(3, 50).redeemCount === 1)
assert('第5次有积分149 → redeem 2次', photoLadderHint(4, 149).kind === 'redeem' && photoLadderHint(4, 149).redeemCount === 2)
assert('第4次无积分0 → inviteOrPro', photoLadderHint(3, 0).kind === 'inviteOrPro')
assert('第4次积分49(<50) → inviteOrPro', photoLadderHint(3, 49).kind === 'inviteOrPro')
assert('第5次无积分 → inviteOrPro', photoLadderHint(4, 0).kind === 'inviteOrPro')

console.log('== 第 ≥6 次：直接 Pro（即使有积分）==')
assert('第6次有积分999 → pro', photoLadderHint(5, 999).kind === 'pro' && photoLadderHint(5, 999).nth === 6)
assert('第6次无积分 → pro', photoLadderHint(5, 0).kind === 'pro')
assert('第8次 → pro', photoLadderHint(7, 500).kind === 'pro')

console.log('== 反复拍照判定（食物名重合≥70% 且热量差≤10%）==')
const a = { names: ['米饭', '红烧肉', '青菜'], totalKcal: 600 }
const b = { names: ['米饭', '红烧肉', '青菜'], totalKcal: 620 } // 完全一致，热量差3%
assert('完全一致 → 重复', isDuplicatePhoto(a, b) === true)
const c = { names: ['米饭', '红烧肉', '青菜'], totalKcal: 720 } // 名一致但热量差20%
assert('名一致但热量差20% → 不重复', isDuplicatePhoto(a, c) === false)
const d = { names: ['米饭', '红烧肉'], totalKcal: 600 } // 名2/3重合≈67%<70%
assert('名重合67%<70% → 不重复', isDuplicatePhoto(a, d) === false)
const e = { names: ['米饭', '红烧肉', '青菜', '汤'], totalKcal: 610 } // 3/4=75%≥70%，热量差2%
assert('名重合75% 热量差2% → 重复', isDuplicatePhoto(a, e) === true)
assert('两次都无食物名 → 不重复', isDuplicatePhoto({ names: [], totalKcal: 0 }, { names: [], totalKcal: 0 }) === false)

console.log('== summarizePhoto 汇总 ==')
const s = summarizePhoto([
  { food_name: '米饭', kcalPerG: 1.2, grams: 200 },
  { food_name: '红烧肉', kcalPerG: 2.5, grams: 150 },
])
assert('总热量=1.2*200+2.5*150=615', Math.round(s.totalKcal) === 615, `实得 ${s.totalKcal}`)
assert('食物名2个', s.names.length === 2)

console.log('== 兑换价格 / 打卡积分 / 里程碑 / 时间格式化 ==')
assert('ai1Scan=50', honeyCost('ai1Scan') === 50)
assert('打卡全达成=9', dailyCheckinHoney({ mealCount: 1, waterMl: 2000, waterTargetMl: 2000, exerciseCount: 1 }).total === 9)
assert('封顶=9', CHECKIN_DAILY_CAP === 9)
assert('里程碑7天=40', streakMilestoneHoney(7) === 40)
assert('时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatHoneyTime('2026-10-16T12:25:07.515855+08:00')))
assert('时间null→空', formatHoneyTime(null) === '')

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 个失败'}`)
process.exit(failed > 0 ? 1 : 0)
