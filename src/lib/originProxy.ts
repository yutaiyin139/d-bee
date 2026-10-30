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
 * 1. **流式响应**：新版原生插件提供 `requestStream`（chunk 经 Capacitor 事件
 *    `originProxyChunk/End/Error` 逐块回传），本层据此构造 ReadableStream，
 *    LLM 的 SSE 可增量消费（教练打字机效果）。**旧版插件**（只有 `request`）
 *    自动回退整体缓冲模式 —— 流式退化成一次性返回，功能仍可用。
 *    背景：iOS V1.7.0 用户实测「问问小蜜」无思考链路 + 60s 报网络超时，
 *    根因即旧插件整体缓冲 + 60s 硬超时（原生超时已同步放宽到 180s）。
 * 2. **中途取消**：流式请求（requestStream）支持 `AbortSignal` —— 中断时调原生
 *    `cancel(streamId)` 真正终止 HTTP 连接（新旧插件都探测 PluginHeaders，旧版
 *    无 cancel 方法时仅关流、请求自然跑到超时）。缓冲请求（request）无 streamId
 *    可取消，abort 只让 JS 侧 Promise 立即以 AbortError 收尾，原生请求不省。
 * 3. 原生插件缺失时返回 undefined，调用方（cloud.ts）会退回默认 fetch ——
 *    此时行为与方案 B 之前一致（即登录会失败），但不会崩。
 */

import { isNative } from './platform'

/**
 * 应用创建时预留的发布域名（applicationId = wbapp_w6iIU6TqTyHvJxESPTxBTy）。
 * 云端按它做精确匹配，**换域名等于登录失效**，不要随手改。
 * 若将来启用自有域名 d-bee.cn（双域名规划中 Web 端的正式域名），
 * 这里要与云端预留来源、Nginx 三处同步变更。
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
  /** requestStream 专用：本次流式请求的关联 ID（原生层随事件回传） */
  streamId?: string
}

/** requestStream 的回执：HTTP 头信息立即可得，body 经事件通道逐块回传 */
interface OriginProxyStreamHandle {
  streamId: string
  status: number
  statusText: string
  headers: Record<string, string>
  /** 仅非 2xx / 非 SSE 响应时存在：原生已整体缓冲（SDK httpError 需要完整体） */
  data?: string
}

/** 插件的最小结构（不引 @dbee/origin-proxy，保持零依赖） */
interface OriginProxyPlugin {
  request: (options: OriginProxyRequestOptions) => Promise<OriginProxyResponse>
  /** 新版插件才有：SSE/长响应逐块回传（事件 originProxyChunk/End/Error） */
  requestStream?: (options: OriginProxyRequestOptions) => Promise<OriginProxyStreamHandle>
  /** 新版插件才有：按 streamId 终止在途请求（配合 AbortSignal） */
  cancel?: (options: { streamId: string }) => Promise<unknown>
  /** Capacitor 桥接的标准事件监听（原生 notifyListeners → 这里收到） */
  addListener?: (eventName: string, handler: (payload: Record<string, unknown>) => void) => Promise<{ remove(): void }> | { remove(): void }
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
 * 原生插件是否真实实现了 requestStream 方法。
 *
 * ⚠️ 不能用 `typeof plugin.requestStream === 'function'` 探测：Capacitor 的
 * 插件 Proxy 对**任意属性名**都返回 wrapper 函数（get 陷阱 default 分支），
 * 探测恒真；真正的未实现要到调用时才 reject「not implemented」。
 * 可靠信源是原生桥注入的 PluginHeaders（注册时逐方法列出）。
 */
function nativeHasStreamMethod(): boolean {
  return nativeHasMethod('requestStream')
}

/** 通用版方法探测（理由同 nativeHasStreamMethod 的注释） */
function nativeHasMethod(name: string): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as unknown as {
    Capacitor?: { PluginHeaders?: ReadonlyArray<{ name: string; methods?: ReadonlyArray<{ name: string }> }> }
  }).Capacitor
  const header = cap?.PluginHeaders?.find((h) => h.name === 'OriginProxy')
  return !!header?.methods?.some((m) => m.name === name)
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
  // AbortSignal 优先取显式 init（fetch 语义：init.signal 覆盖 Request.signal），
  // 其次是 Request 对象自带的 signal
  const signal: AbortSignal | null = init?.signal ?? (input instanceof Request ? input.signal : null) ?? null
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

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

  const options: OriginProxyRequestOptions = {
    url: request.url,
    method: request.method,
    headers,
    body,
    bodyEncoding,
    origin: CLOUD_ORIGIN,
  }

  // ── 流式分支：LLM 的 SSE 请求（Accept: text/event-stream）走 requestStream ──
  // 仅当原生桥 PluginHeaders 声明了 requestStream（新版插件）才走流式；
  // 旧版插件（只有 request）自动落到整体缓冲分支。用 PluginHeaders 而非
  // typeof 探测——Capacitor Proxy 对任意方法名都返回函数，typeof 恒真不可靠。
  const wantsStream =
    nativeHasStreamMethod() &&
    String(headers['accept'] ?? '').includes('text/event-stream')
  if (wantsStream) {
    try {
      return await nativeStreamFetch(plugin, options, signal)
    } catch (e) {
      // 用户主动中断：直接向上抛 AbortError，绝不能回退缓冲再发一次请求
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      // 流式通道异常（如原生 requestStream 意外失败）→ 回退整体缓冲，保证功能可用
      console.warn('[originProxy] 流式请求失败，回退缓冲模式：', e)
    }
  }

  return bufferedFetch(plugin, options, signal)
}

