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
