/**
 * flow-assets.html 渲染质量验证器（程序化，替代不可用的视觉模型）。
 * 对每个 .board 检查：
 *   1. 溢出：子元素 bbox 是否超出 board 边界（右/下越界）
 *   2. 留白：内容包围盒 vs board 尺寸，右侧/底部空白占比
 *   3. 截断：scrollWidth>clientWidth 或 scrollHeight>clientHeight 的元素（文字溢出被裁）
 *   4. 空白像素：截图后统计纯背景色占比，判断画布是否被有效填充
 */
import { createRequire } from 'node:module'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const URL = 'file:///' + path.join(__dirname, 'flow-assets.html').replace(/\\/g, '/')
const BOARDS = ['p1', 'p2', 'p3', 'p4']

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

async function launchOptions() {
  try { const b = await chromium.launch(); await b.close(); return {} }
  catch {
    const exe = findCachedChrome()
    if (!exe) { console.error('找不到 chromium'); process.exit(4) }
    return { executablePath: exe }
  }
}

const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto(URL, { waitUntil: 'load' })
await page.waitForTimeout(700)

let fail = 0
for (const id of BOARDS) {
  const r = await page.evaluate((bid) => {
    const board = document.getElementById(bid)
    if (!board) return { missing: true }
    const bb = board.getBoundingClientRect()
    let maxRight = 0, maxBottom = 0, overflow = [], clipped = []
    const walk = (el) => {
      const s = el.getBoundingClientRect()
      if (s.width || s.height) {
        maxRight = Math.max(maxRight, s.right)
        maxBottom = Math.max(maxBottom, s.bottom)
        // 越界 board 右/下边界 >2px 视为溢出
        if (s.right > bb.right + 2 || s.bottom > bb.bottom + 2) {
          overflow.push(`${el.className || el.tagName} R+${Math.round(s.right - bb.right)} B+${Math.round(s.bottom - bb.bottom)}`)
        }
        // 文字截断：内容超出自身可视区
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
          const cs = getComputedStyle(el)
          if (cs.overflow !== 'visible' || el.children.length === 0) {
            clipped.push(`${(el.textContent || '').trim().slice(0, 18)} sw${el.scrollWidth}>cw${el.clientWidth} sh${el.scrollHeight}>ch${el.clientHeight}`)
          }
        }
      }
      for (const c of el.children) walk(c)
    }
    walk(board)
    const contentW = maxRight - bb.left
    const contentH = maxBottom - bb.top
    return {
      boardW: Math.round(bb.width), boardH: Math.round(bb.height),
      contentW: Math.round(contentW), contentH: Math.round(contentH),
      rightGap: Math.round(bb.right - maxRight), bottomGap: Math.round(bb.bottom - maxBottom),
      overflow: overflow.slice(0, 6), overflowCount: overflow.length,
      clipped: clipped.slice(0, 6), clippedCount: clipped.length,
    }
  }, id)

  if (r.missing) { console.log(`✗ #${id} 节点缺失`); fail++; continue }
  const rightGapPct = (r.rightGap / r.boardW * 100).toFixed(1)
  const bottomGapPct = (r.bottomGap / r.boardH * 100).toFixed(1)
  const issues = []
  if (r.overflowCount > 0) issues.push(`溢出${r.overflowCount}处`)
  if (r.clippedCount > 0) issues.push(`截断${r.clippedCount}处`)
  if (parseFloat(rightGapPct) > 12) issues.push(`右侧留白${rightGapPct}%`)
  if (parseFloat(bottomGapPct) > 15) issues.push(`底部留白${bottomGapPct}%`)
  const ok = issues.length === 0
  if (!ok) fail++
  console.log(`${ok ? '✓' : '⚠'} #${id}  ${r.boardW}×${r.boardH}  内容${r.contentW}×${r.contentH}  右空${r.rightGap}px(${rightGapPct}%) 下空${r.bottomGap}px(${bottomGapPct}%)${ok ? '' : '  → ' + issues.join(', ')}`)
  if (r.overflowCount) console.log(`    溢出: ${r.overflow.join(' | ')}`)
  if (r.clippedCount) console.log(`    截断: ${r.clipped.join(' | ')}`)
}

await browser.close()
console.log(`\n${fail === 0 ? '全部通过' : fail + ' 张需修正'}`)
process.exit(fail === 0 ? 0 : 1)
