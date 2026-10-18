/**
 * Apple HealthKit 原生插件对接（自研 dbee-health 插件）。
 *
 * 与 Swift 插件接口逐条对齐（见 native-plugins/dbee-health/.../DbeeHealthPlugin.swift）：
 *   - requestAuthorization({ read }) → { completed }  授权流程走完即 true
 *   - fetchToday() → { steps, activeKcal }            真实数据
 *
 * ⚠️ HealthKit 铁律：读授权状态不可探测（authorizationStatus 对读取类型恒返回
 *   .notDetermined）。因此本层不做「是否真的授权了」的判断——是否真有数据
 *   以 fetchToday 返回为准；连接意图存云端 profiles.health_connected，
 *   用户可随时在「我的 > 健康数据源」重连/解除。
 */

import { isIOS } from '../platform'

/** dbee-health 原生插件的最小接口 */
interface HealthPlugin {
  /** 请求 HealthKit 授权（读步数 + 活动能量）；completed = 授权流程已走完 */
  requestAuthorization: (opts: { read: string[] }) => Promise<{ completed: boolean }>
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

/**
 * 发起授权；返回授权流程是否完成。
 * 注意：completed=true 不代表用户勾选了读取权限（读授权不可探测），
 * 用户拒绝/取消时流程同样走完，是否真有数据以 fetchToday 为准。
 */
export async function requestHealthAuthorization(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const res = await plugin.requestAuthorization({
      read: ['stepCount', 'activeEnergyBurned'],
    })
    return res.completed === true
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