/**
 * 缓冲请求的 abort 处理（尽力而为）。
 *
 * 原生 request() 没有 streamId、无法从 JS 终止——请求会继续跑到超时或完成，
 * 但 JS 侧 Promise 会立即以 AbortError 收尾，调用方（SDK/教练问答）能马上
 * 解除等待。这是「不支持中途取消」旧限制下能做到的最好程度：不省流量，但省交互。
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** 整体缓冲转发：原生 request() 读完整个响应体再回传（旧插件唯一路径） */
async function bufferedFetch(plugin: OriginProxyPlugin, options: OriginProxyRequestOptions, signal?: AbortSignal | null): Promise<Response> {
  let result: OriginProxyResponse
  try {
    result = await withAbort(plugin.request(options), signal ?? null)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    // 原生层失败（DNS / TLS / 超时）要映射成 fetch 的语义：抛 TypeError，
    // 云 SDK 会把它归类为 kind: 'network'。
    throw new TypeError(e instanceof Error ? e.message : String(e))
  }
  return bufferedResponse(result.status, result.statusText, result.headers, result.data)
}

/** 流式转发：先挂事件监听，再发起 requestStream，把原生 chunk 泵进 ReadableStream。
 *  支持 AbortSignal：中断时调原生 cancel(streamId) 真正终止 HTTP 连接（新版插件），
 *  并让 ReadableStream 以 close 收尾——对消费方是正常结束，不是网络错误。 */
