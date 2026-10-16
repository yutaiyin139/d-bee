/**
 * V1.5.0 变更点自测。
 *
 * 与 tools/validate-selftest.mjs 不同，本脚本**直接导入 src 下的真实模块**
 * （Node 22 的 --experimental-strip-types 可运行时剥离类型），
 * 不复制一份逻辑到测试里 —— 复制会让测试在源码改错时仍然通过。
 *
 * 运行：node --experimental-strip-types tools/v15-selftest.mjs
 */
import { zh, errText } from '../src/lib/errmsg.ts'
import { FREE_DAILY_AI as ENT_FREE, isPro, effectivePlan } from '../src/lib/entitlement.ts'
import {
  FREE_DAILY_AI as UPSELL_FREE,
  shouldShowUpsell,
  markUpsellShown,
  dismissUpsell,
} from '../src/lib/upsell.ts'

let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}
const eq = (label, actual, expected) =>
  assert(label, actual === expected, actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`)

const DAY = 86400000
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString()

/* ── 1) errmsg：英文报错中文化 ───────────────────────────────── */
console.log('\n[1] errmsg 错误文案中文化')
eq('网络层英文', zh('Failed to fetch', '兜底'), '网络连接失败，请检查网络后重试')
eq('登录过期英文', zh('JWT expired', '兜底'), '登录已过期，请重新登录')
eq('权限英文（带表名）', zh('permission denied for table meal_entries', '兜底'), '没有操作权限')
eq('RLS 英文', zh('new row violates row-level security policy', '兜底'), '没有操作权限')
eq('唯一约束英文', zh('duplicate key value violates unique constraint "x"', '兜底'), '该记录已存在')
eq('频控英文', zh('over_email_send_rate_limit', '兜底'), '操作过于频繁，请稍后再试')
eq('超时英文', zh('ETIMEDOUT', '兜底'), '网络超时，请稍后重试')
eq('5xx 英文', zh('502 Bad Gateway', '兜底'), '服务暂时不可用，请稍后重试')
eq('空串回落兜底', zh('', '保存失败'), '保存失败')
eq('null 回落兜底', zh(null, '保存失败'), '保存失败')
eq('中文原样透传', zh('照片太模糊，请重新拍一张', '兜底'), '照片太模糊，请重新拍一张')
eq('未知英文回落兜底', zh('some totally unknown english', '识别失败，请重试'), '识别失败，请重试')
eq('errText(Error)', errText(new Error('Failed to fetch'), '兜底'), '网络连接失败，请检查网络后重试')
eq('errText(string)', errText('JWT expired', '兜底'), '登录已过期，请重新登录')
eq('errText(null)', errText(null, '兜底'), '兜底')
eq('errText(非 Error 对象)', errText({ a: 1 }, '兜底'), '兜底')

/* ── 2) entitlement：会员判定边界 ───────────────────────────── */
console.log('\n[2] entitlement 会员判定边界')
eq('null → 非会员', isPro(null), false)
eq('free → 非会员', isPro({ plan: 'free', pro_until: null }), false)
eq('lifetime（pro_until=null）→ 会员', isPro({ plan: 'lifetime', pro_until: null }), true)
eq('pro + 未来到期 → 会员', isPro({ plan: 'pro', pro_until: iso(10) }), true)
eq('pro + 已过期 → 非会员', isPro({ plan: 'pro', pro_until: iso(-1) }), false)
// 本次修复的核心：pro 档缺 pro_until 一律按已过期，不能再判成永久会员（收入漏洞）
eq('pro + pro_until=null → 非会员（本次修复）', isPro({ plan: 'pro', pro_until: null }), false)
eq('pro + pro_until=空串 → 非会员', isPro({ plan: 'pro', pro_until: '' }), false)
eq('effectivePlan: pro 已过期回落 free', effectivePlan({ plan: 'pro', pro_until: iso(-3) }), 'free')
eq('effectivePlan: pro 缺到期回落 free', effectivePlan({ plan: 'pro', pro_until: null }), 'free')
eq('effectivePlan: lifetime', effectivePlan({ plan: 'lifetime', pro_until: null }), 'lifetime')

/* ── 3) upsell：转化钩子判定（修复后才会真正触发）──────────── */
console.log('\n[3] upsell 转化钩子判定')
eq('免费额度常量与 entitlement 对齐', UPSELL_FREE, ENT_FREE)
eq('会员不提示', await shouldShowUpsell(true, 0), false)
eq('还有额度不提示', await shouldShowUpsell(false, 1), false)
eq('刚用尽最后一次 → 提示（本次修复的触发路径）', await shouldShowUpsell(false, 0), true)
await markUpsellShown()
eq('同周已提示过 → 不再提示', await shouldShowUpsell(false, 0), false)
await dismissUpsell()
eq('永久关闭后 → 不再提示', await shouldShowUpsell(false, 0), false)
eq('永久关闭对会员/非会员一致生效', await shouldShowUpsell(false, null), false)

/* ── 汇总 ───────────────────────────────────────────────────── */
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
