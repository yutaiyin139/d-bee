/**
 * 合规页面线上验收：用真实浏览器核对
 *   1) 页脚是否存在「用户协议 / 隐私政策 / 免责声明」三个入口
 *   2) 三份文档页能否正常打开、标题与正文是否渲染
 *   3) 备案号**双向**校验。期望值按与 SITE.icp **完全同一条解析链**取得：
 *      EXPECT_ICP 环境变量 > .env 的 VITE_ICP_BEIAN（覆盖口）> @dbee/shared 的
 *      ICP_BEIAN_D_BEE_CN（默认真相源，四端同源）
 *        · 期望非空 → 页面**必须**逐字出现该号；出现别的「ICP备」号即 FAIL
 *          （防「-1 官网号填进 -2 自律蜜蜂站」这类域名错配，备案号须与域名一一对应）
 *        · 期望为空 → 页面**不得**出现任何「ICP备」字样（展示假备案号属违规）
 *      🔴 2026-11-06 起由单向「必须不出现」改为双向：ICP 已下证
 *         （京ICP备2026075565号-2 / 自律蜜蜂 / d-bee.cn）。
 *      ⚠️ 若期望非空而线上不出现，通常是**生产尚未用新代码重新构建部署**，
 *         不是页面 bug —— 此时会明确提示，可用 EXPECT_ICP= 临时按旧产物验收。
 *   4) 首启隐私同意门四要素 + 排版（华为/小米/OPPO 硬性拒审项）
 *   5) 法律深链免同意放行（审核员/爬虫直达 /legal/privacy 须能读全文）
 *   6) 第三方 SDK 公示完整性（与真实链路涉及的每一方逐条比对）
 *   7) 公示 URL 可达性（每条第三方链接真实可达，防死链/错误主体）
 *
 * 用法：
 *   node deploy/verify-legal.mjs https://d-bee.cn/
 *   node deploy/verify-legal.mjs https://www.d-bee.cn/
 *   🔴 别再用 http://150.158.51.106/ —— 2026-11-06 上 HTTPS 后，certbot 的跳转块
 *      只对域名做 301，IP 直连 HTTP 落 return 404，验收会全项 FAIL（不是页面 bug）。
 * 环境变量：
 *   CHECK_URLS=0  跳过第 7 项联网校验（无外网的 CI 用）
 */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'

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

/**
 * 期望的 ICP 备案号（第 3 项校验的基准）。
 *
 * 🔴 **不在这里复制 SITE.icp 的解析链**（那会变成第三份实现，必然漂移）。
 *   改为用 vite `ssrLoadModule` 直接取 `src/content/legal.ts` 导出的 `SITE.icp`
 *   —— 即页脚**实际会渲染的那个值**，与 tools/gen-legal-static.mjs:187 同一范式。
 *   这样「校验的期望值」与「渲染的真值」在语言层面就是同一个对象，不可能不一致。
 *
 *   ⚠️ 为什么不能直接 `import { ICP_BEIAN_D_BEE_CN } from '@dbee/shared'`：
 *      实测报 ERR_UNSUPPORTED_DIR_IMPORT —— shared 的 dist 用目录式 re-export
 *      （`export * from './constants'`，无扩展名），只有 vite/webpack 能解析，
 *      裸 Node ESM 不行。且那样取的是 shared 常量、**绕过**了 .env 覆盖口，
 *      与实际渲染值可能不同 → 又是复制解析链。
 *
 *   mode 固定 'production'：与 `vite build` 一致，才能读到 `.env.production` 与
 *   构建期传入的 `VITE_ICP_BEIAN`（同 gen-legal-static.mjs 的注释理由）。
 *
 * 优先级：显式 EXPECT_ICP 环境变量（传 '' = 按未备案口径验收旧产物）> SITE.icp。
 */
