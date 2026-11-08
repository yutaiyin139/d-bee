/**
 * 健康数据源门面（小程序端）—— 对齐主工程 src/lib/health/index.ts 的**形状与措辞**。
 *
 * 🔴 2026-11-08 整改：此前本文件是「恒定 false + 裸占位」：
 *    getHealthVendor() 返回 vendor:'none'、connectHealth() 说「小程序端暂不支持」、
 *    syncFromHealth() 只返回 {steps, activeKcal} 两个字段（缺 status）。
 *    而主端早已为微信小程序预留了 brand 识别（wechat-miniprogram / 微信运动 / canSync）
 *    与 connectHealth、syncFromHealth 的分支。门面形状不同会让「诚实降级」措辞四端不一致。
 *
 * 现在的取舍（区分「真做不到」与「只是没做」）：
 *  - 门面形状、vendor 识别、状态枚举、降级文案、状态提示：**完全对齐主端**。
 *  - 真同步步数：做不到。wx.getWeRunData 需「运动健康」类目资质、返回加密数据须服务端
 *    用 session_key 解密、且只有步数无 activeEnergyBurned 粒度 → 诚实返回 no_plugin，
 *    绝不伪装成已连接或已同步（与主端小程序分支逐字一致）。
 */
import { getProfile, saveProfile } from '../api'

export interface HealthVendorInfo {
  vendor: 'wechat-miniprogram' | 'apple' | 'huawei' | 'xiaomi' | 'none'
  label: string
  canSync: boolean
  tip?: string
}

/** 主端 brand.ts:45-55 的小程序分支同源 */
export function getHealthVendor(): HealthVendorInfo {
  return {
    vendor: 'wechat-miniprogram',
    label: '微信运动',
    canSync: true,
    tip: '请在微信「设置 > 通用 > 辅助功能」里开启微信运动后使用。',
  }
}

/**
 * 是否显示「健康数据源」入口。
 * 主端 isHealthConnectable() 在小程序环境返回 true（见 src/lib/health/index.ts:51-55），
 * 故这里也必须返回 true，否则「我的」页区块会凭空消失。
 */
export function isHealthConnectable(): boolean {
  return true
}

/** 是否已连接（读云端 profile.health_connected，与主端同口径） */
export async function isHealthConnected(): Promise<boolean> {
  try {
    const p = await getProfile()
    return p?.health_connected === true
  } catch {
    return false
  }
}

export interface ConnectResult {
  ok: boolean
  message: string
  vendor: HealthVendorInfo['vendor']
}

/** 主端 connectHealth:165-172 的小程序分支逐字同源：不写云端连接态、不误导为已连接 */
export async function connectHealth(): Promise<ConnectResult> {
  return {
    ok: false,
    message: '微信运动接入正在准备中，当前请先手动记录运动。',
    vendor: 'wechat-miniprogram',
  }
}

/** 与主端同形状；未接入前不写云端状态 */
export async function disconnectHealth(): Promise<void> {
  try {
    await saveProfile({ health_connected: false })
  } catch {
    // 状态清除失败不抛出：下次连接会重新覆盖
  }
}

/** 主端 src/lib/health/types.ts:24-31 同源的状态枚举 */
export type HealthSyncStatus =
  | 'ok' | 'empty' | 'denied' | 'error' | 'unavailable' | 'not_ready' | 'no_plugin'

export interface HealthSyncData {
  steps: number
  activeKcal: number
  status: HealthSyncStatus
  message?: string
}

/** 主端 syncFromHealth:203-205 的小程序分支同源 */
export async function syncFromHealth(): Promise<HealthSyncData> {
  return { steps: 0, activeKcal: 0, status: 'no_plugin' }
}

/** 是否应把数值写回 UI（denied/error/unavailable/not_ready 时保留旧值，避免闪成 0） */
export function isUsableHealthStatus(status: HealthSyncStatus): boolean {
  return status === 'ok' || status === 'empty' || status === 'no_plugin'
}

/** 主端 healthStatusHint:213-229 逐字同源：三处调用点措辞必须一致 */
export function healthStatusHint(status: HealthSyncStatus, vendorLabel: string): string {
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
 * 步数 → 活动消耗（kcal）换算。
 * 主端 src/lib/health/index.ts:243-257 同源实现：步幅法（身高 × 0.45，缺省 0.72m），
 * 每公斤体重每公里约 0.75 kcal。缺体重或步数为 0 时返回 0，保证净摄入不会虚高。
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

/** 四端单一真相源：数值口径常量统一下沉 @dbee/shared，不再各写一份副本 */
export { ACTIVITY_EATBACK_RATIO, DEFAULT_STEP_GOAL, HEALTH_SYNC_INTERVAL_MS } from '@dbee/shared'
