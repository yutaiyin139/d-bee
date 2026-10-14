/**
 * D-Bee（自律蜜蜂）App 图标生成器
 *
 * 产出：
 *   design/icon/concept-*.svg              矢量源文件（可再编辑 / 交付设计师）
 *   design/icon/preview/<id>-<size>.png    各尺寸位图
 *   design/icon/preview/<id>-maskable.png  Android 自适应图标变体（图形缩到 0.82 留安全余量）
 *   design/icon/preview.html               对比预览页（遮罩适配 / 小尺寸可读性 / 主屏效果 / 安全区）
 *
 * 用法：
 *   node design/icon/build.mjs
 *
 * 设计约束：
 *   - 画布 1024×1024，矢量导出（任意尺寸无损）
 *   - 背景**满幅出血**（full-bleed），圆角由系统遮罩负责
 *   - 每个方案的图形层统一包在 <g id="art"> 里：
 *       · 隐藏它即可得到"纯背景"，与完整图做像素差 => 精确安全区检查（见 check-safezone.py）
 *       · 对它套 scale 变换即可得到 maskable 变体，无需复制一份图形代码
 *   - maskable 安全区：Android 要求关键内容落在直径 80% 的圆内（半径 0.4×画布 = 410px）
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')
const PYTHON = process.env.PY || 'C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_SVG = __dirname
const OUT_PNG = path.join(__dirname, 'preview')
const CHECK_DIR = path.join(__dirname, '_check')
mkdirSync(OUT_PNG, { recursive: true })
mkdirSync(CHECK_DIR, { recursive: true })

// ── 品牌色（与 src/styles.css 的设计令牌一致）──────────────────────
const C = {
  honey: '#F2A93B',
  honeyLight: '#F9C868',
  honeyDeep: '#DD8A18',
  honeyDark: '#B9740D',
  cream: '#FBF8F1',
  creamWarm: '#FFFCF2',
  amberInk: '#4A3208',
  ink: '#3A2A10',
}

/** 尖顶正六边形路径（蜂巢单元） */
function hexPath(cx, cy, s) {
  const pts = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90)
    pts.push(`${(cx + s * Math.cos(a)).toFixed(2)},${(cy + s * Math.sin(a)).toFixed(2)}`)
  }
  return `M ${pts.join(' L ')} Z`
}

/** 蜂巢纹理 pattern：尖顶六边形，平铺周期 横向 √3·s / 纵向 3s，四角+中心各一个即可无缝 */
function honeycomb({ id, s = 84, stroke = '#FFFFFF', opacity = 0.13, width = 11 }) {
  const w = Math.sqrt(3) * s
  const h = 3 * s
  const cells = [[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2]]
  const paths = cells.map(([x, y]) => `<path d="${hexPath(x, y, s)}"/>`).join('')
  return `<pattern id="${id}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" patternUnits="userSpaceOnUse">
      <g fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linejoin="round">${paths}</g>
    </pattern>`
}

/** maskable 变体：图形层整体缩到 0.82（留出比 0.4 半径更宽的余量） */
const MASKABLE_SCALE = 0.82
const maskableTransform = () =>
  `transform="translate(${(512 * (1 - MASKABLE_SCALE)).toFixed(2)} ${(512 * (1 - MASKABLE_SCALE)).toFixed(2)}) scale(${MASKABLE_SCALE})"`

