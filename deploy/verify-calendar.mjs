/**
 * 首页周历交互验收：真实浏览器里验证
 *   1) 初始渲染一周 7 天，今天高亮
 *   2) 向左拖动 → 显示未来一周（日期 +7 天）
 *   3) 向右拖动 → 回到过去一周（日期 -7 天）
 *   4) 点右上角日期 → 打开月份日历弹层
 *   5) 在日历里选一天 → 顶部标签与周历同步
 *
 * 用法：先起 dev（端口 3000），再执行
 *   node deploy/verify-calendar.mjs [port]
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

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

const port = process.argv[2] || '3000'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const shotDir = path.join(__dirname, 'screenshots')
mkdirSync(shotDir, { recursive: true })

const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
const errors = []
const notFound = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url ?? '未知来源'}`)
})
page.on('pageerror', (e) => errors.push(String(e)))
page.on('response', (r) => {
  if (r.status() === 404) notFound.push(r.url())
})

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails.push(label)
}

const dayNums = () => page.$$eval('.ws-day .dn', (els) => els.map((e) => e.textContent))
const label = () => page.textContent('.date-label')

/** 在周历上横向拖动：dx<0 向左（未来），dx>0 向右（过去） */
async function dragStrip(dx) {
  const box = await page.locator('.week-strip').boundingBox()
  const y = box.y + box.height / 2
  const x0 = box.x + box.width / 2
  await page.mouse.move(x0, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (dx * i) / 8, y)
  await page.mouse.up()
  await page.waitForTimeout(450)
}

console.log(`=== 周历交互验收: http://localhost:${port}/preview.html ===\n`)

await page.goto(`http://localhost:${port}/preview.html`, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

console.log('--- 1) 初始状态 ---')
const first = await dayNums()
const firstLabel = (await label()).trim()
console.log(`  周历日号: ${first.join(' ')} · 顶部标签: ${firstLabel}`)
check('渲染 7 天', first.length === 7, `${first.length} 天`)
check('今天被高亮', (await page.locator('.ws-day.is-today').count()) === 1)
check('顶部初始显示「今天」', firstLabel.includes('今天'), firstLabel)
await page.screenshot({ path: path.join(shotDir, 'cal-1-initial.png') })

console.log('\n--- 2) 向左滑动（看未来）---')
await dragStrip(-120)
const afterLeft = await dayNums()
const leftLabel = (await label()).trim()
console.log(`  周历日号: ${afterLeft.join(' ')} · 顶部标签: ${leftLabel}`)
check('周历已切到未来一周', afterLeft.join() !== first.join(), `第 1 天 ${first[0]} → ${afterLeft[0]}`)
check('顶部标签变为具体日期', !leftLabel.includes('今天'), leftLabel)
const todayDom = new Date()
const expectFuture = new Date(todayDom.getFullYear(), todayDom.getMonth(), todayDom.getDate() + 7)
const expectFutureNum = String(expectFuture.getDate())
check('选中日 = 今天 +7 天', Number(afterLeft[expectFuture.getDay()]) === expectFuture.getDate(), `期望 ${expectFutureNum}`)
await page.screenshot({ path: path.join(shotDir, 'cal-2-swipe-left.png') })

console.log('\n--- 3) 向右滑动两次（看过去）---')
await dragStrip(120)
const backNums = await dayNums()
check('向右滑一次回到原周', backNums.join() === first.join(), `${backNums[0]} vs ${first[0]}`)
await dragStrip(120)
const pastLeft = await dayNums()
console.log(`  周历日号: ${pastLeft.join(' ')} · 顶部标签: ${(await label()).trim()}`)
check('再向右滑到过去一周', pastLeft.join() !== first.join(), `第 1 天 ${pastLeft[0]}`)

console.log('\n--- 4) 点右上角日期打开日历 ---')
await page.click('.date-label')
await page.waitForTimeout(450)
const dayCells = await page.locator('.mp-day').count()
check('弹层已打开且格子数合理', dayCells >= 28 && dayCells <= 42, `${dayCells} 个可选日`)
check('弹层标题正确', (await page.textContent('.sheet-head h2')).includes('选择日期'))
await page.screenshot({ path: path.join(shotDir, 'cal-3-picker.png') })

console.log('\n--- 5) 在日历里选一天 ---')
const target = (await page.getAttribute('.mp-day.is-selected', 'aria-label')) || ''
console.log(`  当前选中: ${target}`)
// 选当月的 1 号，验证顶部与周历同步
const firstOfMonth = (await page.$$('.mp-day'))[0]
const firstAria = await firstOfMonth.getAttribute('aria-label')
await firstOfMonth.click()
await page.waitForTimeout(450)
const pickedLabel = (await label()).trim()
const pickedNums = await dayNums()
console.log(`  点击 ${firstAria} → 顶部标签: ${pickedLabel} · 周历: ${pickedNums.join(' ')}`)
check('弹层已关闭', (await page.locator('.mp-day').count()) === 0)
const pickedDay = Number(firstAria.replace('选择 ', '').split('-')[2])
check('顶部标签与所选日期一致', pickedLabel.includes(`${Number(firstAria.split('-')[1])}月${pickedDay}日`), pickedLabel)
check('周历包含所选日', pickedNums.map(Number).includes(pickedDay), pickedNums.join(' '))
await page.screenshot({ path: path.join(shotDir, 'cal-4-after-pick.png') })

console.log('\n--- 6) 报错 ---')
if (notFound.length) console.log(`  404 资源: ${notFound.join(', ')}`)
check('无 console / page 报错', errors.length === 0, errors.slice(0, 3).join(' | ') || '0 条')

await browser.close()
console.log(`\n=== ${fails.length === 0 ? 'PASS' : 'FAIL: ' + fails.join('; ')} ===`)
process.exit(fails.length === 0 ? 0 : 1)
