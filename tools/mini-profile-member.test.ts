/**
 * 「会员状态」四端一致性回归测试（2026-11-03）。
 *
 * 起因：用户要求「四个端的业务逻辑、收费用户及免费逻辑必须一致」。审计发现会员
 * 相关的展示文案在两端各写了一份、且已经分叉：
 *
 *   ① mini/src/pages/profile/profile.tsx 的会员状态**完全是假的**：
 *      `const [pro, setPro] = useState(false)` / `lifetime` 声明后从未赋值，也没
 *      import getEntitlement → 付费用户在「我的」页永远显示「免费版」+「升级」按钮；
 *      免费档还把剩余拍照次数**硬编码成 3**（真实额度可能是 0）。
 *   ② 「有效期至 X」这句在两端共 3 处直接调 `new Date(iso).toLocaleDateString('zh-CN')`
 *      （主端 ProfileScreen:425 / PaywallSheet:253、mini paywall:140），而
 *      toLocaleDateString 的输出由各端 JS 引擎的 ICU/locale 数据决定 ——
 *      web/iOS/Android 与微信小程序并不同步，同一到期日可能给出不同文案。
 *      那不是「一致」而是「碰巧一致」。
 *   ③ 付费墙顶部「你已是 Pro 会员」整句在两端各写一份逐字相同的副本。
 *
 * 修复方式：全部下沉到 @dbee/shared，两端调**同一个函数**（不是两份需人工对齐的副本）：
 *   · formatCnDate / proUntilText / proNoticeText —— packages/shared/src/datefmt.ts
 *   · memberSubText                               —— packages/shared/src/rules/index.ts
 *
 * 本测试直接 import 这些真实实现来测（而非在测试里复刻一份逻辑），确保测的就是线上跑的代码。
 *
 * 🔴 关于时区：formatCnDate 取**本地**年月日（不是 UTC）。为让断言在任何机器时区
 *   （本地 Asia/Shanghai、CI 可能 UTC）都成立，本文件**不硬编码具体日期结果**，而是断言
 *   「formatCnDate(iso) === 用同一个 Date 的 getFullYear/getMonth/getDate 拼出的串」——
 *   这个等式本身就精确编码了「用本地 getter、不用 getUTC*、不补零」的契约，且恒真于所有时区。
 *   另配一条与 `toLocaleDateString('zh-CN')` 的对拍（仅 full-ICU 环境跑）锁定输出形状。
 *
 * 🔴 关于分隔符：见 SEP 常量注释 —— 是正斜杠不是横线，且本文件所有涉及它的断言都用
 *   SEP 拼接，不手输字面量（手输会被肉眼误判，本文件初版就这么错过一次）。
 *
 * 运行：npx vitest run tools/mini-profile-member.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  FREE_REPORT_DAYS,
  formatCnDate,
  proUntilText,
  proNoticeText,
  memberSubText,
  isPro,
  type Entitlement,
} from '@dbee/shared'

/**
 * 日期分隔符 = **正斜杠 `/`（U+002F, charCode 47）**，用 fromCharCode 构造而非手输字面量。
 *
 * ⚠️ 2026-11-03 实测踩坑：终端字体把 `/` 渲染得几乎和 `-` 一样，肉眼读
 * `toLocaleDateString('zh-CN')` 的输出会误判成「横线分隔」，进而写出错误的硬编码期望值、
 * 甚至按横线改实现（那会把主端线上文案从 `2026/11/30` 变成 `2026-11-30`，
 * 一次没人要求过的 UI 变更）。凡涉及这个字符的判断，一律用 charCode 定论：
 *   new Date('2026-11-30T12:00:00+08:00').toLocaleDateString('zh-CN').charCodeAt(4) === 47
 */
const SEP = String.fromCharCode(47)

/** 用与实现相同的本地 getter 拼出期望串（TZ 无关的真值来源） */
function localParts(d: Date): string {
  return `${d.getFullYear()}${SEP}${d.getMonth() + 1}${SEP}${d.getDate()}`
}

