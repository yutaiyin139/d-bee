/**
 * Apple HealthKit 原生插件探测（自研 dbee-health 插件）。
 *
 * ⚠️ 当前状态（2026-10-17）：插件骨架，尚未在 Mac 上编译验证。
 *   原生侧还没有 dbee-health 插件（见 native-plugins/dbee-health，待 Mac 编译）。
 *   本文件用「运行时鸭子类型探测」预留插件接口（沿用 wechat.ts / originProxy.ts 风格），
 *   真实 Swift 插件实现后，只需让插件满足下面的 HealthPlugin 接口即可。
 *
 * HealthKit 关键点（实现 Swift 插件时对照）：
 *   - 授权：HKHealthStore.requestAuthorization(toShare:read:)，
 *     读 stepCount + activeEnergyBurned + workoutType
 *   - 读步数/活动能量：HKSampleQuery 按当天起止时间聚合
 *   - 授权状态：HKHealthStore.authorizationStatus(for:)
 */

import { isIOS } from '../platform'

/** dbee-health 原生插件的最小接口 */
interface HealthPlugin {
  /** 请求 HealthKit 授权（读步数 + 活动能量） */
  requestAuthorization: (opts: { read: string[] }) => Promise<{ authorized: boolean }>
  /** 查询授权状态 */
  authorizationStatus: () => Promise<{ authorized: boolean }>
  /** 读当天步数 + 活动能量 */
  fetchToday: () => Promise<{ steps: number; activeKcal: number }>
}

function getPlugin(): HealthPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.DbeeHealth
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<HealthPlugin>
  if (typeof candidate.requestAuthorization !== 'function' || typeof candidate.fetchToday !== 'function') {
    return null
  }
  return candidate as HealthPlugin
}

/** 是否具备 HealthKit 运行条件（iOS 原生 + 插件已注入） */
export function isHealthKitAvailable(): boolean {
  return isIOS() && getPlugin() !== null
}

/** 请求授权；返回是否已授权 */
export async function requestHealthAuthorization(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const res = await plugin.requestAuthorization({
      read: ['stepCount', 'activeEnergyBurned', 'workoutType'],
    })
    return res.authorized === true
  } catch {
    return false
  }
}

/** 查询当前授权状态（已授权 = 已连接） */
export async function getHealthAuthorizationStatus(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const res = await plugin.authorizationStatus()
    return res.authorized === true
  } catch {
    return false
  }
}

/** 读当天步数 + 活动能量（kcal） */
export async function fetchTodayHealth(): Promise<{ steps: number; activeKcal: number }> {
  const plugin = getPlugin()
  if (!plugin) return { steps: 0, activeKcal: 0 }
  try {
    const res = await plugin.fetchToday()
    return {
      steps: Math.max(0, Math.round(res.steps || 0)),
      activeKcal: Math.max(0, Math.round(res.activeKcal || 0)),
    }
  } catch {
    return { steps: 0, activeKcal: 0 }
  }
}
