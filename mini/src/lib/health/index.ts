/**
 * 健康数据源门面（小程序端）—— 对齐主工程 src/lib/health/index.ts 的**形状与措辞**。
 *
 * 🔴 2026-11-08 整改：此前本文件是「恒定 false + 裸占位」：
 *    getHealthVendor() 返回 vendor:'none'、connectHealth() 说「小程序端暂不支持」、
 *    syncFromHealth() 只返回 {steps, activeKcal} 两个字段（缺 status）。
 *    而主端早已为微信小程序预留了 brand 识别（wechat-miniprogram / 微信运动 / canSync）
 *    与 connectHealth、syncFromHealth 的分支。门面形状不同会让「诚实降级」措辞四端不一致。
 *
 * 2026-11-17 WX-0~WX-3：微信运动已真接入（隐私指引审核通过 + 网关解密端点 + 主动同步）。
 *  - 门面形状、vendor 识别、状态枚举、降级文案、状态提示：**完全对齐主端**。
 *  - 🔴 纠偏旧结论：读取方向的硬前置是《用户隐私保护指引》声明 + 用户授权，
 *    **不是**「运动健康」类目资质（那类目限制的是「写入/分享到微信运动」，D6 已决定不做）。
 *  - 真同步步数：connectHealth() 由用户主动点击触发完整链路（隐私→授权→login→
 *    getWeRunData→网关解密），syncFromHealth() 自动路径只读本地缓存，绝不自动调 getWeRunData
 *    （平台规范）。步数只有步数、无 activeKcal 粒度 → activeKcal 恒 0，由步幅法兜底。
 */
import { getProfile, saveProfile } from '../api'
import { syncWechatStepsActive, readWechatStepsCache } from '../werun'
import { isVendorConnected } from '@dbee/shared'
import type { HealthVendorDb } from '@dbee/shared'

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

/**
 * 是否已连接微信运动（读云端 profile，WX-4 防串台）。
 *
 * 小程序恒只认 werun 来源：iPhone App 连了 Apple 健康后 health_vendor='apple'，
 * 这里按来源判定不算已连接 → 不显示「微信运动已连接」（真机验收判据）。
 * 旧数据（health_vendor 为空）回退布尔，兼容 0053 之前只写布尔的旧包。
 */
export async function isHealthConnected(expectedVendor?: HealthVendorDb): Promise<boolean> {
  try {
    const p = await getProfile()
    if (!p) return false
    return isVendorConnected(p.health_connected, p.health_vendor, expectedVendor ?? 'werun')
  } catch {
    return false
  }
}

export interface ConnectResult {
  ok: boolean
  message: string
  vendor: HealthVendorInfo['vendor']
}

/**
 * 用户主动点「同步微信运动」时调用：走完整主动同步链路（WX-2）。
 * 🔴 只有拿到真实数据（status ok/empty）才写云端连接态，授权拒绝/错误不写，
 *    避免把「点了一下」误标成「已连接」（零假功能）。
 * 自动路径（首页轮询）不会调到这里——那里走 syncFromHealth() 读缓存。
 */
export async function connectHealth(): Promise<ConnectResult> {
  const r = await syncWechatStepsActive()
  if (r.status === 'ok' || r.status === 'empty') {
    // 真同步成功（含「今天真的 0 步」）→ 写云端连接态 + 来源 werun（WX-4 防串台），
    // 下次进入据此显示已连接；旧数据无来源时回退布尔，兼容先前版本
    try {
      await saveProfile({ health_connected: true, health_vendor: 'werun' })
    } catch {
      // 写状态失败不阻断本次结果展示
    }
    return {
      ok: true,
      message: r.status === 'empty'
        ? '已连接微信运动，今天还没有步数数据。'
        : `已连接微信运动，今日 ${r.steps} 步已同步。`,
      vendor: 'wechat-miniprogram',
    }
  }
  return { ok: false, message: r.message || '微信运动同步未成功，请稍后重试。', vendor: 'wechat-miniprogram' }
}

/** 解除连接：清云端状态 + 本地步数缓存，UI 恢复「连接」入口 */
export async function disconnectHealth(): Promise<void> {
  try {
    await saveProfile({ health_connected: false, health_vendor: null })
  } catch {
    // 状态清除失败不抛出：下次连接会重新覆盖
  }
  try {
    const { kvRemove } = await import('../kv')
    await kvRemove('dbee:werun:cache')
  } catch {
    // 缓存清理失败不阻断
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
  /** 微信运动快照时间（ISO）；UI 据此标「更新于 HH:mm」，不宣称实时（仅小程序端有值） */
  syncedAt?: string
}

/**
 * 自动路径（首页登录同步 / 60s 定时 / onShow）走这里：只读本地缓存，
 * 🔴 绝不触发 wx.getWeRunData —— 平台要求用户主动触发，且微信运动只在用户进入时更新。
 * 无缓存/过期 → status:'empty'（UI 提示「点一下同步」，不弹系统授权框）。
 * 数值由 connectHealth() 主动同步后写入缓存；activeKcal 恒 0，由步幅法兜底。
 */
export async function syncFromHealth(): Promise<HealthSyncData> {
  const cached = await readWechatStepsCache()
  return {
    steps: cached.steps,
    activeKcal: 0,
    status: cached.status as HealthSyncStatus,
    syncedAt: cached.syncedAt,
  } as HealthSyncData
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
