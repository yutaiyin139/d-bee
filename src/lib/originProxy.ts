/**
 * 原生 Origin 转发抽象层（方案 B）。
 *
 * ── 它要解决什么 ────────────────────────────────────────────────────────────
 * 云端按 **Origin 精确匹配** 校验客户端。Web 端之所以能登录，是因为自托管站点的
 * Nginx 反代里显式覆写了两行：
 *
 *     proxy_set_header Origin  "https://zilv-mifeng.app.workbuddy.host";
 *     proxy_set_header Referer "https://zilv-mifeng.app.workbuddy.host/";
 *
 * 原生端没有 Nginx：请求在 WebView 里发出，`Origin` 属于 fetch 规范的
 * forbidden header name，**JS 侧再怎么设都会被 Request 构造过滤掉**（已实测）。
 * 于是 signup / signin 一律 401 invalid_grant，而发码 / 验码却是 200 —— 症状很隐蔽。
 * 顺带一提：refreshToken 句柄同样绑定 Origin，所以续期也会一起坏掉。
 *
 * 解法：让请求经 `OriginProxy` 原生插件转发，由原生 HTTP 栈强制注入这两个头
 * （等于把 Nginx 那两行搬进 App）。本文件就是那层「会说 fetch 语言」的适配器。
 *
 * ── 接入方式（刻意选择）──────────────────────────────────────────────────────
 * 云 SDK 官方支持注入自定义 fetch（`WorkBuddyCloudOptions.fetch`），因此
 * **不 patch window.fetch**、也不动 CapacitorHttp 已有的补丁 —— 影响面严格限定在
 * 云 SDK 自己的请求上，Web 端与其它网络调用一行代码都不变。
 *
 * 与其他 lib 抽象层一致：**不静态 import 任何 Capacitor 插件包**，只做运行时
 * 鸭子类型探测，保证 Web 构建产物零新增依赖、体积不变。
 *
 * ── 已知限制（务必知悉）──────────────────────────────────────────────────────
 * 1. **不支持流式响应**：原生层会把整个响应体读完才回传，因此 LLM 的
 *    `stream: true` 会退化成一次性返回。接 LLM 对话时要么关流式，要么在插件里
 *    补 SSE 事件转发（阶段 2 的活儿）。
 * 2. **不支持中途取消**：不响应 `AbortSignal`，请求一旦发出只能等超时。
 * 3. 原生插件缺失时返回 undefined，调用方（cloud.ts）会退回默认 fetch ——
 *    此时行为与方案 B 之前一致（即登录会失败），但不会崩。
 */

import { isNative } from './platform'

/**
 * 应用创建时预留的发布域名（applicationId = wbapp_w6iIU6TqTyHvJxESPTxBTy）。
 * 云端按它做精确匹配，**换域名等于登录失效**，不要随手改。
 * 若将来启用自有域名 d-bee.com.cn，这里要与云端预留来源、Nginx 三处同步变更。
 */
const CLOUD_ORIGIN = 'https://zilv-mifeng.app.workbuddy.host'

/** OriginProxy 插件的响应形状（见 native-plugins/dbee-origin-proxy） */
interface OriginProxyResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  /** 响应体，Base64 编码（避免 charset 与二进制两类问题） */
  data: string
  url: string
}

interface OriginProxyRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  bodyEncoding?: 'text' | 'base64'
  origin?: string
  referer?: string
}

/** 插件的最小结构（不引 @dbee/origin-proxy，保持零依赖） */
interface OriginProxyPlugin {
  request: (options: OriginProxyRequestOptions) => Promise<OriginProxyResponse>
}

function getPlugin(): OriginProxyPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.OriginProxy
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<OriginProxyPlugin>
  if (typeof candidate.request !== 'function') return null
  return candidate as OriginProxyPlugin
}

/**
 * 原生转发通道是否可用。
 * Web 端恒为 false；原生端在插件未随包发布时也为 false。
 */
export function isOriginProxyAvailable(): boolean {
  return isNative() && getPlugin() !== null
}

/**
 * 创建注入给云 SDK 的 fetch 实现。
 *
 * 返回 undefined 表示「不需要 / 不能注入」——Web 端与插件缺失时都是这个结果，
 * 调用方应据此退回 SDK 默认的全局 fetch。
 */
export function createNativeFetch(): typeof fetch | undefined {
  if (!isNative()) return undefined
  if (!getPlugin()) {
    // 原生端却拿不到插件 = 插件没随包发布（或 cap sync 没跑），属于集成故障，
    // 但这里只降级不抛错：让 App 能起来，问题在登录时暴露。
    console.warn('[originProxy] 原生端未发现 OriginProxy 插件，云端请求将退回默认 fetch（Origin 缺失，登录会失败）')
    return undefined
  }
  return nativeFetch as typeof fetch
}

/** 兼容 `fetch(input, init)` 语义的转发实现 */
async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const plugin = getPlugin()
  if (!plugin) throw new TypeError('OriginProxy 插件不可用')

  const request = input instanceof Request ? input : new Request(input as RequestInfo, init)

  // 这里的 headers 里不会有 Origin/Referer —— Request 构造已把它们过滤掉了，
  // 来源由原生层强制注入（这正是本方案成立的原因）。
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  let body: string | undefined
  let bodyEncoding: 'text' | 'base64' | undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buffer = await request.clone().arrayBuffer()
    if (buffer.byteLength > 0) {
      if (isTextPayload(request.headers.get('content-type'))) {
        body = new TextDecoder().decode(buffer)
        bodyEncoding = 'text'
      } else {
        body = bytesToBase64(new Uint8Array(buffer))
        bodyEncoding = 'base64'
      }
    }
  }

  let result: OriginProxyResponse
  try {
    result = await plugin.request({
      url: request.url,
      method: request.method,
      headers,
      body,
      bodyEncoding,
      origin: CLOUD_ORIGIN,
    })
  } catch (e) {
    // 原生层失败（DNS / TLS / 超时）要映射成 fetch 的语义：抛 TypeError，
    // 云 SDK 会把它归类为 kind: 'network'。
    throw new TypeError(e instanceof Error ? e.message : String(e))
  }

  const status = Number(result.status)
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    throw new TypeError(`OriginProxy 返回了非法状态码：${result.status}`)
  }

  const bytes = base64ToBytes(result.data)
  // 状态码 101/204/205/304 按规范不允许带 body，构造 Response 时会抛错
  const bodyless = status === 101 || status === 204 || status === 205 || status === 304
  return new Response(bodyless || bytes.byteLength === 0 ? null : toArrayBuffer(bytes), {
    status,
    statusText: result.statusText || '',
    headers: result.headers,
  })
}

/**
 * 复制成独立的 ArrayBuffer。
 * 直接用 Uint8Array 作为 BodyInit 在 TS 5.7+ 的泛型 Uint8Array<ArrayBufferLike> 下不被接受。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/** 文本型载荷直接用 UTF-8 传递，二进制走 Base64（storage 下载等场景） */
function isTextPayload(contentType: string | null): boolean {
  if (!contentType) return true
  const ct = contentType.toLowerCase()
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('application/x-www-form-urlencoded')
  )
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x4000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j])
    }
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0)
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
