/**
 * 隐私政策/用户协议 URL 深链自测（真实浏览器渲染）。
 *
 * 背景：商店上架（华为/小米/应用宝）、App 备案、ASC、微信开放平台都要求
 * 填报一个「能直达隐私政策正文」的公网 URL。此前 /legal/privacy 只是 nginx
 * SPA 回退到 index.html，前端靠 useState 驱动、不解析 URL → 审核员直接访问
 * 只会看到首页，等于「隐私政策不可直达」。App.tsx 已加 readLegalFromUrl，
 * 本脚本验证该深链真实渲染出文档正文。
 *
 * ⚠️ 依赖 playwright（非项目运行时依赖，仅测试用）。解析顺序：
 *    项目 node_modules → 全局 workspace node_modules。都没有则给出安装指引。
 * 运行：node tools/legal-deeplink-check.mjs [BASE_URL]
 *    默认 BASE_URL=http://150.158.51.106（生产）；也可测 http://localhost:5173
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const BASE = process.argv[2] ?? 'http://150.158.51.106'
const require = createRequire(import.meta.url)

// 解析 playwright：先项目内，再全局 workspace（本机托管运行时约定位置）
function loadChromium() {
  const candidates = [
    'playwright',
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.workbuddy/binaries/node/workspace/node_modules/playwright'),
  ]
  for (const c of candidates) {
    try {
      const mod = require(c)
      if (mod?.chromium) return mod.chromium
    } catch {
      /* 尝试下一个 */
    }
  }
  console.error('❌ 未找到 playwright。请任选其一安装后重试：')
  console.error('   npm i -D playwright            # 项目内')
  console.error('   或用已托管的全局 playwright（本脚本已自动探测 ~/.workbuddy/binaries/node/workspace）')
  process.exit(2)
}

const chromium = loadChromium()

/**
 * 定位可用的 Chromium 可执行文件。
 * 托管的 playwright 版本可能期望某个特定内核版本（如 1243），而本机装的是另一个
 * （如 1148）→ 直接 launch 会报 "Executable doesn't exist"。这里显式探测 ms-playwright
 * 下任意已装的 chromium，避开重复下载。可用 PLAYWRIGHT_CHROMIUM_PATH 覆盖。
 */
function resolveExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const roots = [
    path.join(home, 'AppData/Local/ms-playwright'), // Windows
    path.join(home, '.cache/ms-playwright'), // Linux
    path.join(home, 'Library/Caches/ms-playwright'), // macOS
  ]
  const rel = [
    'chrome-win/chrome.exe',
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    // 版本目录形如 chromium-1148 / chromium-1243，取最高版本
    const dirs = readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
    for (const d of dirs.reverse()) {
      for (const r of rel) {
        const exe = path.join(root, d, r)
        if (existsSync(exe)) return exe
      }
    }
  }
  return undefined // 交给 playwright 自行解析
}

// [路径, 期望标题, 类型]  类型 legal=应渲染文档；fallback=非法 id 应回落首页
const cases = [
  ['/legal/privacy', '隐私政策', 'legal'],
  ['/legal/terms', '用户协议', 'legal'],
  ['/legal/disclaimer', '免责声明', 'legal'],
  ['/legal/bogus', '', 'fallback'],
]

const launchOpts = { headless: true }
const exe = resolveExecutable()
if (exe) launchOpts.executablePath = exe

const browser = await chromium.launch(launchOpts)
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
let fail = 0

for (const [route, expectTitle, kind] of cases) {
  await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(1200)
  const overlay = await page.locator('.legal-overlay').count()
  const h1 = overlay ? await page.locator('.legal-head h1').first().innerText().catch(() => '') : ''
  const bodyLen = overlay ? (await page.locator('.legal-page').first().innerText().catch(() => '')).length : 0

  if (kind === 'legal') {
    // 正文 >500 字 = 真的渲染出文档内容，不是空壳
    const ok = overlay > 0 && h1.includes(expectTitle) && bodyLen > 500
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} ${route} → 「${h1.trim()}」正文 ${bodyLen} 字`)
  } else {
    const ok = overlay === 0
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} ${route} → 非法 id 回落首页（overlay=${overlay}）`)
  }
}

// 返回按钮：关文档 + URL 回首页
await page.goto(BASE + '/legal/privacy', { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(1000)
await page.locator('.legal-head .btn-text').first().click()
await page.waitForTimeout(800)
const backOk = (await page.locator('.legal-overlay').count()) === 0 && page.url().endsWith('/')
if (!backOk) fail++
console.log(`${backOk ? '✅' : '❌'} 返回按钮 → 关闭文档回首页（${page.url()}）`)

await browser.close()
console.log(fail ? `\n💥 ${fail} 项未通过` : '\n🎉 法律文档深链全部通过——隐私政策 URL 可对外填报')
process.exit(fail ? 1 : 0)
