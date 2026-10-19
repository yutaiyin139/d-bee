/**
 * 运行环境探测。
 *
 * 这是「阶段 0：代码解耦」的地基：所有需要区分 Web / 原生 App 的地方都从这里取判断，
 * 业务代码不再直接嗅探全局对象，未来接入 Capacitor 时无需回头改业务逻辑。
 *
 * 四类运行环境（平台标识 platformName()）：
 *   - web                普通浏览器 / PWA / 微信内置浏览器
 *   - ios / android      Capacitor 原生 App
 *   - wechat-miniprogram 微信小程序（规划中，识别已就绪，不影响现有三端）
 *
 * 探测依据：
 *   - 原生 App：window.Capacitor 存在，且 getPlatform() 返回 'ios' / 'android'
 *   - 微信小程序：存在 wx 全局对象且具备 getSystemInfoSync（无标准 DOM/window）
 *   - 其余：一律判定为 Web
 *
 * 因此本模块在 Web 端的行为是「恒定且可预测的」——isNative() 永远 false，
 * 不会因为浏览器差异产生偶发分支，Web 版功能零变化。
 * 新增小程序识别不影响既有 web/ios/android 三条路径：它们优先于小程序判定之外，
 * 且小程序环境既无 Capacitor 也无标准 DOM，天然不会命中原生分支。
 */

/** Capacitor 注入的全局对象的最小结构（不引入 @capacitor/core 依赖，保持 Web 包体积不变） */
interface CapacitorGlobal {
  getPlatform?: () => string
  isNativePlatform?: () => boolean
  platform?: string
  Plugins?: Record<string, unknown>
}

function getCapacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  return c && typeof c === 'object' ? c : null
}

/**
 * 是否运行在原生 App 容器内（iOS / Android）。
 * Web 端（含 PWA、桌面浏览器、微信内置浏览器）恒为 false。
 */
export function isNative(): boolean {
  // 微信小程序不是 Capacitor 原生容器，先短路（宿主可能注入受限 window，防误判）
  if (isWechatMiniProgram()) return false
  const c = getCapacitor()
  if (!c) return false
  // 优先用官方 API；两者都缺失时，只要全局对象存在也认为在原生容器内
  if (typeof c.isNativePlatform === 'function') {
    try {
      return c.isNativePlatform() === true
    } catch {
      /* 回退到下面的判断 */
    }
  }
  if (typeof c.getPlatform === 'function') {
    try {
      const p = c.getPlatform()
      return p === 'ios' || p === 'android'
    } catch {
      /* 回退到下面的判断 */
    }
  }
  return true
}

/**
 * 微信小程序全局对象的最小结构（不引入任何类型库，保持零依赖）。
 * 小程序运行环境没有标准 DOM/`window`/`navigator`，但宿主会注入 `wx` 全局对象；
 * `wx.getSystemInfoSync` 是识别「微信小程序」最可靠的运行时信号。
 */
interface WxGlobal {
  getSystemInfoSync?: () => unknown
  login?: (...args: unknown[]) => unknown
  request?: (...args: unknown[]) => unknown
}

function getWx(): WxGlobal | null {
  if (typeof wx === 'undefined') return null
  const w = wx as WxGlobal
  return w && typeof w === 'object' ? w : null
}

/**
 * 是否运行在「微信小程序」容器内。
 *
 * 判定依据：存在 `wx` 全局对象且具备 `getSystemInfoSync`。这与微信内置浏览器
 * （微信里打开 H5，仍走 Web 逻辑）严格区分：内置浏览器**没有** `wx` 全局对象。
 *
 * 与 Capacitor 原生（iOS/Android）也互斥：小程序里没有 `window.Capacitor`。
 * 该函数不依赖 window/navigator，在小程序受限环境里也能安全求值。
 */
export function isWechatMiniProgram(): boolean {
  const w = getWx()
  return !!w && typeof w.getSystemInfoSync === 'function'
}

/** 当前平台标识；Web 端统一返回 'web'，小程序返回 'wechat-miniprogram' */
export function platformName(): 'web' | 'ios' | 'android' | 'wechat-miniprogram' {
  // 小程序优先判定：它既不是 Capacitor 原生，也不是普通 Web 浏览器
  if (isWechatMiniProgram()) return 'wechat-miniprogram'
  const c = getCapacitor()
  if (!c) return 'web'
  let p = ''
  if (typeof c.getPlatform === 'function') {
    try {
      p = c.getPlatform()
    } catch {
      p = ''
    }
  }
  if (!p && typeof c.platform === 'string') p = c.platform
  if (p === 'ios' || p === 'android') return p
  return 'web'
}

/** 是否 iOS 原生 App；Web 端（含 iOS Safari / 微信）恒为 false */
export function isIOS(): boolean {
  return platformName() === 'ios'
}

/** 是否 Android 原生 App；Web 端恒为 false */
export function isAndroid(): boolean {
  return platformName() === 'android'
}

/**
 * 是否运行在浏览器里（含 PWA）。
 * 语义上等价于 !isNative()，单独导出是为了让业务代码的表达更直观。
 *
 * 注意：微信小程序**不是**浏览器（无 DOM），但为保持既有「非原生即 Web」的兜底
 * 语义不变，本函数仍返回 true（小程序环境不依赖 DOM 的路径会走 Web 兜底）。
 * 需要精确区分小程序的代码，请显式调用 isWechatMiniProgram()。
 */
export function isWeb(): boolean {
  return !isNative()
}

/**
 * 是否处于 WebView 容器内（原生 App 或微信内置浏览器）。
 * 用于需要在「非纯浏览器」环境下调整行为的地方，例如 Service Worker 注册。
 */
export function isWebView(): boolean {
  if (isNative()) return true
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  // 微信内置浏览器 / 通用 WebView 标识
  return /MicroMessenger|;\s*wv\)/.test(ua)
}
