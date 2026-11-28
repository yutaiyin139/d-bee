/**
 * Health Connect 原生插件对接（Android 统一健康层 · 第三适配器）。
 *
 * 与 iOS 侧 healthkit.ts、Android 厂商侧 android.ts **完全同构**：
 *   - healthConnectStatus()            → { available }   运行时能力探测（缓存）
 *   - requestHealthConnectAuthorization → { completed, reason? }
 *   - fetchHealthConnectToday()         → { steps, activeKcal, status }
 *
 * ── 为什么是「第三适配器」而非改 android.ts ──────────────────────────
 * Health Connect 是跨品牌**系统级统一层**（华为/小米/vivo/OPPO 及第三方手环
 * 只要愿意写入 HC 都能读到），与「按 UA 品牌分派的厂商 SDK」是两条独立通道。
 * 门面分派优先级：iOS→HealthKit；Android→**HC 优先**，厂商 SDK 兜底，都无→引导。
 *
 * ── 能力探测为什么用「异步 probe + 同步缓存」──────────────────────────
 * `getSdkStatus()` 是跨进程查询，不能每次渲染都打；也不能假设 UA 能探测 HC
 * （HC 与机型品牌无关）。故：App 启动时 probe 一次 → 缓存布尔 → isHealthConnectAvailable()
 * 同步读缓存（供 isHealthConnectable() 的 useMemo 使用）。
 *
 * 🔴 零回归保证（HC-1 阶段）：原生插件**尚未实现** healthConnectStatus 方法，
 *   getPlugin() 返回 null → 缓存恒 false → isHealthConnectAvailable() 恒 false →
 *   门面 Android 分派退回既有厂商路径，行为与改造前**逐字节一致**。
 *   HC-2 原生落地后，插件提供该方法，本适配器自动点亮，无需再改前端。
 *
 * ⚠️ 铁律 #13：本地绿 ≠ 真机绿。HC 可用性、读数正确性、多源去重均须真机验收后
 *   才能把 HEALTH_APP_CATALOG 的 health_connect 行从 in_progress 改 available。
 */

import { isAndroid } from '../platform'
import { normalizeHealthStatus, type HealthAuthResult, type HealthSyncData } from './types'
import type { SmartDeviceSample } from '@dbee/shared'

/** dbee-health 原生插件的 Health Connect 接口（与厂商接口分离，互不干扰） */
interface HealthConnectPlugin {
  /** 运行时探测 HC 是否可用（SDK 状态 + provider 存在）；旧插件无此方法 */
  healthConnectStatus?: () => Promise<{
    available: boolean
    reason?: string
    sdkStatusLabel?: string
  }>
  /** 打开健康连接的安装页或系统设置；旧插件无此方法 */
  openHealthConnect?: (opts: { target: 'install' | 'settings' }) => Promise<{ opened?: boolean }>
  /** 发起 HC 读权限授权；completed = 授权流程走完（真实授予以 fetchToday 为准） */
  requestHealthConnectAuthorization?: () => Promise<{
    completed: boolean
    reason?: string
    message?: string
  }>
  /** 读秤、跳绳、营养、血糖当天样本 */
  fetchHealthDevices?: () => Promise<{
    status?: string
    weightKg?: number
    bodyFatPct?: number
    nutritionKcal?: number
    jumpCount?: number
    jumpMinutes?: number
    glucoseMmol?: number
    weightGranted?: boolean
    ropeGranted?: boolean
    nutritionGranted?: boolean
    glucoseGranted?: boolean
    message?: string
  }>
  /** 读当天步数 + 活动能量 + 数据来源状态（HC aggregate 聚合读） */
  fetchHealthConnectToday?: () => Promise<{
    steps: number
    activeKcal: number
    status?: string
    message?: string
  }>
}

/** probe 超时的合成结果（timedOut 标记使其可与「真探测到不可用」区分，避免写死缓存） */
interface HealthConnectProbeResult {
  available: boolean
  reason?: string
  sdkStatusLabel?: string
  timedOut?: boolean
}

function getPlugin(): HealthConnectPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.DbeeHealth
  if (!p || typeof p !== 'object') return null
  return p as HealthConnectPlugin
}

/**
 * HC 能力缓存：null = 尚未 probe；true/false = probe 结果。
 * 用模块级变量而非每次查询：getSdkStatus 是跨进程调用，必须缓存（性能）。
 */
