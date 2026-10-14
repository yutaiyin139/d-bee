/**
 * 把选定的图标方案导出为 PWA 全套尺寸，写入 public/。
 *
 * 用法：
 *   node design/icon/export-pwa.mjs          # 默认导出方案 C
 *   node design/icon/export-pwa.mjs b        # 导出方案 B
 *
 * 产出（覆盖 public/ 下的同名文件）：
 *   icon-512.png            512×512   清单常规图标
 *   icon-192.png            192×192   清单常规图标（Android 主屏）
 *   icon-maskable-512.png   512×512   清单 maskable（Android 自适应，图形内缩留安全区）
 *   apple-touch-icon.png    180×180   iOS 添加到主屏幕（不透明背景）
 *   favicon.png              64×64    浏览器标签页
 *
 * ⚠️ 每个尺寸新建 page —— 复用同一 page 反复 setContent+screenshot 会卡死（见 build.mjs 注释）
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../../public')

/** maskable 图形层缩放：方案 C 内容最远点 364px，安全半径 409.6px，
 *  原图即可通过；再缩 0.94 让边界更宽松，同时视觉仍饱满 */
const MASKABLE_SCALE = 0.94

const planId = (process.argv[2] || 'c').toLowerCase()
const svgPath = path.join(__dirname, `concept-${planId}.svg`)
if (!existsSync(svgPath)) {
  console.error(`找不到 ${svgPath}`)
  process.exit(1)
}
const svg = readFileSync(svgPath, 'utf8')

const maskableSvg = svg.replace(
  '<g id="art">',
  `<g id="art" transform="translate(${(512 * (1 - MASKABLE_SCALE)).toFixed(2)} ${(512 * (1 - MASKABLE_SCALE)).toFixed(2)}) scale(${MASKABLE_SCALE})">`
)

/** 目标清单：文件名 -> [源 SVG, 边长, 是否强制不透明] */
const TARGETS = [
  ['icon-512.png', svg, 512, false],
  ['icon-192.png', svg, 192, false],
  ['icon-maskable-512.png', maskableSvg, 512, false],
  ['apple-touch-icon.png', svg, 180, true], // iOS 不支持透明，强制铺白底兜底
  ['favicon.png', svg, 64, false],
]

async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch {
    // playwright 包要求的 chromium 版本常与本地缓存不一致，退回缓存里已有的可执行文件
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

async function renderSvg(browser, markup, size, outPath, opaque) {
  const page = await browser.newPage()
  try {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
      { waitUntil: 'load' }
    )
    await page.screenshot({ path: outPath, omitBackground: !opaque, timeout: 20000 })
  } finally {
    await page.close()
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const browser = await launchBrowser()
console.log(`导出方案 ${planId.toUpperCase()} -> public/`)
for (const [name, markup, size, opaque] of TARGETS) {
  const out = path.join(OUT_DIR, name)
  await renderSvg(browser, markup, size, out, opaque)
  const bytes = readFileSync(out).length
  console.log(`  ${name.padEnd(24)} ${String(size).padStart(3)}×${String(size).padEnd(3)}  ${(bytes / 1024).toFixed(1)} KB`)
}
await browser.close()
console.log('完成')