// ══════════════════════════════════════════════════════════════════
// 方案 A：蜂巢蜜蜂（拟物友好）
// ══════════════════════════════════════════════════════════════════
const conceptA = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="aBg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${C.honeyLight}"/>
      <stop offset="0.52" stop-color="${C.honey}"/>
      <stop offset="1" stop-color="${C.honeyDeep}"/>
    </linearGradient>
    <radialGradient id="aGlow" cx="0.27" cy="0.16" r="0.78">
      <stop offset="0" stop-color="#FFE7B4" stop-opacity="0.72"/>
      <stop offset="1" stop-color="#FFE7B4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="aBody" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#FFFEFB"/>
      <stop offset="1" stop-color="#F8E5BF"/>
    </linearGradient>
    <clipPath id="aClipBody"><ellipse cx="512" cy="664" rx="176" ry="208"/></clipPath>
    ${honeycomb({ id: 'aHex', s: 84, opacity: 0.11, width: 11 })}
  </defs>

  <rect width="1024" height="1024" fill="url(#aBg)"/>
  <rect width="1024" height="1024" fill="url(#aHex)"/>
  <rect width="1024" height="1024" fill="url(#aGlow)"/>

  <g id="art">
    <g fill="#FFFFFF" fill-opacity="0.78">
      <ellipse cx="322" cy="470" rx="140" ry="92" transform="rotate(-22 322 470)"/>
      <ellipse cx="702" cy="470" rx="140" ry="92" transform="rotate(22 702 470)"/>
    </g>
    <g stroke="${C.amberInk}" stroke-width="20" fill="none" stroke-linecap="round">
      <path d="M472 336 C 452 282 418 258 392 248"/>
      <path d="M552 336 C 572 282 606 258 632 248"/>
    </g>
    <g fill="${C.amberInk}">
      <circle cx="388" cy="246" r="19"/>
      <circle cx="636" cy="246" r="19"/>
    </g>
    <ellipse cx="512" cy="664" rx="176" ry="208" fill="url(#aBody)"/>
    <g clip-path="url(#aClipBody)" fill="${C.amberInk}" fill-opacity="0.88">
      <rect x="300" y="600" width="424" height="62"/>
      <rect x="300" y="716" width="424" height="62"/>
    </g>
    <circle cx="512" cy="438" r="116" fill="url(#aBody)"/>
    <circle cx="466" cy="432" r="21" fill="${C.ink}"/>
    <circle cx="558" cy="432" r="21" fill="${C.ink}"/>
    <circle cx="472" cy="424" r="7" fill="#FFFFFF" fill-opacity="0.92"/>
    <circle cx="564" cy="424" r="7" fill="#FFFFFF" fill-opacity="0.92"/>
  </g>
</svg>`

// ══════════════════════════════════════════════════════════════════
// 方案 B：极简侧影蜜蜂（高辨识度）
// ══════════════════════════════════════════════════════════════════
const conceptB = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bBg" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="#F8C356"/>
      <stop offset="1" stop-color="#D97F0D"/>
    </linearGradient>
    <radialGradient id="bGlow" cx="0.5" cy="0.1" r="0.72">
      <stop offset="0" stop-color="#FFEEC0" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#FFEEC0" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="bClip"><ellipse cx="470" cy="606" rx="252" ry="152"/></clipPath>
  </defs>

  <rect width="1024" height="1024" fill="url(#bBg)"/>
  <rect width="1024" height="1024" fill="url(#bGlow)"/>

  <g id="art">
      <!-- 图形整体绕画布中心缩 3%：原始构图最远点距中心 413px，略超 maskable
           安全半径 410px（实测 14px 擦线），缩放后 400.6px 达标。0.97 与
           -16.65 = 0.97×545-512 配合，等效于"先 -33 平移再绕中心缩放" -->
    <g transform="translate(-16.65 -16.65) scale(0.97)">
      <ellipse cx="500" cy="410" rx="136" ry="78" transform="rotate(-20 500 410)" fill="#FFFFFF" fill-opacity="0.86"/>
      <ellipse cx="640" cy="452" rx="112" ry="64" transform="rotate(12 640 452)" fill="#FFFFFF" fill-opacity="0.62"/>
      <path d="M 252 576 L 156 606 L 252 648 Z" fill="${C.amberInk}" fill-opacity="0.92"/>
      <ellipse cx="470" cy="606" rx="252" ry="152" fill="${C.creamWarm}"/>
      <g clip-path="url(#bClip)" fill="${C.amberInk}" fill-opacity="0.86">
        <rect x="330" y="430" width="56" height="360"/>
        <rect x="452" y="430" width="56" height="360"/>
        <rect x="574" y="430" width="56" height="360"/>
      </g>
      <circle cx="742" cy="566" r="116" fill="${C.creamWarm}"/>
      <circle cx="790" cy="540" r="24" fill="${C.ink}"/>
      <circle cx="797" cy="531" r="8" fill="#FFFFFF" fill-opacity="0.88"/>
      <g stroke="${C.amberInk}" stroke-width="19" fill="none" stroke-linecap="round">
        <path d="M796 470 C 838 424 880 408 908 402"/>
        <path d="M736 456 C 758 408 776 388 792 372"/>
      </g>
      <g fill="${C.amberInk}">
        <circle cx="912" cy="400" r="18"/>
        <circle cx="796" cy="369" r="18"/>
      </g>
    </g>
  </g>
</svg>`

