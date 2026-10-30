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
import { isHealthKitAvailable, requestHealthAuthorization, fetchTodayHealth } from './healthkit'
import {
  isAndroidVendorHealthAvailable,
  requestAndroidVendorAuthorization,
  fetchAndroidVendorToday,
} from './android'
import { isWechatMiniProgram } from '../platform'
import { getProfile, saveProfile } from '../api'
import type { HealthSyncData } from './types'

export type { HealthVendor, HealthVendorInfo } from './brand'
export type { HealthSyncData, HealthSyncStatus, HealthAuthResult, HealthAuthReason } from './types'
export { isUsableHealthStatus } from './types'

export interface ConnectResult {
  ok: boolean
  /** 展示给用户的提示文案 */
  message: string
  /** 已连接的数据源标识 */
  vendor: HealthVendorInfo['vendor']
}

/** 品牌识别入口 */
export function getHealthVendor(): HealthVendorInfo {
  return detectHealthVendor()
}

/**
 * 是否显示「连接健康」入口。
 *
 * 原生 App 且健康平台插件可用时显示，微信小程序（微信运动）也显示：
 *   - iOS    ：Apple 健康（HealthKit）真同步
 *   - Android：华为 Health Kit / 小米运动健康数据服务 真同步（依赖资质，未就绪时授权降级为引导）
 *   - 微信小程序：微信运动（wx.getWeRunData）真同步（规划中）
 * 其它安卓厂商无公开读取 API；Web 也不显示。
 *
 * ⚠️ 零影响保证：现有三端走的是 isHealthKitAvailable()/isAndroidVendorHealthAvailable()，
 *   两者在非对应平台恒为 false；新增的 isWechatMiniProgram() 仅在小程序环境为 true，
 *   对 Web/iOS/Android 返回值不变。
 */
