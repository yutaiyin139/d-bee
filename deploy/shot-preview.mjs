/**
 * 首页顶部改版截图：vite dev 已启动后运行
 *   node deploy/shot-preview.mjs [port]
 */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

/** 缓存里挑一个可用的 chromium（与 verify-live.mjs 同款兜底） */
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

const port = process.argv[2] || '5173'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true })

const browser = await chromium.launch(await launchOptions())
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
await page.goto(`http://localhost:${port}/preview.html`, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

await page.screenshot({ path: path.join(__dirname, 'screenshots', 'preview-top.png'), fullPage: false })
await page.screenshot({ path: path.join(__dirname, 'screenshots', 'preview-full.png'), fullPage: true })

// 记录页：打开「记一餐」→ 切到「食物库」→ 选「更健康」排序，验证标签与排序
let logProbe = null
try {
  await page.getByRole('button', { name: /记一餐/ }).click()
  await page.waitForSelector('.sheet', { timeout: 5000 })
  const budgetText = await page.locator('.budget-hint').textContent()
  await page.getByRole('button', { name: '食物库' }).click()
  await page.waitForTimeout(300)
  await page.locator('.chips').getByRole('button', { name: '更健康' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(__dirname, 'screenshots', 'preview-logsheet.png'), fullPage: false })
  logProbe = {
    budget: budgetText?.trim() ?? '(无)',
    tags: await page.locator('.ftag').count(),
    firstFoods: await page.locator('.food-row .nm').allTextContents().then((a) => a.slice(0, 6)),
  }
  await page.keyboard.press('Escape')
  await page.locator('.sheet-close').click().catch(() => {})
} catch (e) {
  logProbe = { error: String(e) }
}

// 关键新模块是否真的渲染出来（截图看不出「有数据但没渲染」的差别）
const probe = await page.evaluate(() => ({
  checkup: !!document.querySelector('.checkup'),
  checkupRows: document.querySelectorAll('.cg-row').length,
  miniTrend: document.querySelectorAll('.mt-col').length,
  advice: document.querySelector('.advice-strip')?.textContent?.trim() ?? '',
  exerciseChips: document.querySelectorAll('.chips-scroll .chip').length,
  footer: !!document.querySelector('.site-footer'),
  tags: document.querySelectorAll('.ftag').length,
}))

await browser.close()
console.log('saved deploy/screenshots/preview-top.png + preview-full.png + preview-logsheet.png')
console.log('渲染探针:', JSON.stringify(probe, null, 2))
console.log('记录页探针:', JSON.stringify(logProbe, null, 2))
if (errors.length) console.log('页面报错:', errors.slice(0, 3))
else console.log('页面报错: 0 条')