// ══════════════════════════════════════════════════════════════════
// 方案 C：D 字母徽标（品牌感）
// 奶油底 + 蜜色 D 字形，字腔里是一只小蜜蜂（D-Bee 的字面含义）
// ══════════════════════════════════════════════════════════════════
const conceptC = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="cBg" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#FFFDF8"/>
      <stop offset="1" stop-color="#F5E7CB"/>
    </linearGradient>
    <linearGradient id="cD" x1="0.12" y1="0" x2="0.88" y2="1">
      <stop offset="0" stop-color="#F9C868"/>
      <stop offset="0.5" stop-color="#EE9C22"/>
      <stop offset="1" stop-color="#C67C0E"/>
    </linearGradient>
    <clipPath id="cClipBee"><ellipse cx="520" cy="540" rx="54" ry="74"/></clipPath>
    ${honeycomb({ id: 'cHex', s: 96, stroke: C.honey, opacity: 0.09, width: 9 })}
  </defs>

  <rect width="1024" height="1024" fill="url(#cBg)"/>
  <rect width="1024" height="1024" fill="url(#cHex)"/>

  <g id="art">
    <g transform="translate(-30 0)">
      <!-- D 字形（evenodd 抠出字腔） -->
      <path d="M300 240 L512 240 A272 272 0 0 1 512 784 L300 784 Z M392 332 L512 332 A180 180 0 0 1 512 692 L392 692 Z"
            fill="url(#cD)" fill-rule="evenodd"/>

      <!-- 字腔里的小蜜蜂（呼应 D-Bee） -->
      <g>
        <ellipse cx="486" cy="452" rx="42" ry="25" transform="rotate(-24 486 452)" fill="${C.honey}" fill-opacity="0.8"/>
        <ellipse cx="554" cy="452" rx="42" ry="25" transform="rotate(24 554 452)" fill="${C.honey}" fill-opacity="0.6"/>
        <ellipse cx="520" cy="540" rx="54" ry="74" fill="${C.honeyDark}"/>
        <g clip-path="url(#cClipBee)" fill="${C.creamWarm}" fill-opacity="0.92">
          <rect x="456" y="520" width="130" height="20"/>
          <rect x="456" y="556" width="130" height="20"/>
        </g>
      </g>
    </g>
  </g>
