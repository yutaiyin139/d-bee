/**
 * App Store「创意素材」（Creative Assets）生成器。
 *
 * ⚠️ 与 deploy/shot-store.mjs（设备截图槽位）是**两套独立资产**：
 *   · 设备截图 = App 界面实拍，iPhone 6.3"(1179×2556) / iPad 13"(2048×2732)，提审**必填**
 *   · 创意素材 = 横版营销图，产品页面标题 / 搜索结果版位，**选填**（iOS/iPadOS 27 起）
 *   两者比例不同（竖屏 0.46 vs 横版 1.78/1.5），**不可互相缩放**。
 *
 * 版位与尺寸（Apple《Creative assets specifications》现行口径）：
 *   16:9 通用素材        5244×2950  仅 PNG   （产品页面标题 / 搜索结果 二选一）
 *   3:2  搜索结果（最大） 3840×2560  PNG/JPEG
 *   3:2  搜索结果（最小） 1920×1280  PNG/JPEG
 *   硬性约束：不得含 alpha 通道或透明度 → 落盘前用 PIL 转 RGB（24-bit）。
 *
 * 渲染策略：CSS viewport = 目标像素 / 2，deviceScaleFactor = 2。
 *   5244×2950 → 2622×1475 @2x（2950/2=1475 整除；与 16:9 理论值 2949.75 差 0.25px，
 *   官方标注本身即为四舍五入值，以 5244×2950 为准）
 *   3840×2560 → 1920×1280 @2x；1920×1280 → 960×640 @2x
 *   页面全部用 vw 单位 → 同一份 DOM 等比适配两种画布比例，文字矢量光栅化不糊。
 *
 * 用法：
 *   node deploy/shot-creative.mjs              # 出全部 3 个尺寸（variant 0）
 *   node deploy/shot-creative.mjs --variants 3 # 每个尺寸出 3 个文案变体
 *   node deploy/shot-creative.mjs --only 16x9  # 只出 5244×2950
 *
 * 输出：deploy/screenshots/creative/
 *   creative-16x9-5244x2950-v{N}.png
 *   creative-3x2-3840x2560-v{N}.png
 *   creative-3x2-1920x1280-v{N}.png
 *
 * 依赖：playwright（全局 workspace，同 shot-store.mjs 的加载方式）+ Python PIL（去 alpha）。
 */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, 'screenshots', 'creative')
const PAGE = path.join(ROOT, 'creative-assets.html')

// 目标规格：key 用于 --only 过滤，ratio 驱动页面布局分支
const TARGETS = [
  { key: '16x9', ratio: '16x9', w: 5244, h: 2950, scale: 2, placement: '产品页面标题/搜索结果 通用素材（仅 PNG）' },
  { key: '3x2-max', ratio: '3x2', w: 3840, h: 2560, scale: 2, placement: '搜索结果图 · 最大' },
  { key: '3x2-min', ratio: '3x2', w: 1920, h: 1280, scale: 2, placement: '搜索结果图 · 最小' },
]

const onlyArg = (() => {
  const i = process.argv.indexOf('--only')
  return i > 0 ? process.argv[i + 1] : ''
})()
const variantsArg = (() => {
  const i = process.argv.indexOf('--variants')
  return i > 0 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 1) : 1
})()

const ACTIVE = onlyArg ? TARGETS.filter((t) => t.key.startsWith(onlyArg) || t.ratio === onlyArg) : TARGETS
if (ACTIVE.length === 0) {
  console.error(`--only ${onlyArg} 未匹配任何目标。可选：${TARGETS.map((t) => t.key).join(' / ')}`)
  process.exit(2)
}

if (!existsSync(PAGE)) {
  console.error(`找不到创意素材页：${PAGE}`)
  process.exit(3)
}

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

async function launchOptions() {
  try {
    const b = await chromium.launch()
    await b.close()
    return {}
  } catch {
    const exe = findCachedChrome()
    if (!exe) {
      console.error('找不到可用的 chromium')
      process.exit(4)
    }
    return { executablePath: exe }
  }
}

