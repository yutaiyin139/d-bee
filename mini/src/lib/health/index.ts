/**
 * 健康数据源占位模块（小程序端）。
 *
 * 小程序端当前**不具备**健康数据接入能力：
 *  - 微信 getWeRunData（微信运动步数）需要「运动健康」类目资质，资质申请中；
 *  - 支付宝 / 抖音无步数 API；
 *  - 无 HealthKit / Health Connect / 华为 / 小米 SDK。
 *
 * 因此这里 isHealthConnectable() 恒返回 false，Profile 页据此隐藏「健康数据源」区块，
 * 与主工程 iOS / Android 端（可连接）的 UI 保持「能力对齐、诚实降级」。
 */

export interface HealthVendorInfo {
  vendor: 'apple' | 'huawei' | 'xiaomi' | 'none'
  label: string
  canSync: boolean
}

export function getHealthVendor(): HealthVendorInfo {
  return { vendor: 'none', label: '健康数据', canSync: false }
}

/** 是否显示「连接健康」入口（小程序端恒 false） */
export function isHealthConnectable(): boolean {
  return false
}

/** 是否已连接（小程序端恒 false） */
export function isHealthConnected(): boolean {
  return false
}

export interface ConnectResult {
  ok: boolean
  message: string
  vendor: HealthVendorInfo['vendor']
}

export async function connectHealth(): Promise<ConnectResult> {
  return { ok: false, message: '小程序端暂不支持连接健康数据', vendor: 'none' }
}

export async function disconnectHealth(): Promise<void> {
  /* no-op */
}

export interface HealthSyncData {
  steps: number
  activeKcal: number
}

export async function syncFromHealth(): Promise<HealthSyncData> {
  return { steps: 0, activeKcal: 0 }
}
