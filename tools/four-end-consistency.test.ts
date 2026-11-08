/**
 * 四端一致性护栏（2026-11-04 新建）。
 *
 * 起因：用户要求「每次改代码前，要考虑各端的一致性」。口号无法执行，必须落成机器护栏。
 *
 * 「四端」的架构事实（见 docs/四端上线路线图与首发决策-2026-11-04.md §一）：
 *   web / iOS / Android 经 Capacitor 共用 `src/`（ios/、android/ 内无业务代码），
 *   mini 是独立代码库。故「四端一致」= `src/` 与 `mini/src/` 一致 + 都走 `packages/shared`。
 *
 * 本文件防的是**分叉复发**，不是首次发现分叉（那是 2026-11-03 审计做的，提交 7d61151 已收敛）。
 *
 * 🔴 关键设计约束：必须剥离注释再扫描。
 *   两端源码里有大量「历史说明注释」，例如 src/pages/PaywallSheet.tsx:252 的 JSX 注释里
 *   写着「此前这里直接 new Date(pro_until).toLocaleDateString('zh-CN')」——
 *   那是解释「为什么不再这么做」的宝贵上下文，**绝不能删**。若护栏不剥离注释就会永远误报红，
 *   而一个永远红的测试等于没有测试（人会习惯性忽略）。
 *   剥离方式：字符级状态机，把注释内容替换成**等长空格**（保留换行）→ 行号不变，红了能直接定位。
 *   ⚠️ 本注释内不得出现块注释结束符（星号+斜杠），否则会提前闭合 —— 新建时踩过。
 *
 * 运行：npx vitest run tools/four-end-consistency.test.ts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 统一用 / 分隔，便于断言与跨平台比对。 */
const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

// ---------------------------------------------------------------------------
// 注释剥离（保留行号：注释字符 → 空格，换行原样保留）
// ---------------------------------------------------------------------------
type Lex = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

function stripComments(src: string): string {
  const out = src.split('')
  let s: Lex = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    switch (s) {
      case 'code':
        if (c === '/' && c2 === '/') {
          s = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c === '/' && c2 === '*') {
          s = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c === "'") { s = 'sq'; i++; continue }
        if (c === '"') { s = 'dq'; i++; continue }
        if (c === '`') { s = 'tpl'; i++; continue }
        i++; continue
      case 'line':
        if (c === '\n') { s = 'code'; i++; continue }
        out[i] = ' '; i++; continue
      case 'block':
        if (c === '*' && c2 === '/') {
          out[i] = ' '; out[i + 1] = ' '; s = 'code'; i += 2; continue
        }
        if (c !== '\n') out[i] = ' '
        i++; continue
      case 'sq':
        if (c === '\\') { i += 2; continue }
        if (c === "'") s = 'code'
        i++; continue
      case 'dq':
        if (c === '\\') { i += 2; continue }
        if (c === '"') s = 'code'
        i++; continue
      case 'tpl':
        // 模板字符串整体视为字符串（不递归解析 ${} 内的注释）。
        // 这是**保守**方向：宁可误报也不漏报 —— 误报会促使人去看，漏报会让分叉溜过去。
        if (c === '\\') { i += 2; continue }
        if (c === '`') s = 'code'
        i++; continue
    }
  }
  return out.join('')
}

/** 剥离注释后定位命中行号（1 起），供报错信息直接指向可改之处。 */
function hits(code: string, re: RegExp): number[] {
  const lines = code.split('\n')
  const out: number[] = []
  lines.forEach((ln, idx) => {
    if (re.test(ln)) out.push(idx + 1)
  })
  return out
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.taro', 'build', '.git', '.cache', 'coverage', 'baselineProfiles',
])

function collect(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collect(p, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(p)
    }
  }
  return out
}

const SRC = collect(join(ROOT, 'src'), ['.ts', '.tsx'])
const MINI = collect(join(ROOT, 'mini', 'src'), ['.ts', '.tsx'])
const BOTH = [...SRC, ...MINI]

/** 读文件并剥离注释，返回 { path, code, raw }（raw 保留注释，用于「必须有说明注释」类断言）。 */
function load(files: string[]) {
  return files.map((f) => {
    const raw = readFileSync(f, 'utf8')
    return { path: rel(f), raw, code: stripComments(raw) }
  })
}

const LOADED = load(BOTH)
const byPath = (p: string) => LOADED.find((f) => f.path === p)

