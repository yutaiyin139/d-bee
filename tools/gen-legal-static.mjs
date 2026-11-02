/**
 * 生成法律文档的**静态 HTML**（`dist/legal/{terms,privacy,disclaimer}/index.html`）。
 *
 * 为什么必须有它（2026-11-02 整改，Android 清单 §4.5）：
 *   `/legal/privacy` 此前只是 nginx SPA 回退到 `index.html`，正文由 React 在
 *   **客户端渲染** —— 无 JS 的爬虫拿到的是空 `<div id="root">`。OPPO 明确要求隐私政策
 *   「不能是 PDF/图片/需登录/需 JS 渲染，否则自动化审核爬取失败 → 驳回」；工信部备案、
 *   各安卓商店、微信开放平台填报的隐私政策 URL 同样会被机器抓取。
 *   产出静态页后，审核爬虫**零 JS 即可读到全文**。
 *
 * 关键设计：
 *   1. **单一真源**：文本不手抄第二份，用 vite `ssrLoadModule` 直接加载
 *      `src/content/legal.ts` 的 DOCS / SITE —— 改法律文本只需改那一处，重跑构建即同步。
 *      手抄副本必然漂移，而「隐私政策与实际不符」是比「爬不到」更严重的合规问题。
 *   2. **零 JS、内联 CSS、无外部资源**：保证任何 UA（含 curl）都能拿到完整正文；
 *      不引打包后的 `/assets/*.js`，避免「静态页反而依赖 JS」的自相矛盾。
 *   3. **目录 + index.html**（而非 `privacy.html`）：对外填报 URL 保持 `/legal/privacy`
 *      不变，nginx `try_files $uri $uri/ /index.html` 的 `$uri/` 分支会命中目录 index；
 *      同时 SPA 路由（`src/lib/legalRoute.ts` 的正则允许尾斜杠）行为不变，两套并存。
 *
 * 运行：
 *   node tools/gen-legal-static.mjs            # 默认输出 dist/legal
 *   node tools/gen-legal-static.mjs <outDir>   # 指定输出目录
 *   已串入 `npm run build`（web 生产构建）；原生包构建（build:native*）**不**串入 ——
 *   原生端法律文档由 React 在 App 内渲染（PrivacyGate / LegalPage），不需要静态页。
 *
 * ⚠️ mode 固定 'production'：与 `vite build` 一致，才能读到 `.env.production` 与
 *    构建期传入的 `VITE_ICP_BEIAN` / `VITE_SITE_OPERATOR` 等变量。用 dev mode 会漏读，
 *    导致备案号「构建时明明传了、静态页却没有」这类静默偏差。
 */
import { createServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist', 'legal')

/** HTML 文本转义。法律文本虽由我们自己维护，仍按纪律转义（防注入 / 防 `&`、`<` 破坏结构）。 */
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

/** 段落数组 → <p>...</p>；空数组返回 ''（避免产出空标签） */
function paragraphs(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return list.map((t) => `<p>${esc(t)}</p>`).join('\n')
}

/** 条目数组 → <ul><li>；空数组返回 '' */
function bulletList(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return `<ul>\n${list.map((t) => `        <li>${esc(t)}</li>`).join('\n')}\n      </ul>`
}

/**
 * 单份文档 → 完整 HTML 页面。
 * 内联样式取自站点视觉（米白底 + 蜂蜜色标题），但不依赖 /assets/*.css ——
 * 打包后的 CSS 文件名带 hash，硬引用会在下次构建后失效。
 */
function renderDoc(doc, site, allDocs) {
  const others = allDocs
    .filter((d) => d.id !== doc.id)
    // 站内互链带尾斜杠：直达目录 index，省掉 nginx 的一次 301
    .map((d) => `<a href="/legal/${esc(d.id)}/">${esc(d.title)}</a>`)
    .join(' ｜ ')

  const sections = doc.sections
    .map(
      (s) => `      <section>
        <h2>${esc(s.h)}</h2>
${paragraphs(s.p)}
${bulletList(s.list)}
      </section>`,
    )
    .join('\n')

  // 备案号：未下发时整块不渲染（展示假备案号属违规，口径与 src/components/SiteFooter.tsx 一致）
  const beian = site.icp
    ? `<p><a href="${esc(site.icpUrl)}" target="_blank" rel="noreferrer noopener">${esc(site.icp)}</a></p>`
    : ''
  const police = site.police
    ? `<p><a href="${esc(site.policeUrl)}" target="_blank" rel="noreferrer noopener">${esc(site.police)}</a></p>`
    : ''
  const operatorAddr = site.operatorAddress ? `（注册地址：${esc(site.operatorAddress)}）` : ''

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="index, follow" />
    <meta name="description" content="${esc(site.name)}（${esc(site.nameEn)}）${esc(doc.title)}全文，运营主体：${esc(site.operator)}。" />
    <title>${esc(doc.title)} · ${esc(site.name)} ${esc(site.nameEn)}</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0; padding: 24px 18px 48px; background: #fbf8f1; color: #2b2417;
        font: 16px/1.85 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei",
          "Helvetica Neue", Arial, sans-serif;
        -webkit-text-size-adjust: 100%;
      }
      main { max-width: 760px; margin: 0 auto; }
      h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.4; color: #6b4a08; }
      .meta { margin: 0 0 22px; font-size: 13.5px; color: #7a6b52; }
      .intro {
        margin: 0 0 24px; padding: 14px 16px; background: #fff;
        border-left: 3px solid #e0a83c; border-radius: 8px; font-size: 15.5px; color: #463a26;
      }
      section { margin: 0 0 22px; }
      h2 { margin: 0 0 10px; font-size: 18px; color: #6b4a08; }
      p { margin: 0 0 10px; }
      ul { margin: 0 0 10px; padding-left: 22px; }
      li { margin-bottom: 8px; }
      a { color: #a06c07; text-decoration: underline; word-break: break-all; }
      footer {
        margin-top: 34px; padding-top: 18px; border-top: 1px solid #e8ddc6;
        font-size: 13.5px; color: #7a6b52;
      }
      footer p { margin: 0 0 8px; }
      .nav { font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${esc(doc.title)}</h1>
      <p class="meta">${esc(site.name)}（${esc(site.nameEn)}）${esc(site.version ? ' · ' + site.version : '')} · 最近更新：${esc(doc.updated)}</p>
      <p class="intro">${esc(doc.intro)}</p>
${sections}
      <footer>
        <p class="nav">其他文档：${others}</p>
        <p>运营主体：${esc(site.operator)}${operatorAddr}</p>
        <p>联系方式：<a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a></p>
${beian}
${police}
        <p><a href="/">进入 ${esc(site.name)} →</a></p>
      </footer>
    </main>
  </body>
</html>
`
}

async function main() {
  // middlewareMode + appType:'custom'：只用 vite 的模块加载能力，不起 HTTP 服务、不注入 HTML 中间件
  const server = await createServer({
    root: ROOT,
    mode: 'production',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  })

  let exitCode = 0
  try {
    const mod = await server.ssrLoadModule('/src/content/legal.ts')
    const { DOCS, SITE } = mod

    if (!Array.isArray(DOCS) || DOCS.length === 0) {
      console.error('[legal-static] ❌ DOCS 为空，无法生成静态页')
      process.exitCode = 1
      return
    }

    const written = []
    for (const doc of DOCS) {
      const html = renderDoc(doc, SITE, DOCS)
      // 正文长度守卫：太短说明渲染漏了内容（例如 sections 结构变化），宁可不产出也别产出残页
      const textLen = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length
      if (textLen < 500) {
        console.error(`[legal-static] ❌ ${doc.id} 正文仅 ${textLen} 字（<500），疑似渲染不完整 → 跳过`)
        exitCode = 1
        continue
      }
      const dir = path.join(OUT_DIR, doc.id)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, 'index.html')
      await writeFile(file, html, 'utf8')
      written.push(`${doc.id} (${textLen} 字)`)
    }

    if (written.length > 0) {
      console.log(`[legal-static] ✅ 已生成 ${written.length} 份静态法律页 → ${path.relative(ROOT, OUT_DIR)}/`)
      console.log(`[legal-static]    ${written.join(' / ')}`)
    }
    process.exitCode = exitCode
  } finally {
    await server.close()
  }
}

main().catch((e) => {
  console.error('[legal-static] 💥 生成失败：', e?.stack || e)
  process.exitCode = 1
})
