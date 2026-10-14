// 由 WorkBuddy 云服务返回的公开配置（仅供参考于前端初始化，不含任何密钥）
//
// ── endpoint 的取值策略（重要）──────────────────────────────────────
// endpoint 决定前端把 /.cloud/、/auth/ 请求发往哪里。SDK 会用
// `${endpoint}/.cloud/database/rest/...` 拼**绝对地址**，所以它必须与浏览器的
// 当前来源一致，否则请求会变成跨域：
//   - 若 endpoint 指向云端域名（https://zilv-mifeng.app.workbuddy.host），
//     自托管站点下浏览器会**绕过本站 Nginx 直连云端**，而云端在跨域预检时
//     不允许 apikey 请求头（已实测），数据库请求会被整体拦掉 → App 不可用。
//   - 若 endpoint 指向某个固定来源，则用**其他**来源访问时又会被跨域拦掉
//     （例如构建时写死 https://d-bee.com.cn，用 http://150.158.51.106 打开就坏）。
//
// 因此这里**默认取当前页面的来源**（window.location.origin），运行时确定：
//   - 官方域名部署：origin = https://zilv-mifeng.app.workbuddy.host
//     —— 该来源本身就是云端，天然同源，直连即可
//   - 自托管 IP：origin = http://150.158.51.106
//     —— 请求发往本站，由 Nginx 反代到云端（见 deploy/nginx.conf.example）
//   - 自托管域名：origin = https://d-bee.com.cn
//     —— 同上
//
// 好处：同一份构建产物在 IP / 自建域名 / 官方域名下**都能直接工作**，
//       换域名无需重新构建，且多个访问入口可以并存。
//
// VITE_CLOUD_ENDPOINT 仍然可用作**显式覆盖**（一般只在排查问题时需要）：
//   VITE_CLOUD_ENDPOINT=http://49.233.208.169 npm run build
// 留空则不写死，走上面的运行时策略。
//
// ── 原生 App（Capacitor）的特殊情况 ──────────────────────────────────
// 原生 WebView 的来源不是 http/https，而是：
//   - iOS：capacitor://localhost
//   - Android：https://localhost（或 http://localhost）
// 这两个来源**都不能**作为 endpoint：它们指向本地 WebView，服务器不存在。
// 而上面「同源反代」的整套思路在原生端也不成立——原生运行时没有本机 Nginx，
// 无法把 /auth/、/.cloud/ 反代到云端。
//
// 所以原生端的 endpoint **必须是一个绝对 HTTPS 地址**。按优先级：
//   1. VITE_NATIVE_ENDPOINT（构建时显式注入，最可控）
//   2. 官方云端域名 CLOUD_HOST（走 https://，满足 iOS ATS 要求）
// 未来若启用自有域名，只需在原生构建时注入：
//   VITE_NATIVE_ENDPOINT=https://d-bee.com.cn npm run build
//
// ⚠️ 注意：原生端直连云端时，SDK 会用 fetch 发送 apikey 请求头，属于跨域；
// 这依赖 CapacitorHttp 插件在原生层补发请求（绕过 WebView 的 CORS 预检）。
// 该插件在阶段 2 接入，届时此处逻辑无需再改。
const CLOUD_HOST = 'https://zilv-mifeng.app.workbuddy.host'

const fromEnv = (import.meta.env.VITE_CLOUD_ENDPOINT as string | undefined)?.trim()

/** 原生端专用的绝对 endpoint（构建时注入，见文件头说明） */
const fromNativeEnv = (import.meta.env.VITE_NATIVE_ENDPOINT as string | undefined)?.trim()

/** 本地开发/预览时没有 Nginx 反代，直接回退到云端地址，避免开发环境跑不起来 */
function isLocalHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.local') ||
    // 局域网 IP（如 192.168.x.x / 10.x.x.x）通常也是本机开发场景
    /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
}

/** 去掉末尾斜杠，统一 endpoint 形态（SDK 内部会自行拼接子路径） */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 是否运行在原生 App 容器内（Capacitor）。
 *
 * 这里**刻意不 import ./lib/platform**：cloudConfig 是模块级的初始化常量，
 * 会被最早求值，保持它零依赖可以避免任何潜在的循环引用。
 * 探测逻辑与 platform.ts 保持同一语义（见该文件说明）。
 */
function detectNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } })
    .Capacitor
  if (!cap) return false
  try {
    if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform() === true
    if (typeof cap.getPlatform === 'function') {
      const p = cap.getPlatform()
      return p === 'ios' || p === 'android'
    }
  } catch {
    /* 回退 */
  }
  return true
}

/**
 * 判定一个 URL 能否作为 endpoint：必须是绝对 http/https 地址。
 * 原生 WebView 的 capacitor://localhost、https://localhost 等本地来源会被排除。
 */
function isUsableEndpoint(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const u = new URL(url)
    // 本地来源不能作为服务器地址
    if (isLocalHostname(u.hostname)) return false
    return true
  } catch {
    return false
  }
}

/**
 * endpoint 解析。三层优先级，职责清晰：
 *
 *   1. 显式注入（VITE_CLOUD_ENDPOINT）—— 排查问题 / 指向测试环境时使用，最高优先
 *   2. 原生分支       —— 必须绝对 HTTPS，取 VITE_NATIVE_ENDPOINT，否则回退云端域名
 *   3. Web 运行时来源 —— 当前 origin（Nginx 同源反代），本地开发则回退云端域名
 */
function resolveEndpoint(): string {
  // 1. 显式覆盖
  if (fromEnv) return trimSlash(fromEnv)

  // 2. 原生 App：WebView 来源不可用，必须钉死一个绝对 HTTPS 地址
  if (detectNative()) {
    if (fromNativeEnv && isUsableEndpoint(fromNativeEnv)) return trimSlash(fromNativeEnv)
    return CLOUD_HOST
  }

  // 3. Web：取当前来源，交给本站 Nginx 反代到云端
  if (typeof window !== 'undefined' && window.location) {
    const { origin, protocol, hostname } = window.location
    // 协议必须是 http/https，且不是本地开发地址
    if (origin && /^https?:$/.test(protocol) && hostname && !isLocalHostname(hostname)) {
      return origin
    }
  }

  // 兜底：本地开发 / 预览等无反代场景，直连云端
  return CLOUD_HOST
}

export const publicConfig = {
  resourceId: 'wbcs_45DQ4I52Uv2NUAKAJkWdq1',
  endpoint: resolveEndpoint(),
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E',
} as const

/** 云端原始地址，供构建日志/排查使用 */
export const CLOUD_UPSTREAM = CLOUD_HOST
