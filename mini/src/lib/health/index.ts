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
 *    getWeRunData→网关解密）；syncFromHealth() 默认**静默实时**同步（已授权才读，
 *    绝不弹框），未授权/失败回退本地缓存。🔴 2026-11-18 修正：旧版恒只读缓存，
 *    把「授权须由用户主动动作触发」误读成「读取也须每次点一下」，导致用户反馈的
 *    「连接成功但今日步数不刷新 / 登录不实时」。平台约束的真实边界见 werun.ts 头注②。
 *    步数只有步数、无 activeKcal 粒度 → activeKcal 恒 0，由步幅法兜底。
 */
import { getProfile, saveProfile } from '../api'
import { syncWechatStepsActive, syncWechatStepsSilent, readWechatStepsCache } from '../werun'
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
  /**
   * 🔴 本次连接实际同步到的当天步数（2026-11-18 用户反馈修复）。
   * 此前只把 steps 塞进 message 文案，UI 拿不到数值 → 「连接成功但今日步数不刷新」。
   * 现在回传出来，profile/SmartDeviceSheet 可立即 setState，不必等缓存回读。
   */
  steps?: number
  syncedAt?: string
}

/**
 * 用户主动点「同步微信运动」时调用：走完整主动同步链路（WX-2）。
 * 🔴 只有拿到真实数据（status ok/empty）才写云端连接态，授权拒绝/错误不写，
 *    避免把「点了一下」误标成「已连接」（零假功能）。
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
      // 连接成功即回传数值：调用方立刻刷新今日步数（不等轮询、不等缓存回读）
      steps: r.steps,
      syncedAt: r.syncedAt,
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
 * 读取当前步数（首页登录/进入、健康档案、智能设备弹层共用）。
 *
 * 🔴 2026-11-18 语义修正（用户实测反馈：连接后今日步数不刷新、登录不实时）：
 *   旧版**恒只读本地缓存**，把「平台要求授权由用户主动动作触发」误当成
 *   「读取也必须每次点一下」。实际约束是**不得凭生命周期弹授权框**，
 *   已授权用户静默读取完全合规且不弹框（见 werun.ts checkWerunAuthSilent）。
 *
 * 现在的行为（默认 live=true）：
 *   已授权 → 静默实时同步，拿到微信运动**当时**的步数；
 *   未授权/不支持/本次同步失败 → 回退本地缓存，UI 保留上次数值（不闪 0、不弹框、不报错）。
 *
 * @param opts.live 传 false 表示只读缓存（🔴 仅 60s 轮询用：微信运动只在进入小程序时
 *   更新，轮询做实时同步拿到的仍是同一份快照，却每分钟一次 wx.login + 网关调用，
 *   会撞 jscode2session 频控 errcode 45011 → 把本来正常的登录链路拖成 503）。
 */
export async function syncFromHealth(opts?: { live?: boolean }): Promise<HealthSyncData> {
  const live = opts?.live !== false
  if (live) {
    try {
      const fresh = await syncWechatStepsSilent()
      // null = 未授权/不支持/失败（静默路径刻意不区分，一律不打扰用户）→ 落到缓存兜底
      if (fresh) {
        return {
          steps: fresh.steps,
          activeKcal: 0,
          status: fresh.status as HealthSyncStatus,
          syncedAt: fresh.syncedAt,
        }
      }
    } catch {
      // 实时路径任何异常都不该让用户看不到步数 → 缓存兜底
    }
  }
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
