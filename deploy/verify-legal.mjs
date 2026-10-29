/**
 * 合规页面线上验收：用真实浏览器核对
 *   1) 页脚是否存在「用户协议 / 隐私政策 / 免责声明」三个入口
 *   2) 三份文档页能否正常打开、标题与正文是否渲染
 *   3) 备案号未配置时**不得**出现任何「ICP备」字样
 *      （备案审核期间展示假备案号属违规，必须为空）
 *
 * 用法：
 *   node deploy/verify-legal.mjs http://150.158.51.106/
 *   node deploy/verify-legal.mjs https://d-bee.cn/
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

/* ── 0) 首次启动隐私同意门（P0 合规）─────────────────────────────
   华为/小米缺它直接拒审；OPPO 明确驳回过「首次必须在登录页面出现前独立弹框
   展示隐私政策」。这里把商店的硬性四要素逐条断言，不靠肉眼看截图。
   注意：本段必须在**全新 context**（无 localStorage）下跑，否则读不到门。 */
const gateCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ignoreHTTPSErrors: true,
})
const gatePage = await gateCtx.newPage()
const gateErrors = []
gatePage.on('pageerror', (e) => gateErrors.push(String(e)))

await gatePage.goto(target, { waitUntil: 'networkidle', timeout: 45000 })
await gatePage.waitForTimeout(1200)

console.log('--- 0) 首次启动隐私同意门 ---')
const gateVisible = await gatePage.locator('.privacy-gate').count()
console.log(`  .privacy-gate 渲染: ${gateVisible > 0 ? 'YES' : 'NO ← 商店会直接拒审'}`)

// ① 不可跳过 + 不默认勾选：不得存在任何 checkbox（尤其不能有 pre-checked 的）
const checkboxCount = await gatePage.locator('.privacy-gate input[type="checkbox"]').count()
const noCheckbox = checkboxCount === 0
console.log(`  ① 无默认勾选的 checkbox: ${noCheckbox ? 'YES' : `NO ← 发现 ${checkboxCount} 个`}`)

// ② 两个协议链接可点击、点了能打开全文
const linkTerms = gatePage.locator('.privacy-gate .privacy-link:has-text("用户协议")')
const linkPrivacy = gatePage.locator('.privacy-gate .privacy-link:has-text("隐私政策")')
const hasTermsLink = (await linkTerms.count()) > 0
const hasPrivacyLink = (await linkPrivacy.count()) > 0
console.log(`  ② 《用户协议》链接: ${hasTermsLink ? 'YES' : 'NO'} ｜ 《隐私政策》链接: ${hasPrivacyLink ? 'YES' : 'NO'}`)

let privacyDocOpened = false
if (hasPrivacyLink) {
  await linkPrivacy.first().click()
  await gatePage.waitForTimeout(700)
  const docTitle = await gatePage.locator('.legal-head h1').innerText().catch(() => '')
  privacyDocOpened = docTitle.includes('隐私政策')
  console.log(`     点击后打开文档「${docTitle}」: ${privacyDocOpened ? 'YES' : 'NO'}`)
  // 关闭文档后必须**回到**同意门（同意未给出前不放行）
  await gatePage.locator('.legal-head button:has-text("返回")').first().click().catch(() => {})
  await gatePage.waitForTimeout(500)
  const backToGate = (await gatePage.locator('.privacy-gate').count()) > 0
  console.log(`     关闭文档后回到同意门: ${backToGate ? 'YES' : 'NO ← 可能被绕过'}`)
}

// ③ 「同意」+「不同意并退出」两个按钮都在
const btnAgree = gatePage.locator('.privacy-gate .btn:has-text("同意并继续")')
const btnDecline = gatePage.locator('.privacy-gate .btn:has-text("不同意并退出")')
const hasAgree = (await btnAgree.count()) > 0
const hasDecline = (await btnDecline.count()) > 0
console.log(`  ③ 「同意并继续」按钮: ${hasAgree ? 'YES' : 'NO'} ｜ 「不同意并退出」按钮: ${hasDecline ? 'YES' : 'NO'}`)

// ④ 明示「点击同意即表示已阅读并同意」
const gateText = await gatePage.locator('.privacy-gate').innerText().catch(() => '')
const hasExplicitStatement = gateText.includes('即表示你已阅读并同意')
console.log(`  ④ 明示「点击同意即表示已阅读并同意」: ${hasExplicitStatement ? 'YES' : 'NO'}`)

// ⑤ 排版：卡片不溢出视口、文字无截断、按钮同排不换行（改文案后最易回归的三项）
const layout = await gatePage.evaluate(() => {
  const card = document.querySelector('.privacy-card')
  if (!card) return null
  const cr = card.getBoundingClientRect()
  const fits = cr.right <= window.innerWidth + 0.5 && cr.bottom <= window.innerHeight + 0.5
  const truncated = [...card.querySelectorAll('h1, p, button')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => el.innerText.slice(0, 16))
  const btns = [...document.querySelectorAll('.privacy-actions .btn')].map((b) => {
    const br = b.getBoundingClientRect()
    return { top: Math.round(br.top), h: Math.round(br.height), right: Math.round(br.right) }
  })
  const sameRow = btns.length === 2 && Math.abs(btns[0].top - btns[1].top) < 2
  const wrapped = btns.filter((b) => b.h > 56).length
  return { fits, overflow: card.scrollHeight > card.clientHeight + 1, truncated, sameRow, wrapped }
})
const layoutOk = !!layout && layout.fits && !layout.overflow && layout.truncated.length === 0 && layout.sameRow && layout.wrapped === 0
console.log(`  ⑤ 排版（卡片不溢出/文字无截断/按钮同排不换行）: ${layoutOk ? 'YES' : `NO ← ${JSON.stringify(layout)}`}`)

