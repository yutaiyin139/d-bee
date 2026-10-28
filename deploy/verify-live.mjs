/**
 * D-Bee 线上验收脚本：用真实 Chromium 打开站点，核对
 *   1) 页面是否正常渲染出登录页
 *   2) 有无 console 报错 / 页面异常 / 请求失败
 *   3) endpoint 运行时策略是否生效 —— 即 /.cloud/ 与 /auth/ 请求
 *      是否都发往**当前页面的来源**（同源），而不是云端域名或其它来源
 *
 * 这是判断「自托管 + Nginx 反代」链路是否完好的最强证据：
 * 状态码 200 只能说明静态文件在，浏览器实测才能证明接口链路通。
 *
 * 用法：
 *   node deploy/verify-live.mjs http://150.158.51.106/
 *   node deploy/verify-live.mjs https://d-bee.cn/
 */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// playwright 装在 WorkBuddy 托管 Node 工作区里，用绝对路径解析（ESM 不认 NODE_PATH）
const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const target = process.argv[2]
if (!target) {
  console.error('用法: node deploy/verify-live.mjs <url>')
  process.exit(2)
}
const origin = new URL(target).origin

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const shotDir = path.join(__dirname, 'screenshots')
mkdirSync(shotDir, { recursive: true })
const shot = path.join(shotDir, `verify-${new URL(target).hostname.replace(/[^\w.-]/g, '_')}.png`)

/**
 * 本机 ms-playwright 缓存里的 chromium 版本常常与 playwright 包要求的版本不一致
 * （包要 1243、缓存只有 1148 之类），此时 launch 会直接抛「Executable doesn't exist」。
 * 这里扫描缓存目录，挑一个存在的 chrome 可执行文件兜底。
 */
function findCachedChrome() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
  let dirs = []
  try {
    dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))
  } catch {
    return null
  }
  // 版本号大的优先
  dirs.sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10))
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(base, d, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** 优先用 playwright 自带解析；失败则退回缓存里的 chromium */
async function launchOptions() {
  try {
    const b = await chromium.launch()
    await b.close()
    return {}
  } catch {
    const exe = findCachedChrome()
    if (!exe) {
      console.error('找不到可用的 chromium：playwright 自带解析失败，缓存里也没有')
      process.exit(3)
    }
    console.log(`（playwright 版本不匹配，改用缓存 chromium: ${exe}）`)
    return { executablePath: exe }
  }
}

const consoleErrors = []
const pageErrors = []
const failedRequests = []
const cloudHits = []       // 发往 /.cloud/ 或 /auth/ 的请求
const crossOriginCloud = [] // 其中跨源的（= endpoint 策略失效）

const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },       // iPhone 14 Pro 尺寸，贴近真机
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ignoreHTTPSErrors: true,
})
const page = await ctx.newPage()

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('requestfailed', (r) => {
  // 被浏览器主动 abort 的第三方埋点之类不算失败
  const err = r.failure()?.errorText || ''
  if (!/ERR_ABORTED/.test(err)) failedRequests.push(`${r.method()} ${r.url()} :: ${err}`)
})
page.on('request', (r) => {
  const u = r.url()
  if (/\/\.cloud\/|\/auth\/|\/\.cloud$/.test(new URL(u).pathname)) {
    const reqOrigin = new URL(u).origin
    cloudHits.push(`${r.method()} ${u}`)
    if (reqOrigin !== origin) crossOriginCloud.push(`${r.method()} ${u}  (来自 ${reqOrigin}，期望 ${origin})`)
  }
})

console.log(`=== 验收目标: ${target} ===\n`)
let bodyText = ''
try {
  await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(2500)
  bodyText = (await page.locator('body').innerText().catch(() => '')) || ''
  await page.screenshot({ path: shot, fullPage: false })
} catch (e) {
  console.log(`!! 页面加载异常: ${e.message}`)
}

const renderOk = /D-Bee|自律蜜蜂|登录|手机号|邮箱|微信/.test(bodyText)

console.log('--- 1) 渲染 ---')
console.log(`  页面文本长度: ${bodyText.length}`)
console.log(`  登录页特征命中: ${renderOk ? 'YES' : 'NO'}`)
console.log(`  文本前 120 字: ${bodyText.replace(/\s+/g, ' ').slice(0, 120)}`)

console.log('\n--- 2) 报错 ---')
console.log(`  console error: ${consoleErrors.length}`)
consoleErrors.slice(0, 8).forEach((t) => console.log(`    · ${t.slice(0, 160)}`))
console.log(`  page error   : ${pageErrors.length}`)
pageErrors.slice(0, 5).forEach((t) => console.log(`    · ${t.slice(0, 160)}`))
console.log(`  请求失败     : ${failedRequests.length}`)
failedRequests.slice(0, 8).forEach((t) => console.log(`    · ${t.slice(0, 160)}`))

console.log('\n--- 3) endpoint 运行时策略 ---')
console.log(`  发往云端接口的请求数: ${cloudHits.length}`)
cloudHits.slice(0, 6).forEach((t) => console.log(`    · ${t.slice(0, 140)}`))
console.log(`  其中跨源的: ${crossOriginCloud.length}`)
crossOriginCloud.forEach((t) => console.log(`    · !! ${t.slice(0, 160)}`))
if (cloudHits.length === 0) {
  console.log('    （本次未产生云端请求，无法据此判断；登录后复测更准确）')
}

console.log(`\n截图: ${shot}`)

const pass =
  renderOk &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  failedRequests.length === 0 &&
  crossOriginCloud.length === 0
console.log(`\n=== ${pass ? 'PASS' : 'FAIL'} ===`)
await browser.close()
process.exit(pass ? 0 : 1)
