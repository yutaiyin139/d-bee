/**
 * 微信开放平台「App 运行流程图」渲染器。
 *
 * 平台要求：最多 10 张，jpg/JPEG/bmp/gif/png，单张 ≤5MB。
 * 平台原文允许「APP运行流程图，或相关交互设计图、流程逻辑图等，
 * 能够说明该应用具体运营业务相关的图片」。
 *
 * 本脚本渲染的是【流程逻辑图】（非真机截图），因为：
 *   deploy/screenshots/store/*.png 是 Playwright + src/preview-mock.ts 演示数据生成的，
 *   shot-store.mjs:19 自述「截图用演示数据，非真实用户记录」→ 不符合「真实截图」要求。
 *
 * 渲染策略沿用项目既有模式（同 shot-creative.mjs）：
 *   CSS viewport = 目标像素 / scale，deviceScaleFactor = scale
 *   → 精确像素 + 文字矢量光栅化不糊。
 *
 * 用法：node deploy/wechat-open-platform/flow/render-flow.mjs
 * 输出：deploy/wechat-open-platform/flow/flow-0{1..4}-*.png
 */
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = __dirname
mkdirSync(OUT, { recursive: true })

const SCALE = 2 // 2x → 文字锐利；画板高自适应(≤1400)远低于 5MB 上限
const W = 1600
const H = 1400 // viewport 高于最大画板，确保 el.screenshot() 完整捕获

const PAGES = [
  { id: 'p1', file: 'flow-01-应用主业务流程图.png' },
  { id: 'p2', file: 'flow-02-AI拍照识别交互时序图.png' },
  { id: 'p3', file: 'flow-03-应用功能架构图.png' },
  { id: 'p4', file: 'flow-04-数据流转与合规链路图.png' },
]

const URL = 'file:///' + path.join(OUT, 'flow-assets.html').replace(/\\/g, '/')

/** 同 shot-creative.mjs:102 —— 默认 launch 失败时回落到 ms-playwright 缓存的 chrome.exe */
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
    console.log('↪ 回落缓存浏览器：' + exe)
    return { executablePath: exe }
  }
}

const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: SCALE,
})
const page = await ctx.newPage()
await page.goto(URL, { waitUntil: 'load' })
// 等字体与布局稳定
await page.waitForTimeout(700)

for (const p of PAGES) {
  const el = await page.$('#' + p.id)
  if (!el) { console.error('未找到节点 #' + p.id); continue }
  const out = path.join(OUT, p.file)
  await el.screenshot({ path: out, type: 'png' })
  console.log('✓ ' + p.file)
}

await browser.close()
console.log('完成，输出目录：' + OUT)
