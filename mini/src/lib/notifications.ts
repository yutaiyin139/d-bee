/**
 * 推送通知（P1-4 · 小程序端）。
 *
 * 微信端：订阅消息 wx.requestSubscribeMessage（一次性授权，需后台申请模板 ID）。
 * 支付宝/抖音：条件编译降级（暂无订阅消息，静默 no-op）。
 *
 * 设计：
 *  - 通知偏好存本地 kv（键 notif.checkin / notif.water），对齐主工程。
 *  - 微信订阅消息需要「模板 ID」，由微信公众平台后台申请（不依赖营业执照）。
 *    模板 ID 未配置时，requestSubscribeMessage 静默降级，不阻断。
 */

import { kvGet, kvSet } from './kv'

/** 微信打卡提醒订阅消息模板 ID（需在微信公众平台「订阅消息」申请后回填） */
const CHECKIN_TEMPLATE_ID: string = ''

/**
 * 🔴 提醒是否真能送达 —— **UI 与实现共用的单一真源**（2026-11-15 新增，与
 *   `share.ts` 的 `isExportAvailable` 同款设计）。
 *
 * 为什么需要它：微信订阅消息**必须**有后台申请的模板 ID 才能发起授权与下发。
 *   `CHECKIN_TEMPLATE_ID` 为空时 `requestCheckinSubscribe()` 恒返回 `no_template`，
 *   两个开关只是把偏好写进本地 kv，**永远不会有任何推送**。而 UI 此前无条件渲染
 *   两个 Switch 且零说明 —— 用户拨开开关后什么也收不到，属「可见但不可用」的误导，
 *   比导出那条更隐蔽（导出至少有「即将上线」角标）。
 *   法务 `legal.ts` §七已如实声明，但普通用户不会先读隐私政策再拨开关。
 *
 * 用法：profile 页据此条件渲染一行诚实说明（`NOTIFY_UNAVAILABLE_NOTE`）。
 *   🔴 模板 ID 申请到并回填后，本值自动变 true、说明自动消失，**不必再改 UI**；
 *   届时还须补服务端下发链路（网关调 subscribeMessage.send），否则开关仍不生效。
 */
export const isNotifyPushAvailable: boolean = CHECKIN_TEMPLATE_ID.length > 0

/**
 * 推送未接入时的诚实说明。
 * 🔴 措辞红线：不得写「每天 20:00 提醒」这类具体时间 —— 那是对未实现能力的承诺
 *   （广告法 / 微信审核风险）。只说明「保存了什么、现在会不会推、什么时候会推」。
 */
export const NOTIFY_UNAVAILABLE_NOTE =
  '开关目前仅保存你的提醒偏好，小程序端尚未接入微信订阅消息，因此暂时不会收到推送通知。'

export interface NotifyPrefs {
  checkin: boolean
  water: boolean
}

/**
 * 🔴 新用户默认「全部关闭」（2026-11-12 P0.7，对齐主端 src/lib/notifications.ts）。
 * 只改缺省值、不写回 kv：老用户已存的 '1' 保持不变（灰度）。护栏 24-D 钉住。
 */
export async function getNotifyPrefs(): Promise<NotifyPrefs> {
  return {
    checkin: (await kvGet('notif.checkin', '0')) === '1',
    water: (await kvGet('notif.water', '0')) === '1',
  }
}

export async function setNotifyPrefs(kind: 'checkin' | 'water', enabled: boolean): Promise<void> {
  await kvSet(`notif.${kind}`, enabled ? '1' : '0')
}

/** 是否微信小程序（订阅消息仅微信支持） */
function isWeapp(): boolean {
  return process.env.TARO_ENV === 'weapp'
}

/**
 * 请求微信订阅消息授权（打卡提醒）。
 * 返回 'ok' | 'denied' | 'unsupported' | 'no_template'。
 * 支付宝/抖音端恒返回 'unsupported'。
 */
export async function requestCheckinSubscribe(): Promise<'ok' | 'denied' | 'unsupported' | 'no_template'> {
  if (!isWeapp()) return 'unsupported'
  if (!CHECKIN_TEMPLATE_ID) return 'no_template'

  try {
    const Taro = (await import('@tarojs/taro')).default
    // 注意：Taro 的 requestSubscribeMessage 类型里 entityIds 与 tmplIds 被 AtLeastOne
    // 交叉类型收窄，导致 `{ tmplIds: string[] }` 被误判为不满足 Option。这里用
    // 显式断言绕过（tmplIds 是微信端正确字段，见微信官方文档）。
    const res = (await Taro.requestSubscribeMessage({
      tmplIds: [CHECKIN_TEMPLATE_ID],
    } as unknown as Parameters<typeof Taro.requestSubscribeMessage>[0])) as Record<string, string>
    const status = res[CHECKIN_TEMPLATE_ID]
    return status === 'accept' ? 'ok' : 'denied'
  } catch {
    return 'denied'
  }
}

/**
 * 统一入口：用户开启「打卡提醒」开关时调用。
 * 先写偏好，再尝试请求订阅消息授权（微信）；其余端直接写偏好即可。
 */
export async function enableCheckinNotify(): Promise<void> {
  await setNotifyPrefs('checkin', true)
  if (isWeapp()) await requestCheckinSubscribe()
}

/** 关闭打卡提醒（写偏好；微信订阅消息为一次性授权，无需取消） */
export async function disableCheckinNotify(): Promise<void> {
  await setNotifyPrefs('checkin', false)
}

/** 饮水提醒：微信订阅消息需单独模板，当前仅记录偏好（模板 ID 就绪后扩展） */
export async function enableWaterNotify(): Promise<void> {
  await setNotifyPrefs('water', true)
}

export async function disableWaterNotify(): Promise<void> {
  await setNotifyPrefs('water', false)
}