export function isHealthConnectable(): boolean {
  return isWechatMiniProgram() || isHealthKitAvailable() || isAndroidVendorHealthAvailable()
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
 * 点击「连接 Apple 健康」：调 HealthKit 授权流程，走完后写云端连接状态。
 *
 * 流程：
 *   ① 调原生 requestAuthorization → 系统弹健康权限配置（首次）；
 *      已询问过时系统不再弹窗，流程直接走完（所以这里永远可以重连）
 *   ② 授权流程完成 → saveProfile({ health_connected: true, health_connected_at })
 *   ③ 返回 ok，前端据此隐藏按钮 + 触发一次同步
 *
 * ⚠️ 读授权不可探测：用户即使拒绝，流程也返回 completed=true。
 *   是否真有数据以 fetchToday 为准；步数一直为 0 时引导用户到
 *   iOS「设置 > 健康 > 数据访问权限 > D-Bee」勾选（见健康数据源页提示）。
 */
export async function connectHealth(): Promise<ConnectResult> {
  const v = detectHealthVendor()

  if (v.vendor === 'apple') {
    if (!isHealthKitAvailable()) {
      // 插件未注入（非原生 iOS / 尚未编译插件）：保留原占位提示
      return { ok: false, message: 'Apple 健康同步正在接入中，当前请先手动记录运动。', vendor: 'apple' }
    }

    const auth = await requestHealthAuthorization()
    if (!auth.completed) {
      // 按原生透传的 reason 精确提示，不再一律显示「授权未完成」
      if (auth.reason === 'unavailable') {
        return {
          ok: false,
          message: '当前设备不支持 Apple 健康数据，请手动记录运动。',
          vendor: 'apple',
        }
      }
      if (auth.reason === 'system_error') {
        return {
          ok: false,
          message: `健康授权失败（${auth.message ?? '系统错误'}），请稍后重试。`,
          vendor: 'apple',
        }
      }
      return {
        ok: false,
        message: '授权未完成，可稍后在「我的 > 健康数据源」里重新连接。',
        vendor: 'apple',
      }
    }

    // 授权流程完成 → 存云端连接状态（跨设备一致）
    try {
      await saveProfile({ health_connected: true, health_connected_at: new Date().toISOString() })
    } catch {
      // 存状态失败不阻断；本地连接态未落云端时按钮仍在，可重试
    }
    return { ok: true, message: '已连接 Apple 健康，步数与活动能量将自动同步。', vendor: 'apple' }
  }

  if (v.vendor === 'huawei' || v.vendor === 'xiaomi') {
    if (!isAndroidVendorHealthAvailable()) {
      // 插件未注入（非对应 Android / 尚未编译插件）：保留原占位提示
      return { ok: false, message: `${v.label}同步正在接入中，当前请先手动记录运动。`, vendor: v.vendor }
    }

    const auth = await requestAndroidVendorAuthorization()
    if (auth.notReady) {
      // 厂商资质未就绪（无真实授权 SDK），诚实引导，不误导为「用户拒绝授权」
      return {
        ok: false,
        message: `${v.label}接入正在申请资质，当前请先手动记录运动。`,
        vendor: v.vendor,
      }
    }
    if (!auth.completed) {
      return {
        ok: false,
        message: '授权未完成，可稍后在「我的 > 健康数据源」里重新连接。',
        vendor: v.vendor,
      }
    }

    // 授权流程完成 → 存云端连接状态（跨设备一致，与 Apple 端同一字段）
    try {
      await saveProfile({ health_connected: true, health_connected_at: new Date().toISOString() })
    } catch {
      // 存状态失败不阻断；本地连接态未落云端时按钮仍在，可重试
    }
    return { ok: true, message: `已连接${v.label}，步数与活动能量将自动同步。`, vendor: v.vendor }
  }

  if (v.vendor === 'wechat-miniprogram') {
    // 微信运动接入规划中：当前诚实引导，不写云端连接态、不误导为「已连接」。
    return {
      ok: false,
      message: '微信运动接入正在准备中，当前请先手动记录运动。',
      vendor: 'wechat-miniprogram',
    }
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
 * 拉取当天步数 + 活动能量，并返回数据来源状态。
 * 按品牌分派：iOS → HealthKit；华为/小米 → 各自 Health Kit；否则 no_plugin。
 * 登录后（Dashboard 加载时）若已连接，调用本函数自动同步。
 *
 * status 用于区分「今天真的 0 步」与「读不到数据」：
 * 调用方应仅在 isUsableHealthStatus(status) 时把数值写回 UI，
 * 其余状态保留旧值并展示对应引导（授权被拒 → 去系统设置；出错 → 稍后重试）。
 */
export async function syncFromHealth(): Promise<HealthSyncData> {
  const v = detectHealthVendor()
  if (v.vendor === 'apple') {
    if (!isHealthKitAvailable()) return { steps: 0, activeKcal: 0, status: 'no_plugin' }
    return fetchTodayHealth()
  }
  if (v.vendor === 'huawei' || v.vendor === 'xiaomi') {
    if (!isAndroidVendorHealthAvailable()) return { steps: 0, activeKcal: 0, status: 'no_plugin' }
    return fetchAndroidVendorToday()
  }
  // 微信小程序（wechat-miniprogram）：微信运动真同步规划中，当前返回 no_plugin，
  // 不影响任何现有端；接入后在此补 wx.getWeRunData 拉取。
  return { steps: 0, activeKcal: 0, status: 'no_plugin' }
}

/**
 * 把同步状态翻译成给用户看的一句话（无可展示信息时返回空串）。
 *
 * 集中在此处而不是散在各页面：三处调用点（Dashboard 自动同步、Dashboard 手动连接、
 * 「我的 > 健康数据源」）需要完全一致的措辞，否则用户会以为是两个不同问题。
 */
export function healthStatusHint(status: HealthSyncData['status'], vendorLabel: string): string {
  switch (status) {
    case 'denied':
      return `${vendorLabel}读取权限未开启，步数不会同步。请到系统设置 > 健康 > 数据访问权限中勾选「自律蜜蜂」。`
    case 'error':
      return '读取健康数据时出错，请稍后重试；步数暂时保持上次结果。'
    case 'unavailable':
      return '当前设备不支持健康数据同步，请手动记录运动。'
    case 'not_ready':
      return `${vendorLabel}接入正在申请资质，当前请先手动记录运动。`
    case 'empty':
      return `今天还没有${vendorLabel}数据。确认设备已同步后，会自动读取。`
    case 'no_plugin':
    case 'ok':
    default:
      return ''
  }
}

/**
 * 解除连接：清云端状态，UI 恢复「连接」入口。
 * 不清系统侧授权（iOS 无 API 可撤销第三方读授权），
 * 重新连接时系统大概率不再弹窗、直接走完流程。
 */
export async function disconnectHealth(): Promise<void> {
  try {
    await saveProfile({ health_connected: false, health_connected_at: null })
  } catch {
    // 状态清除失败不抛出：下次连接会重新覆盖
  }
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