/** 是否 full-ICU（zh-CN 能被正确解析）；small-icu 的 Node 会退回 en-US，跳过对拍 */
const FULL_ICU = (() => {
  try {
    return new Intl.DateTimeFormat('zh-CN').resolvedOptions().locale === 'zh-CN'
  } catch {
    return false
  }
})()

describe('formatCnDate：本地日期、正斜杠分隔、月日不补零', () => {
  const samples = [
    '2026-11-30T12:00:00+08:00', // 常规
    '2026-01-05T12:00:00+08:00', // 个位月日（验证不补零）
    '2026-11-30T23:59:59+08:00',
    '2027-12-31T18:30:00+08:00',
    '2026-02-28T09:00:00+08:00',
    '2026-11-30T00:30:00+08:00', // 跨日边界：北京 11-30 00:30 = UTC 11-29 16:30
    '2026-11-30T12:00:00Z',
    '2026-11-30 23:59:59', // DB 常见空格分隔
    '2026-11-30', // 纯日期串（按 UTC 解析，见实现注释③）
  ]

  it('分隔符确实是正斜杠（charCode 47），不是横线', () => {
    // 这条是「肉眼误判」的永久护栏：断言用 charCode，不用字面量比较
    const got = formatCnDate('2026-11-30T12:00:00+08:00')!
    expect(got.charCodeAt(4)).toBe(47)
    expect(got.charCodeAt(7)).toBe(47)
    expect(got.includes(String.fromCharCode(45))).toBe(false)
  })

  it('输出等于本地 getter 拼串（即：取本地日期、不补零、斜杠分隔）', () => {
    for (const iso of samples) {
      expect(formatCnDate(iso), iso).toBe(localParts(new Date(iso)))
    }
  })

  it('形状契约：YYYY/M/D，年 4 位、月日无前导零', () => {
    for (const iso of samples) {
      const got = formatCnDate(iso)!
      expect(got, iso).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/)
      const [y, m, day] = got.split(SEP)
      const d = new Date(iso)
      expect(y, `${iso} 年`).toBe(String(d.getFullYear()))
      expect(m, `${iso} 月不应补零`).toBe(String(d.getMonth() + 1))
      expect(day, `${iso} 日不应补零`).toBe(String(d.getDate()))
    }
  })

  it('跨日边界用本地日期，绝不因 UTC 偏移少一天', () => {
    // 北京时间 11-30 00:30 = UTC 11-29 16:30。若误用 toISOString/getUTCDate 会得 11-29，
    // 比真实到期日少一天 → 用户少一天会员。
    const iso = '2026-11-30T00:30:00+08:00'
    const d = new Date(iso)
    expect(formatCnDate(iso)).toBe(localParts(d))
    // 在 UTC 以东的时区（如 Asia/Shanghai），本地日 ≠ UTC 日，此时可正面证明没用 UTC；
    // 在 UTC/以西的时区两者可能相等，跳过这半段（不是失败，只是无从区分）。
    if (d.getTimezoneOffset() < 0 && d.getDate() !== d.getUTCDate()) {
      expect(formatCnDate(iso)!.split(SEP)[2]).toBe(String(d.getDate()))
      expect(formatCnDate(iso)!.split(SEP)[2]).not.toBe(String(d.getUTCDate()))
    }
  })

  it.runIf(FULL_ICU)('与 Node full-ICU 的 toLocaleDateString("zh-CN") 逐字对拍', () => {
    // 这条锁定「线上展示零变化」：新实现必须与主端改动前的输出逐字相同
    for (const iso of samples) {
      expect(formatCnDate(iso), iso).toBe(new Date(iso).toLocaleDateString('zh-CN'))
    }
  })

  it('非法输入返回 null（不产出 "NaN/NaN/NaN"）', () => {
    expect(formatCnDate('not-a-date')).toBeNull()
    expect(formatCnDate('garbage')).toBeNull()
  })

  it('🔴 null/undefined/空串返回 null —— 绝不返回 1970/1/1', () => {
    // 实测踩到的真坑：new Date(null) 不报错而返回 epoch(1970-01-01)，
    // new Date(undefined) 才是 Invalid Date。pro_until 对 lifetime 用户恒为 null，
    // 少了这道守卫就会在「我的」页显示「有效期至 1970/1/1」。
    expect(formatCnDate(null)).toBeNull()
    expect(formatCnDate(undefined)).toBeNull()
    expect(formatCnDate('')).toBeNull()
    expect(formatCnDate('   ')).toBeNull()
    // 反证：不加守卫的话 new Date(null) 是合法的 epoch，会拼出一个「看起来正常」的日期
    expect(Number.isNaN(new Date(null as unknown as string).getTime())).toBe(false)
  })

  it('非字符串入参（防御运行时脏数据）返回 null', () => {
    expect(formatCnDate(null as unknown as string)).toBeNull()
    expect(formatCnDate(12345 as unknown as string)).toBeNull()
    expect(formatCnDate({} as unknown as string)).toBeNull()
  })
})