</svg>`

const CONCEPTS = [
  { id: 'a', name: 'A · 蜂巢蜜蜂', desc: '拟物友好：蜜色底 + 蜂巢纹理 + 圆润正面蜜蜂', svg: conceptA() },
  { id: 'b', name: 'B · 极简侧影', desc: '高辨识：大色块 + 侧面蜜蜂剪影，无背景纹理', svg: conceptB() },
  { id: 'c', name: 'C · D 字母徽标', desc: '品牌感：奶油底 + 蜜色 D + 字腔小蜜蜂', svg: conceptC() },
]

// ── 变体生成 ────────────────────────────────────────────────────────
/** 隐藏图形层 -> 纯背景，用于与完整图做像素差 */
const bgOnly = (svg) => svg.replace('<g id="art">', '<g id="art" style="display:none">')
/** maskable 变体：图形层整体缩小 */
const maskable = (svg) => svg.replace('<g id="art">', `<g id="art" ${maskableTransform()}>`)

const SIZES = [512, 192, 96, 64, 32]
const CHECK_SIZE = 512

async function renderSvg(browser, svg, size, outPath) {
  // ⚠️ 必须每次新建并关闭 page：复用同一个 page 反复 setViewportSize + setContent
  //    + screenshot 会累积渲染状态，实测连续第 4 次左右 screenshot 直接卡到超时，
  //    与尺寸和 SVG 内容均无关（已用探针脚本复现定位）。
  const page = await browser.newPage()
  try {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      { waitUntil: 'load' }
    )
    await page.screenshot({ path: outPath, omitBackground: true, timeout: 20000 })
  } finally {
    await page.close()
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch {
    // playwright 包要求的 chromium 版本常与本地缓存不一致，退回缓存里已有的可执行文件
    const { readdirSync, existsSync } = await import('node:fs')
    const base = path.join(process.env.USERPROFILE || process.env.HOME, 'AppData', 'Local', 'ms-playwright')
    const dirs = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((x, y) => parseInt(y.split('-')[1], 10) - parseInt(x.split('-')[1], 10))
    let exe = null
    for (const d of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
        const p = path.join(base, d, rel)
        if (existsSync(p)) { exe = p; break }
      }
      if (exe) break
    }
    if (!exe) throw new Error(`找不到可用的 chromium，缓存目录: ${base}`)
    console.log(`（改用缓存 chromium: ${exe}）`)
    return chromium.launch({ executablePath: exe })
  }
}

async function render() {
  for (const c of CONCEPTS) writeFileSync(path.join(OUT_SVG, `concept-${c.id}.svg`), c.svg.trim() + '\n', 'utf8')
  console.log('已写出 SVG:')
  CONCEPTS.forEach((c) => console.log(`  concept-${c.id}.svg  (${c.name})`))

  const browser = await launchBrowser()

  for (const c of CONCEPTS) {
    for (const size of SIZES) {
      await renderSvg(browser, c.svg, size, path.join(OUT_PNG, `${c.id}-${size}.png`))
    }
    // maskable 变体
    await renderSvg(browser, maskable(c.svg), 512, path.join(OUT_PNG, `${c.id}-maskable.png`))
    // 安全区检查用的两张（完整 / 仅背景）
    await renderSvg(browser, c.svg, CHECK_SIZE, path.join(CHECK_DIR, `${c.id}-full.png`))
    await renderSvg(browser, bgOnly(c.svg), CHECK_SIZE, path.join(CHECK_DIR, `${c.id}-bg.png`))
    console.log(`  已渲染 ${c.name}`)
  }
  await browser.close()

  console.log('\n=== 安全区像素级自检（安全圆半径 = 画布 × 0.4）===')
  let allOk = true
  for (const c of CONCEPTS) {
    console.log(`方案 ${c.id}:`)
    try {
      execFileSync(PYTHON, [
        path.join(__dirname, 'check-safezone.py'),
        path.join(CHECK_DIR, `${c.id}-full.png`),
        path.join(CHECK_DIR, `${c.id}-bg.png`),
      ], { stdio: 'inherit' })
    } catch (e) {
      allOk = false // check 脚本以非零退出码表示超界
    }
  }
  console.log(allOk ? '\n=> 三套方案均满足 maskable 安全区' : '\n=> 有方案超界，需要调整构图')

  writePreviewHtml()
}

function maskCss(kind) {
  return { ios: 'border-radius:22.37%', circle: 'border-radius:50%', rounded: 'border-radius:16%', squircle: 'border-radius:28%' }[kind] || ''
}

function writePreviewHtml() {
  const cards = CONCEPTS.map((c) => {
    const realSizes = [192, 96, 64, 32]
      .map((s) => `<div class="sz"><img src="preview/${c.id}-${s}.png" width="${s}" height="${s}" alt=""><span>${s}px</span></div>`)
      .join('')
    const masks = ['ios', 'circle', 'rounded', 'squircle', 'none']
      .map((m) => `<div class="m"><img src="preview/${c.id}-192.png" width="104" height="104" style="${maskCss(m)}"><span>${m}</span></div>`)
      .join('')
    const maskableImg = `<div class="m"><img src="preview/${c.id}-maskable.png" width="104" height="104" style="border-radius:50%"><span>maskable(圆)</span></div>
      <div class="m"><img src="preview/${c.id}-maskable.png" width="104" height="104" style="border-radius:22.37%"><span>maskable(方)</span></div>`
    const homescreen = Array.from({ length: 4 }, () => `<div class="app"><img src="preview/${c.id}-192.png" width="60" height="60" style="border-radius:22.37%"><span>D-Bee</span></div>`).join('')
    const hero = `<div class="hero-wrap">
        <img class="hero" src="preview/${c.id}-512.png" width="280" height="280" style="border-radius:22.37%">
        <span class="safezone" title="Android maskable 安全区（直径 80%）"></span>
      </div>`
    return `<section class="card">
      <header><h2>${c.name}</h2><p>${c.desc}</p></header>
      <div class="stage">
        ${hero}
        <div class="col">
          <h3>遮罩适配</h3>
          <div class="row">${masks}${maskableImg}</div>
        </div>
      </div>
      <h3>小尺寸可读性（真实像素）</h3>
      <div class="row sizes">${realSizes}</div>
      <h3>主屏效果</h3>
      <div class="homescreen">${homescreen}</div>
    </section>`
  }).join('')

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>D-Bee 图标方案对比</title>
<style>
  :root{--bg:#FBF8F1;--ink:#2a2723;--ink2:#6b655c;--line:rgba(42,39,35,.12)}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       padding:40px 28px 72px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:26px;margin:0 0 6px}
  .lede{color:var(--ink2);margin:0 0 34px}
  .card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:26px 28px 30px;
        margin-bottom:26px;box-shadow:0 1px 2px rgba(42,39,35,.04),0 10px 30px rgba(42,39,35,.045)}
  .card header h2{font-size:19px;margin:0 0 2px}
  .card header p{color:var(--ink2);margin:0;font-size:13.5px}
  .stage{display:flex;gap:34px;align-items:center;flex-wrap:wrap;margin:22px 0 6px}
  .hero-wrap{position:relative;flex:0 0 auto}
  .hero{box-shadow:0 8px 26px rgba(42,39,35,.17)}
  .safezone{position:absolute;left:10%;top:10%;width:80%;height:80%;border:2px dashed rgba(60,45,20,.4);
            border-radius:50%;pointer-events:none}
  .col{flex:1 1 340px;min-width:280px}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink2);
     margin:20px 0 10px;font-weight:600}
  .row{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap}
  .m,.sz{display:flex;flex-direction:column;align-items:center;gap:7px}
  .m span,.sz span{font-size:11px;color:var(--ink2)}
  .m img{box-shadow:0 3px 12px rgba(42,39,35,.14)}
  .sizes{align-items:flex-end}
  .sz img{box-shadow:0 2px 8px rgba(42,39,35,.13)}
  .homescreen{display:flex;gap:20px;padding:18px 20px;border-radius:18px;
    background:linear-gradient(160deg,#d9d3c6,#bdb5a5)}
  .app{display:flex;flex-direction:column;align-items:center;gap:6px}
  .app span{font-size:11px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.35)}
  .note{margin-top:30px;font-size:13px;color:var(--ink2);border-top:1px solid var(--line);padding-top:18px}
  code{background:#f1ece1;padding:1px 6px;border-radius:6px;font-size:12.5px}
</style>
</head>
<body>
<div class="wrap">
  <h1>D-Bee · 自律蜜蜂 — App 图标方案</h1>
  <p class="lede">三套方向，均为矢量源文件，全部通过 maskable 安全区像素级自检。大图上的虚线圆 = Android 自适应图标安全区。</p>
  ${cards}
  <p class="note">
    矢量源文件：<code>design/icon/concept-a.svg</code> / <code>-b.svg</code> / <code>-c.svg</code>。
    选定后我会导出 PWA 全套尺寸（192 / 512 / maskable-512 / apple-touch 180 / favicon 64），
    替换 <code>public/</code> 下现有图标并部署实测。
  </p>
</div>
</body>
</html>`
  writeFileSync(path.join(__dirname, 'preview.html'), html, 'utf8')
  console.log('\n已生成对比预览: design/icon/preview.html')
}

await render()
