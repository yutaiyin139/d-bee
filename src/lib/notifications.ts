/**
 * 本地通知调度（P1-4 · 主工程）。
 *
 * 设计原则：
 *  - 不硬依赖 @capacitor/local-notifications，采用运行时探测（对齐 platform.ts 的
 *    鸭子类型做法），插件未安装时优雅降级为 no-op，Web 构建不引入 Capacitor 依赖。
 *  - 通知偏好（打卡提醒/饮水提醒开关）存本地 kv，键 notif.checkin / notif.water。
 *  - iOS 本地通知权限首次请求需用户授权，拒绝后需引导到系统设置；此处仅在
 *    requestPermission 时触发系统弹窗，失败静默（不阻断主流程）。
 *
 * 注意：真正的端到端通知需要先 `npm i @capacitor/local-notifications` + `npx cap sync`
 * 更新 iOS/Android 原生工程并真机验证。本模块在插件未安装时优雅降级，代码结构
 * 与插件安装后的行为一致，后续装好插件即可生效。
 */

import { kvGet, kvSet } from './kv'
import { isNative } from './platform'
import {
  CHECKIN_REMINDER_HOUR, CHECKIN_REMINDER_MINUTE,
  WATER_REMINDER_START_HOUR, WATER_REMINDER_END_HOUR, WATER_REMINDER_INTERVAL_HOURS,
} from '@dbee/shared'

/** Capacitor LocalNotifications 插件的最小接口（鸭子类型） */
interface LocalNotificationsPlugin {
  requestPermissions?: () => Promise<{ display: string }>
  schedule: (opts: { notifications: unknown[] }) => Promise<unknown>
  cancel?: (opts: { notifications: unknown[] }) => Promise<unknown>
}

function getLocalNotifications(): LocalNotificationsPlugin | null {
  if (!isNative()) return null
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.LocalNotifications
  if (!p || typeof p !== 'object') return null
  const c = p as Partial<LocalNotificationsPlugin>
  if (typeof c.schedule !== 'function') return null
  return c as LocalNotificationsPlugin
}

/* ── 通知偏好 ────────────────────────────────────────────── */

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

/* ── 调度 ────────────────────────────────────────────── */

/** 计算下一个「打卡提醒」触发时间（今天 20:00 或明天 20:00） */
function nextCheckinTime(now = new Date()): Date {
  const t = new Date(now)
  t.setHours(CHECKIN_REMINDER_HOUR, CHECKIN_REMINDER_MINUTE, 0, 0)
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1)
  return t
}

/** 计算当天所有「饮水提醒」触发时间（9:00~21:00 每 2 小时，只保留未来的） */
function waterTimes(now = new Date()): Date[] {
  const out: Date[] = []
  for (let h = WATER_REMINDER_START_HOUR; h <= WATER_REMINDER_END_HOUR; h += WATER_REMINDER_INTERVAL_HOURS) {
    const t = new Date(now)
    t.setHours(h, 0, 0, 0)
    if (t.getTime() > now.getTime()) out.push(t)
  }
  return out
}

function toNotification(id: number, title: string, body: string, at: Date): unknown {
  return {
    id,
    title,
    body,
    schedule: { at, allowWhileIdle: true },
    sound: 'default',
    smallIcon: 'ic_stat_dbee',
  }
}

/**
 * 请求通知权限并（若用户开启对应开关）调度本地通知。
 * 返回是否已调度；插件未安装 / 非原生环境 / 权限被拒时返回 false，静默降级。
 */
export async function syncLocalNotifications(): Promise<boolean> {
  const plugin = getLocalNotifications()
  if (!plugin) return false

  const prefs = await getNotifyPrefs()

  try {
    if (plugin.requestPermissions) {
      const res = await plugin.requestPermissions()
      if (res.display !== 'granted') return false
    }
  } catch {
    // 权限请求失败（可能已被永久拒绝），静默返回
    return false
  }

  const notifications: unknown[] = []
  let id = 1000
  const now = new Date()

  // 打卡提醒（每日 20:00）
  if (prefs.checkin) {
    notifications.push(toNotification(id++, '该记录今天的饮食啦', '点开 D-Bee，拍一拍或记一记今天的每一餐。', nextCheckinTime(now)))
  }

  // 饮水提醒（当日剩余时段，每 2 小时一次）
  if (prefs.water) {
    for (const at of waterTimes(now)) {
      notifications.push(toNotification(id++, '喝口水吧 💧', '今天的饮水目标还没到，记得补水哦。', at))
    }
  }

  if (notifications.length === 0) return false

  try {
    await plugin.schedule({ notifications })
    return true
  } catch {
    return false
  }
}

/** 取消全部本地通知（用户关闭所有开关时调用） */
export async function cancelAllNotifications(): Promise<void> {
  const plugin = getLocalNotifications()
  if (!plugin || !plugin.cancel) return
  try {
    // 取消失效通知（已触发的无需取消）；这里按 ID 段清理本模块调度过的
    const ids = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }))
    await plugin.cancel({ notifications: ids })
  } catch {
    // ignore
  }
}
