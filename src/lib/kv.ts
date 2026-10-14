/**
 * 键值存储抽象。
 *
 * 为什么需要它：原生 App 的 WebView（WKWebView）在系统存储紧张时会**清空 localStorage**，
 * 而 localStorage 目前是登录态的唯一真源（云 SDK 内部使用，无法替换）。
 * 因此本项目自己写入的小状态（偏好、UI 记忆等）必须有一个可切换到原生实现的出口，
 * 后续接入 @capacitor/preferences（iOS UserDefaults / Android SharedPreferences）时
 * 只需替换本文件的实现，业务代码不动。
 *
 * Web 端实现 = localStorage，行为与直接调用 localStorage 完全一致。
 */

import { isNative } from './platform'

/**
 * 原生 KV 插件的最小接口（@capacitor/preferences 的形状）。
 * 之所以用「运行时探测 + 鸭子类型」而不是 import，是为了让 Web 构建产物
 * 不引入任何 Capacitor 依赖、不增加包体积、也不影响现有构建流程。
 */
interface PreferencesPlugin {
  get: (opts: { key: string }) => Promise<{ value: string | null }>
  set: (opts: { key: string; value: string }) => Promise<void>
  remove: (opts: { key: string }) => Promise<void>
  keys?: () => Promise<{ keys: string[] }>
}

function getPreferences(): PreferencesPlugin | null {
  if (!isNative()) return null
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.Preferences
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<PreferencesPlugin>
  if (typeof candidate.get !== 'function' || typeof candidate.set !== 'function') return null
  return candidate as PreferencesPlugin
}

/* ────────────────────────── 内存兜底 ────────────────────────── */

const memory = new Map<string, string>()

/** localStorage 是否真的可用（无痕模式、被策略禁用时会抛错） */
let lsUsable: boolean | null = null

function canUseLocalStorage(): boolean {
  if (lsUsable !== null) return lsUsable
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      lsUsable = false
      return lsUsable
    }
    const probe = '__d_bee_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    lsUsable = true
  } catch {
    lsUsable = false
  }
  return lsUsable
}

/* ────────────────────────── 对外接口 ────────────────────────── */

/**
 * 读取一个字符串值。
 * 原生端读 Preferences；Web 端读 localStorage。读不到返回 fallback。
 */
export async function kvGet(key: string, fallback: string | null = null): Promise<string | null> {
  const prefs = getPreferences()
  if (prefs) {
    try {
      const { value } = await prefs.get({ key })
      return value ?? fallback
    } catch {
      return memory.get(key) ?? fallback
    }
  }
  if (canUseLocalStorage()) {
    try {
      const v = window.localStorage.getItem(key)
      return v === null ? fallback : v
    } catch {
      /* 落到内存 */
    }
  }
  return memory.get(key) ?? fallback
}

/** 写入一个字符串值。失败时静默（存储不可用不应让业务中断） */
export async function kvSet(key: string, value: string): Promise<void> {
  const prefs = getPreferences()
  if (prefs) {
    try {
      await prefs.set({ key, value })
      return
    } catch {
      memory.set(key, value)
      return
    }
  }
  if (canUseLocalStorage()) {
    try {
      window.localStorage.setItem(key, value)
      return
    } catch {
      /* 落到内存 */
    }
  }
  memory.set(key, value)
}

/** 删除一个键 */
export async function kvRemove(key: string): Promise<void> {
  const prefs = getPreferences()
  if (prefs) {
    try {
      await prefs.remove({ key })
      memory.delete(key)
      return
    } catch {
      memory.delete(key)
      return
    }
  }
  if (canUseLocalStorage()) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      /* 忽略 */
    }
  }
  memory.delete(key)
}

/* ────────────────────────── 便捷封装 ────────────────────────── */

/** 读取 JSON；解析失败返回 fallback，不抛错 */
export async function kvGetJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await kvGet(key, null)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 写入 JSON */
export async function kvSetJSON(key: string, value: unknown): Promise<void> {
  try {
    await kvSet(key, JSON.stringify(value))
  } catch {
    /* 序列化失败时静默 */
  }
}
