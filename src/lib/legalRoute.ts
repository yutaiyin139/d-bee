import type { DocId } from '../content/legal'

/**
 * 法律文档 URL 路由（App 与首启隐私门共用）。
 *
 * 🔴 为什么必须抽成独立模块：`PrivacyGate` 挂在 main.tsx（比 App 更外层），它需要
 * 判断「当前是不是外部直达的法律文档深链」。若是，**必须放行**，不能被隐私门拦住——
 * 商店/备案/ASC 审核员会直接访问 `https://d-bee.cn/legal/privacy`，OPPO 的隐私政策
 * 自动化审核也会直接抓取该 URL；被门拦住 = 抓到空页面 = 驳回「URL 无法访问或不合规」。
 * 若把这段逻辑复制一份在 main.tsx，两处极易走偏，故抽为单一真源。
 *
 * 支持三种写法：
 *   /legal/privacy      ← 推荐给外部填报（商店/备案/ASC 的隐私政策 URL）
 *   /?legal=privacy     ← 查询参数兜底
 *   #/legal/privacy     ← hash 兜底（静态托管无 SPA 回退时也能用）
 */

/** 合法的法律文档 id（与 legal.ts 的 DOCS 对齐） */
export const LEGAL_IDS: readonly DocId[] = ['terms', 'privacy', 'disclaimer']

/** 从 URL 解析法律文档 id；非法律深链返回 null */
export function readLegalFromUrl(): DocId | null {
  try {
    const { pathname, search, hash } = location
    const fromPath = /^\/legal\/([a-z]+)\/?$/i.exec(pathname)?.[1]
    const fromQuery = new URLSearchParams(search).get('legal')
    const fromHash = /^#\/legal\/([a-z]+)\/?$/i.exec(hash)?.[1]
    const raw = (fromPath ?? fromQuery ?? fromHash ?? '').toLowerCase()
    return (LEGAL_IDS as readonly string[]).includes(raw) ? (raw as DocId) : null
  } catch {
    return null
  }
}

/** 打开/关闭法律文档时同步 URL，保证可刷新、可分享、可被审核员直接访问 */
export function syncLegalUrl(id: DocId | null) {
  try {
    const target = id ? `/legal/${id}` : '/'
    // 已在目标路径则不动（避免污染 history 栈）
    if (location.pathname === target) return
    if (id) history.pushState(null, '', target)
    else history.replaceState(null, '', '/')
  } catch {
    /* 原生 WebView 或受限环境下静默降级：URL 不同步但页面仍可用 */
  }
}