async function nativeStreamFetch(plugin: OriginProxyPlugin, options: OriginProxyRequestOptions, signal?: AbortSignal | null): Promise<Response> {
  const streamId = `os${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  // Response 构造前收到的事件先缓冲，避免竞态丢块
  const earlyChunks: Uint8Array[] = []
  let earlyEnded = false
  let earlyError: Error | null = null
  // 是否已被 AbortSignal 中断：中断后到达的事件一律丢弃（原生取消有传播延迟）
  let aborted = false
  const canCancel = nativeHasMethod('cancel') && typeof plugin.cancel === 'function'

  const removals: Array<() => void> = []

  const onChunk = (p: Record<string, unknown>) => {
    if (aborted) return
    if (p.streamId !== streamId) return
    const bytes = base64ToBytes(typeof p.data === 'string' ? p.data : '')
    if (bytes.byteLength === 0) return
    if (controller) controller.enqueue(bytes)
    else earlyChunks.push(bytes)
  }
  const onEnd = (p: Record<string, unknown>) => {
    if (p.streamId !== streamId) return
    dispose()
    if (controller) {
      try { controller.close() } catch { /* 已关闭 */ }
    } else {
      earlyEnded = true
    }
  }
  const onError = (p: Record<string, unknown>) => {
    if (aborted) return
    if (p.streamId !== streamId) return
    dispose()
    const err = new TypeError(`OriginProxy 流中断：${String(p.message ?? 'unknown')}`)
    if (controller) {
      try { controller.error(err) } catch { /* 已结束 */ }
    } else {
      earlyError = err
    }
  }

  function dispose() {
    aborted = true
    while (removals.length > 0) {
      try { removals.pop()?.() } catch { /* 忽略重复移除 */ }
    }
  }

  /** 用户中断：终止原生连接 + 关流。对 JS 消费方表现为正常结束（close）。 */
  function handleAbort() {
    if (aborted) return
    dispose()
    if (canCancel && plugin.cancel) {
      // fire-and-forget：取消失败（连接已自然结束）无副作用，不需要 await
      void plugin.cancel({ streamId }).catch(() => { /* ignore */ })
    }
    if (controller) {
      try { controller.close() } catch { /* 已关闭 */ }
    } else {
      earlyEnded = true
    }
  }

  // 发起前已中断：直接抛 AbortError，不留任何原生请求
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  signal?.addEventListener('abort', handleAbort, { once: true })

  // 必须先挂监听再发请求，防止 chunk 早于监听到达被丢弃
  try {
    const addListener = plugin.addListener!.bind(plugin)
    const subs = await Promise.all([
      addListener('originProxyChunk', onChunk),
      addListener('originProxyEnd', onEnd),
      addListener('originProxyError', onError),
    ])
    for (const s of subs) removals.push(() => s.remove())
  } catch (e) {
    signal?.removeEventListener('abort', handleAbort)
    throw new TypeError(e instanceof Error ? e.message : String(e))
  }

  let handle: OriginProxyStreamHandle
  try {
    handle = await plugin.requestStream!({ ...options, streamId })
  } catch (e) {
    dispose()
    signal?.removeEventListener('abort', handleAbort)
    if (aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    throw new TypeError(e instanceof Error ? e.message : String(e))
  }

  // 请求刚发出就被中断（requestStream 还在途时 signal 已 abort）：立即取消
  if (aborted) {
    signal?.removeEventListener('abort', handleAbort)
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  const status = Number(handle.status)
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    dispose()
    signal?.removeEventListener('abort', handleAbort)
    throw new TypeError(`OriginProxy 返回了非法状态码：${handle.status}`)
  }

  // 原生侧对非 2xx / 非 SSE 响应已整体缓冲（SDK 的 httpError 需要完整 JSON 体）
  if (typeof handle.data === 'string') {
    dispose()
    signal?.removeEventListener('abort', handleAbort)
    return bufferedResponse(status, handle.statusText, handle.headers, handle.data)
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of earlyChunks) c.enqueue(chunk)
      earlyChunks.length = 0
      if (earlyError) c.error(earlyError)
      else if (earlyEnded) c.close()
    },
    // 消费方主动 cancel 流（如 reader.cancel()）：同样终止原生连接，
    // 否则 LLM 回答会一直泵到超时
    cancel() {
      if (!aborted) handleAbort()
    },
  })
  return new Response(stream, {
    status,
    statusText: handle.statusText || '',
    headers: handle.headers,
  })
}

/** 整体缓冲响应 → fetch Response（状态码校验 + bodyless 特例） */
function bufferedResponse(
  statusIn: number | string,
  statusText: string | undefined,
  headers: Record<string, string>,
  base64Data: string,
): Response {
  const status = Number(statusIn)
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    throw new TypeError(`OriginProxy 返回了非法状态码：${statusIn}`)
  }
  const bytes = base64ToBytes(base64Data)
  // 状态码 101/204/205/304 按规范不允许带 body，构造 Response 时会抛错
  const bodyless = status === 101 || status === 204 || status === 205 || status === 304
  return new Response(bodyless || bytes.byteLength === 0 ? null : toArrayBuffer(bytes), {
    status,
    statusText: statusText || '',
    headers,
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
