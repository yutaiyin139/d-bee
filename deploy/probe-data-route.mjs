// 数据路由探针：打开线上页面，抓取所有网络请求，判定数据实际发往哪里。
// 用法：node deploy/probe-data-route.mjs http://150.158.51.106/
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKSPACE = process.env.PW_WORKSPACE || 'C:/Users/yuty/.workbuddy/binaries/node/workspace/'
const require = createRequire(WORKSPACE)
const { chromium } = require('playwright')

/** 缓存的 chromium 兜底（与 verify-live.mjs 同款） */
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

const base = (process.argv[2] || 'http://150.158.51.106/').replace(/\/+$/, '')
const host = new URL(base).host

const browser = await chromium.launch(await launchOptions())
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } })
const page = await ctx.newPage()

const reqs = []
page.on('request', (r) => {
  const u = new URL(r.url())
  reqs.push({
    method: r.method(),
    host: u.host,
    path: u.pathname,
    sameOrigin: u.host === host,
  })
})

await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
await page.waitForTimeout(2500)

// 触发一次数据层请求：在当前位置跑一次 SDK 等价的 REST 调用
const probe = await page.evaluate(async () => {
  const out = { tried: [], note: '' }
  const candidates = ['/.cloud/auth/v1/user/me', '/.cloud/database/rest/v1/profiles?limit=1']
  for (const p of candidates) {
    try {
      const res = await fetch(p, { headers: { apikey: 'probe' } })
      out.tried.push({ path: p, status: res.status, server: res.headers.get('server') || '', acao: res.headers.get('access-control-allow-origin') || '' })
    } catch (e) {
      out.tried.push({ path: p, error: String(e).slice(0, 80) })
    }
  }
  out.note = 'fetch 由页面自身发起，相对路径 → 浏览器按当前 origin 拼绝对地址'
  return out
})

console.log('=== 对照组：页面来源 ===')
console.log('  origin            ', base)
console.log('  host              ', host)
console.log()
console.log('=== 页面加载期间的全部请求（按目标主机归类）===')
const byHost = new Map()
for (const r of reqs) {
  const k = r.host
  if (!byHost.has(k)) byHost.set(k, [])
  byHost.get(k).push(r)
}
for (const [h, list] of byHost) {
  const mark = h === host ? '【同源 · 本站】' : '【跨域 · 第三方】'
  console.log(`  ${mark} ${h}  —— ${list.length} 个请求`)
  const uniq = [...new Set(list.map((r) => `${r.method} ${r.path}`))]
  for (const u of uniq.slice(0, 12)) console.log(`      ${u}`)
  if (uniq.length > 12) console.log(`      ... 另外 ${uniq.length - 12} 个`)
}
console.log()

const cloudReqs = reqs.filter((r) => r.path.startsWith('/.cloud/') || r.path.startsWith('/auth/'))
console.log('=== 判定 ===')
console.log(`  指向 /.cloud/ 或 /auth/ 的请求：${cloudReqs.length} 个`)
console.log(`  其中同源（走本站 Nginx 反代）：${cloudReqs.filter((r) => r.sameOrigin).length} 个`)
console.log(`  其中直连云端域名（跨域）：${cloudReqs.filter((r) => !r.sameOrigin).length} 个`)
console.log()
console.log('=== 端到端探测（浏览器内发起，相对路径）===')
for (const t of probe.tried) {
  if (t.error) console.log(`  ${t.path}  → 失败: ${t.error}`)
  else console.log(`  ${t.path}  → HTTP ${t.status} | server=${t.server} | ACAO=${t.acao}`)
}
console.log()
console.log('  提示：HTTP 200/401/400 都说明请求已被服务端处理（401/400 是未带合法凭据的正常拒绝）；')
console.log('        若为 404 且响应体是 HTML，则说明请求没打到 API。')

await browser.close()