describe('proUntilText：「有效期至 X」整句 + null 回退', () => {
  const iso = '2026-12-31T23:59:59+08:00'

  it('有 pro_until → 有效期至 YYYY/M/D', () => {
    expect(proUntilText(iso)).toBe(`有效期至 2026${SEP}12${SEP}31`)
  })

  it('pro_until 为 null → 回退通用文案，不显示 "有效期至 null"', () => {
    expect(proUntilText(null)).toBe('全部功能已解锁')
  })

  it('pro_until 非法 → 同样回退', () => {
    expect(proUntilText('garbage')).toBe('全部功能已解锁')
  })

  it('支持自定义回退文案', () => {
    expect(proUntilText(null, '会员已到期')).toBe('会员已到期')
  })
})

describe('proNoticeText：付费墙顶部提示整句（两端共用）', () => {
  const iso = '2026-12-31T23:59:59+08:00'

  it('有 pro_until → 带有效期', () => {
    expect(proNoticeText(iso)).toBe(`你已是 Pro 会员，有效期至 2026${SEP}12${SEP}31。`)
  })

  it('pro_until 缺失 → 通用解锁文案（不显示 null）', () => {
    expect(proNoticeText(null)).toBe('你已是 Pro 会员，所有功能已解锁。')
  })

  it('pro_until 非法 → 通用解锁文案', () => {
    expect(proNoticeText('garbage')).toBe('你已是 Pro 会员，所有功能已解锁。')
  })

  it.runIf(FULL_ICU)('与主端改动前的整句逐字一致（线上零变化）', () => {
    // 主端 PaywallSheet.tsx 改动前的写法（直接 toLocaleDateString），用于锁定线上零变化
    const legacy = `你已是 Pro 会员，有效期至 ${new Date(iso).toLocaleDateString('zh-CN')}。`
    expect(proNoticeText(iso)).toBe(legacy)
  })
})

