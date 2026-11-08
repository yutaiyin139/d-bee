/**
 * 小程序启动 / 登录失败自报（2026-11-08；14:5x 二次加固）。
 *
 * ## 为什么必须有它
 *
 * iOS 真机反馈「微信登录白屏」，服务端实证该时段 **没有任何 login-wechat 请求**，
 * 说明异常发生在发请求之前：模块级求值（cloud.ts 创建 SDK 客户端）、页面渲染期抛错、
 * 或 wx.login 前的同步 API 失败。这类异常在小程序里没有任何网络报错、没有弹窗，
 * 表现就是「纯白屏」；Windows 开发机也无法复现 iOS JSCore，只能靠猜。
 *
 * 小程序**没有 DOM**，无法照搬 iOS 原生端的内联红屏脚本。微信原生 `wx.showModal`
 * 不依赖 WXML 渲染树，即使页面没挂出来也能弹出，是白屏场景下唯一可靠的可见通道。
 *
 * ## 🔴 2026-11-08 二次加固：为什么改成零依赖 + 重入锁
 *
 * iOS 微信扫码真机调试 Console 报：
 *   `MiniProgramError: RangeError: Maximum call stack size exceeded`
 *   堆栈全是同一帧 `app-service.js:16815:59` —— 同步无限递归，发生在 appservice
 *   逻辑层加载阶段（与「零 login-wechat 请求」互相印证）。
 *
 * 旧版自报 `import Taro from '@tarojs/taro'`，而 `cloud.ts` 会在 **common.js 模块
 * 求值期、App 注册之前**调用它。此时 Taro 的 API 代理层可能尚未完成初始化，
 * `Taro.showModal` 存在自递归风险；自报通道一旦自己递归，就把「静默白屏」升级成
 * 「栈溢出白屏」，反而更难排障。
 *
 * 因此本版约束（每条都有对应护栏，见 tools/four-end-consistency.test.ts 护栏 13/14）：
 *  - **零 import**：只从 `globalThis.wx` 取原生 API，绝不碰 Taro / ./cloud / ./api；
 *  - **函数级重入锁**：任何原因导致的自递归都在第二层直接 return；
 *  - **console 只输出纯字符串**：不把原始 Error 对象交给 Console 序列化（微信真机
 *    调试的 Console 会展开 Error.stack / 属性 getter，可能再次触发递归）；
 *  - 所有外部对象属性访问都在 try/catch 内，取不到就用兜底文本。
 *
 * 正常路径零副作用：只有调用方进了 catch、或全局 onError 触发时才会弹。
 * 相同错误 10 秒内只弹一次，避免 Promise 链多处 catch 刷屏。
 * 提供「复制详情」按钮，方便把完整栈帧发回开发者（微信 Modal 不支持选择文本）。
 */

/** 只声明本模块真正用到的 wx API 子集，避免引入完整平台类型包。 */
interface WxLike {
  showModal?: (options: {
    title?: string
    content?: string
    showCancel?: boolean
    cancelText?: string
    confirmText?: string
    success?: (res: { confirm?: boolean; cancel?: boolean }) => void
    fail?: (err: unknown) => void
  }) => void
  getSystemInfoSync?: () => Record<string, unknown>
  setClipboardData?: (options: { data: string; success?: () => void; fail?: (e: unknown) => void }) => void
  onError?: (callback: (error: string) => void) => void
}

/** 安全取 wx：真机调试 / 体验版 / 开发者工具均存在；异常时返回 null 不阻断。 */
function getWx(): WxLike | null {
  try {
    const w = (globalThis as unknown as { wx?: WxLike }).wx
    return w && typeof w === 'object' ? w : null
  } catch {
    return null
  }
}

/** 任何一次外部取值都可能抛（iOS JSCore 的 getter / Proxy），统一兜底。 */
function safeText(fn: () => string, fallback: string): string {
  try {
    const v = fn()
    return typeof v === 'string' ? v : fallback
  } catch {
    return fallback
  }
}