let availabilityCache: boolean | null = null
/** 探测结论是「可以安装/更新健康连接」，与「这台手机根本没有这条通道」分开 */
let installOffered = false

/**
 * 🔴 读数硬超时（8s）。为什么必须有：`aggregate()` 是**跨进程 suspend 调用**，
 * 厂商 ROM（小米 HyperOS 等）上可能永不返回 —— 原生侧的 CoroutineExceptionHandler
 * 只能兜住「抛异常」，兜不住「一直挂起」。Promise 不 settle → syncFromHealth()
 * 不返回 → UI 永远停在「正在读取今天的步数，稍候自动展示」（2026-11-18 小米 15 Ultra
 * 实测：连接成功但读数无任何反应）。超时后如实降级为 error，绝不用假数据填空。
 *
 * 不入 shared：这是 HC 单端关注点（mini 无 HC，iOS HealthKit 走本地库不跨进程挂起），
 * 与四端同源的 HEALTH_SYNC_INTERVAL_MS（轮询节奏）不是一回事。
 */
const HC_FETCH_TIMEOUT_MS = 8_000

/**
 * 给跨进程 Promise 套硬超时。
 * 🔴 用 `p.then(onFulfilled, onRejected)` 而非 `Promise.race`：race 在超时后不会
 *    消费 p 的迟到 rejection → 逃逸成 unhandledrejection（WebView 里报错、部分宿主上报）。
 *    这里 settled 标志一旦置位，迟到的成功/失败都就地消化，不再影响已返回的结论。
 * 🔴 未超时时的 rejection 原样 reject 给调用方的 try/catch（保留真实 message，
 *    不被超时结论覆盖），语义与改造前逐条一致。
 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(onTimeout())
    }, ms)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 探测并缓存 HC 可用性。App 启动 / 首次进入健康页时调一次即可。
 * 幂等：重复调用命中缓存直接返回，不重复打跨进程查询。
 *
 * @param force 传 true 时强制重探（用户从系统设置切回 App 时用，授权可能刚变）
 */
export async function probeHealthConnectAvailability(force = false): Promise<boolean> {
  if (availabilityCache !== null && !force) return availabilityCache
  if (!isAndroid()) {
    availabilityCache = false
    installOffered = false
    return false
  }
  const plugin = getPlugin()
  // 旧插件无 healthConnectStatus 方法 → HC 通道未就绪 → false（零回归）
  if (!plugin || typeof plugin.healthConnectStatus !== 'function') {
    availabilityCache = false
    installOffered = false
    return false
  }
  try {
    // 🔴 getSdkStatus 也是跨进程调用，同样可能挂起；超时按「不可用」处理（保守降级），
    // 但**不写缓存**（保持 null）→ 下次仍可重探，一次系统卡顿不等于把 HC 永久判死。
    const res = await withTimeout<HealthConnectProbeResult>(
      plugin.healthConnectStatus(),
      HC_FETCH_TIMEOUT_MS,
      () => ({ available: false, reason: 'probe_timeout', timedOut: true }),
    )
    if (res?.timedOut === true) return false
    availabilityCache = res?.available === true
    const label = typeof res?.sdkStatusLabel === 'string' ? res.sdkStatusLabel : ''
    const reason = typeof res?.reason === 'string' ? res.reason : ''
    // Android 13 及以下没装健康连接时，系统返回的是「需要安装/更新」，不是「这台手机没有」
    installOffered = availabilityCache !== true &&
      (label === 'provider_update_required' || reason === 'provider_update_required')
  } catch {
    availabilityCache = false
    installOffered = false
  }
  return availabilityCache
}

/**
 * 是否具备 Health Connect 运行条件（Android + 已 probe 到 HC 可用）。
 * 同步读缓存，供 isHealthConnectable() 的 useMemo 使用。
 * 🔴 probe 之前恒 false（缓存 null），确保未探测时不误显示入口。
 */
export function isHealthConnectAvailable(): boolean {
  return isAndroid() && availabilityCache === true
}

/** 本机可以安装或更新「健康连接」，点连接应去安装页，而不是提示手动记录 */
export function healthConnectInstallOffered(): boolean {
  return isAndroid() && installOffered
}

/** 打开健康连接的安装页（install）或系统设置（settings）。打不开时返回 false */
export async function openHealthConnect(target: 'install' | 'settings'): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin || typeof plugin.openHealthConnect !== 'function') return false
  try {
    const res = await plugin.openHealthConnect({ target })
    return res?.opened === true
  } catch {
    return false
  }
}