describe('memberSubText：会员状态副标题四档（两端同一函数）', () => {
  // 用远期日期，避免测试随时间推移自然失效（2026-12-31 到期后 isPro 会变 false）
  const FUTURE = '2999-12-31T23:59:59+08:00'
  const PAST = '2000-01-01T00:00:00+08:00'

  const lifetimeWithCode: Entitlement = { plan: 'lifetime', pro_until: null, redeemed_code: 'DBEE-2026' }
  const lifetimeNoCode: Entitlement = { plan: 'lifetime', pro_until: null, redeemed_code: null }
  const proEnt: Entitlement = { plan: 'pro', pro_until: FUTURE, redeemed_code: null }
  const free: Entitlement = { plan: 'free', pro_until: null, redeemed_code: null }

  const days = FREE_REPORT_DAYS

  it('终身会员 + 兑换码 → 显示兑换码', () => {
    expect(memberSubText(lifetimeWithCode, null)).toBe('已通过兑换码 DBEE-2026 永久解锁')
  })

  it('终身会员无兑换码（如内购）→ 通用文案', () => {
    expect(memberSubText(lifetimeNoCode, null)).toBe('全部功能已永久解锁')
  })

  it('终身会员不受 pro_until 影响（其 pro_until 恒为 null）', () => {
    expect(memberSubText(lifetimeWithCode, null)).toBe('已通过兑换码 DBEE-2026 永久解锁')
  })

  it('Pro 未过期 → 有效期至 X', () => {
    expect(memberSubText(proEnt, null)).toBe(`有效期至 ${formatCnDate(FUTURE)}`)
    expect(isPro(proEnt)).toBe(true)
  })

  it('🔴 plan=pro 但 pro_until 为 null → isPro 判为已过期，回落免费档', () => {
    // 这是 rules/index.ts:100 的明确产品行为：「订阅档必须带有效 pro_until 才判为会员；
    // 缺失按『已过期』处理」。所以本函数的 pro 分支**走不到**，输出免费档文案 ——
    // 这是对的：一个没有到期日的订阅无法证明仍然有效，按免费档展示不会给用户
    // 一个「永久 Pro」的错觉。（本文件初版误把这里断言成「全部功能已解锁」，
    // 那是断言错、不是代码错。）
    const noUntil: Entitlement = { plan: 'pro', pro_until: null, redeemed_code: null }
    expect(isPro(noUntil)).toBe(false)
    expect(memberSubText(noUntil, 2)).toBe(`今日剩拍照 2 次 · 报告看近 ${days} 天`)
  })

  it('🔴 plan=pro 但已过期 → 同样回落免费档（服务端到期回落的前端兜底）', () => {
    const expired: Entitlement = { plan: 'pro', pro_until: PAST, redeemed_code: null }
    expect(isPro(expired)).toBe(false)
    expect(memberSubText(expired, 1)).toBe(`今日剩拍照 1 次 · 报告看近 ${days} 天`)
  })

  it('entitlement 为 null（读不到权益）→ 按免费档，额度未知不谎报', () => {
    expect(memberSubText(null, null)).toBe(`今日拍照额度暂时读不到 · 报告看近 ${days} 天`)
  })

  it('免费档：显示真实剩余额度（不再硬编码 3）', () => {
    expect(memberSubText(free, 1)).toBe(`今日剩拍照 1 次 · 报告看近 ${days} 天`)
  })

  it('免费档额度用完：如实显示 0 次', () => {
    // 旧 mini 代码这里永远显示「3 次」→ 用户点拍照被拒，是本 bug 最直接的体感
    expect(memberSubText(free, 0)).toBe(`今日剩拍照 0 次 · 报告看近 ${days} 天`)
  })

  it('免费档额度未知（null/undefined，含 mini 的 degraded 场景）：不谎报数字', () => {
    // mini getPhotoQuota 失败时 degraded=true，调用方传 aiRemaining=null。
    // 此时显示任何数字都是谎报（用户会据此以为还能拍照，实际会被 fail-closed 拒绝）。
    expect(memberSubText(free, null)).toBe(`今日拍照额度暂时读不到 · 报告看近 ${days} 天`)
    expect(memberSubText(free, undefined)).toBe(`今日拍照额度暂时读不到 · 报告看近 ${days} 天`)
  })

  it('报告天数走常量插值（第三参可覆盖），不硬编码 7', () => {
    expect(memberSubText(free, 2, 30)).toBe('今日剩拍照 2 次 · 报告看近 30 天')
  })

  it('主端口径回归：非 Pro 且额度为数字时，与旧 `${aiRemaining ?? 0}` 输出逐字一致', () => {
    // 主端 usePlan 的 aiRemaining 非 Pro 时恒为数字（plan.tsx:127 = pro ? null : Math.max(0, total)，
    // 且 photoQuota 各分支都设了 total 数字），故下沉后输出必须与改动前
    // `今日剩拍照 ${aiRemaining ?? 0} 次 · 报告看近 ${FREE_REPORT_DAYS} 天` 完全相同。
    for (const n of [0, 1, 2, 3]) {
      expect(memberSubText(free, n)).toBe(`今日剩拍照 ${n} 次 · 报告看近 ${days} 天`)
    }
  })
})
