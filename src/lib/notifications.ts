/**
 * 本地通知调度（P1-4 · 主工程）。
 *
 * 设计原则：
 *  - 不硬依赖 @capacitor/local-notifications 的运行时对象，仍用鸭子类型探测
 *    （对齐 platform.ts 的做法）：Web 构建产物里插件对象不存在时优雅降级为 no-op。
 *    注：包本身已装入 dependencies，`cap sync` 后 iOS/Android 原生工程才有实现。
 *  - 通知偏好（打卡提醒/饮水提醒开关）存本地 kv，键 notif.checkin / notif.water。
 *  - **固定 ID**：同类提醒恒用同一 ID，重复调度时原生侧自动覆盖，
 *    不会像旧实现（每次 `id++` 从 1000 起）那样在多次开关后堆积重复通知。
 *  - **先取消再排程**：每次同步前取消本模块的全部 ID，避免关闭开关后旧通知残留。
 *  - 权限状态可查询：UI 据此显示「已被拒绝，请到系统设置开启」而不是静默无反应。
 *
 * ⚠️ 打卡提醒用 `every: 'day'` 一次排程长期重复；饮水提醒受「9:00~21:00 时间窗」
 *   限制无法用单一 every 表达（会跨到深夜），因此按天排当天剩余时段，
 *   每次 App 前台/开关变更时重排（固定 ID 保证不会重复）。
 */

import { kvGet, kvSet } from './kv'
import { isNative } from './platform'
import {
  CHECKIN_REMINDER_HOUR, CHECKIN_REMINDER_MINUTE,
  WATER_REMINDER_START_HOUR, WATER_REMINDER_END_HOUR, WATER_REMINDER_INTERVAL_HOURS,
} from '@dbee/shared'

/** 通知 ID 规划：打卡 1 个固定 ID；饮水每小时一个（9~21 点，最多 7 个） */
const CHECKIN_ID = 1001
const WATER_ID_BASE = 1010
/** 饮水最大条数 = (21-9)/2 + 1 = 7；给到 20 个 ID 余量，改常量也不会串号 */
const WATER_ID_SPAN = 20