/** 把任意抛出值转成可读文本；不做 JSON.stringify（循环引用对象会再炸一次）。 */
function describe(e: unknown): string {
  const head = safeText(() => {
    if (e && typeof e === 'object') {
      const o = e as { name?: unknown; message?: unknown }
      const n = typeof o.name === 'string' && o.name ? o.name : 'Error'
      const m = typeof o.message === 'string' && o.message ? o.message : '(无 message)'
      return `${n}: ${m}`
    }
    return typeof e === 'string' ? e : String(e)
  }, '未知错误（异常对象不可读）')

  const stack = safeText(() => {
    const s = (e as { stack?: unknown } | null)?.stack
    return typeof s === 'string' ? s : ''
  }, '')

  return stack && stack.indexOf(head) === -1
    ? `${head}\n\n${stack.slice(0, 1200)}`
    : head
}

/** 环境快照：区分 iOS / Android、基础库版本，是判断平台差异的关键线索。 */
function envSnapshot(): string {
  const wx = getWx()
  if (!wx || typeof wx.getSystemInfoSync !== 'function') return '环境信息不可用（wx 未就绪）'
  return safeText(() => {
    const s = wx.getSystemInfoSync!()
    const pick = (k: string) => {
      try {
        const v = s[k]
        return v == null ? '?' : String(v)
      } catch {
        return '?'
      }
    }
    return [
      `platform: ${pick('platform')}`,
      `system: ${pick('system')}`,
      `微信: ${pick('version')}`,
      `基础库: ${pick('SDKVersion')}`,
      `brand: ${pick('brand')}`,
    ].join('\n')
  }, '环境信息读取失败')
}

let lastKey = ''
let lastAt = 0
/** 🔴 重入锁：自报通道自身绝不参与递归（2026-11-08 iOS 栈溢出实证）。 */
let reporting = false

/**
 * 弹出启动 / 登录异常详情。页面白屏时也能显示。
 *
 * @param stage 出错阶段（如「云端客户端初始化失败」「微信一键登录」）
 * @param e     原始抛出值
 */
export function reportBootError(stage: string, e: unknown): void {
  if (reporting) return
  reporting = true
  try {
    const detail = describe(e)
    const key = `${stage}|${detail.slice(0, 160)}`
    const now = Date.now()
    if (key === lastKey && now - lastAt < 10_000) return
    lastKey = key
    lastAt = now

    const content = [
      `【${stage}】`,
      '',
      detail.slice(0, 700),
      '',
      '──── 环境 ────',
      envSnapshot(),
    ].join('\n')

    // 🔴 只输出纯字符串：不要把原始 Error 对象交给 Console 序列化。
    try {
      console.error(`[D-Bee 自报] ${stage}\n${content}`)
    } catch {
      /* 控制台不可用时忽略 */
    }

    const wx = getWx()
    if (!wx || typeof wx.showModal !== 'function') return
    try {
      wx.showModal({
        title: '启动异常 · 请截图反馈',
        content,
        showCancel: true,
        cancelText: '关闭',
        confirmText: '复制详情',
        success: (res) => {
          if (!res?.confirm || typeof wx.setClipboardData !== 'function') return
          try {
            wx.setClipboardData({ data: content })
          } catch {
            /* 复制失败不阻断 */
          }
        },
      })
    } catch {
      // 连 Modal 都不可用时已无可见通道，只能靠上面的 console.error
    }
  } catch {
    try {
      console.error(`[D-Bee 自报] ${stage}（自报通道自身异常，已降级）`)
    } catch {
      /* 无可见通道 */
    }
  } finally {
    reporting = false
  }
}

let globalInstalled = false

/**
 * 注册全局未捕获异常监听（wx.onError / App.onError 同源）。
 * 由 app.ts 在**模块顶层**尽早调用，覆盖那些没走 try/catch 的渲染期异常。
 * 幂等；基础库不支持 onError 时静默跳过，不影响启动。
 */
export function installGlobalErrorReporter(): void {
  if (globalInstalled) return
  globalInstalled = true
  const wx = getWx()
  if (!wx || typeof wx.onError !== 'function') return
  try {
    wx.onError((msg) => {
      reportBootError('全局未捕获异常', String(msg))
    })
  } catch {
    /* 注册失败不影响启动 */
  }
}