async function resolveExpectedIcp() {
  if (process.env.EXPECT_ICP !== undefined) {
    return { value: process.env.EXPECT_ICP.trim(), source: 'EXPECT_ICP 环境变量' }
  }
  const server = await createServer({
    root: path.join(__dirname, '..'),
    mode: 'production',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  })
  try {
    const mod = await server.ssrLoadModule('/src/content/legal.ts')
    const v = String(mod?.SITE?.icp ?? '').trim()
    if (!v) {
      return { value: '', source: 'SITE.icp 为空（.env 与 shared 常量都未提供）' }
    }
    return { value: v, source: 'SITE.icp（vite ssrLoadModule 实取，= 页脚真实渲染值）' }
  } finally {
    await server.close()
  }
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
// 🔴 深链命中的可能是**两种不同结构**，选择器必须都兼容：
//   ① SPA 路由页（React 渲染）：.legal-head h1 + .legal-body（见 src/pages/LegalPage.tsx）
//   ② 静态预渲染页（tools/gen-legal-static.mjs 产出，nginx 直接命中
//      /legal/privacy/index.html）：<h1> 直挂 + .intro/.meta/.nav，**没有** legal-body
//   只认 ① 会让 ② 读到 0 字 → 误报「深链被同意门拦住」+ 连带 0.6 SDK 公示全 NO。
//   而 OPPO 审核抓的恰恰是静态页（爬虫不跑 JS），② 才是真实审核路径，
//   所以这里优先取 ①、取不到退回 ②（body 全文），而不是反过来。
const deepTitle = await deepPage.evaluate(() => {
  const h = document.querySelector('.legal-head h1') || document.querySelector('h1')
  return (h?.textContent || '').trim()
}).catch(() => '')
const deepBody = await deepPage.evaluate(() => {
  const spa = document.querySelector('.legal-body')
  if (spa && spa.innerText.trim().length > 200) return spa.innerText
  // 静态页：取 body 全文（剔除导航/页脚噪声后仍以全文为准，宁多勿漏）
  return document.body ? document.body.innerText : ''
}).catch(() => '')
// 结构标识：便于输出里看清命中的是哪一种（排查时不用再猜）
const deepKind = await deepPage.evaluate(() =>
  document.querySelector('.legal-body') ? 'SPA 路由页' : '静态预渲染页').catch(() => '?')
const deepGateBlocked = (await deepPage.locator('.privacy-gate').count()) > 0
const deepLinkOk = deepTitle.includes('隐私政策') && deepBody.length > 400 && !deepGateBlocked
console.log(`  ${deepUrl}`)
console.log(`  命中结构: ${deepKind}（爬虫不跑 JS → 静态页才是 OPPO 实际审核路径）`)
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

/* 0.7) 公示 URL 可达性 —— 隐私政策里给出的每一条第三方隐私政策/协议链接都必须真实可达。
   死链（404）或指向错误主体（如把国内小程序引到 English-only、适用境外主体的政策页）
   会被审核判「公示链接无效/不合规」。此前网易 163 链接失效即因缺这道断言而漏网。
   默认联网校验；CI 无外网或想跳过时设 CHECK_URLS=0。 */
const CHECK_URLS = process.env.CHECK_URLS !== '0'
let urlsOk = true
if (CHECK_URLS) {
  console.log('\n--- 0.7) 公示 URL 可达性 ---')
  // 从渲染后的正文里抓全部 http(s) 链接（去重）。deepBody 为隐私政策全文 innerText。
  const found = [...new Set((deepBody.match(/https?:\/\/[^\s，、；）)]+/g) || [])
    .map((u) => u.replace(/[.,]+$/, '')))]
  if (found.length === 0) {
    urlsOk = false
    console.log('  ⚠️ 正文未提取到任何 URL（隐私政策应公示第三方链接）')
  }
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  for (const u of found) {
    let code = 0
    try {
      const r = await fetch(u, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA } })
      code = r.status
    } catch (e) {
      console.log(`  ERR  ${u}  ← ${String(e).slice(0, 80)}`)
      urlsOk = false
      continue
    }
    const ok = code >= 200 && code < 400
    if (!ok) urlsOk = false
    console.log(`  ${ok ? 'OK ' : 'BAD'} ${code}  ${u}`)
  }
} else {
  console.log('\n--- 0.7) 公示 URL 可达性 ---（CHECK_URLS=0，跳过）')
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

console.log('\n--- 2) 备案号校验（双向）---')
const bodyAll = (await page.locator('body').innerText().catch(() => '')) || ''
const expectedIcp = await resolveExpectedIcp()
console.log(`  期望值: ${expectedIcp.value || '(空 = 未备案口径)'}  ← 取自 ${expectedIcp.source}`)

// 页面上真实出现的备案号（可能为空、可能与期望不符）
// 省份简称用标准全称：京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新
const ICP_RE =
  /[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新]ICP备\d{6,}号(?:-\d+)?/g
const icpFound = [...new Set(bodyAll.match(ICP_RE) ?? [])]
const icpAnyVisible = /ICP备|京ICP|沪ICP|粤ICP/.test(bodyAll)

let icpOk
if (expectedIcp.value) {
  // 已备案口径：必须逐字出现期望号
  const shown = bodyAll.includes(expectedIcp.value)
  icpOk = shown
  if (shown) {
    console.log(`  页面出现「${expectedIcp.value}」: YES（正确）`)
    // 额外防错配：出现了期望号之外的其他备案号 = 域名/主体错配
    const wrong = icpFound.filter((n) => n !== expectedIcp.value)
    if (wrong.length) {
      icpOk = false
      console.log(`  🔴 同时出现**其他**备案号: ${wrong.join('、')} —— 备案号须与域名一一对应，疑似错填`)
    }
  } else {
    // 🔴 两种失败的**根因完全不同**，诊断必须分开，否则会把「填错号」误报成「没部署」：
    //   A) 页面有别的备案号 → 号填错了（域名/主体错配，合规问题，改代码）
    //   B) 页面完全没有号 → 生产产物还是旧的（部署问题，重新构建部署）
    if (icpFound.length) {
      console.log('  🔴 页面出现的是**别的**备案号，与期望不符')
      console.log(`     期望: ${expectedIcp.value}`)
      console.log(`     实际: ${icpFound.join('、')}`)
      console.log(
        '     这是**填错号**（不是部署问题）：备案号须与域名一一对应。' +
          '\n     本项目 d-bee.cn（自律蜜蜂）= 京ICP备2026075565号-2；' +
          '\n     京ICP备2026075565号-1 是 d-bee.com.cn（门户网站）的号，**不可**用于本站。',
      )
    } else if (icpAnyVisible) {
      console.log('  🔴 页面有「ICP备」字样但未匹配到完整备案号 —— 可能被截断或格式异常，请人工核对')
    } else {
      console.log('  🔴 页面完全没有任何备案号')
      console.log('     最可能原因：生产产物还是旧的 —— 备案号已进代码（shared 常量）但未重新构建部署。')
      console.log('     确认命令：curl -s <线上 index-*.js> | grep -o "京ICP备[0-9]*号-[0-9]"')
      console.log('     （注意 webpack 会把中文转义成 \\uXXXX，grep 不到时改用 unicode_escape 解码后再搜）')
      console.log('     若确实要按旧产物验收，用 EXPECT_ICP="" 显式声明未备案口径。')
    }
  }
} else {
  // 未备案口径：不得出现任何「ICP备」字样
  icpOk = !icpAnyVisible
  console.log(
    `  页面出现「ICP备」字样: ${icpAnyVisible ? `YES ← 未配置时不该出现（${icpFound.join('、') || '?'}）` : 'NO（正确）'}`,
  )
}

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
const sdkPass = deepLinkOk && Object.values(sdkOk).every(Boolean) && urlsOk

const pass =
  gatePass &&
  sdkPass &&
  hasFooter &&
  links.every((n) => linkState[n]) &&
  icpOk &&
  docChecks.every((d) => docOk[d.name]) &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0

console.log(`\n截图目录: ${shotDir}`)
console.log(`隐私同意门: ${gatePass ? 'PASS' : 'FAIL'} ｜ 深链放行+SDK公示: ${sdkPass ? 'PASS' : 'FAIL'}`)
console.log(`\n=== ${pass ? 'PASS' : 'FAIL'} ===`)
await gateCtx.close()
await browser.close()
process.exit(pass ? 0 : 1)
