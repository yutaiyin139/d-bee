/**
 * 创意素材页 DOM 断言 + 通用素材裁切安全区检查。
 *
 * 为什么需要这个脚本：出图成功 ≠ 版位可用。16:9 那张（5244×2950）是 Apple 的
 * 「通用素材（universal）」，同一张图会被两个版位分别裁切：
 *   · 产品页面标题按 21:9 → 保宽、切掉上下各 11.91%
 *   · 搜索结果按 3:2     → 保高、切掉左右各 7.81%
 * 交集安全区 = 中央 84.38% × 76.18%。满幅设计在画布内不溢出，却会被版位裁掉文案，
 * 合规角标更会整条消失 —— 这种问题只有对裁切后的可见区做断言才能发现。
 *
 * 3:2 两张（3840×2560 / 1920×1280）本身就是版位原始尺寸，不被裁，只做常规布局断言。
 *
 * 用法：node deploy/verify-creative.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PAGE = path.join(ROOT, 'creative-assets.html')

function findCachedChrome() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
  let dirs = []
  try {
    dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))
  } catch {
    return null
  }
  dirs.sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10))
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(base, d, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}
const launchOpts = (() => {
  const exe = findCachedChrome()
  return exe ? { executablePath: exe } : {}
})()

// 与 shot-creative.mjs 的 TARGETS 对齐：CSS viewport = 目标像素 / 2
const CASES = [
  { key: '21x9', ratio: '21x9', w: 1920, h: 823, universal: false, native: true, target: '3840×1646' },
  { key: '16x9', ratio: '16x9', w: 2622, h: 1475, universal: true, native: false, target: '5244×2950' },
  { key: '3x2-max', ratio: '3x2', w: 1920, h: 1280, universal: false, native: true, target: '3840×2560' },
  { key: '3x2-min', ratio: '3x2', w: 960, h: 640, universal: false, native: true, target: '1920×1280' },
]
const VARIANTS = Number(process.env.VARIANTS || 1)
// LAYOUT=showcase 可验证 21:9 / 16:9 的满幅备选版（默认不传 = 按页面自身规则：
// 21:9/16:9 → brand，3:2 恒为 showcase）。备选版若要上传，须先过这套断言。
const LAYOUT = process.env.LAYOUT === 'showcase' ? 'showcase' : ''

/**
 * Apple 官方 PSD 模板 "Art Safe Area" 实测值（比例形式，可换算到任意 viewport）：
 *   header 3840×1646     → 1646×661 居中            = 42.86% × 40.16%
 *   universal 5244×2950  → 1402×962，中心在 39% 画布高 = 26.73% × 32.61%
 * 21:9 与 16:9 数值不同（尤其垂直中心 50% vs 39%），必须按 ratio 取，不可混用。
 */
const ART_SAFE = {
  '21x9': { wFrac: 1646 / 3840, hFrac: 661 / 1646, cyFrac: 0.5 },
  '16x9': { wFrac: 1402 / 5244, hFrac: 962 / 2950, cyFrac: 0.39 },
}

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const browser = await chromium.launch(launchOpts)

