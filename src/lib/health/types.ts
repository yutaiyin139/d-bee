/**
 * 健康数据源的公共类型（iOS HealthKit / Android 厂商 Health Kit 共用）。
 *
 * 独立成文件的原因：healthkit.ts 与 android.ts 是两个同构适配器，
 * 若把类型定义在其中之一，另一个就得反向 import（形成无谓的耦合方向）。
 */

/**
 * 同步结果状态。
 *
 * 为什么必须有它：旧实现把「设备不支持」「授权被拒」「查询报错」「今天真的没数据」
 * 全部吞成 `steps: 0`，前端只能显示「0 步」。用户看到 0 步会以为自己没运动，
 * 而真实原因可能是系统健康权限没开——两者需要的引导完全不同。
 *
 *   ok          读到了数据
 *   empty       查询成功但今天没有样本（可能没戴表；也可能系统里关了读取——
 *               HealthKit 的读授权不可探测，二者在 API 层无法区分）
 *   denied      系统明确返回授权被拒 / 从未询问 → 引导去「设置 > 健康」勾选
 *   error       查询本身报错（数据库异常等）→ 提示稍后重试，不要显示为 0
 *   unavailable 设备不具备健康能力（模拟器 / 部分 iPad）→ 隐藏入口
 *   not_ready   Android 厂商资质未就绪 → 提示「接入中」，不误导为「用户没运动」
 *   no_plugin   原生插件未注入（Web 端 / 旧版包）→ 静默降级，与改造前行为一致
 */
export type HealthSyncStatus =
  | 'ok'
  | 'empty'
  | 'denied'
  | 'error'
  | 'unavailable'
  | 'not_ready'
  | 'no_plugin'

export interface HealthSyncData {
  /** 当天步数 */
  steps: number
  /** 当天活动能量（kcal，HealthKit activeEnergyBurned 直接值） */
  activeKcal: number
  /** 数据来源状态；调用方据此决定「显示数值」还是「显示引导」 */
  status: HealthSyncStatus
  /** 原生层透传的错误描述（仅 denied / error / not_ready 有值） */
  message?: string
}

/** 授权流程的降级原因（原生插件透传） */
export type HealthAuthReason = 'unavailable' | 'no_types' | 'system_error' | 'not_ready' | null

export interface HealthAuthResult {
  /** 授权流程是否走完（⚠️ HealthKit 读授权不可探测，走完 ≠ 用户同意） */
  completed: boolean
  /** 未完成的原因；null = 流程正常走完但用户可能拒绝（读授权不可探测） */
  reason: HealthAuthReason
  /** 原生错误描述 */
  message?: string
}

/**
 * 把原生返回的 status 字符串收敛到已知枚举。
 *
 * 旧版插件不带 status 字段（只有 steps/activeKcal）：按值推断为 ok/empty，
 * 行为与改造前完全一致，保证「Web 包先发、原生包后发」期间不出错。
 */
export function normalizeHealthStatus(raw: unknown, steps: number, kcal: number): HealthSyncStatus {
  if (typeof raw === 'string' && raw.length > 0) {
    switch (raw) {
      case 'ok':
      case 'empty':
      case 'denied':
      case 'error':
      case 'unavailable':
      case 'not_ready':
      case 'no_plugin':
        return raw
      default:
        break
    }
  }
  return steps > 0 || kcal > 0 ? 'ok' : 'empty'
}

/** 是否应把数值写回 UI（denied/error/unavailable/not_ready 时保留旧值，避免闪成 0） */
export function isUsableHealthStatus(status: HealthSyncStatus): boolean {
  return status === 'ok' || status === 'empty' || status === 'no_plugin'
}