describe('护栏 1 · 日期格式禁止 toLocaleDateString（各端 ICU 不同步，必须走 shared formatCnDate）', () => {
  it('两端源码（剥离注释后）零处 toLocaleDateString', () => {
    const bad = LOADED
      .map((f) => ({ path: f.path, lines: hits(f.code, /toLocaleDateString/) }))
      .filter((x) => x.lines.length > 0)

    // 🔴 血泪教训（2026-11-04）：`toLocaleDateString('zh-CN')` 输出是**斜杠**分隔
    // （2026/11/30，charCodeAt(4)===47），不是横线。终端字体让 `/` 与 `-` 几乎无法分辨，
    // 肉眼 diff 必然误判。且该输出由各端 JS 引擎 ICU/locale 数据决定，web/iOS/Android 与
    // 微信小程序各厂商引擎不同步 →「碰巧一致」不是「一致」。故一律下沉到
    // packages/shared/src/datefmt.ts 的 formatCnDate（确定性实现，用本地 getter）。
    expect(
      bad,
      `发现 toLocaleDateString（日期须走 @dbee/shared 的 formatCnDate/proUntilText/proNoticeText）：` +
        bad.map((x) => `\n  ${x.path}:${x.lines.join(',')}`).join(''),
    ).toEqual([])
  })

  it('两端日期格式化确实由 shared 提供（导入关系存在 = 副本未复活）', () => {
    // 会员到期文案的两处渲染点都必须调 shared 的函数，而不是自己拼。
    const need = [
      { path: 'src/pages/PaywallSheet.tsx', fn: 'proNoticeText' },
      { path: 'mini/src/pages/paywall/paywall.tsx', fn: 'proNoticeText' },
    ] as const

    for (const { path, fn } of need) {
      const f = byPath(path)
      expect(f, `${path} 不存在（文件被移动/改名？请同步更新本护栏）`).toBeTruthy()
      expect(
        hits(f!.code, new RegExp(`\\b${fn}\\s*\\(`)).length,
        `${path} 未调用 ${fn}()（会员到期文案必须走 shared，否则两端会各自拼一份）`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('护栏 2 · 定价禁止硬编码（必须走 shared PRICE_* / priceTag）', () => {
  it('两端源码（剥离注释后）零处硬编码价格数字', () => {
    const bad = LOADED
      .map((f) => ({ path: f.path, lines: hits(f.code, /[¥￥]\s*\d/) }))
      .filter((x) => x.lines.length > 0)

    // 2026-11-03 审计发现价格曾有**三份互相独立副本**（constants / PRODUCTS 内联 / PaywallSheet
    // 的 PRICE_TAG），改价必漏改。已收敛为单一真相源，回归测试见 tools/price-single-source.test.ts。
    // 本护栏防复发：任何在两端页面里写死的 ¥ 数字都视为副本复活。
    // 📌 注释里的 ¥18 是历史记录，已被 stripComments 排除（不是漏报）。
    expect(
      bad,
      `发现硬编码价格（须走 @dbee/shared 的 PRICE_* / priceTag / PRODUCTS）：` +
        bad.map((x) => `\n  ${x.path}:${x.lines.join(',')}`).join(''),
    ).toEqual([])
  })

  it('主端付费墙确实用 priceTag 生成价格（不是自己拼字符串）', () => {
    const f = byPath('src/pages/PaywallSheet.tsx')!
    expect(hits(f.code, /\bpriceTag\s*\(/).length).toBeGreaterThan(0)
    expect(hits(f.code, /\bPRODUCTS\b/).length).toBeGreaterThan(0)
  })
})

describe('护栏 3 · 数值口径禁止新增手写舍入（唯一权威 numfmt）', () => {
  const RE = /Math\.round\s*\([^)]*\*\s*10\s*\*?\*?\s*\d*\s*\)\s*\//

  function scanRounding() {
    return LOADED
      .map((f) => ({ path: f.path, lines: hits(f.code, RE) }))
      .filter((x) => x.lines.length > 0)
      .map((x) => `${x.path}:${x.lines.join(',')}`)
      .sort()
  }

  it('🟡 手写舍入清单必须等于已知历史债（多一条 = 新增违规）', () => {
    const found = scanRounding()

    // 2026-11-04 实测基线：**7 处**（5 个文件命中项，ProfileScreen 一个文件含 3 个行号）。
    //
    // 其中 2 处是**两端逐字相同**的共同历史债（不是分叉）：
    //   src/pages/Onboarding.tsx:123        ≡ mini/src/pages/onboarding/onboarding.tsx:88
    //   src/components/Charts.tsx:62        ≡ mini/src/components/Charts.tsx:47
    //
    // 另 3 处（src/pages/ProfileScreen.tsx:168,169,510）是**主端独有**，mini 无对应实现：
    //   :168/:169 体重变化文案 `已减重 X kg` / `较起始 +X kg`；
    //   :510      体重趋势图传给 LineChart 的 fmt。
    //   mini/src/pages/profile/profile.tsx:6 的注释已写明「体重趋势图：主工程用 SVG
    //   LineChart，小程序端以列表形式展示」——即 mini **刻意不画该图**，故无 :510 的等价物；
    //   而全 mini/src 搜「已减重|较起始」为 0 命中，说明体重变化文案 mini 尚未实现。
    //   → 这是**功能覆盖差异**（记入路线图 §四 A 层待办），不是「同一功能两种写法」的分叉。
    //
    // 另 Charts.tsx 的 :202/:290（主端）与 :146/:218（mini）是整数/百分比取整，
    // 不匹配本护栏的「乘 10 幂再除」模式，故不在清单内（由 numfmt 的 pct/roundTo 纪律另行覆盖）。
    //
    // 项目纪律（MEMORY.md）：新增数字展示/舍入一律走 numfmt（roundTo/fmtNum/pct），
    // 禁止自己写 toFixed 或 Math.round(n*f)/f —— 后者有 ① 大数溢出精度
    // ② 负数 .5 方向不一致 ③ 乘法误差「凑巧」掩盖逻辑错 三个问题。
    //
    // 📌 为何是快照式而非「零违规」：这 7 处是既有代码，一次性替换成 fmtNum 会**改变
    //   placeholder 语义**（fmtNum 异常返回 `—`、去尾随零），属有产品影响的重构，
    //   须单独评估（已记入 docs/四端上线路线图与首发决策-2026-11-04.md §四 A9）。
    //   护栏的职责是**防新增**，不是逼人在无评估下改既有行为。
    const KNOWN = [
      'mini/src/components/Charts.tsx:47',
      'mini/src/pages/onboarding/onboarding.tsx:88',
      'src/components/Charts.tsx:62',
      'src/pages/Onboarding.tsx:123',
      // 2026-11-07 A-5 真删号整改：ProfileScreen 顶部多 1 行 import，
      // doDeleteAccount 注释/实现改写使后半段再平移 → 168,169,510 → 169,170,514。
      // 三行**代码内容逐字未变**（仍是既有的 Math.round(x*10)/10 手写舍入），
      // 这里同步的是行号快照，不是放宽基线；同步后已做红验证。
      'src/pages/ProfileScreen.tsx:169,170,514',
    ]

    expect(
      found,
      '手写舍入清单与基线不符：多出的条目属**新增违规**（请改走 numfmt 的 roundTo/fmtNum）；' +
        '少了则说明历史债已清理，请把期望值同步更新（否则护栏失去侦测力）',
    ).toEqual(KNOWN)
  })
})

describe('护栏 4 · 会员状态文案必须由 shared memberSubText 统一产出', () => {
  it('两端 profile 页都调 memberSubText（同一个函数，不是两份对齐的副本）', () => {
    const need = ['src/pages/ProfileScreen.tsx', 'mini/src/pages/profile/profile.tsx'] as const
    for (const path of need) {
      const f = byPath(path)
      expect(f, `${path} 不存在（被移动/改名？请同步更新本护栏）`).toBeTruthy()
      expect(
        hits(f!.code, /\bmemberSubText\s*\(/).length,
        `${path} 未调用 memberSubText()（会员副标题四分支必须走 shared，改一处两端同时生效）`,
      ).toBeGreaterThan(0)
    }
  })

  it('🟡 mini 的额度降级刻意比主端保守，且必须留有说明注释（防被当 bug 抹平）', () => {
    const f = byPath('mini/src/pages/profile/profile.tsx')!

    // 刻意分叉：主端 getPhotoQuota fail-open 给满额；mini fail-closed（degraded:true）
    // → 展示「暂时读不到」而非编一个数字。这是**正确的分叉**，不是缺陷。
    expect(hits(f.code, /quotaDegraded\s*\?\s*null/).length).toBeGreaterThan(0)

    // 护栏的价值：分叉必须有注释解释，否则下一个人（或下一个 AI）会「顺手修好」。
    expect(
      /刻意|保守|不谎报|degraded/i.test(f.raw),
      'mini profile 的额度降级分叉缺少说明注释 —— 刻意分叉必须写清理由，' +
        '否则会被后人当成 bug 抹平（见 docs/四端上线路线图与首发决策-2026-11-04.md §7.2）',
    ).toBe(true)
  })
})

describe('护栏 5 · AI 同意门覆盖率快照（缺口 1 的量化跟踪）', () => {
  const AI_CALLS = ['generatePlan', 'generateReportInsight', 'askCoach', 'recognizeFoodFromImage']

  /** 扫两端页面 + 组件目录：AI 逻辑下沉到组件后也要纳入同意门覆盖统计。 */
  function scanAiGates() {
    const pages = LOADED.filter((f) =>
      /(^src\/pages\/|^mini\/src\/pages\/|^src\/components\/|^mini\/src\/components\/)/.test(f.path),
    )
    const withCall: string[] = []
    const withoutGate: string[] = []
    for (const f of pages) {
      const calls = AI_CALLS.filter((fn) => hits(f.code, new RegExp(`\\b${fn}\\s*\\(`)).length > 0)
      if (calls.length === 0) continue
      withCall.push(f.path)
      if (hits(f.code, /AiConsent/).length === 0) withoutGate.push(f.path)
    }
    return { withCall: withCall.sort(), withoutGate: withoutGate.sort() }
  }

  it('🔴 无门清单必须等于已知缺口（多一个 = 新增违规，少一个 = 请更新快照）', () => {
    const { withCall, withoutGate } = scanAiGates()

    // 2026-11-04 实测基线：**两端共 8 个 AI 入口**，其中 4 个无 AiConsent 门。
    // 📌 注意口径：《小程序上线前缺口清单》§二 缺口 1 说的「4 处 AI 调用」是指 **mini 一端**；
    //   本护栏扫的是**两端**，故有门的入口是 4（CoachSheet/LogSheet/coach/录入弹层）。
    //   2026-11-08：mini 的 AI 拍照入口从 pages/scan 下沉为 components/LogSheet，
    //   扫描范围同步扩到 components/，总数仍为 8、无门清单仍为 4。
    //   新建时我曾把总数误写成 6（漏数了 CoachSheet 与 LogSheet 中的一个），
    //   护栏立刻红给我看 —— 快照式断言的价值正在于此。
    //
    // 而 mini/src/content/legal.ts 向用户承诺「首次使用**任一** AI 功能前会单独征得同意」
    // → 承诺与实现不符（PIPL 单独同意）。
    //
    // 📌 这是**快照式**断言，两种情况都会红，且都该红：
    //   · 清单变长 → 有人又加了一个无门的 AI 入口（新违规，必须补门）
    //   · 清单变短 → 缺口 1 已修（好事，但请把下面的期望值同步改成实际值，
    //                  否则护栏会失去对「未来新增违规」的侦测力）
    const KNOWN_WITHOUT_GATE = [
      'mini/src/pages/onboarding/onboarding.tsx',
      'mini/src/pages/report/report.tsx',
      'src/pages/Onboarding.tsx',
      'src/pages/ReportScreen.tsx',
    ]

    expect(withoutGate, '无 AiConsent 门的 AI 页面清单与基线不符（见上方注释两种情况）').toEqual(
      KNOWN_WITHOUT_GATE,
    )

    // 调用 AI 的页面总数也纳入快照：新增 AI 入口时这条会先红，提示同步评估是否需要门。
    expect(withCall.length, '调用 AI 的页面数变化（新增/移除了 AI 入口？请重新评估同意门覆盖）').toBe(8)
  })
})

describe('护栏 6 · 刻意分叉清单必须有说明注释（防被「顺手抹平」）', () => {
  it('🔴 mini 售卖能力必须由单一构建期开关驱动，且与 legal.ts 同源（2026-11-08 起）', () => {
    // 历史（11-02 ~ 11-08）：mini 曾「刻意不展示价格、无任何支付入口」，legal.ts 写
    //   「免费提供、不销售任何商品」。用户 11-08 指令改为小程序售卖会员（盈利核心）。
    // 现状：售卖与否由 `lib/xpayEnabled.ts` 的**单一构建期常量** `XPAY_SALE_ENABLED` 决定，
    //   它**同时**驱动付费墙售卖 UI 与 legal.ts 法务口径 —— 二者必须同源，因为微信审核
    //   核「页面展示内容与用户协议是否一致」，一处卖钱一处写「免费提供」= 可判驳回。
    // 本护栏钉死三件事：① paywall 与 legal 都引用同一常量；② 该常量出自 xpayEnabled.ts；
    //   ③ paywall 留有「同开关 + 措辞纪律」说明注释（防后人只加价格不改协议）。
    const paywall = byPath('mini/src/pages/paywall/paywall.tsx')!
    const legal = byPath('mini/src/content/legal.ts')!
    const enabled = byPath('mini/src/lib/xpayEnabled.ts')!

    expect(
      /XPAY_SALE_ENABLED/.test(paywall.code) && /XPAY_SALE_ENABLED/.test(legal.code),
      'paywall.tsx 与 legal.ts 必须都引用 XPAY_SALE_ENABLED —— 售卖 UI 与法务口径同源，' +
        '否则一处卖钱一处写「免费提供」会被微信审核判「展示与协议不符」',
    ).toBe(true)

    expect(
      /export const XPAY_SALE_ENABLED/.test(enabled.code),
      'mini/src/lib/xpayEnabled.ts 缺少 XPAY_SALE_ENABLED 导出（售卖开关的唯一真相源）',
    ).toBe(true)

    expect(
      /同源|同开关|措辞纪律|不自动续费/i.test(paywall.raw),
      'mini paywall 缺少「售卖与 legal 同源 / 道具直购不自动续费」的说明注释 —— ' +
        '后人只把价格加回来而漏改协议或误写「自动续费」都是合规事故',
    ).toBe(true)
  })

  it('两端法务公示主体刻意不同（mini 连云库 / 主端自托管），cloud.ts 必须留有更正说明', () => {
    const f = byPath('mini/src/lib/cloud.ts')!
    // 2026-10-29 曾误写「三端共用同一云端」并导致 legal.ts 出现与实际链路不符的公示。
    // 事实：mini 连 WorkBuddy 云、主端连自托管，**数据不互通** → 公示主体必须不同。
    expect(
      /不是同一后端|数据不互通|更正/.test(f.raw),
      'mini/src/lib/cloud.ts 缺少「两端后端不同、数据不互通」的更正说明 —— ' +
        '改任一端 legal.ts 前必须先确认此结论',
    ).toBe(true)
  })
})

/**
 * 护栏 7 · 合规公示可达性与版本号同源（2026-11-05 新建）。
 *
 * 起因：用户反馈「小程序端没有用户协议、隐私政策、免责声明和版本信息」。查证后发现
 * 事实更细：三份文档 mini **一直都有**（pages/legal + profile「关于」卡片入口），
 * 但存在三个真实缺口 —— 这正是「一致性问题的第三类：功能覆盖差异」的典型样本，
 * 与护栏 3 注释里记录的体重文案缺口同源同类，故必须同样落成机器护栏。
 *
 * 三个缺口的性质各不相同，修法也不同：
 *  ① 登录前不可达 —— mini 三份文档只挂在「我的 → 关于」下，而该页登录后才可达；
 *     未登录时首页渲染 auth gate（仅标题+描述+登录按钮），login 页零协议文案。
 *     用户注册前看不到隐私政策 = 违反 PIPL 第 17 条「处理前以显著方式告知」。
 *     主端 AuthScreen 就渲染了 SiteFooter，属明确覆盖差异 → 补 LegalLinks 组件。
 *  ② 版本信息缺失 —— mini 的 SITE.version 写死 '1.6.9'（既非 mini/package.json 的
 *     0.1.0 也非产品版本 1.7.3），因无单一真相源，legal.tsx 干脆「刻意不渲染」，
 *     结果是 mini 全端不展示版本 → 改为构建期注入 __APP_VERSION__（与主端同源）。
 *  ③ 失实指引 —— 两端注销提示都写「请通过『关于 → 联系我们』与客服联系」，
 *     而该入口两端都不存在（web 连「关于」区块都没有）→ 两端补真实「联系我们」入口。
 *
 * ⚠️ 本护栏**不**断言法律日期与最后提交日的关系（见下方 it 的说明）。
 */
describe('护栏 7 · 合规公示可达性与版本号同源', () => {
  it('🔴 mini 登录前必须可达法律文档（auth gate 与 login 页都要有入口）', () => {
    // 两个页面都要查：login 由 navigateTo 独立打开，不是首页的同一棵渲染树。
    // 只补一处仍会留缺口 —— 用户可能停在 auth gate，也可能直接进 login 页。
    const gate = byPath('mini/src/pages/index/index.tsx')!
    const login = byPath('mini/src/pages/login/login.tsx')!

    // 🔴 必须匹配 **JSX 使用**（`<LegalLinks`），不能只匹配标识符 `LegalLinks`。
    // 2026-11-05 红验证踩过：把 <LegalLinks /> 换成 <View /> 但留下 import 行，
    // /LegalLinks/ 照样命中 → 护栏假绿。加了未使用 = 等于没加。
    for (const f of [gate, login]) {
      expect(
        /<LegalLinks[\s/>]/.test(f.code),
        `${f.path} 缺少 <LegalLinks /> 的**实际渲染**（仅有 import 不算）—— ` +
          '登录前不可达隐私政策属 PIPL 第 17 条违规，不是「可以后补」的体验优化项',
      ).toBe(true)
    }

    // login 页的 LegalLinks 必须在 !session 三元**之外**，否则已登录态看不到入口
    const idx = login.code.indexOf('<LegalLinks')
    const branch = login.code.indexOf('{!session ? (')
    expect(
      idx > 0 && branch > 0 && idx > branch,
      'login.tsx 的 <LegalLinks /> 必须在登录态条件分支之外（放分支内会漏掉一种状态）',
    ).toBe(true)
  })

  it('🔴 LegalLinks 必须是单一组件，两端页面不得各写一份文案副本', () => {
    const comp = byPath('mini/src/components/LegalLinks.tsx')
    expect(comp, 'mini/src/components/LegalLinks.tsx 不存在 —— 入口组件被删了？').toBeTruthy()

    // 三份文档的标签只允许出现在 LegalLinks 组件与「关于」卡片里。
    // 若某天有人在新页面又手写一遍「用户协议/隐私政策/免责声明」三个链接，
    // 就出现了第二份文案副本（护栏 4 防的正是这种漂移），本断言会红。
    const LABELS = ['用户协议', '隐私政策', '免责声明']
    const dup = LOADED.filter(
      (f) =>
        f.path.startsWith('mini/src/') &&
        LABELS.every((l) => f.code.includes(l)) &&
        f.path !== 'mini/src/components/LegalLinks.tsx' &&
        f.path !== 'mini/src/pages/profile/profile.tsx' && // 「关于」卡片：登录后的正入口
        f.path !== 'mini/src/content/legal.ts', // 文档标题定义处
    ).map((f) => f.path)

    expect(
      dup,
      `以下文件自行硬写了三份法律文档入口（应复用 LegalLinks 组件，避免文案副本漂移）：${dup.join(', ')}`,
    ).toEqual([])
  })

  // 🔴 以下三条**刻意拆成独立 it**，不合并。2026-11-05 红验证实证：合成一个 it 时，
  // 首条断言失败即抛出，后续断言根本不执行 —— 当时删掉 config 的 name 校验，
  // 测试却因 version 断言先红而「看起来通过了」，那条 config 断言的有效性无从证明。
  // 拆分后每条独立报红，才谈得上「有侦测力」。
  it('🔴 两端 SITE.version 必须走构建期注入，禁止写死版本字面量', () => {
    // 单一真相源 = 项目根 package.json 的 version。主端 vite.config.ts:64 与
    // mini/config/index.ts 的 defineConstants 都注入同名 __APP_VERSION__。
    // 写死字面量正是「package.json 已升版、界面还显示旧版本」的成因（见 vite.config.ts:55-58）。
    for (const p of ['src/content/legal.ts', 'mini/src/content/legal.ts']) {
      const f = byPath(p)!
      expect(
        /version:\s*__APP_VERSION__/.test(f.code),
        `${p} 的 SITE.version 必须写 __APP_VERSION__（构建期注入），不得写死版本号字面量`,
      ).toBe(true)
    }
  })

  it('🔴 mini/config 必须真实注入 __APP_VERSION__（否则编译后是 undefined）', () => {
    const cfg = stripComments(readFileSync(join(ROOT, 'mini', 'config', 'index.ts'), 'utf8'))
    expect(
      /__APP_VERSION__:\s*JSON\.stringify/.test(cfg),
      'mini/config/index.ts 缺少 __APP_VERSION__ 的 defineConstants 注入 —— ' +
        'SITE.version 编译后会变成未定义标识符，界面显示异常',
    ).toBe(true)
  })

  it('🔴 mini/config 解析版本号必须校验 name==="d-bee"（防误读 mini/package.json 的 0.1.0）', () => {
    const cfg = stripComments(readFileSync(join(ROOT, 'mini', 'config', 'index.ts'), 'utf8'))
    // 根 package.json 的 name 是 'd-bee'、version 是产品版本（1.7.3）；
    // mini/package.json 的 name 是 'd-bee-mini'、version 是 0.1.0（小程序包自身版本）。
    // 少了这道校验，候选路径一旦命中 mini 自己的包，就会向用户展示 0.1.0 —— 错版本号比不显示更糟。
    expect(
      /name\s*===\s*['"]d-bee['"]/.test(cfg),
      'mini/config/index.ts 解析版本号时未校验 package.json 的 name==="d-bee" —— ' +
        '可能误读 mini/package.json 拿到 0.1.0，向用户展示错误版本号',
    ).toBe(true)
  })

  it('🔴 两端必须有真实「联系我们」入口，且不得再出现指向不存在入口的文案', () => {
    // ① 入口必须真实存在（两端都要有字面标签「联系我们」的可点元素）
    expect(
      /联系我们/.test(byPath('src/components/SiteFooter.tsx')!.code),
      'web 页脚缺少「联系我们」入口 —— 注销提示与法律正文都在指路到它',
    ).toBe(true)
    expect(
      /联系我们/.test(byPath('mini/src/pages/profile/profile.tsx')!.code),
      'mini「关于」卡片缺少「联系我们」入口 —— 注销提示与法律正文都在指路到它',
    ).toBe(true)

    // ② 失实指引不得复活：「关于 → 联系我们」这个路径两端都不存在
    //    （web 无「关于」区块；mini 的「关于」卡片里也没有二级路径）
    const bad = LOADED
      .map((f) => ({ path: f.path, lines: hits(f.code, /关于\s*→\s*联系我们/) }))
      .filter((x) => x.lines.length > 0)
      .map((x) => `${x.path}:${x.lines.join(',')}`)

    expect(
      bad,
      `以下位置的用户可见文案指向不存在的「关于 → 联系我们」路径（注释里提及不算，` +
        `本断言已剥离注释）：${bad.join(', ')}`,
    ).toEqual([])
  })

  // 🟡 刻意**不做**「UPDATED 日期不得早于文件最后提交日」的自动断言。
  //
  // 原因（2026-11-05 查证）：主端 LEGAL_UPDATED 被 src/lib/privacyConsent.ts:29 用于
  // 隐私同意版本比对 —— `kvGet('privacy.agreed') === LEGAL_UPDATED`，日期一变，
  // **全体老用户下次启动都会重新弹隐私同意窗**。这在 PIPL 第 14 条下是正确的
  // （处理个人信息种类变化时应重新取得同意），但它是有真实用户影响的产品决策，
  // 不该由一条测试在 CI 里自动「修好」。
  //
  // 当前已知状态（人工核对，非自动断言）：
  //   src/content/legal.ts       UPDATED=11-02，文件最后实质改动 11-03 09:54（74aa2bc，
  //                              补 AI 生成内容标识条款）→ **偏早 1 天，待产品决策**
  //   mini/src/content/legal.ts  UPDATED=11-03，最后实质改动 11-03 12:35（07a46ca）→ 已校正
  // mini 端不依赖该日期做门控（走微信原生 ensurePrivacyAuthorized），故改动零副作用。
  //
  // 改任一端日期前必须先读 privacyConsent.ts，确认是否要触发重新同意。
  it('两端 legal.ts 必须留有关于 UPDATED 语义的说明注释（防被当普通常量随手改）', () => {
    for (const p of ['src/content/legal.ts', 'mini/src/content/legal.ts']) {
      const f = byPath(p)!
      // mini 侧要求写明「最后实质改动日」语义；主端要求写明它与隐私同意门控的联动。
      expect(
        /最后.*改动|最后更新|重新.*同意|privacyConsent|门控|版本比对/.test(f.raw),
        `${p} 缺少 UPDATED 语义说明 —— 主端该常量驱动隐私同意重新弹窗，` +
          '随手改会让全体老用户重新同意，必须留注释警示',
      ).toBe(true)
    }
  })
})

/* ──────────────────────────────────────────────────────────────────────────
 * 护栏 8 · ICP 备案号单一真相源 + 域名后缀不得错配（2026-11-06 备案下证后新增）
 *
 * 背景：ICP 下证拿到**两个**备案号，同一主体、两个站点，后缀不同：
 *   · 京ICP备2026075565号-2 = 自律蜜蜂 / d-bee.cn      ← 本项目（四端）
 *   · 京ICP备2026075565号-1 = 门户网站 / d-bee.com.cn  ← 官网，**不在本仓库**
 * 二者只差一个字符，而 mini/src/pages/legal/legal.tsx、docs/备案材料清单.md、
 * docs/小程序上线前缺口清单… 三处旧文档的「回填示例」全都写成了 -1 —— 照抄即合规违规。
 *
 * 另一层风险：备案号原先只走 .env 的 VITE_ICP_BEIAN，而 .env 被 gitignore（.gitignore:6）
 * → 换机器/CI 构建读不到该键，会**静默产出没有备案号的页面**（页脚那行不渲染、
 *   构建 exit 0）。备案号是法律要求每页公示的公开信息、不是密钥，故真相源改为入库的
 *   packages/shared 常量，.env 降级为紧急覆盖口。
 *
 * 本护栏把「不得写死副本」「不得错用官网号」变成机器强制。
 * 注：collect() 只扫 src 与 mini/src，**不含 packages/shared/src**，
 *     故 shared 常量用 readFileSync 直读（同护栏 7 读 mini/config/index.ts 的做法）。
 * ────────────────────────────────────────────────────────────────────────── */
describe('护栏 8 · ICP 备案号单一真相源 + 后缀不得错配', () => {
  const SHARED_CONST = join(ROOT, 'packages', 'shared', 'src', 'constants', 'index.ts')
  // 🔴 必须 stripComments：护栏 7 的漏洞 B 教训重演过一次 —— 若在 raw（含注释）上断言，
  // 把 `export const POLICE_BEIAN = ''` **注释掉**后，注释文本里的子串仍会被正则命中 →
  // 存在性断言假绿。红验证注入「注释掉该常量」时它没报红，当场抓出这个 bug。
  const sharedCode = () => stripComments(readFileSync(SHARED_CONST, 'utf8'))
  /** 本站（d-bee.cn / 自律蜜蜂）的正确备案号 */
  const ICP_SELF = '京ICP备2026075565号-2'
  /** 官网（d-bee.com.cn / 门户网站）的备案号 —— 本仓库代码中**不得**作为生效值出现 */
  const ICP_PORTAL = '京ICP备2026075565号-1'

  it('shared 必须导出 ICP_BEIAN_D_BEE_CN，且值 = 本站备案号（后缀 -2）', () => {
    const raw = sharedCode()
    const m = raw.match(/export const ICP_BEIAN_D_BEE_CN\s*=\s*'([^']*)'/)
    expect(
      m,
      'packages/shared/src/constants/index.ts 缺少 ICP_BEIAN_D_BEE_CN 导出（生效代码中）—— ' +
        '两端 legal.ts 都引用它，缺失会导致构建失败或备案号静默变空',
    ).not.toBeNull()
    expect(
      m![1],
      `ICP_BEIAN_D_BEE_CN = '${m![1]}'，但本站是 d-bee.cn（自律蜜蜂），` +
        `正确值应为 '${ICP_SELF}'。` +
        `🔴 '${ICP_PORTAL}' 是**官网门户**（d-bee.com.cn）的号，用于本站属域名错配（合规违规）`,
    ).toBe(ICP_SELF)
  })

  it('两端 legal.ts 的 SITE.icp 必须引用 shared 常量，禁止写死备案号字面量', () => {
    // 断言「引用了常量」——注意必须匹配 icp 那一行的实际赋值，不能只匹配 import
    // （护栏 7 的漏洞 B 教训：/LegalLinks/ 会命中 import 行，存在性断言必须匹配实际使用）。
    for (const p of ['src/content/legal.ts', 'mini/src/content/legal.ts']) {
      const f = byPath(p)!
      const assign = f.code.match(/^\s*icp:\s*(.+?),?\s*$/m)
      expect(assign, `${p} 找不到 SITE.icp 赋值行`).not.toBeNull()
      expect(
        /ICP_BEIAN_D_BEE_CN/.test(assign![1]),
        `${p} 的 SITE.icp 赋值为「${assign![1].trim()}」，未引用 ICP_BEIAN_D_BEE_CN。` +
          '两端各写一份字面量必然漂移（本项目版本号踩过同一坑），' +
          '必须都引用 shared 常量；主端可保留 env 覆盖口，但**回退值必须是该常量**',
      ).toBe(true)
    }
  })

  it('两端源码（剥离注释后）不得出现官网备案号 -1 的字面量', () => {
    // 用 code（剥离注释）而非 raw：src/content/legal.ts 与 mini/src/pages/legal/legal.tsx
    // 的**注释里**都刻意保留了「-1 是官网号、不可用于本站」的警示说明，那是正确的；
    // 要防的是它出现在**生效代码**里。
    const bad = LOADED.map((f) => ({ path: f.path, lines: hits(f.code, new RegExp(ICP_PORTAL, 'g')) })).filter(
      (x) => x.lines.length > 0,
    )
    expect(
      bad.map((b) => `${b.path}:${b.lines.join(',')}`),
      `🔴 生效代码中出现官网备案号 ${ICP_PORTAL}（d-bee.com.cn 门户站的号）。` +
        `本仓库只服务 d-bee.cn，应使用 ${ICP_SELF}`,
    ).toEqual([])
  })

  it('公安备案号常量必须存在（当前允许为空 = 该行不渲染，但不得删字段）', () => {
    const raw = sharedCode()
    // ICP 下证后 30 日内须办公安联网备案（依据《计算机信息网络国际联网安全保护管理办法》
    // 第 12 条，即 2026-12-06 前）。拿到前留空、页脚那一行不渲染是合规的；
    // 但字段必须存在，否则将来拿到号时又要改两端结构。
    expect(
      /export const POLICE_BEIAN\s*=\s*'[^']*'/.test(raw),
      'shared 缺少 POLICE_BEIAN 常量（生效代码中）—— 两端 legal.ts 都引用它；' +
        '公安联网备案须在 ICP 下证后 30 日内办理（2026-12-06 前）',
    ).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 护栏 9 · App 内真删号（Apple 5.1.1(v) / PIPL 第 47 条）
//
// 起因（2026-11-07）：ProfileScreen 的「注销账号」是降级实现（清记录 + 登出 +
// 提示联系客服），身份行仍在库里。整改落成 0045 SECURITY DEFINER RPC。
// 这里守的是**三个最容易悄悄退化的点**：
//   ① 新增含 owner_id 的表没同步 v_tables → 删号留下孤儿个人信息；
//   ② 前端删号成功后又调 saveProfile() → 把刚删掉的 profiles 档案重建回来；
//   ③ 权限被误放宽给 anon/PUBLIC，或删掉服务端 p_confirm 闸门。
//
// 🔴 快照基线来源：2026-11-07 生产 `information_schema` 实测 18 张含 owner_id 的表
//    （17 业务表 + app_users，后者在函数末尾单独删）。**放宽基线前必须做红验证**。
// ────────────────────────────────────────────────────────────────────────────
describe('护栏 9 · App 内真删号（0045）', () => {
  const MIG = 'db/migrations/0045-account-deletion.sql'
  const sqlRaw = readFileSync(join(ROOT, 'db', 'migrations', '0045-account-deletion.sql'), 'utf8')
  // SQL 只有行注释；逐行剥掉 -- 之后的内容，避免注释里的关键词造成假绿
  const sqlCode = sqlRaw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
  const apiCode = stripComments(readFileSync(join(ROOT, 'src', 'lib', 'api.ts'), 'utf8'))
  const profileCode = stripComments(readFileSync(join(ROOT, 'src', 'pages', 'ProfileScreen.tsx'), 'utf8'))

  const EXPECTED_TABLES = [
    'ai_quota_claims', 'ai_usage', 'apple_transactions', 'badges',
    'entitlements', 'exercise_logs', 'honey_ledger', 'invite_attempts',
    'invite_links', 'meal_entries', 'payment_orders', 'profiles',
    'quota_bonus', 'quota_bonus_newbie_retire_log', 'recipes',
    'water_logs', 'weight_logs',
  ].sort()

  it('🔴 0045 的 v_tables 必须覆盖生产全部 17 张含 owner_id 的业务表', () => {
    const arr = sqlCode.match(/v_tables\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/)?.[1] ?? ''
    const got = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(
      got,
      `${MIG} 的 v_tables 与生产快照不一致。新增任何含 owner_id 的表都必须同步该数组，` +
        '否则删号会留下孤儿个人信息；放宽基线前先做红验证',
    ).toEqual(EXPECTED_TABLES)
  })

  it('🔴 0045 必须删掉 app_users 身份行（不能只清业务数据）', () => {
    expect(
      /DELETE\s+FROM\s+public\.app_users\s+WHERE\s+owner_id\s*=\s*v_owner/.test(sqlCode),
      `${MIG} 未删除 app_users —— 只清数据不删身份不算「注销账号」，Apple 5.1.1(v) 仍不满足`,
    ).toBe(true)
  })

  it('🔴 0045 必须是 SECURITY DEFINER（否则越不过 app_users 的 FORCE RLS + 无 DELETE 授权）', () => {
    expect(
      /SECURITY\s+DEFINER/.test(sqlCode),
      `${MIG} 缺 SECURITY DEFINER：生产 app_users 是 FORCE RLS 且 dbee_app ACL=arw（无 d），` +
        '只有属主 postgres 能删身份行',
    ).toBe(true)
  })

  it('🔴 0045 必须收回 PUBLIC/anon 的 EXECUTE', () => {
    expect(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.delete_own_account\(text\)\s+FROM\s+PUBLIC,\s*anon/.test(sqlCode),
      `${MIG} 未 REVOKE PUBLIC/anon —— PG 默认把新函数 EXECUTE 给 PUBLIC，未登录也能调`,
    ).toBe(true)
  })

  it('🔴 0045 必须只授 authenticated EXECUTE', () => {
    expect(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.delete_own_account\(text\)\s+TO\s+authenticated/.test(sqlCode),
      `${MIG} 未把 EXECUTE 授给 authenticated —— PostgREST 以该角色调用，前端会 404/401`,
    ).toBe(true)
  })

  it('🔴 0045 的身份必须只取自 auth.uid()（禁止接受调用方指定删谁）', () => {
    expect(
      /v_owner\s*:=\s*auth\.uid\(\)/.test(sqlCode),
      `${MIG} 未用 auth.uid() 取身份。删号函数绝不能有 owner_id/p_owner 入参，` +
        '否则会变成「传别人的 id 删别人」的越权面',
    ).toBe(true)
  })

  it('🔴 0045 必须保留服务端 p_confirm 二次闸门', () => {
    expect(
      /p_confirm\s+IS\s+DISTINCT\s+FROM\s+'DELETE_MY_ACCOUNT'/.test(sqlCode),
      `${MIG} 缺 p_confirm 校验：前端两步确认 UI 不是安全边界，误调/回放不可逆`,
    ).toBe(true)
  })

  it('🔴 api.ts 的 deleteAccount() 必须调 delete_own_account RPC 并带确认令牌', () => {
    expect(
      /callRpc\('delete_own_account',\s*\{\s*p_confirm:\s*'DELETE_MY_ACCOUNT'\s*\}\)/.test(apiCode),
      'src/lib/api.ts 的 deleteAccount() 未调用 0045 RPC（或确认令牌不符）—— ' +
        '匹配的是剥离注释后的生效代码，仅注释里提到不算',
    ).toBe(true)
  })

  it('🔴 ProfileScreen 注销成功后不得再写档案（否则删号后又重建 profiles）', () => {
    const fn = profileCode.match(/async function doDeleteAccount\(\)[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(
      /await deleteAccount\(\)/.test(fn) && !/saveProfile\(|clearAllRecords\(/.test(fn),
      'doDeleteAccount() 必须调 deleteAccount()，且不得再调 clearAllRecords()/saveProfile()。' +
        '服务端已事务删干净，saveProfile 会 INSERT 出一条新 profiles 档案 = 账号被重建',
    ).toBe(true)
  })

  it('🔴 注销确认文案不得再把用户推给客服（App 内必须能真正删号）', () => {
    const bad = hits(profileCode, /如需彻底注销账号|与客服联系/g)
    expect(
      bad,
      `ProfileScreen 生效代码里仍有「转客服」文案（行 ${bad.join(',')}）：` +
        'Apple 5.1.1(v) 要求 App 内完成账号删除，转客服通常不满足',
    ).toEqual([])
  })
})

/**
 * 护栏 9b · mini 端真删号必须对齐 0045（2026-11-08 新增）。
 *
 * 起因：四端一致性审计发现护栏 9 只扫主端两个文件，mini 的注销流程仍是
 * 「clearAllRecords + saveProfile + signOut」降级实现，身份行永不删除，
 * 确认文案还把用户推给客服 —— 即主端已修的能力缺口在 mini 端完整复发。
 * 0045 RPC 在网关侧、四端共用，mini 无需改网关即可对齐。
 */
describe('护栏 9b · mini 端 App 内真删号对齐（0045）', () => {
  const miniApiCode = stripComments(readFileSync(join(ROOT, 'mini', 'src', 'lib', 'api.ts'), 'utf8'))
  const miniProfileCode = stripComments(readFileSync(join(ROOT, 'mini', 'src', 'pages', 'profile', 'profile.tsx'), 'utf8'))

  it('🔴 mini api.ts 的 deleteAccount() 必须调 delete_own_account RPC 并带确认令牌', () => {
    expect(
      /callRpc\('delete_own_account',\s*\{\s*p_confirm:\s*'DELETE_MY_ACCOUNT'\s*\}\)/.test(miniApiCode),
      'mini/src/lib/api.ts 的 deleteAccount() 未调用 0045 RPC（或确认令牌不符）—— ' +
        '匹配剥离注释后的生效代码，仅注释里提到不算',
    ).toBe(true)
  })

  it('🔴 mini doDeleteAccount() 不得再清记录/写档案（会在删号后重建 profiles）', () => {
    const fn = miniProfileCode.match(/async function doDeleteAccount\(\)[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(
      /await deleteAccount\(\)/.test(fn) && !/saveProfile\(|clearAllRecords\(/.test(fn),
      'mini doDeleteAccount() 必须调 deleteAccount()，且不得再调 clearAllRecords()/saveProfile()',
    ).toBe(true)
  })

  it('🔴 mini 注销确认文案不得再把用户推给客服', () => {
    const bad = hits(miniProfileCode, /如需彻底注销账号|与客服联系/)
    expect(
      bad,
      `mini profile 生效代码里仍有「转客服」文案（行 ${bad.join(',')}）：四端都应能 App 内真删号`,
    ).toEqual([])
  })
})

/**
 * 护栏 11 · mini「记一餐」统一录入层（2026-11-08 重写）。
 *
 * 起因演进：先修了「三餐全落进加餐」（首页丢餐次 / scan 写死 snack / 返回不刷新），
 * 随后核查发现真正的问题是 mini 把主端「单一 bottom sheet + 4 模式 + 统一草稿」
 * 拆成了三块割裂容器：原生 showActionSheet 选模式、拍照跳独立 scan 页、手录内嵌首页 Sheet。
 * 核查确认 mini 早已具备自定义 fixed 弹层、弹层内 Input、ScrollView、
 * parseFoodFromText 与 @dbee/shared 判重纯函数 —— **不是平台能力限制，是移植走样**。
 * 本护栏钉死统一组件的存在与关键语义，防止再次退回三套逻辑。
 */
describe('护栏 11 · mini 记一餐统一录入层（对齐主端 LogSheet）', () => {
  const idx = byPath('mini/src/pages/index/index.tsx')!.code
  const scan = byPath('mini/src/pages/scan/scan.tsx')!.code
  const sheet = byPath('mini/src/components/LogSheet.tsx')?.code ?? ''
  const miniAi = byPath('mini/src/lib/ai.ts')!.code
  const mainAi = byPath('src/lib/ai.ts')!.code
  const miniApi = byPath('mini/src/lib/api.ts')!.code

  it('🔴 首页记一餐必须打开统一 LogSheet 并传餐次与日期，禁止原生菜单与跳页', () => {
    expect(
      /import \{ LogSheet \} from '\.\.\/\.\.\/components\/LogSheet'/.test(idx) &&
        /openLogSheet\(m\)/.test(idx) && /openLogSheet\(\)/.test(idx) &&
        /logDate=\{logDate\}/.test(idx) && /initialMeal=\{logSheetMeal\}/.test(idx) &&
        !/showActionSheet/.test(idx) && !/pages\/scan\/scan/.test(idx),
      '首页又退回 Taro.showActionSheet + navigateTo 三块割裂入口 → 界面像、逻辑差会复发',
    ).toBe(true)
  })

  it('🔴 mini 必须存在统一录入组件 LogSheet.tsx', () => {
    expect(sheet.length > 0, 'mini/src/components/LogSheet.tsx 被删了 → 记一餐逻辑再次分散').toBe(true)
  })

  it('🔴 统一录入层必须含主端 4 模式与草稿 / 判重 / hint / 自动保存链路', () => {
    expect(
      /type Mode = 'photo' \| 'text' \| 'manual' \| 'free'/.test(sheet) &&
        /function settleDraft/.test(sheet) && /function buildRows/.test(sheet) &&
        /isDuplicatePhoto\(/.test(sheet) && /summarizePhoto\(/.test(sheet) &&
        /recognizeFoodFromImage\(dataUrl, hint\.trim\(\) \|\| undefined\)/.test(sheet) &&
        /autoSaveRecognized\(drafts\)/.test(sheet),
      '统一录入层缺了主端 LogSheet 的核心语义（草稿/判重/hint 透传/识别即保存）',
    ).toBe(true)
  })

  it('🔴 scan 页必须复用统一录入层，不得再保留第二套落库 / 额度逻辑', () => {
    expect(
      /<LogSheet/.test(scan) && /initialMode='photo'/.test(scan) &&
        !/insertMeals/.test(scan) && !/consumePhotoQuota/.test(scan),
      'scan.tsx 又长出了独立的识别/落库实现 → 两套逻辑必然再次漂移',
    ).toBe(true)
  })

  it('🔴 scan 兼容入口仍须读取路由参数中的餐次与日期', () => {
    expect(
      /router\.params\?\.meal/.test(scan) && /router\.params\?\.date/.test(scan),
      '小程序码 / 分享直达链接的 meal/date 参数丢失 → 又会写死 snack 或今天',
    ).toBe(true)
  })

  it('🔴 冲突三选一必须是内嵌横幅且取消后保留草稿，禁止原生 ActionSheet', () => {
    expect(
      /confirmOverride/.test(sheet) && /confirmAppend/.test(sheet) &&
        /cancelOverride/.test(sheet) && !/showActionSheet/.test(sheet),
      '冲突处理退回原生菜单会让「取消后草稿可再编辑」语义失效',
    ).toBe(true)
  })

  it('🔴 首页 onShow 必须刷新记录（跨页写库后可见 + 积分结算）', () => {
    const block = idx.match(/useDidShow\(async \(\) => \{[\s\S]*?\n  \}\)/)?.[0] ?? ''
    expect(
      /void load\(\)/.test(block),
      'mini/index.tsx 的 useDidShow 未调 load() → 返回首页看不到记录且积分漏结算',
    ).toBe(true)
  })

  it('🔴 两端拍照识别 prompt 必须同源', () => {
    expect(
      /不要漏掉任何一道菜/.test(miniAi) && /不要漏掉任何一道菜/.test(mainAi),
      'mini 的识别 prompt 又被改成简化版 → 识别质量与置信度低于主端',
    ).toBe(true)
  })

  it('🔴 mini consumePhotoQuota 必须保留 consumeAiQuota 回退', () => {
    expect(
      /return consumeAiQuota\(todayKey\(\), SCAN_FEATURE, FREE_DAILY_AI\)/.test(miniApi),
      'mini 丢了主端 src/lib/api.ts:517-520 的回退 → RPC 抖动时 claim=null，下次必被网关 402 拦',
    ).toBe(true)
  })

  it('🔴 内置食物库数据必须与主端逐字同源', () => {
    const pairs = [
      ['src/lib/foodsDataCore.ts', 'mini/src/lib/foodsDataCore.ts'],
      ['src/lib/foodsDataFresh.ts', 'mini/src/lib/foodsDataFresh.ts'],
      ['src/lib/foodsDataDishes.ts', 'mini/src/lib/foodsDataDishes.ts'],
    ]
    expect(
      pairs.every(([a, b]) => readFileSync(join(ROOT, a), 'utf8') === readFileSync(join(ROOT, b), 'utf8')),
      '食物库数据文件被单端改动 → 两端「食物库」模式给出的营养值不一致',
    ).toBe(true)
  })
})

/**
 * 护栏 12 · 平台适配层里「只是没做」的部分必须补齐（2026-11-08 新增）。
 *
 * 用户要求支付 / HealthKit / SSE 传输层「尽可能和主端保持一致」。核查结论：
 * 传输底座、真同步步数属平台必然差异（📌 收款原也列为平台差异，11-08 起 mini 已接
 * 微信虚拟支付道具直购，见护栏 6 / tools/mini-xpay.test.ts，不再是「只是没做」）；
 * 但下列三项 mini 只是漏实现，与平台能力无关，必须钉死：
 *   1. mini SDK 0.1.3 已支持 signal → wx.request task.abort()（enableChunked 也能中断），
 *      只差 collectText 一层透传（主端 src/lib/ai.ts:52-80 早已有）。
 *   2. 主端已为 wechat-miniprogram 预留品牌识别与诚实降级分支，mini 却是恒 false 裸占位。
 *   3. ACTIVITY_EATBACK_RATIO / DEFAULT_STEP_GOAL 两端各写一份副本，未下沉 shared。
 */
describe('护栏 12 · SSE 取消 / 健康门面 / 数值常量同源', () => {
  const miniAi = byPath('mini/src/lib/ai.ts')!.code
  const mainAi = byPath('src/lib/ai.ts')!.code
  const miniHealth = byPath('mini/src/lib/health/index.ts')!.code
  const mainHealth = byPath('src/lib/health/index.ts')!.code
  const miniIndex = byPath('mini/src/pages/index/index.tsx')!.code
  const sharedConstants = readFileSync(join(ROOT, 'packages/shared/src/constants/index.ts'), 'utf8')

  it('🔴 mini collectText 必须与主端同签名并透传 signal', () => {
    expect(
      /signal\?: AbortSignal/.test(miniAi) && /signal\?: AbortSignal/.test(mainAi) &&
        /\.\.\.\(signal \? \{ signal \} : \{\}\)/.test(miniAi),
      'mini 的流式请求无法中断 → 页面退出/用户取消时 wx.request 仍在跑，与主端语义不一致',
    ).toBe(true)
  })

  it('🔴 mini 健康门面必须与主端同形状（微信运动 / no_plugin / 诚实降级）', () => {
    expect(
      /wechat-miniprogram/.test(miniHealth) && /label: '微信运动'/.test(miniHealth) &&
        /status: 'no_plugin'/.test(miniHealth) &&
        /微信运动接入正在准备中，当前请先手动记录运动。/.test(miniHealth) &&
        /isHealthConnectable\(\)[\s\S]{0,120}return true/.test(miniHealth),
      'mini 健康门面又退回「恒 false + 裸占位」→ 四端降级措辞与入口显隐不一致',
    ).toBe(true)
  })

  it('🔴 两端健康状态提示措辞必须同源', () => {
    expect(
      /接入正在申请资质，当前请先手动记录运动。/.test(miniHealth) &&
        /接入正在申请资质，当前请先手动记录运动。/.test(mainHealth),
      'healthStatusHint 被单端改写 → 用户会以为是两个不同问题',
    ).toBe(true)
  })

  it('🔴 热量回补比例与步数目标默认值必须只在 shared 定义', () => {
    expect(
      /export const ACTIVITY_EATBACK_RATIO = 0\.5/.test(sharedConstants) &&
        /export const DEFAULT_STEP_GOAL = 6000/.test(sharedConstants) &&
        !/const ACTIVITY_EATBACK_RATIO\s*=/.test(miniIndex) &&
        /ACTIVITY_EATBACK_RATIO/.test(miniIndex),
      '两端又各写一份 0.5 / 6000 副本 → 数值口径重新分叉',
    ).toBe(true)
  })
})

/**
 * 护栏 13 · iOS 微信小程序「白屏自报」不可删（2026-11-08 新增）。
 *
 * 实证：用户反馈 iOS 微信登录白屏，服务端该时段**零 login-wechat 请求**，
 * 说明异常发生在发请求之前（cloud.ts 模块级 SDK 初始化 / 页面渲染期）。小程序
 * 没有 DOM，无法像 iOS 原生端那样内联脚本画红屏；微信原生 Modal 是白屏时唯一
 * 可靠的可见通道。删掉它 = 又回到「纯白屏、只能靠猜」的排障盲区。
 */
describe('护栏 13 · mini 启动/登录失败必须可自报', () => {
  const boot = byPath('mini/src/lib/bootReport.ts')!.code
  const miniCloud = byPath('mini/src/lib/cloud.ts')!.code
  const login = byPath('mini/src/pages/login/login.tsx')!.code

  it('🔴 bootReport 必须用微信原生 Modal 显示错误（页面白屏时仍可见）', () => {
    expect(
      /showModal\s*\(/.test(boot) && /reportBootError/.test(boot),
      '自报改成了 setError/console 就失效了：页面渲染层崩溃时文字根本挂不出来；' +
        '且必须走 globalThis.wx 原生 API，不能在模块求值期依赖 Taro 的 API 代理',
    ).toBe(true)
  })

  it('🔴 cloud.ts 创建 SDK 客户端必须包 try/catch 并自报', () => {
    expect(
      /reportBootError\('云端客户端初始化失败', e\)/.test(miniCloud) &&
        /createMiniProgramWorkBuddyCloud/.test(miniCloud),
      '模块级 SDK 初始化抛错会让 common.js 求值中断 → 所有页面白屏且零请求',
    ).toBe(true)
  })

  it('🔴 登录页微信一键登录 catch 必须自报', () => {
    expect(
      /reportBootError\('微信一键登录', e\)/.test(login),
      '登录失败又变回「静默/纯文字」→ iOS 真机拿不到根因',
    ).toBe(true)
  })
})

/**
 * 护栏 14 · iOS 启动期栈溢出：自报通道不得自递归 / 模块求值不得中断（2026-11-08 新增）。
 *
 * 实证：iOS 微信扫码真机调试 Console 报
 *   `MiniProgramError: RangeError: Maximum call stack size exceeded`
 *   堆栈全是同一帧 `app-service.js:16815:59` —— appservice 逻辑层的同步无限递归，
 *   与「该时段零 login-wechat 请求」互相印证，异常发生在任何网络请求之前。
 *
 * 旧版自报在 cloud.ts 模块求值期（App 注册前）import Taro 并调 Taro.showModal，
 * 而 Taro 的 API 代理层此时可能尚未初始化 —— 自报通道自身递归会把「静默白屏」
 * 升级成「栈溢出白屏」。本护栏锁死四条结构性约束，禁止日后为了省事改回去。
 */
describe('护栏 14 · mini 启动期异常不得变成白屏/栈溢出', () => {
  const boot = byPath('mini/src/lib/bootReport.ts')!.code
  const miniCloud = byPath('mini/src/lib/cloud.ts')!.code
  const app = byPath('mini/src/app.ts')!.code
  const auth = byPath('mini/src/lib/auth.ts')!.code

  it('🔴 bootReport 不得 import Taro（模块求值期 API 代理可能未就绪 → 自递归）', () => {
    expect(
      !/from\s+['"]@tarojs\/taro['"]/.test(boot) && /getWx\s*\(/.test(boot),
      '自报必须只从 globalThis.wx 取原生 API；import Taro 会在 App 注册前踩代理层',
    ).toBe(true)
  })

  it('🔴 bootReport 必须有函数级重入锁（自报自身绝不能参与递归）', () => {
    expect(
      /if\s*\(\s*reporting\s*\)\s*return/.test(boot) &&
        /reporting\s*=\s*true/.test(boot) && /reporting\s*=\s*false/.test(boot),
      '去掉重入锁后，showModal / console 抛错会把白屏变成 RangeError 栈溢出',
    ).toBe(true)
  })

  it('🔴 cloud.ts 初始化失败绝不能 rethrow（会中断 common.js 求值 → 全站白屏）', () => {
    expect(
      !/throw\s+e\b/.test(miniCloud) && /initError\s*=\s*e/.test(miniCloud),
      'rethrow 会让 App 都注册不上，Modal 来不及弹，用户只能看到纯白屏',
    ).toBe(true)
  })

  it('🔴 app.ts 必须在模块顶层注册全局错误监听（覆盖 try/catch 之外的异常）', () => {
    expect(
      app.indexOf('installGlobalErrorReporter()') > -1 &&
        app.indexOf('installGlobalErrorReporter()') < app.indexOf('function App'),
      '放到 useLaunch 里注册太晚：模块求值期的异常根本不会走到 App 生命周期',
    ).toBe(true)
  })

  it('🔴 auth.ts 必须把空壳 cloud 转成可读错误（否则只报 undefined TypeError）', () => {
    expect(
      /assertCloudReady\s*\(/.test(auth) && /cloudInitError\s*\(/.test(auth),
      'cloud.ts 不 rethrow 后 cloud 是空壳，登录入口必须带出真实初始化失败原因',
    ).toBe(true)
  })
})

/**
 * 护栏 15 · 「我的」统计卡「碳水 / 脂肪」双值不得折行（2026-11-08 新增）。
 *
 * 实证：iOS 微信小程序**体验版**可用，但 `254g / 56g` 被拆成两行。根因是 mini 用
 * `<Text>` 嵌 `<Text>` 再夹裸文本 ` / `：小程序 text 组件把每个嵌套节点与空格都当成
 * 断行机会；主端是 DOM div，无此行为。修复 = 外层 View(flex nowrap) + 三个独立
 * token（数字组 / 分隔符 / 数字组），分隔符间距交给 CSS margin，不再用空格断行。
 *
 * 16:22 追加：四格必须统一「label 第一行 / 数值第二行」。mini 的 `.stat-l/.stat-v`
 * 是 `<text>`（inline），不锁纵向布局时短值（当前体重 / 蛋白质目标）会与 label
 * 挤在同一行，只有长值才折到第二行；主端是 div，天然块级，无需额外规则。
 */
describe('护栏 15 · 统计卡布局：双值不折行 + 四格统一两行', () => {
  const profile = byPath('mini/src/pages/profile/profile.tsx')!.code
  const scss = readFileSync(join(ROOT, 'mini/src/pages/profile/profile.scss'), 'utf8')
  const mainCss = readFileSync(join(ROOT, 'src/styles.css'), 'utf8')

  it('🔴 双值必须用 View + stat-v--pair 容器（Text 嵌套会把 / 变成断行点）', () => {
    expect(
      /<View className='stat-v stat-v--pair'>/.test(profile) &&
        /className='stat-sep'/.test(profile),
      '改回 <Text> 嵌套 + 裸空格分隔符 → iOS 小程序 text 组件重新折行',
    ).toBe(true)
  })

  it('🔴 分隔符不得再用带空格的裸文本（空格本身就是断行机会）', () => {
    expect(
      !/<Text className='stat-v'>\{target\.carb_g\}/.test(profile) &&
        !/<\/Text>\s*\/\s*\{target\.fat_g\}/.test(profile),
      '把 ` / ` 写回 JSX 文本节点会重新引入断行机会',
    ).toBe(true)
  })

  it('🔴 stat-v--pair 必须同时锁 flex-wrap 与 white-space', () => {
    expect(
      /\.stat-v--pair\s*\{[^}]*flex-wrap:\s*nowrap[^}]*\}/s.test(scss) &&
        /\.stat-v--pair\s*\{[^}]*white-space:\s*nowrap[^}]*\}/s.test(scss),
      '只锁一个不够：小程序 View 走 flex，内部 text 节点走 white-space',
    ).toBe(true)
  })

  it('🔴 主端同位置统计值也必须有 nowrap 防护（四端一致）', () => {
    expect(
      /\.stat \.v\s*\{[^}]*white-space:\s*nowrap[^}]*\}/s.test(mainCss),
      '主端删掉 nowrap 后窄屏 WebView 也会折行，两端表现重新分叉',
    ).toBe(true)
  })

  it('🔴 四格必须统一纵向两行（短值不得与 label 挤在同一行）', () => {
    expect(
      /\.stat\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s.test(scss) &&
        /\.stat-l\s*\{[^}]*display:\s*block/s.test(scss),
      '小程序 <text> 是 inline：去掉 .stat 的 flex column 后，当前体重 / 蛋白质目标的短值会回到第一行，四格高度与对齐重新分叉',
    ).toBe(true)
  })
})

/**
 * 护栏 16 · 微信运动 / 管理订阅 / 免费·订阅权益逻辑四端同源（2026-11-08 新增）。
 *
 * 用户要求「mini 端微信运动、管理订阅严格参考主端实现；免费和订阅逻辑与三端一致」。
 * 平台 API 适配（wx.getWeRunData 需运动健康类目资质 + 服务端 session_key 解密；
 * 支付通道两端不同 —— 主端 iOS 走 StoreKit 订阅、mini 走微信虚拟支付道具直购，
 * 售卖口径由构建期开关驱动，见护栏 6）保留诚实降级，但**业务逻辑 / 状态机 /
 * 门控 / 权益文案**不允许分叉。本护栏逐条钉死 11-08 修掉的真实分叉，防止「修完又漂回去」。
 */
describe('护栏 16 · 微信运动 / 管理订阅 / 免费·订阅逻辑四端同源', () => {
  const mainManage = byPath('src/lib/manageSubscription.ts')!.code
  const miniManage = byPath('mini/src/lib/manageSubscription.ts')!.code
  const mainReport = byPath('src/pages/ReportScreen.tsx')!.code
  const miniReport = byPath('mini/src/pages/report/report.tsx')!.code
  // 主端会员权益清单真源（2026-11-08 从 PaywallSheet 抽出，付费墙与公开定价页共用）
  const mainMembership = byPath('src/content/membership.ts')!.code
  const miniPaywall = byPath('mini/src/pages/paywall/paywall.tsx')!.code
  const mainProfile = byPath('src/pages/ProfileScreen.tsx')!.code
  const miniProfile = byPath('mini/src/pages/profile/profile.tsx')!.code
  const mainDashboard = byPath('src/pages/Dashboard.tsx')!.code
  const miniIndex = byPath('mini/src/pages/index/index.tsx')!.code
  const mainHealth = byPath('src/lib/health/index.ts')!.code
  const miniHealth = byPath('mini/src/lib/health/index.ts')!.code
  const miniUpsell = byPath('mini/src/lib/upsell.ts')!.code
  const sharedConstants = readFileSync(join(ROOT, 'packages/shared/src/constants/index.ts'), 'utf8')

  it('🔴 报告页 30 天锁图标两端都必须只在免费档显示', () => {
    expect(
      /!pro\s*&&\s*r\.days\s*>\s*FREE_REPORT_DAYS/.test(miniReport) &&
        /!pro\s*&&\s*r\.days\s*>\s*FREE_REPORT_DAYS/.test(mainReport),
      'mini 漏掉 !pro → Pro 用户看 30 天报告仍显示锁图标（免费/订阅逻辑分叉）',
    ).toBe(true)
  })

  it('🔴 免费档点 30 天必须拉起付费墙（两端 openPaywall，不得只弹 toast）', () => {
    expect(
      /openPaywall\s*\(/.test(miniReport) && /openPaywall\s*\(/.test(mainReport) &&
        !/showToast\(\{\s*title:\s*`免费版可看近/.test(miniReport),
      '改回只弹 toast → 免费档点 30 天既没解释也没有转化入口',
    ).toBe(true)
  })

  it('🔴 mini 的 openPaywall 门面必须带 reason（对齐主端 usePlan().openPaywall）', () => {
    expect(
      /export async function openPaywall\(reason\?: string\): Promise<void>/.test(miniUpsell) &&
        /encodeURIComponent\(reason\)/.test(miniUpsell),
      '丢了 reason 就退化成裸跳，用户不知道自己为什么被拦下',
    ).toBe(true)
  })

  it('🔴 管理订阅两端同名门面，且 mini 区块一律可见（不得放进 !pro 分支）', () => {
    expect(
      /export async function openManageSubscriptions\(\): Promise<boolean>/.test(mainManage) &&
        /export async function openManageSubscriptions\(\): Promise<boolean>/.test(miniManage) &&
        /pay-card manage-card/.test(miniPaywall) &&
        miniPaywall.indexOf("className='pay-card manage-card'") < miniPaywall.indexOf('{!pro ? ('),
      '把管理订阅塞进 {!pro} → 非订阅态演示账户看不到，主端 3.1.2 明确禁止',
    ).toBe(true)
  })

  it('🔴 「我的」页必须有管理订阅的可达入口', () => {
    expect(
      /openManageSubscriptions\s*\(/.test(miniProfile),
      '入口只在付费墙里 → 从「我的」页无法到达会员权益管理',
    ).toBe(true)
  })

  it('🔴 健康数据源页必须有连接状态机（已连接 / 重连 / 解除连接）', () => {
    expect(
      /healthConnected\s*=\s*profile\?\.health_connected/.test(miniProfile) &&
        /handleDisconnectHealth\s*\(/.test(miniProfile) &&
        /handleConnectHealth\s*\(/.test(miniProfile),
      '退回「只有一个连接按钮 + 一句占位」→ 与主端 ProfileScreen:578-604 状态机分叉',
    ).toBe(true)
  })

  it('🔴 步数换算两端同源，同步间隔必须来自 shared（不得各写 60_000 副本）', () => {
    expect(
      /export function estimateActivityKcal\(/.test(mainHealth) &&
        /export function estimateActivityKcal\(/.test(miniHealth) &&
        /HEALTH_SYNC_INTERVAL_MS\s*=\s*60_000/.test(sharedConstants) &&
        !/const HEALTH_SYNC_INTERVAL_MS\s*=/.test(mainDashboard) &&
        !/const HEALTH_SYNC_INTERVAL_MS\s*=/.test(miniIndex),
      '同步间隔两端各写一份必然漂 → 步数刷新速度出现端间差异',
    ).toBe(true)
  })

  it('🔴 首页必须自动同步健康数据，且有效消耗取「手动 / 健康」较大者', () => {
    expect(
      /syncFromHealth\s*\(/.test(miniIndex) && /isHealthConnected\s*\(/.test(miniIndex) &&
        /Math\.max\(burnKcal,\s*activityKcal\)/.test(miniIndex) &&
        /Math\.max\(burnKcal,\s*activityKcal\)/.test(mainDashboard),
      '退回 effectiveBurnKcal = burnKcal → 微信运动同步的数据完全不参与净摄入计算',
    ).toBe(true)
  })

  it('🔴 免费权益文案「文字描述识别」两端逐字一致', () => {
    // 📌 2026-11-08 主端真源迁址：FREE_ITEMS 从 PaywallSheet.tsx 抽到 content/membership.ts
    //   （公开定价页 PricingSheet 要复用同一份清单，两处各写一份必然漂移）。
    //   故本断言的主端侧改为查 membership.ts；PaywallSheet 确实渲染这份清单由
    //   tools/web-no-payment.test.ts 的「付费墙必须 import membership 清单」钉住。
    expect(
      /'文字描述识别、手动录入、体重饮水运动记录全部免费'/.test(miniPaywall) &&
        /'文字描述识别、手动录入、体重饮水运动记录全部免费'/.test(mainMembership),
      '11-08 统一录入层已补齐 text 模式，付款墙文案不能停在旧版「只有手动录入」',
    ).toBe(true)
  })

  it('🔴 数据导出必须有 Pro 门控，且非 Pro 仍保留 PIPL 邮箱兜底', () => {
    expect(
      /guardExport\(\)/.test(miniProfile) &&
        /数据导出是 Pro 功能，升级后可随时打包带走全部记录/.test(miniProfile) &&
        /数据导出是 Pro 功能，升级后可随时打包带走全部记录/.test(mainProfile) &&
        /EXPORT_UNAVAILABLE_MESSAGE/.test(miniProfile),
      '只加 Pro 门控却删掉邮箱兜底 → 小程序导出未实装时用户的数据复制权入口被藏掉',
    ).toBe(true)
  })
})