await gatePage.screenshot({ path: path.join(shotDir, `legal-${hostTag}-隐私同意门.png`), fullPage: false })

/* 0.5) 🔴 法律深链免同意放行 —— OPPO 的隐私政策自动化审核直接抓取该 URL，
   被同意门拦住 = 抓到空页 = 驳回「url 无法访问或不合规」。用全新 context 验证。 */
console.log('\n--- 0.5) 法律深链免同意放行（审核员/爬虫直达）---')
const deepCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })
const deepPage = await deepCtx.newPage()
const deepUrl = new URL('/legal/privacy', target).toString()
await deepPage.goto(deepUrl, { waitUntil: 'networkidle', timeout: 45000 })
await deepPage.waitForTimeout(900)
const deepTitle = await deepPage.locator('.legal-head h1').innerText().catch(() => '')
const deepBody = await deepPage.locator('.legal-body').innerText().catch(() => '')
const deepGateBlocked = (await deepPage.locator('.privacy-gate').count()) > 0
const deepLinkOk = deepTitle.includes('隐私政策') && deepBody.length > 400 && !deepGateBlocked
console.log(`  ${deepUrl}`)
console.log(`  未同意即读到全文: ${deepLinkOk ? 'YES' : 'NO'}（标题「${deepTitle}」正文 ${deepBody.length} 字，同意门遮挡 ${deepGateBlocked ? 'YES ← 会被驳回' : 'NO'}）`)

/* 0.6) SDK 公示完整性 —— OPPO 要求公示信息与全国 SDK 管理服务平台登记一致。
   这里断言真实链路涉及的每一方都出现在隐私政策正文里（含微信 OpenSDK：
   它已打进 APK，即使功能未开放也必须公示，「装了不说」是明确驳回项）。 */
console.log('\n--- 0.6) 第三方 SDK 公示完整性 ---')
const REQUIRED_PARTIES = [
  { name: '腾讯云（云基础设施）', probe: '腾讯云计算（北京）有限责任公司' },
  { name: '阿里云（短信）', probe: '阿里云短信服务' },
  { name: '网易（邮件）', probe: '网易' },
  { name: 'DeepSeek（AI 文本）', probe: '杭州深度求索人工智能基础技术研究有限公司' },
  { name: '阿里云百炼（AI 图像）', probe: 'Qwen-VL' },
  { name: 'Open Food Facts', probe: 'Open Food Facts' },
  { name: '微信 OpenSDK', probe: '微信 OpenSDK for Android' },
]
const sdkOk = {}
for (const p of REQUIRED_PARTIES) {
  const hit = deepBody.includes(p.probe)
  sdkOk[p.name] = hit
  console.log(`  ${p.name}: ${hit ? 'YES' : 'NO ← 缺失会被 OPPO 判「SDK 未明示」'}`)
}

// 同意门内点「同意并继续」后应放行进入应用（后续检查复用 gateCtx 的已同意状态）
if (hasAgree) {
  await btnAgree.first().click()
  await gatePage.waitForTimeout(1500)
  const gateGone = (await gatePage.locator('.privacy-gate').count()) === 0
  console.log(`\n  点「同意并继续」后同意门消失: ${gateGone ? 'YES' : 'NO'}`)
}
await deepCtx.close()

// 主检查复用「已同意」状态：先注入同意标记再 goto，否则同意门会挡住页脚与文档入口。
// 值必须与 src/content/legal.ts 的 LEGAL_UPDATED 一致（privacyConsent.ts 按此比对），
// 从构建产物里读出来而不是硬编码，避免文案改日期后这里静默失配。
const consentValue = await gatePage.evaluate(() => localStorage.getItem('privacy.agreed'))
console.log(`\n  同意标记 privacy.agreed = ${JSON.stringify(consentValue)}`)
if (consentValue) {
  await ctx.addInitScript((v) => {
    try { localStorage.setItem('privacy.agreed', v) } catch { /* 忽略 */ }
  }, consentValue)
}

console.log('\n--- 1) 页脚入口 ---')
await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(2200)

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
console.log(`  同意门 page error: ${gateErrors.length}`)
gateErrors.slice(0, 4).forEach((t) => console.log(`    · ${t.slice(0, 160)}`))

const gatePass =
  gateVisible > 0 &&
  noCheckbox &&
  hasTermsLink &&
  hasPrivacyLink &&
  privacyDocOpened &&
  hasAgree &&
  hasDecline &&
  hasExplicitStatement &&
  layoutOk &&
  gateErrors.length === 0
const sdkPass = deepLinkOk && Object.values(sdkOk).every(Boolean)

const pass =
  gatePass &&
  sdkPass &&
  hasFooter &&
  links.every((n) => linkState[n]) &&
  !icpVisible &&
  docChecks.every((d) => docOk[d.name]) &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0

console.log(`\n截图目录: ${shotDir}`)
console.log(`隐私同意门: ${gatePass ? 'PASS' : 'FAIL'} ｜ 深链放行+SDK公示: ${sdkPass ? 'PASS' : 'FAIL'}`)
console.log(`\n=== ${pass ? 'PASS' : 'FAIL'} ===`)
await gateCtx.close()
await browser.close()
process.exit(pass ? 0 : 1)
