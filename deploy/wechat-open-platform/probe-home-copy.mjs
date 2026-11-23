/**
 * 抓取 d-bee.cn 官网渲染后的首屏可见文案（SPA，静态 HTML 只有 title）。
 * 用途：核实微信开放平台「应用简介」与官网介绍是否一一对应（平台审核会比对）。
 * 只读，不改任何仓库文件、不写盘（结果打印到 stdout）。
 */
import { createRequire } from 'node:module'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

function findCachedChrome() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
  let dirs = []
  try { dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)) } catch { return null }
  dirs.sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10))
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(base, d, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

const opts = {}
try { const b = await chromium.launch(); await b.close() }
catch {
  const exe = findCachedChrome()
  if (!exe) { console.error('找不到 chromium'); process.exit(4) }
  opts.executablePath = exe
}

const browser = await chromium.launch(opts)
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
await page.goto('https://d-bee.cn/', { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(1500)

const data = await page.evaluate(() => {
  const txt = document.body.innerText || ''
  const heads = [...document.querySelectorAll('h1,h2,h3')]
    .map((e) => (e.innerText || '').trim()).filter(Boolean)
  const paras = [...document.querySelectorAll('p')]
    .map((e) => (e.innerText || '').trim()).filter((s) => s.length > 4)
  return { title: document.title, heads: heads.slice(0, 20), paras: paras.slice(0, 25), bodyLen: txt.length }
})

console.log('=== title ===\n' + data.title)
console.log('\n=== h1/h2/h3 ===')
data.heads.forEach((h, i) => console.log(`  ${i + 1}. ${h.slice(0, 120)}`))
console.log('\n=== p 段落 ===')
data.paras.forEach((p, i) => console.log(`  ${i + 1}. ${p.slice(0, 200)}`))
console.log('\nbody 文本长度 = ' + data.bodyLen)

await browser.close()
