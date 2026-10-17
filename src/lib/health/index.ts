/**
 * 运动健康对接 · 统一门面。
 *
 * 业务代码只从这里取数据/发起连接，不直接嗅探品牌或插件。
 * 平台差异、品牌差异、HealthKit 授权全部封在 health/ 内部。
 *
 * 连接状态（health_connected）存云端 profiles 表（跨设备一致），
 * 授权成功后置 true，下次登录据此「自动获取 + 连接按钮消失」。
 *
 * 当前实现分层：
 *   - getHealthVendor()           品牌识别（纯函数，零依赖）
 *   - isHealthConnectable()       是否显示「连接健康」入口（iOS + 插件可用）
 *   - isHealthConnected()         是否已连接（读云端 profile.health_connected）
 *   - connectHealth()             点击连接 → 调 HealthKit 授权 → 存云端状态
 *   - syncFromHealth()            拉取当天步数 + 活动能量
 *   - estimateActivityKcal()      步数 → 活动消耗换算（融热量缺口）
 */

import { detectHealthVendor, isWechatWebView } from './brand'
import type { HealthVendorInfo } from './brand'
import { getHealthAuthorizationStatus, isHealthKitAvailable, requestHealthAuthorization, fetchTodayHealth } from './healthkit'
import { isIOS } from '../platform'
import { getProfile, saveProfile } from '../api'

export type { HealthVendor, HealthVendorInfo } from './brand'

export interface ConnectResult {
  ok: boolean
  /** 展示给用户的提示文案 */
  message: string
  /** 已连接的数据源标识 */
  vendor: HealthVendorInfo['vendor']
}

export interface HealthSyncData {
  /** 当天步数 */
  steps: number
  /** 当天活动能量（kcal，HealthKit activeEnergyBurned 直接值） */
  activeKcal: number
}

/** 品牌识别入口 */
export function getHealthVendor(): HealthVendorInfo {
  return detectHealthVendor()
}

/**
 * 是否显示「连接健康」入口。
 *
 * 仅 iOS 原生 App 且 HealthKit 插件可用时显示：当前只有 Apple 健康支持真同步。
 * 安卓厂商运动健康无公开读取 API；Web 也不显示。
 */
export function isHealthConnectable(): boolean {
  return isHealthKitAvailable()
}

/**
 * 是否已连接 Apple 健康（读云端 profile.health_connected）。
 * 已连接时 UI 隐藏「连接」按钮；下次登录据此自动拉取数据。
 */
export async function isHealthConnected(): Promise<boolean> {
  try {
    const p = await getProfile()
    return p?.health_connected === true
  } catch {
    return false
  }
}

/**
 * 点击「连接 Apple 健康」：调 HealthKit 授权，成功后写云端状态。
 *
 * 流程（参考自律茄子的授权交互）：
 *   ① 调原生 requestAuthorization → 系统弹健康权限配置
 *   ② 用户在系统弹窗勾选步数/活动能量并同意
 *   ③ 授权成功 → saveProfile({ health_connected: true, health_connected_at })
 *   ④ 返回 ok，前端据此隐藏按钮 + 触发一次同步
 */
export async function connectHealth(): Promise<ConnectResult> {
  const v = detectHealthVendor()

  if (v.vendor === 'apple') {
    if (!isHealthKitAvailable()) {
      // 插件未注入（非原生 iOS / 尚未编译插件）：保留原占位提示
      return { ok: false, message: 'Apple 健康同步正在接入中，当前请先手动记录运动。', vendor: 'apple' }
    }

    const authorized = await requestHealthAuthorization()
    // 双保险：requestAuthorization 的返回值可能因用户部分拒绝而不准，
    // 再查一次真实授权状态确认确实拿到了读取权限。
    const confirmed = authorized && (await getHealthAuthorizationStatus())
    if (!confirmed) {
      return { ok: false, message: '未授权访问 Apple 健康，请在系统弹窗中允许后重试。', vendor: 'apple' }
    }

    // 授权成功 → 存云端连接状态（跨设备一致）
    try {
      await saveProfile({ health_connected: true, health_connected_at: new Date().toISOString() })
    } catch {
      // 存状态失败不阻断，仅提示；下次授权状态查询仍可兜底
    }
    return { ok: true, message: '已连接 Apple 健康，步数与活动能量将自动同步。', vendor: 'apple' }
  }

  if (v.vendor === 'web') {
    if (isWechatWebView()) {
      return { ok: false, message: '微信运动数据请在微信内查看；D-Bee 已支持手动记录运动。', vendor: 'web' }
    }
    return { ok: false, message: '', vendor: 'web' }
  }

  return { ok: false, message: v.tip, vendor: v.vendor }
}

/**
 * 拉取当天步数 + 活动能量。
 * 仅 iOS + 已授权时返回真实数据；否则返回 0。
 * 登录后（Dashboard 加载时）若已连接，调用本函数自动同步。
 */
export async function syncFromHealth(): Promise<HealthSyncData> {
  if (!isHealthKitAvailable()) return { steps: 0, activeKcal: 0 }
  const authorized = await getHealthAuthorizationStatus()
  if (!authorized) return { steps: 0, activeKcal: 0 }
  return fetchTodayHealth()
}

/**
 * 步数 → 活动消耗（kcal）换算。
 *
 * 采用「步幅法」估算：步行距离 = 步数 × 步幅，再按体重折算消耗。
 * 步幅按身高估算（身高 × 0.45，单位米），无身高时用默认 0.72m。
 * 每公斤体重每公里步行约消耗 0.75 kcal（中等步速）。
 *
 * 返回 0 安全值：缺体重或步数为 0 时不产生负值。
 */
export function estimateActivityKcal(
  steps: number,
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
): number {
  const s = Math.max(0, Math.round(steps || 0))
  if (s <= 0 || !weightKg || weightKg <= 0) return 0
  const strideM = heightCm && heightCm > 0 ? (heightCm / 100) * 0.45 : 0.72
  const km = (s * strideM) / 1000
  return Math.round(km * weightKg * 0.75)
}

/**
 * 活动消耗计入「可吃回」额度的比例（50%）。
 *
 * 依据：手环/步数普遍高估消耗 20% 左右，若 100% 回补会让人越减越肥
 * （Cal AI 用 80%、自律茄子用 100%，均被第三方评测点名）。50% 是安全折中。
 */
export const ACTIVITY_EATBACK_RATIO = 0.5

/** 每日步数目标默认值（用户未在「我的」里自定义时使用） */
export const DEFAULT_STEP_GOAL = 6000
