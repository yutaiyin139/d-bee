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
      'src/pages/ProfileScreen.tsx:168,169,510',
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

  /** 扫两端页面目录：哪些页面调了 AI，其中哪些没有 AiConsent 门。 */
  function scanAiGates() {
    const pages = LOADED.filter((f) => /(^src\/pages\/|^mini\/src\/pages\/)/.test(f.path))
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

    // 2026-11-04 实测基线：**两端共 8 个页面**调用 AI（各端 4 个），其中 4 个无 AiConsent 门。
    // 📌 注意口径：《小程序上线前缺口清单》§二 缺口 1 说的「4 处 AI 调用」是指 **mini 一端**；
    //   本护栏扫的是**两端**，故有门的页面数是 4（CoachSheet/LogSheet/coach/scan）、
    //   无门的是 4（见 KNOWN_WITHOUT_GATE）。新建时我把总数误写成 6（漏数了 CoachSheet 与
    //   LogSheet 中的一个），护栏立刻红给我看 —— 快照式断言的价值正在于此。
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
  it('mini 无支付入口是刻意设计，paywall 必须留有说明注释', () => {
    const f = byPath('mini/src/pages/paywall/paywall.tsx')!
    // 刻意分叉：主端有 IAP/微信/支付宝骨架，mini **刻意不展示价格、不提供任何支付入口**
    // （与 legal.ts「不销售任何商品或服务」公示一致；接支付须等商户号 + 走小程序虚拟支付）。
    expect(
      /刻意|不渲染价格|免费提供|不销售/i.test(f.raw),
      'mini paywall 缺少「刻意无支付入口」的说明注释 —— 该分叉是合规要求，不是待办',
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
