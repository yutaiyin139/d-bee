/**
 * Apple HealthKit 原生插件对接（自研 dbee-health 插件）。
 *
 * 与 Swift 插件接口逐条对齐（见 native-plugins/dbee-health/.../DbeeHealthPlugin.swift）：
 *   - requestAuthorization({ read }) → { completed, reason?, message? }
 *   - fetchToday() → { steps, activeKcal, status, message? }
 *
 * ⚠️ HealthKit 铁律：读授权状态不可探测（authorizationStatus 对读取类型恒返回
 *   .notDetermined）。因此本层不做「是否真的授权了」的判断——是否真有数据
 *   以 fetchToday 返回为准；连接意图存云端 profiles.health_connected，
 *   用户可随时在「我的 > 健康数据源」重连/解除。
 *
 * ⚠️ 但「读不到数据」必须区分原因：设备不支持 / 授权被拒 / 查询报错 / 今天真没数据，
 *   四者对用户的引导完全不同（旧实现一律吞成 0 步，用户以为「自己没运动」）。
 *   因此 fetchTodayHealth 现在如实透传原生 status，见 types.ts 的 HealthSyncStatus。
 */

import { isIOS } from '../platform'
import {
  normalizeHealthStatus,
  type HealthAuthResult,
  type HealthSyncData,
} from './types'

/** dbee-health 原生插件的最小接口 */
interface HealthPlugin {
  /** 请求 HealthKit 授权（读步数 + 活动能量）；completed = 授权流程已走完 */
  requestAuthorization: (opts: { read: string[] }) => Promise<{
    completed: boolean
    reason?: string
    message?: string
  }>
  /** 读当天步数 + 活动能量 + 数据来源状态 */
  fetchToday: () => Promise<{
    steps: number
    activeKcal: number
    status?: string
    message?: string
  }>
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
 * 发起授权。
 *
 * 返回 completed 与 reason 两个维度：
 *   - completed=true：流程走完，但**不代表**用户勾选了读取权限（读授权不可探测），
 *     是否真有数据以 fetchToday 为准
 *   - completed=false + reason='unavailable'：设备无健康能力（模拟器/部分 iPad）
 *   - completed=false + reason='system_error'：系统层报错，message 是原生描述
 *   - completed=false + reason=null：插件缺失（no_plugin 在调用方判定）
 */
export async function requestHealthAuthorization(): Promise<HealthAuthResult> {
  const plugin = getPlugin()
  if (!plugin) return { completed: false, reason: null }
  try {
    const res = await plugin.requestAuthorization({
      read: ['stepCount', 'activeEnergyBurned'],
    })
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
    // 旧版插件在系统错误时会 reject（新版改为 resolve + reason），这里同样如实上报
    return {
      completed: false,
      reason: 'system_error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 读当天步数 + 活动能量（kcal），并如实返回数据来源状态。
 *
 * 插件缺失 / 桥接异常一律标记 'no_plugin'（Web 端与旧版原生包的降级路径），
 * 调用方据此保持改造前的「0 步」行为，不会因为读不到就弹出误导性的授权引导。
 */
export async function fetchTodayHealth(): Promise<HealthSyncData> {
  const plugin = getPlugin()
  if (!plugin) return { steps: 0, activeKcal: 0, status: 'no_plugin' }
  try {
    const res = await plugin.fetchToday()
    const steps = Math.max(0, Math.round(res.steps || 0))
    const activeKcal = Math.max(0, Math.round(res.activeKcal || 0))
    return {
      steps,
      activeKcal,
      status: normalizeHealthStatus(res.status, steps, activeKcal),
      message: typeof res.message === 'string' && res.message.length > 0 ? res.message : undefined,
    }
  } catch (e) {
    // 桥接异常（原生崩溃 / 方法未实现）：显式标 error，不再伪装成「今天 0 步」
    return {
      steps: 0,
      activeKcal: 0,
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
