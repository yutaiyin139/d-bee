/**
 * 运行环境探测。
 *
 * 这是「阶段 0：代码解耦」的地基：所有需要区分 Web / 原生 App 的地方都从这里取判断，
 * 业务代码不再直接嗅探全局对象，未来接入 Capacitor 时无需回头改业务逻辑。
 *
 * 探测依据是 Capacitor 注入到 WebView 的 `window.Capacitor` 全局对象：
 *   - 原生 App 内：window.Capacitor 存在，且 getPlatform() 返回 'ios' / 'android'
 *   - 普通浏览器 / PWA：window.Capacitor 不存在 → 一律判定为 Web
 *
 * 因此本模块在 Web 端的行为是「恒定且可预测的」——isNative() 永远 false，
 * 不会因为浏览器差异产生偶发分支，Web 版功能零变化。
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

/** 当前平台标识；Web 端统一返回 'web' */
export function platformName(): 'web' | 'ios' | 'android' {
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
