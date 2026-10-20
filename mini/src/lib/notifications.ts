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

export interface NotifyPrefs {
  checkin: boolean
  water: boolean
}

export async function getNotifyPrefs(): Promise<NotifyPrefs> {
  return {
    checkin: (await kvGet('notif.checkin', '1')) === '1',
    water: (await kvGet('notif.water', '1')) === '1',
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