/**
 * 发起 HC 读授权。
 * reason 语义与 HealthKit 对齐：unavailable（设备无 HC）/ system_error（系统报错）/
 * null（流程走完，真实授予以 fetchToday 为准）。
 */
export async function requestHealthConnectAuthorization(): Promise<HealthAuthResult> {
  const plugin = getPlugin()
  if (!plugin || typeof plugin.requestHealthConnectAuthorization !== 'function') {
    return { completed: false, reason: null }
  }
  try {
    const res = await plugin.requestHealthConnectAuthorization()
    const reason = res.reason
    return {
      completed: res.completed === true,
      reason:
        reason === 'unavailable' || reason === 'no_types' || reason === 'system_error'
          ? reason
          : reason === 'not_ready'
            ? 'not_ready'
            : null,
      message: typeof res.message === 'string' ? res.message : undefined,
    }
  } catch (e) {
    return {
      completed: false,
      reason: 'system_error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 读当天步数 + 活动能量，如实返回数据来源状态。
 * 插件缺失 / 桥接异常 → no_plugin / error，绝不伪装成「今天 0 步」。
 *
 * 🔴 跨进程调用一律套 [HC_FETCH_TIMEOUT_MS] 硬超时：挂起不返回时如实降级为 error
 *    （附「读数超时」文案），让 UI 从「正在读取」切到可见的引导，而不是永远卡着。
 */
function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 10) / 10
}

/** 系统健康里的设备读数。插件没有这个方法时返回 null，调用方按「读不到」展示。 */
export async function fetchHealthConnectDevices(): Promise<SmartDeviceSample | null> {
  const plugin = getPlugin()
  if (!plugin || typeof plugin.fetchHealthDevices !== 'function') return null
  try {
    const res = await withTimeout(plugin.fetchHealthDevices(), HC_FETCH_TIMEOUT_MS, () => ({ status: 'error' }))
    if (res.status === 'unavailable' || res.status === 'error' || res.status === 'denied') {
      return {
        weightKg: null, bodyFatPct: null, nutritionKcal: null, jumpCount: null, jumpMinutes: null, glucoseMmol: null,
        weightGranted: res.weightGranted === true,
        ropeGranted: res.ropeGranted === true,
        nutritionGranted: res.nutritionGranted === true,
        glucoseGranted: res.glucoseGranted === true,
      }
    }
    return {
      weightKg: numOrNull(res.weightKg),
      bodyFatPct: numOrNull(res.bodyFatPct),
      nutritionKcal: numOrNull(res.nutritionKcal),
      jumpCount: res.jumpCount == null ? null : Math.max(0, Math.round(Number(res.jumpCount))),
      jumpMinutes: res.jumpMinutes == null ? null : Math.max(0, Math.round(Number(res.jumpMinutes))),
      glucoseMmol: numOrNull(res.glucoseMmol),
      weightGranted: res.weightGranted !== false,
      ropeGranted: res.ropeGranted !== false,
      nutritionGranted: res.nutritionGranted !== false,
      glucoseGranted: res.glucoseGranted !== false,
    }
  } catch {
    return null
  }
}

export async function fetchHealthConnectToday(): Promise<HealthSyncData> {
  const plugin = getPlugin()
  if (!plugin || typeof plugin.fetchHealthConnectToday !== 'function') {
    return { steps: 0, activeKcal: 0, status: 'no_plugin' }
  }
  try {
    const res = await withTimeout(plugin.fetchHealthConnectToday(), HC_FETCH_TIMEOUT_MS, () => ({
      steps: 0,
      activeKcal: 0,
      status: 'error',
      message: `读取系统健康数据超时（${HC_FETCH_TIMEOUT_MS / 1000}s 未响应），请稍后重试或手动记录运动`,
    }))
    const steps = Math.max(0, Math.round(res.steps || 0))
    const activeKcal = Math.max(0, Math.round(res.activeKcal || 0))
    return {
      steps,
      activeKcal,
      status: normalizeHealthStatus(res.status, steps, activeKcal),
      message: typeof res.message === 'string' && res.message.length > 0 ? res.message : undefined,
    }
  } catch (e) {
    return {
      steps: 0,
      activeKcal: 0,
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
