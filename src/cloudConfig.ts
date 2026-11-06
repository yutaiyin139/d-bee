// 由 WorkBuddy 云服务返回的公开配置（前端初始化使用，不含任何密钥）。
//
// Web 默认取 window.location.origin，由本站 Nginx 同源反代到自建网关；
// VITE_CLOUD_ENDPOINT 仅用于 Web 排查问题时显式覆盖。
//
// 原生 WebView 没有本机 Nginx，必须显式使用绝对 HTTPS endpoint：
// - native-release：只接受 https://d-bee.cn，构建期与运行时双重校验；
// - native-internal：可使用 HTTPS 测试网关，或显式允许 WorkBuddy 云库内测；
// - development：保留云库回退，方便本地开发。
// 原生分支刻意优先于 VITE_CLOUD_ENDPOINT，避免 Web 的临时覆盖污染 App 数据面。
//
// 🔒 双后端口径（2026-10-31 核查确认）：
//   CLOUD_HOST 回退只存在于 DEV 与 native-internal+VITE_ALLOW_CLOUD_NATIVE
//   两个【显式内测口子】；Web 生产走 window.location.origin（自托管 nginx），
//   native-release 走硬断言的 d-bee.cn。云库侧 7 个权益函数已于 2026-10-31
//   通过 MCP 补齐 0039 闸门（db/cloud-patch-0039/，攻击路径全拦、正常放行），
//   即使内测走云库也吃得到库内权益校验 —— 双后端不再是「闸门旁路」。
const CLOUD_HOST = 'https://zilv-mifeng.app.workbuddy.host'
const PRODUCTION_NATIVE_ENDPOINT = 'https://d-bee.cn'

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
 * Web 端 origin → 数据面 endpoint 的**纯函数**（零依赖，可单测）。
 *
 * 🔴 为什么强制 https（2026-11-06 生产登录故障根治）：
 *   站点已上 HTTPS，certbot `--nginx` installer 会在 80 端口 server 块自动注入
 *   `if ($host = d-bee.cn) { return 301 https://$host$request_uri; }`
 *   （配置里带 `# managed by Certbot` 标记，**不在本仓模板内** → 改模板无效）。
 *   浏览器对 301 的历史兼容行为是 **POST→GET 降级**，于是：
 *     POST http://d-bee.cn/.cloud/auth/v1/verification
 *       → 301 → GET https://…/verification → 网关只注册了 POST → 404「未知端点」
 *   实测复现（access.log 用户手机请求链 + `curl --data -L` 得 404，
 *   而 https 直连同端点得 401 invalid access key = 路由正常）。
 *   页面若从 http 加载（SPA 常驻内存的旧标签），`window.location.origin` 就是 http →
 *   所有 API 都踩这个坑。强制 https 后请求直连 443、不经重定向，方法不被降级。
 *
 * 本地开发（isLocalHostname）不走此分支，http 原样保留（dev server 没有 TLS）。
 */
export function resolveWebOrigin(loc: {
  origin?: string
  protocol?: string
  hostname?: string
}): string | null {
  const { origin, protocol, hostname } = loc ?? {}
  if (!origin || !protocol || !hostname) return null
  if (!/^https?:$/.test(protocol)) return null
  if (isLocalHostname(hostname)) return null
  return protocol === 'http:' ? origin.replace(/^http:/, 'https:') : origin
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

function resolveNativeEndpoint(): string {
  const mode = import.meta.env.MODE
  if (import.meta.env.PROD && mode !== 'native-release' && mode !== 'native-internal') {
    throw new Error('原生 App 必须使用 build:native 或 build:native:internal 构建，禁止直接复用 Web 产物。')
  }

  if (fromNativeEnv) {
    const endpoint = trimSlash(fromNativeEnv)
    if (!isUsableEndpoint(endpoint) || (import.meta.env.PROD && !endpoint.startsWith('https://'))) {
      throw new Error(`原生 endpoint 必须是可用的绝对 HTTPS 地址：${endpoint}`)
    }
    if (import.meta.env.MODE === 'native-release' && endpoint !== PRODUCTION_NATIVE_ENDPOINT) {
      throw new Error(`原生正式包只能连接 ${PRODUCTION_NATIVE_ENDPOINT}，当前为 ${endpoint}`)
    }
    return endpoint
  }

  if (import.meta.env.DEV) return CLOUD_HOST
  if (
    import.meta.env.MODE === 'native-internal' &&
    import.meta.env.VITE_ALLOW_CLOUD_NATIVE === 'true'
  ) {
    return CLOUD_HOST
  }

  throw new Error(
    '原生生产构建缺少 VITE_NATIVE_ENDPOINT，已阻止静默回退云库。' +
      '正式包请使用 npm run build:native；云库内测必须使用 native-internal 并显式授权。',
  )
}

/** 原生与 Web 数据面分开解析，原生正式包绝不复用 Web 的临时覆盖或云库兜底。 */
function resolveEndpoint(): string {
  if (detectNative()) return resolveNativeEndpoint()

  if (fromEnv) return trimSlash(fromEnv)

  // Web：取当前来源（强制 https），交给本站 Nginx 反代到自建网关。
  // 判定与升级逻辑全部在 resolveWebOrigin 里（纯函数，可单测，见其文档注释）。
  if (typeof window !== 'undefined' && window.location) {
    const fromOrigin = resolveWebOrigin(window.location)
    if (fromOrigin) return fromOrigin
  }

  // 本地开发 / 预览等无 nginx 反代场景：回退自建网关（d-bee.cn）。
  // 🔴 不再回退 WorkBuddy 云库 —— 云库即将释放，本地开发统一走自建栈，避免
  //    「本地连云库、生产连自建」的行为分叉（2026-11-06 用户批准「回退自建网关」）。
  //    可行性已实测：生产网关 CORS 放行 http://localhost:3000
  //    （OPTIONS /.cloud/auth/v1/verification → 204 + access-control-allow-origin 回显）。
  //    ⚠️ 依赖生产 CORS_ALLOWED_ORIGINS 保留 localhost —— 收紧白名单会让本地开发登录失败。
  return PRODUCTION_NATIVE_ENDPOINT
}

export const publicConfig = {
  resourceId: 'wbcs_45DQ4I52Uv2NUAKAJkWdq1',
  endpoint: resolveEndpoint(),
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E',
} as const

/** 云端原始地址，供构建日志/排查使用 */
export const CLOUD_UPSTREAM = CLOUD_HOST
