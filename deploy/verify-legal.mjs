/**
 * 合规页面线上验收：用真实浏览器核对
 *   1) 页脚是否存在「用户协议 / 隐私政策 / 免责声明」三个入口
 *   2) 三份文档页能否正常打开、标题与正文是否渲染
 *   3) 备案号未配置时**不得**出现任何「ICP备」字样
 *      （备案审核期间展示假备案号属违规，必须为空）
 *
 * 用法：
 *   node deploy/verify-legal.mjs http://150.158.51.106/
 *   node deploy/verify-legal.mjs https://d-bee.com.cn/
 */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const target = process.argv[2]
if (!target) {
  console.error('用法: node deploy/verify-legal.mjs <url>')
  process.exit(2)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const shotDir = path.join(__dirname, 'screenshots')
mkdirSync(shotDir, { recursive: true })
const hostTag = new URL(target).hostname.replace(/[^\w.-]/g, '_')

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
    console.log(`（playwright 版本不匹配，改用缓存 chromium: ${exe}）`)
    return { executablePath: exe }
  }
}

const consoleErrors = []
const pageErrors = []

const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ignoreHTTPSErrors: true,
})
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))

console.log(`=== 合规页面验收: ${target} ===\n`)

await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(2200)

console.log('--- 1) 页脚入口 ---')
const footerText = await page.locator('.site-footer').innerText().catch(() => '')
const hasFooter = footerText.length > 0
console.log(`  .site-footer 存在: ${hasFooter ? 'YES' : 'NO'}`)
console.log(`  页脚文本: ${footerText.replace(/\s+/g, ' ').slice(0, 160)}`)

const links = ['用户协议', '隐私政策', '免责声明']
const linkState = {}
for (const name of links) {
  const n = await page.locator(`.site-footer button:has-text("${name}")`).count()
  linkState[name] = n > 0
  console.log(`  入口「${name}」: ${n > 0 ? 'YES' : 'NO'}`)
}

console.log('\n--- 2) 备案号占位检查 ---')
const bodyAll = (await page.locator('body').innerText().catch(() => '')) || ''
const icpVisible = /ICP备|京ICP|沪ICP|粤ICP/.test(bodyAll)
console.log(`  页面出现「ICP备」字样: ${icpVisible ? 'YES ← 未配置环境变量时不该出现' : 'NO（正确）'}`)

console.log('\n--- 3) 三份文档页 ---')
const docChecks = [
  { name: '用户协议', expect: '服务内容' },
  { name: '隐私政策', expect: '我们收集的信息' },
  { name: '免责声明', expect: '不构成医疗建议' },
]
const docOk = {}
for (const d of docChecks) {
  docOk[d.name] = false
  const btn = page.locator(`.site-footer button:has-text("${d.name}")`)
  if ((await btn.count()) === 0) {
    console.log(`  ${d.name}: 入口不存在，跳过`)
    continue
  }
  await btn.first().click()
  await page.waitForTimeout(700)

  const title = await page.locator('.legal-head h1').innerText().catch(() => '')
  const body = await page.locator('.legal-body').innerText().catch(() => '')
  const sections = await page.locator('.legal-body section').count()
  const expectHit = body.includes(d.expect)

  console.log(
    `  ${d.name}: 标题「${title}」 小节数 ${sections} 关键内容命中 ${expectHit ? 'YES' : 'NO'} 正文 ${body.length} 字`
  )
  docOk[d.name] = title === d.name && sections >= 3 && expectHit && body.length > 400

  await page.screenshot({
    path: path.join(shotDir, `legal-${hostTag}-${d.name}.png`),
    fullPage: false,
  })

  await page.locator('.legal-head button:has-text("返回")').first().click()
  await page.waitForTimeout(500)
}

console.log('\n--- 4) 报错 ---')
console.log(`  console error: ${consoleErrors.length}`)
consoleErrors.slice(0, 6).forEach((t) => console.log(`    · ${t.slice(0, 160)}`))
console.log(`  page error   : ${pageErrors.length}`)
pageErrors.slice(0, 4).forEach((t) => console.log(`    · ${t.slice(0, 160)}`))

const pass =
  hasFooter &&
  links.every((n) => linkState[n]) &&
  !icpVisible &&
  docChecks.every((d) => docOk[d.name]) &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0

console.log(`\n截图目录: ${shotDir}`)
console.log(`\n=== ${pass ? 'PASS' : 'FAIL'} ===`)
await browser.close()
process.exit(pass ? 0 : 1)
