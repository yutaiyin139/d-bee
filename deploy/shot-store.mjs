/**
 * App Store 商店截图生成器（iPhone 6.3" 必填槽位：1179×2556）。
 *
 * 原理：起 vite dev → 逐个画面加载 store-preview.html?screen=xxx（已注入假 iOS 环境，
 * 付费墙按 App Store 形态渲染）→ viewport 393×852 @ deviceScaleFactor 3 = 1179×2556 精确截图。
 *
 * 用法：
 *   node deploy/shot-store.mjs            # 用已运行的 dev server（默认 localhost:5173）
 *   node deploy/shot-store.mjs --spawn    # 脚本自行拉起 dev server 再截图
 *   PORT=5174 node deploy/shot-store.mjs  # 指定已运行端口
 *
 * 输出：deploy/screenshots/store/iphone-{today,log,report,paywall,me}.png
 * ⚠️ 截图用演示数据（preview-mock.ts），非真实用户记录；价格 ¥18/¥128/¥298 为硬编码回退值，与 ASC 定价一致。
 */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, 'screenshots', 'store')
const PORT = process.env.PORT || '5173'
const BASE = `http://localhost:${PORT}/store-preview.html`
const SPAWN = process.argv.includes('--spawn')

// App Store 必填槽位：iPhone 6.3" = 1179×2556（viewport 393×852 × 3）
const VIEWPORT = { width: 393, height: 852 }
const SCALE = 3

const SHOTS = [
  ['today', '今日记录'],
  ['log', '记一餐'],
  ['report', '趋势报告'],
  ['paywall', '会员付费墙'],
  ['me', '我的'],
]

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
      process.exit(3)
    }
    return { executablePath: exe }
  }
}

async function waitForServer(url, timeoutMs = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {
      /* 还没起 */
    }
    await new Promise((res) => setTimeout(res, 600))
  }
  return false
}

let devProc = null
if (SPAWN) {
  console.log('拉起 vite dev server …')
  devProc = spawn('npm', ['run', 'dev', '--', '--port', PORT, '--strictPort'], {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
    detached: false,
  })
  const ok = await waitForServer(BASE)
  if (!ok) {
    console.error('dev server 启动超时')
    devProc?.kill()
    process.exit(4)
  }
} else {
  const ok = await waitForServer(BASE, 5000)
  if (!ok) {
    console.error(`未检测到 dev server（${BASE}）。先 npm run dev，或加 --spawn 让脚本自起。`)
    process.exit(5)
  }
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
const page = await ctx.newPage()

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

const results = []
for (const [screen, label] of SHOTS) {
  await page.goto(`${BASE}?screen=${screen}`, { waitUntil: 'networkidle' })
  // 等 tabbar 与各卡片渲染稳定（图表/动画留足时间）
  await page.waitForSelector('.tabbar', { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1400)
  const file = path.join(OUT, `iphone-${screen}.png`)
  await page.screenshot({ path: file, fullPage: false })
  results.push([screen, label, file])
  console.log(`✅ ${label.padEnd(6)} → ${path.relative(ROOT, file)}`)
}

await browser.close()
if (devProc) devProc.kill()

console.log('─'.repeat(48))
console.log(`共 ${results.length} 张，输出目录：${path.relative(ROOT, OUT)}`)
console.log(`目标尺寸：${VIEWPORT.width * SCALE}×${VIEWPORT.height * SCALE}（iPhone 6.3" 必填槽位）`)
if (errors.length) console.log(`页面报错 ${errors.length} 条：`, errors.slice(0, 3))
else console.log('页面报错：0 条')
