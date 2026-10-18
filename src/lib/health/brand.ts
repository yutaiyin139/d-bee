/**
 * 设备品牌识别。
 *
 * 用于「运动健康对接」：识别当前机型对应的运动健康 App，决定连接入口的形态
 * （iPhone → Apple 健康真同步；华为/小米/vivo/OPPO → 引导跳转；微信内置浏览器 → 说明）。
 *
 * 纯函数、无副作用、零外部依赖。识别依据只有两点：
 *   - 是否原生 App（复用 lib/platform 的运行时探测）
 *   - User-Agent 里的品牌关键字（华为/小米/vivo/OPPO/荣耀）
 *
 * Web 端（普通浏览器）恒返回 'web'，不显示连接入口，行为可预测。
 */

import { isIOS, isNative, platformName } from '../platform'

export type HealthVendor =
  | 'apple'
  | 'huawei'
  | 'xiaomi'
  | 'vivo'
  | 'oppo'
  | 'android-other'
  | 'web'

export interface HealthVendorInfo {
  vendor: HealthVendor
  /** 展示名，例如 'Apple 健康' / '华为运动健康' */
  label: string
  /** 是否支持真同步（当前只有 Apple 健康，第二批 HealthKit 落地后启用） */
  canSync: boolean
  /** 点击「连接」后的引导文案（canSync 为 false 时的降级提示） */
  tip: string
}

function userAgent(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgent || ''
}

/**
 * 识别当前机型对应的运动健康品牌。
 * 优先级：iOS 原生 > 安卓品牌关键字 > 其它安卓 > Web。
 */
export function detectHealthVendor(): HealthVendorInfo {
  if (isIOS()) {
    return {
      vendor: 'apple',
      label: 'Apple 健康',
      canSync: true,
      tip: 'Apple 健康同步即将开放，当前请先手动记录运动。',
    }
  }

  if (isNative()) {
    const ua = userAgent()
    if (/HUAWEI|HONOR|HarmonyOS/i.test(ua)) {
      return {
        vendor: 'huawei',
        label: '华为运动健康',
        canSync: true,
        tip: '请在华为运动健康 App 中查看运动数据，当前 D-Bee 支持手动记录运动。',
      }
    }
    if (/Xiaomi|Redmi|MI \d|MIUI|HyperOS/i.test(ua)) {
      return {
        vendor: 'xiaomi',
        label: '小米运动健康',
        canSync: true,
        tip: '请在小米运动健康 App 中查看运动数据，当前 D-Bee 支持手动记录运动。',
      }
    }
    if (/vivo/i.test(ua)) {
      return {
        vendor: 'vivo',
        label: 'vivo 健康',
        canSync: false,
        tip: '请在 vivo 健康 App 中查看运动数据，当前 D-Bee 支持手动记录运动。',
      }
    }
    if (/OPPO|Realme|OnePlus/i.test(ua)) {
      return {
        vendor: 'oppo',
        label: 'OPPO 健康',
        canSync: false,
        tip: '请在 OPPO 健康 App 中查看运动数据，当前 D-Bee 支持手动记录运动。',
      }
    }
    return {
      vendor: 'android-other',
      label: '系统健康',
      canSync: false,
      tip: '当前机型暂未接入对应健康 App，请手动记录运动。',
    }
  }

  // 非原生：普通浏览器 / PWA / 微信内置浏览器
  return {
    vendor: 'web',
    label: '',
    canSync: false,
    tip: '',
  }
}

/** 是否为微信内置浏览器（用户从微信里打开 D-Bee 网页版时，引导其用微信运动） */
export function isWechatWebView(): boolean {
  if (platformName() !== 'web') return false
  return /MicroMessenger/i.test(userAgent())
}