for (const c of CASES) {
  for (let v = 0; v < VARIANTS; v++) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text())
    })
    const layoutQuery = LAYOUT ? `&layout=${LAYOUT}` : ''
    await page.goto(`file:///${PAGE.replace(/\\/g, '/')}?ratio=${c.ratio}&variant=${v}${layoutQuery}`, { waitUntil: 'load' })
    await page
      .waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 20000 })
      .catch(() => console.log('  ⚠️ data-ready 超时，仍继续断言'))
    await page.waitForTimeout(600)

    console.log(
      `\n【${c.key} → ${c.target}${c.universal ? '（通用素材，需过裁切安全区）' : c.native ? '（版位原生尺寸）' : ''}${LAYOUT ? ` · 强制 layout=${LAYOUT}` : ''} variant ${v}】`,
    )

    const m = await page.evaluate(() => {
      const rect = (s) => {
        const e = document.querySelector(s)
        if (!e) return null
        const r = e.getBoundingClientRect()
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, display: getComputedStyle(e).display }
      }
      const phones = Array.from(document.querySelectorAll('.phone')).map((e) => {
        const r = e.getBoundingClientRect()
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, display: getComputedStyle(e).display }
      })
      const visible = phones.filter((p) => p.display !== 'none' && p.r - p.l > 1 && p.b - p.t > 1)
      const union = visible.length
        ? {
            l: Math.min(...visible.map((p) => p.l)),
            t: Math.min(...visible.map((p) => p.t)),
            r: Math.max(...visible.map((p) => p.r)),
            b: Math.max(...visible.map((p) => p.b)),
          }
        : null
      // 收集所有可见文本节点的行盒，用于「安全区外不得有文字/图标」检查
      const textBoxes = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue
        const el = n.parentElement
        if (!el) continue
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        let anc = el
        let hidden = false
        while (anc && anc !== document.body) {
          if (getComputedStyle(anc).display === 'none') {
            hidden = true
            break
          }
          anc = anc.parentElement
        }
        if (hidden) continue
        const rg = document.createRange()
        rg.selectNodeContents(n)
        for (const r of Array.from(rg.getClientRects())) {
          if (r.width < 1 || r.height < 1) continue
          textBoxes.push({ text: n.nodeValue.trim().slice(0, 18), l: r.left, t: r.top, r: r.right, b: r.bottom })
        }
      }
      return {
        layout: document.body.dataset.layout,
        stage: rect('#stage'),
        copy: rect('.copy'),
        headline: rect('.headline'),
        subline: rect('.subline'),
        features: rect('.features'),
        footnote: rect('.footnote'),
        brand: rect('.brand'),
        decor: rect('.decor'),
        phonesDisplay: getComputedStyle(document.querySelector('.phones')).display,
        visiblePhones: visible.length,
        phoneUnion: union,
        stackTransform: document.querySelector('.phone-stack').style.transform || '(none)',
        headlineText: document.getElementById('headline').innerText,
        // 实测主标题渲染行数：数行盒的纵向去重（同一 top 视为一行）。
        // 比判断 innerHTML 是否含 <br> 可靠——CSS 换行/字体度量导致的视觉两行也算。
        headlineLines: (() => {
          const el = document.getElementById('headline')
          const rg = document.createRange()
          rg.selectNodeContents(el)
          const tops = new Set()
          for (const r of Array.from(rg.getClientRects())) {
            if (r.width < 1 || r.height < 1) continue
            tops.add(Math.round(r.top))
          }
          return tops.size
        })(),
        sublineText: document.getElementById('subline').innerText,
        featureTexts: Array.from(document.querySelectorAll('.feature-text')).map((e) => e.innerText.replace(/\s+/g, ' ')),
        footnoteText: document.querySelector('.footnote').innerText,
        textOutside: null, // 由外部按安全区计算
        textBoxes,
        imgs: Array.from(document.images).map((i) => ({ src: i.src.split('/').pop(), nw: i.naturalWidth, complete: i.complete })),
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      }
    })

    // ── 通用断言（两种布局都查）───────────────────
    ok('页面报错 0 条', errs.length === 0, errs[0] || '')
    ok(
      '无滚动溢出',
      m.scrollW <= m.innerW + 1 && m.scrollH <= m.innerH + 1,
      `scroll ${m.scrollW}×${m.scrollH} vs ${m.innerW}×${m.innerH}`,
    )
    ok(
      '主标题命中卖点之一',
      /多少卡|随手拍|饮食体检/.test(m.headlineText),
      JSON.stringify(m.headlineText),
    )
    ok(
      '含合规角标（演示数据 + 不构成医疗建议）',
      /演示数据/.test(m.footnoteText) && /医疗建议/.test(m.footnoteText),
      m.footnoteText,
    )

    if (m.layout === 'brand') {
      // ── brand 布局（21:9 header / 16:9 通用素材）：Apple 模板 art safe area ──
      // 第三方实测 Apple 官方 PSD 的 "Art Safe Area" 图层：
      //   header 3840×1646    → 1646×661 居中（占画布 17.2%）
      //   universal 5244×2950 → 1402×962，水平居中、垂直中心约在 39% 画布高（仅 8.7%）
      const sa = ART_SAFE[c.ratio]
      const W = m.stage.w
      const H = m.stage.h
      const safe = {
        l: W / 2 - (sa.wFrac * W) / 2,
        r: W / 2 + (sa.wFrac * W) / 2,
        t: H * sa.cyFrac - (sa.hFrac * H) / 2,
        b: H * sa.cyFrac + (sa.hFrac * H) / 2,
      }
      console.log(
        `  · Apple art safe area x[${safe.l.toFixed(0)}..${safe.r.toFixed(0)}] y[${safe.t.toFixed(0)}..${safe.b.toFixed(0)}]` +
          ` = ${(sa.wFrac * 100).toFixed(1)}% × ${(sa.hFrac * 100).toFixed(1)}% 画布，中心 y=${(sa.cyFrac * 100).toFixed(0)}%` +
          `（${c.ratio === '21x9' ? 'header 模板，居中' : 'universal 模板，中心偏上'}）`,
      )

      const inSafe = (r) => r && r.l >= safe.l - 1 && r.r <= safe.r + 1 && r.t >= safe.t - 1 && r.b <= safe.b + 1
      ok('品牌行（图标+名称）在 art safe area 内', inSafe(m.brand), m.brand ? `x[${Math.round(m.brand.l)}..${Math.round(m.brand.r)}] y[${Math.round(m.brand.t)}..${Math.round(m.brand.b)}]` : 'missing')
      ok('主标题在 art safe area 内', inSafe(m.headline), m.headline ? `x[${Math.round(m.headline.l)}..${Math.round(m.headline.r)}] y[${Math.round(m.headline.t)}..${Math.round(m.headline.b)}]` : 'missing')
      ok('合规角标在 art safe area 内', inSafe(m.footnote), m.footnote ? `x[${Math.round(m.footnote.l)}..${Math.round(m.footnote.r)}] y[${Math.round(m.footnote.t)}..${Math.round(m.footnote.b)}]` : 'missing')

      // 安全区外不得有任何文字（Apple：区外只放 mood——纹理/色彩，never a logo or text）
      const outside = m.textBoxes.filter((b) => !(b.l >= safe.l - 1 && b.r <= safe.r + 1 && b.t >= safe.t - 1 && b.b <= safe.b + 1))
      ok(
        '安全区外无任何文字',
        outside.length === 0,
        outside.length ? outside.slice(0, 4).map((o) => `"${o.text}" x[${Math.round(o.l)}..${Math.round(o.r)}]`).join(' | ') : `共 ${m.textBoxes.length} 个文本行盒全部在区内`,
      )

      // UI 界面交给 3:2 搜索素材（Apple 对 universal 的业界结论：never a UI screen）
      ok('通用素材不含真实 UI 截图（手机组隐藏）', m.phonesDisplay === 'none' && m.visiblePhones === 0, `phones display=${m.phonesDisplay}, 可见 ${m.visiblePhones} 台`)
      ok('长副标题与特性条已隐藏（聚焦单一理念）', m.subline.display === 'none' && m.features.display === 'none', `subline=${m.subline.display} features=${m.features.display}`)
      ok('装饰层存在（安全区外的 mood）', m.decor && m.decor.display !== 'none', m.decor ? m.decor.display : 'missing')
      ok(
        '文案区整体在安全区内',
        inSafe(m.copy),
        `copy x[${Math.round(m.copy.l)}..${Math.round(m.copy.r)}] y[${Math.round(m.copy.t)}..${Math.round(m.copy.b)}] 高${Math.round(m.copy.h)}≤${Math.round(safe.b - safe.t)}`,
      )

      // 21:9 专项：超宽画幅纵向仅 823 CSS px，主标题必须**单行**。
      // 页面按 ratio+layout 选用 headlineWide（无 <br>）；若误用两行版会挤压安全区，
      // 且违背 Apple 对顶部横幅「聚焦单个清晰明确的理念」的要求。
      // 判据用实际渲染行数（行盒数），而非只看 innerHTML——防止 CSS 换行导致视觉两行。
      if (c.ratio === '21x9') {
        ok('主标题为单行（21:9 超宽横幅专用文案）', m.headlineLines === 1, `实测 ${m.headlineLines} 行 · ${JSON.stringify(m.headlineText)}`)
        ok(
          '主标题不窄于安全区宽的一半（横幅应撑开，避免两侧空荡）',
          m.headline.w >= (safe.r - safe.l) * 0.5,
          `headline 宽 ${Math.round(m.headline.w)} / 安全区宽 ${Math.round(safe.r - safe.l)}`,
        )
      }
    } else {
      // ── showcase / 3:2：常规布局断言 ─────────────
      ok('图片全部解码成功', m.imgs.every((i) => i.complete && i.nw > 0), m.imgs.map((i) => `${i.src}:${i.nw}`).join(' '))
      ok('副标题非空且无 HTML 残留', m.sublineText.length > 10 && !m.sublineText.includes('<'), m.sublineText.slice(0, 36))
      // 特性条在 21:9 showcase 下刻意隐藏（header 版位忌视觉密集，见页面注释）。
      // 隐藏元素的 innerText 返回空串、getBoundingClientRect 返回全零，
      // 若不先判可见性会让「3 条特性齐全」「不与特性重叠」等断言误报失败。
      const featuresShown = m.features && m.features.display !== 'none'
      if (featuresShown) {
        ok('3 条特性齐全', m.featureTexts.length === 3, m.featureTexts.map((t) => t.slice(0, 12)).join(' / '))
        ok('特性文案无 HTML 残留', m.featureTexts.every((t) => t.length > 4 && !t.includes('<')), '')
      } else {
        console.log('  · 特性条已隐藏（该版位聚焦单一理念），跳过特性相关断言')
      }
      ok('标题不与副标题重叠', m.headline.b <= m.subline.t + 1, `headline.b=${Math.round(m.headline.b)} subline.t=${Math.round(m.subline.t)}`)
      if (featuresShown) {
        ok('副标题不与特性重叠', m.subline.b <= m.features.t + 1, `subline.b=${Math.round(m.subline.b)} features.t=${Math.round(m.features.t)}`)
        ok('特性不与角标重叠', m.features.b <= m.footnote.t + 1, `features.b=${Math.round(m.features.b)} footnote.t=${Math.round(m.footnote.t)}`)
      } else {
        ok('副标题不与角标重叠', m.subline.b <= m.footnote.t + 1, `subline.b=${Math.round(m.subline.b)} footnote.t=${Math.round(m.footnote.t)}`)
      }
      ok(
        `${c.ratio === '16x9' ? 3 : 2} 台手机可见`,
        m.visiblePhones === (c.ratio === '16x9' ? 3 : 2),
        `${m.visiblePhones} 台`,
      )
      const inStage =
        m.phoneUnion.l >= m.stage.l - 2 &&
        m.phoneUnion.r <= m.stage.r + 2 &&
        m.phoneUnion.t >= m.stage.t - 2 &&
        m.phoneUnion.b <= m.stage.b + 2
      ok(
        '手机组完全在画布内',
        inStage,
        `内缩 左${(m.phoneUnion.l - m.stage.l).toFixed(0)} 右${(m.stage.r - m.phoneUnion.r).toFixed(0)} 上${(m.phoneUnion.t - m.stage.t).toFixed(0)} 下${(m.stage.b - m.phoneUnion.b).toFixed(0)}`,
      )
      ok('文案区不与手机组重叠', m.copy.r <= m.phoneUnion.l + 1, `copy.r=${Math.round(m.copy.r)} 手机最左=${Math.round(m.phoneUnion.l)}`)
      ok(
        '文案区在画布内',
        m.copy.t >= -1 && m.copy.b <= m.stage.b + 1 && m.copy.l >= -1 && m.copy.r <= m.stage.r + 1,
        `copy x[${Math.round(m.copy.l)}..${Math.round(m.copy.r)}] y[${Math.round(m.copy.t)}..${Math.round(m.copy.b)}]`,
      )

      // 3:2 是版位原始尺寸、不被裁切，只查画布内即可。
      // 16:9 showcase（备选布局）额外查几何裁切交集（依赖「居中式裁切」这一未公开假设）。
      if (c.ratio === '16x9') {
        const W = m.stage.w
        const H = m.stage.h
        const keepH = W / (21 / 9) // 21:9 裁切后保留的高度
        const keepW = H * 1.5 // 3:2 裁切后保留的宽度
        const safe = { l: (W - keepW) / 2, t: (H - keepH) / 2, r: W - (W - keepW) / 2, b: H - (H - keepH) / 2 }
        console.log(
          `  · 几何裁切交集 x[${safe.l.toFixed(0)}..${safe.r.toFixed(0)}] y[${safe.t.toFixed(0)}..${safe.b.toFixed(0)}]` +
            ` = 中央 ${(keepW / W) * 100}% × ${(keepH / H) * 100}%`,
        )
        for (const [name, r] of [
          ['品牌行', m.brand],
          ['主标题', m.headline],
          ['副标题', m.subline],
          ['特性组', m.features],
          ['合规角标', m.footnote],
          ['手机组', m.phoneUnion],
        ]) {
          ok(
            `${name} 在几何裁切交集内`,
            r && r.l >= safe.l - 1 && r.r <= safe.r + 1 && r.t >= safe.t - 1 && r.b <= safe.b + 1,
            r ? `x[${Math.round(r.l)}..${Math.round(r.r)}] y[${Math.round(r.t)}..${Math.round(r.b)}]` : 'missing',
          )
        }
      }
    }
    console.log(`  · phone-stack transform: ${m.stackTransform}`)
    await ctx.close()
  }
}

await browser.close()
console.log(`\n${'─'.repeat(48)}\n断言：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
