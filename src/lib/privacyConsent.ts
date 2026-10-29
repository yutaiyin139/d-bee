/**
 * 首次启动隐私政策同意状态（P0 合规）。
 *
 * 为什么必须有它：华为/小米对「首次启动未弹隐私政策」直接拒审；OPPO 明确驳回过
 * 「首次必须在登录页面出现前独立弹框展示隐私政策」。《个人信息保护法》第 14 条也
 * 要求处理个人信息前取得个人同意。
 *
 * 关键设计：
 *   1. **同意前不得发起任何网络请求**。因此门控必须挂在 `PlanProvider` 之外 ——
 *      它一挂载就会调 getEntitlement / getPhotoQuota，等于「未取得同意先采集」。
 *   2. 存的是**隐私政策更新日期**而非固定标志位：政策更新后需重新征求同意
 *      （PIPL 要求处理目的/方式变更时重新取得同意），日期不变则不打扰老用户。
 *   3. 读取走 kv（原生 Preferences / Web localStorage），与项目其余小状态一致。
 */

import { kvGet, kvSet } from './kv'
import { isNative } from './platform'
import { LEGAL_UPDATED } from '../content/legal'

/** kv 键：值 = 用户同意时的隐私政策更新日期 */
const KEY = 'privacy.agreed'

/**
 * 用户是否已对**当前版本**的隐私政策作出同意。
 * 政策更新日期变化 → 视为未同意，需重新弹窗征求。
 */
export async function hasPrivacyConsent(): Promise<boolean> {
  try {
    return (await kvGet(KEY, null)) === LEGAL_UPDATED
  } catch {
    return false
  }
}

/**
 * 同步预览同意状态（**仅 Web 端**有效）。
 *
 * 为什么需要它：`kvGet` 是异步的，若首屏一律等异步结果，会出现「短暂空白」。
 * 这对普通用户只是闪一下，但对**商店的隐私政策自动化审核**是实质风险 ——
 * OPPO 明确要求隐私政策链接「不需登录、不需点击、不需再跳转，允许对内容进行
 * 自动化分析、验证」，爬虫若在白屏期抓取就会判「url 无法访问或内容不合规」。
 * Web 端 localStorage 本身是同步 API，直接读即可零白屏。
 *
 * 原生端没有同步存储（Preferences 是异步桥），返回 null 让调用方走异步分支。
 */
export function peekPrivacyConsent(): boolean | null {
  try {
    if (isNative()) return null
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage.getItem(KEY) === LEGAL_UPDATED
  } catch {
    return null
  }
}

/** 记录同意（幂等；写入失败静默，下次启动会重新弹，不影响使用） */
export async function grantPrivacyConsent(): Promise<void> {
  try {
    await kvSet(KEY, LEGAL_UPDATED)
  } catch {
    /* 存储不可用时不阻断：宁可下次再弹，也不能把用户挡在门外 */
  }
}

/**
 * 退出应用（用户点「不同意并退出」时调用）。
 *
 * 原生端走 Capacitor App 插件的 exitApp()。这里用**鸭子类型探测**而非 import，
 * 与 kv.ts / share.ts / platform.ts 的既有约定一致：Web 构建产物不引入 Capacitor
 * 依赖、不增包体积。原生侧插件由 capacitor.config.ts 的 includePlugins 白名单纳入。
 *
 * @returns true = 已调起原生退出；false = 非原生环境或插件缺失（调用方应自行降级）
 */
export async function exitApp(): Promise<boolean> {
  try {
    if (typeof window === 'undefined') return false
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
    const p = cap?.Plugins?.App as { exitApp?: () => Promise<unknown> } | undefined
    if (p && typeof p.exitApp === 'function') {
      await p.exitApp()
      return true
    }
  } catch {
    /* 落到下方 Web 降级 */
  }
  return false
}
