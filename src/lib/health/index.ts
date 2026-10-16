/**
 * 运动健康对接 · 统一门面。
 *
 * 业务代码只从这里取数据/发起连接，不直接嗅探品牌或插件。
 * 平台差异、品牌差异全部封在 health/ 内部。
 *
 * 第一批（零原生依赖）实现：
 *   - getHealthVendor()            品牌识别
 *   - isHealthConnectable()        是否显示「连接健康」入口（原生端才显示）
 *   - connectHealth()              点击连接后的行为路由（苹果跳设置 / 安卓各品牌提示）
 *   - estimateActivityKcal()       步数 → 活动消耗换算（融入热量缺口公式）
 *
 * 第二批（iOS HealthKit 落地后）：syncFromHealth() 替换占位，读真实步数/活动能量。
 */

import { detectHealthVendor, isWechatWebView } from './brand'
import type { HealthVendorInfo } from './brand'
import { isNative } from '../platform'

export type { HealthVendor, HealthVendorInfo } from './brand'

export interface ConnectResult {
  ok: boolean
  /** 展示给用户的提示文案 */
  message: string
  /** 已连接的数据源标识（第一批只有 apple 会返回，但同步仍未真接） */
  vendor: HealthVendorInfo['vendor']
}

/** 品牌识别入口 */
export function getHealthVendor(): HealthVendorInfo {
  return detectHealthVendor()
}

/**
 * 是否显示「连接健康」入口。
 * 仅原生 App 显示；Web（含 PWA、桌面浏览器、微信内置浏览器）不显示。
 */
export function isHealthConnectable(): boolean {
  return isNative()
}

/**
 * 点击「连接健康」后的行为路由。
 *
 * 第一批的诚实策略（不新增原生依赖、不做深链跳转）：
 *   - apple：跳 iPhone「设置 → 健康」+ 提示「同步即将开放」
 *   - huawei/xiaomi/vivo/oppo/android-other：弹提示引导手动查看
 *   - 微信内置浏览器：提示用微信运动
 *   - web：不显示入口（本函数不应被调用，兜底返回空）
 *
 * 跳转「设置 → 健康」通过 location.href 的 App-Prefs 方案，WebView 内会由系统接管。
 */
export function connectHealth(): ConnectResult {
  const v = detectHealthVendor()

  if (v.vendor === 'apple') {
    // 跳 iPhone「设置 → 健康」；失败时静默降级，仅提示
    try {
      if (typeof window !== 'undefined' && window.location) {
        // App-Prefs 是 iOS 通用的设置跳转 scheme
        window.location.href = 'App-Prefs:HEALTH'
      }
    } catch {
      /* 忽略跳转失败，仅提示 */
    }
    return { ok: true, message: 'Apple 健康同步即将开放，已为你打开系统健康设置，当前请先手动记录运动。', vendor: 'apple' }
  }

  if (v.vendor === 'web') {
    if (isWechatWebView()) {
      return { ok: false, message: '微信运动数据请在微信内查看；D-Bee 已支持手动记录运动。', vendor: 'web' }
    }
    return { ok: false, message: '', vendor: 'web' }
  }

  return { ok: false, message: v.tip, vendor: v.vendor }
}

/**
 * 步数 → 活动消耗（kcal）换算。
 *
 * 采用「步幅法」估算：步行距离 = 步数 × 步幅，再按体重折算消耗。
 * 步幅按身高估算（身高 × 0.45，单位米），无身高时用默认 0.72m。
 * 每公斤体重每公里步行约消耗 0.75 kcal（中等步速）。
 *
 * 返回 0 安全值：缺体重或步数为 0 时不产生负值。
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

/**
 * 活动消耗计入「可吃回」额度的比例（50%）。
 *
 * 依据：手环/步数普遍高估消耗 20% 左右，若 100% 回补会让人越减越肥
 * （Cal AI 用 80%、自律茄子用 100%，均被第三方评测点名）。50% 是安全折中。
 */
export const ACTIVITY_EATBACK_RATIO = 0.5