/** Capacitor LocalNotifications 插件的最小接口（鸭子类型） */
interface PermissionResult {
  display: string
}
interface LocalNotificationsPlugin {
  checkPermissions?: () => Promise<PermissionResult>
  requestPermissions?: () => Promise<PermissionResult>
  schedule: (opts: { notifications: unknown[] }) => Promise<unknown>
  cancel?: (opts: { notifications: unknown[] }) => Promise<unknown>
  getPending?: () => Promise<{ notifications: Array<{ id: number }> }>
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

/**
 * 当前运行环境是否真的能发本地通知。
 * UI 据此决定「通知提醒」区块是显示还是隐藏——原生包未装插件时
 * 显示一个点了没反应的开关，比不显示更伤信任。
 */
export function isNotificationsSupported(): boolean {
  return getLocalNotifications() !== null
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

/* ── 权限 ────────────────────────────────────────────── */

/**
 * 通知权限状态：
 *  - 'unsupported' 插件缺失/非原生（UI 应隐藏开关）
 *  - 'granted'     已授权，可排程
 *  - 'prompt'      尚未询问，首次开启开关时会弹系统授权
 *  - 'denied'      已被拒绝（含 iOS 永久拒绝），需引导到系统设置
 */
export type NotifyPermission = 'unsupported' | 'granted' | 'prompt' | 'denied'

export async function getNotificationPermission(): Promise<NotifyPermission> {
  const plugin = getLocalNotifications()
  if (!plugin) return 'unsupported'
  if (!plugin.checkPermissions) return 'prompt'
  try {
    const res = await plugin.checkPermissions()
    const d = String(res?.display ?? '')
    if (d === 'granted' || d === 'limited') return 'granted'
    if (d === 'denied') return 'denied'
    return 'prompt'
  } catch {
    return 'denied'
  }
}

/**
 * 确保拿到授权：已授权直接返回；未询问则触发系统弹窗；被拒不再打扰。
 * 返回 false 时 UI 可提示「通知权限已关闭，请到系统设置开启」。
 */
async function ensurePermission(plugin: LocalNotificationsPlugin): Promise<boolean> {
  // 先查后请：checkPermissions 不弹窗，避免每次开关都触发系统授权请求
  if (plugin.checkPermissions) {
    try {
      const cur = await plugin.checkPermissions()
      const d = String(cur?.display ?? '')
      if (d === 'granted' || d === 'limited') return true
      if (d === 'denied') return false
    } catch {
      return false
    }
  }
  if (!plugin.requestPermissions) return false
  try {
    const res = await plugin.requestPermissions()
    const d = String(res?.display ?? '')
    return d === 'granted' || d === 'limited'
  } catch {
    return false
  }
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

/** 本模块可能用到的全部通知 ID（取消时按此清单清理） */
function allNotificationIds(): number[] {
  const ids = [CHECKIN_ID]
  for (let i = 0; i < WATER_ID_SPAN; i++) ids.push(WATER_ID_BASE + i)
  return ids
}

/** 饮水 ID 由小时决定：同一时刻恒定，重排时原生侧覆盖而不是新增 */
function waterNotificationId(at: Date): number {
  const idx = Math.floor((at.getHours() - WATER_REMINDER_START_HOUR) / WATER_REMINDER_INTERVAL_HOURS)
  const safe = Math.max(0, Math.min(WATER_ID_SPAN - 1, idx))
  return WATER_ID_BASE + safe
}

/**
 * 构造一条通知。
 * iOS 上 `allowWhileIdle` 对应 Android 的 doze 穿透；iOS 的重复靠 `every`。
 * 不指定 smallIcon：让插件回退到 App 图标。旧实现写了 'ic_stat_dbee'，
 * 但 android/res 里并不存在该资源（找不到虽不崩溃，却不如显式依赖默认行为可靠）。
 */
function toNotification(
  id: number,
  title: string,
  body: string,
  at: Date,
  every?: 'day',
): unknown {
  return {
    id,
    title,
    body,
    schedule: every ? { at, every, allowWhileIdle: true } : { at, allowWhileIdle: true },
    sound: 'default',
  }
}

export interface SyncResult {
  /** 是否成功排程（插件缺失/权限被拒/无开关开启时为 false） */
  scheduled: boolean
  /** 失败原因，供 UI 精确提示（null = 无失败） */
  reason: 'unsupported' | 'denied' | 'error' | null
}

/**
 * 按当前偏好重新排程本地通知。
 *
 * 流程：取消本模块全部 ID → 检查/申请权限 → 按开关排程。
 * 「先取消」是必须的：用户关掉饮水提醒后，若不取消，已排入原生队列的
 * 7 条仍会照点响，表现为「开关关了还在提醒」。
 */
export async function syncLocalNotifications(): Promise<SyncResult> {
  const plugin = getLocalNotifications()
  if (!plugin) return { scheduled: false, reason: 'unsupported' }

  // 无条件先清理：即使随后权限被拒，也不能留下旧的排程
  await cancelAllNotifications()

  const prefs = await getNotifyPrefs()
  if (!prefs.checkin && !prefs.water) return { scheduled: false, reason: null }

  const allowed = await ensurePermission(plugin)
  if (!allowed) return { scheduled: false, reason: 'denied' }

  const notifications: unknown[] = []
  const now = new Date()

  // 打卡提醒：每日 20:00，一次排程长期重复（every: 'day'）
  if (prefs.checkin) {
    notifications.push(
      toNotification(CHECKIN_ID, '该记录今天的饮食啦', '点开 D-Bee，拍一拍或记一记今天的每一餐。', nextCheckinTime(now), 'day'),
    )
  }

  // 饮水提醒：当天剩余时段逐条排程（固定 ID，重排即覆盖）
  if (prefs.water) {
    const times = waterTimes(now)
    if (times.length === 0) {
      // 今天时段已过：排明天的整窗，避免用户晚上开开关后「今天什么都收不到」就以为坏了
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      for (const at of waterTimes(tomorrow)) {
        notifications.push(toNotification(waterNotificationId(at), '喝口水吧 💧', '今天的饮水目标还没到，记得补水哦。', at))
      }
    } else {
      for (const at of times) {
        notifications.push(toNotification(waterNotificationId(at), '喝口水吧 💧', '今天的饮水目标还没到，记得补水哦。', at))
      }
    }
  }

  if (notifications.length === 0) return { scheduled: false, reason: null }

  try {
    await plugin.schedule({ notifications })
    return { scheduled: true, reason: null }
  } catch (e) {
    console.warn('[notifications] 排程失败：', e)
    return { scheduled: false, reason: 'error' }
  }
}

/** 取消本模块排程的全部本地通知（关闭所有开关 / 退出登录时调用） */
export async function cancelAllNotifications(): Promise<void> {
  const plugin = getLocalNotifications()
  if (!plugin || !plugin.cancel) return
  try {
    await plugin.cancel({ notifications: allNotificationIds().map((id) => ({ id })) })
  } catch {
    // 取消失败不阻断：下一次排程仍会先取消一次
  }
}

/**
 * 静默重排（App 启动 / 回到前台时调用）。
 *
 * 与 syncLocalNotifications 的唯一区别：**绝不申请权限**。
 * 饮水提醒是「按天排当天剩余时段」的一次性通知，昨天排的今天已经过期，
 * 若只在用户进「我的」页切开关时才排程，多数用户永远收不到提醒。
 * 但启动时弹系统授权框违反 HIG（用户没有任何上下文，只会直接拒绝），
 * 因此这里只在「已经授权」时补排；从未授权的用户仍由开关交互触发申请。
 *
 * 返回是否排程成功，调用方一般无需关心（纯后台维护动作）。
 */
export async function rescheduleIfPermitted(): Promise<boolean> {
  const plugin = getLocalNotifications()
  if (!plugin) return false
  const perm = await getNotificationPermission()
  if (perm !== 'granted') return false

  const prefs = await getNotifyPrefs()
  if (!prefs.checkin && !prefs.water) {
    // 两个开关都关着：清掉可能残留的旧排程即可
    await cancelAllNotifications()
    return false
  }
  const res = await syncLocalNotifications()
  return res.scheduled
}