/** PIL 去 alpha：Apple 明确「不得含 alpha 通道或透明度」，带 alpha 的 PNG 会被拒收 */
function stripAlpha(file) {
  const py = process.env.PY || 'python'
  const code = `
import sys
from PIL import Image
p = sys.argv[1]
im = Image.open(p)
mode_before = im.mode
if mode_before != 'RGB':
    bg = Image.new('RGB', im.size, (251, 248, 241))  # --bg 品牌底色兜底
    if mode_before in ('RGBA', 'LA') or (mode_before == 'P' and 'transparency' in im.info):
        bg.paste(im.convert('RGBA'), mask=im.convert('RGBA').split()[-1])
    else:
        bg.paste(im.convert('RGB'))
    bg.save(p, 'PNG', optimize=True)
im2 = Image.open(p)
print(f'{mode_before}->{im2.mode} {im2.size[0]}x{im2.size[1]}')
`
  const r = spawnSync(py, ['-c', code, file], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`  ⚠️ 去 alpha 失败：${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
    return null
  }
  return (r.stdout || '').trim()
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch(await launchOptions())

const errors = []
const results = []

for (const t of ACTIVE) {
  const cssW = t.w / t.scale
  const cssH = t.h / t.scale
  console.log(`\n【${t.w}×${t.h}】${t.placement}`)
  console.log(`  viewport ${cssW}×${cssH} @${t.scale}x`)

  const ctx = await browser.newContext({
    viewport: { width: cssW, height: cssH },
    deviceScaleFactor: t.scale,
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${t.key}] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${t.key}] ${String(e)}`))

  for (let v = 0; v < variantsArg; v++) {
    const url = `file:///${PAGE.replace(/\\/g, '/')}?ratio=${t.ratio}&variant=${v}`
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    // 页面在所有图片解码 + fitPhones 后置 data-ready=1
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 }).catch(() => {
      console.log('  ⚠️ data-ready 超时，继续出图')
    })
    await page.waitForTimeout(900)

    const file = path.join(OUT, `creative-${t.ratio}-${t.w}x${t.h}-v${v}.png`)
    await page.screenshot({ path: file, fullPage: false })

    // 素材图必须铺满画布，检查是否有溢出/空白（手机组被裁是常见事故）
    const overflow = await page.evaluate(() => {
      const st = document.getElementById('stage')
      const stack = document.querySelector('.phone-stack')
      const phones = Array.from(document.querySelectorAll('.phone'))
      const sr = st.getBoundingClientRect()
      let worst = 0
      for (const p of phones) {
        const r = p.getBoundingClientRect()
        worst = Math.max(worst, r.right - sr.right, sr.left - r.left)
      }
      return {
        stageW: Math.round(sr.width),
        stackW: Math.round(stack.getBoundingClientRect().width),
        overflowPx: Math.round(worst),
        copyH: Math.round(document.querySelector('.copy').getBoundingClientRect().height),
        stageH: Math.round(sr.height),
      }
    })
    const flag = overflow.overflowPx > 2 ? ' ⚠️溢出' : ''
    console.log(
      `  ✅ v${v} → ${path.relative(ROOT, file)}` +
        `  [stage ${overflow.stageW}×${overflow.stageH}, 手机组 ${overflow.stackW}, 文案高 ${overflow.copyH}${flag}]`,
    )
    results.push([t.key, t.w, t.h, v, file])
  }
  await ctx.close()
}

await browser.close()

// 统一后处理：去 alpha（Apple 硬要求）
console.log('\n' + '─'.repeat(56))
console.log('去 alpha 通道（Apple：Images can\u2019t include alpha channels）')
for (const [, , , , file] of results) {
  const info = stripAlpha(file)
  if (info) console.log(`  ✅ ${path.basename(file)}  ${info}`)
}

console.log('─'.repeat(56))
console.log(`共 ${results.length} 张，输出目录：${path.relative(ROOT, OUT)}`)
for (const t of ACTIVE) {
  const n = results.filter((r) => r[0] === t.key).length
  console.log(`  ${t.w}×${t.h} (${t.ratio}): ${n} 张 · ${t.placement}`)
}
if (errors.length) console.log(`页面报错 ${errors.length} 条：`, errors.slice(0, 3))
else console.log('页面报错：0 条')
