/**
 * Android 厂商运动健康原生插件对接（dbee-health 插件的 Android 实现）。
 *
 * 华为 Health Kit / 小米运动健康数据服务，客户端 SDK 的接口形态高度一致
 * （都是「系统健康服务 + DataController.readTodaySummation 读当日步数」），
 * 且都通过同一个 DbeeHealth 插件注入（jsName 相同），因此前端只需**一个**适配器，
 * 用「品牌白名单」区分哪些 Android 厂商支持真同步。
 *
 * 与 iOS 侧 healthkit.ts 完全同构，唯一区别是平台/品牌探测：
 *   - healthkit.ts : iOS + DbeeHealth 插件可用
 *   - android.ts   : Android + 可同步厂商（华为/小米）+ DbeeHealth 插件可用
 *
 * 插件 JS 桥接口与 Swift 侧逐条对齐（前端无感知，门面层不嗅探平台差异）：
 *   - requestAuthorization({ read }) → { completed }  授权流程走完即 true
 *   - fetchToday() → { steps, activeKcal }            真实数据
 *
 * ⚠️ 华为/小米均依赖资质（开发者账号 + 服务申请 + 签名配置），未就绪时插件
 *   的 requestAuthorization 返回 completed=false（见插件 Java 侧注释），前端据此
 *   降级为「引导」提示，不影响手动运动。详见 docs/健康数据源方案.md。
 */

import { isAndroid } from '../platform'
import { detectHealthVendor, type HealthVendor } from './brand'
import { normalizeHealthStatus, type HealthSyncData } from './types'

/**
 * 支持真同步的 Android 厂商白名单（有官方健康数据开放 SDK 的品牌）。
 * 华为 = Health Kit；小米 = 运动健康数据服务 SDK。
 * 未来接入 vivo/OPPO 等，只需在此追加品牌。
 */
export const SYNCABLE_ANDROID_VENDORS: ReadonlySet<HealthVendor> = new Set<HealthVendor>(['huawei', 'xiaomi'])

/** dbee-health 原生插件的最小接口（与 healthkit.ts 同构） */
interface HealthPlugin {
  /**
   * 请求健康数据授权；completed = 授权流程已走完。
   * reason 为 Android 厂商特有的降级标记：资质未就绪时返回 'not_ready'。
   */
  requestAuthorization: (opts: { read: string[] }) => Promise<{ completed: boolean; reason?: string }>
  /** 读当天步数 + 活动能量（+ 数据来源状态，与 iOS 侧对齐） */
  fetchToday: () => Promise<{ steps: number; activeKcal: number; status?: string; message?: string }>
}

/** Android 厂商授权的返回结果 */
export interface AndroidAuthResult {
  /** 授权流程是否完成（资质就绪后接真实 SDK 才有意义） */
  completed: boolean
  /** 是否因厂商资质未就绪而无法发起授权（区别于用户主动拒绝） */
  notReady: boolean
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

/** 是否具备 Android 厂商健康数据运行条件（Android 原生 + 可同步厂商 + 插件已注入） */
export function isAndroidVendorHealthAvailable(): boolean {
  return isAndroid() && SYNCABLE_ANDROID_VENDORS.has(detectHealthVendor().vendor) && getPlugin() !== null
}

/**
 * 发起授权；返回授权结果。
 * 华为/小米授权结果明确可感知（拒绝返回明确错误码），但「资质未就绪」与「用户拒绝」
 * 需区分：notReady 表示厂商 SDK 尚未接入（无真实授权流程），前端据此诚实引导。
 */
export async function requestAndroidVendorAuthorization(): Promise<AndroidAuthResult> {
  const plugin = getPlugin()
  if (!plugin) return { completed: false, notReady: false }
  try {
    const res = await plugin.requestAuthorization({
      read: ['stepCount', 'activeEnergyBurned'],
    })
    return {
      completed: res.completed === true,
      notReady: res.reason === 'not_ready',
    }
  } catch {
    return { completed: false, notReady: false }
  }
}

/**
 * 读当天步数 + 活动能量（kcal），并如实返回数据来源状态。
 *
 * 当前厂商 SDK 未接资质，插件返回 status='not_ready'（区别于「今天真的 0 步」）；
 * 资质就绪后插件返回真实值，本函数不需要再改。
 */
export async function fetchAndroidVendorToday(): Promise<HealthSyncData> {
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
    return {
      steps: 0,
      activeKcal: 0,
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
