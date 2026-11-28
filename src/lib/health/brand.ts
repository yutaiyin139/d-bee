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

import { isIOS, isNative, isWechatMiniProgram, platformName } from '../platform'

export type HealthVendor =
  | 'apple'
  | 'health_connect'
  | 'huawei'
  | 'xiaomi'
  | 'vivo'
  | 'oppo'
  | 'android-other'
  | 'wechat-miniprogram'
  | 'web'

export interface HealthVendorInfo {
  vendor: HealthVendor
  /** 展示名，例如 'Apple 健康' / '系统健康' */
  label: string
  /**
   * 是否**当前就能真同步**。
   *
   * 🔴 语义收紧（2026-11-18 华为 P40 实测）：这个布尔直接决定按钮文案
   *   （`canSync ? '连接' : '查看'`，见 ProfileScreen/Dashboard），也就是**对用户的承诺**。
   *   因此它必须等于「点了真能连上」，不能等于「将来可能连上」。
   *
   *   华为曾误置 true：原生 `requestAuthorization` 恒返回 `reason='not_ready'`
   *   （Health Kit 资质未获批），`fetchToday` 恒返回 `not_ready`，永远连不上；
   *   而 `isAndroidVendorHealthAvailable()` 只检查「插件在不在」，不检查「厂商通道能不能用」，
   *   于是按钮显示成「连接」= **点了不可能成功的假按钮**（违反铁律 #13 零假功能）。
   *   用户实测反馈「点击连接没有任何反应」即由此产生。
   *
   *   真接入华为 Health Kit 后再改回 true（前置条件见 docs/App备案后实施路径）。
   */
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
 * 优先级：微信小程序 > iOS 原生 > 安卓品牌关键字 > 其它安卓 > Web。
 */
export function detectHealthVendor(): HealthVendorInfo {
  // 微信小程序：微信运动（wx.getWeRunData）是真同步通道，规划中接入。
  // 识别置于最前，保证既不被 iOS/Android 原生分支命中，也不落到 Web 分支。
  if (isWechatMiniProgram()) {
    return {
      vendor: 'wechat-miniprogram',
      label: '微信运动',
      canSync: true,
      tip: '请先在微信「我 → 设置 → 通用 → 辅助功能」打开微信运动。手环和手表的步数要先进入微信运动，这里才能读到；小程序不能直接配对设备。',
    }
  }

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
    if (/HUAWEI|HarmonyOS/i.test(ua)) {
      return {
        vendor: 'huawei',
        // 🔴 中性措辞（2026-11-18）：华为《HUAWEI Health 授权使用规范》把
        //   「在入口或提示消息中显示 Huawei / 华为运动健康 / Huawei health data 等字样」
        //   明确列为资质申请**驳回理由**（Incorrect Brand Icon Usage）。未获授权前
        //   不得用其品牌名做入口标签或提示文案，否则将来申报 Health Kit 会被这条卡住。
        //   故 label 与 tip 全程不出现「华为运动健康」，只用机型中性表述。
        label: '手机健康数据',
        // 🔴 false：华为机型当前**没有任何可用通道**（三重锁）：
        //   ① Health Connect 需 Google Play services，华为无 GMS → 装不上；
        //      且华为运动健康**不向 HC 写数据**（HMS/GMS 生态隔离）；
        //   ② Health Kit 需企业资质（实缴注册资本≥50万、主体存续≥1年）+ 应用先上架
        //      华为应用市场 + 测试权限约10工作日、验证权限约15工作日，测试期限前100名用户；
        //   ③ HarmonyOS NEXT / 5.0 只认 .hap，**装不上 Android APK**。
        //   故诚实标为「查看」，点击后给出可操作说明，绝不做点了必然失败的「连接」按钮。
        canSync: false,
        tip: '本机型暂不支持自动同步步数：本机没有 Health Connect（该系统组件依赖 Google Play 服务），厂商健康数据接口也仍在申请资质。当前请手动记录运动，数据同样计入热量缺口。',
      }
    }
    // 🔴 荣耀（HONOR）已从华为独立、跑 MagicOS 且带 GMS，与华为是**两个厂商**：
    //   原写法 /HUAWEI|HONOR|HarmonyOS/ 会把荣耀误标成华为 → 荣耀机型既拿到华为文案
    //   （错误引导），又被华为的 canSync=false 连坐（荣耀其实可能能用 HC）。
    //   现独立成分支：走 android-other 中性引导，HC 可用时门面会优先返回 health_connect。
    if (/HONOR/i.test(ua)) {
      return {
        vendor: 'android-other',
        label: '系统健康',
        canSync: false,
        tip: '本机暂未接入对应健康 App，请手动记录运动。',
      }
    }
    if (/Xiaomi|Redmi|MI \d|MIUI|HyperOS/i.test(ua)) {
      return {
        vendor: 'xiaomi',
        label: '手机健康数据',
        // 🔴 与华为同理收紧（2026-11-18）：小米**厂商 SDK 通道**同样未接资质，原生
        //   `fetchToday` 恒返回 not_ready → 按钮显示「连接」是点了必然失败的假按钮。
        //   小米机型真正能用的是 **Health Connect**（Android 14+ 系统内置，无需 Play 商店），
        //   那条路由门面 getHealthVendor() 优先返回 health_connect（canSync=true），
        //   所以本分支只在「本机没有 HC」时才会命中 —— 此时确实连不上，标 false 才诚实。
        canSync: false,
        // 🔴 tip 同样不含厂商品牌字样（与华为同口径）：华为把「提示消息中出现品牌名」
        //   列为资质驳回理由，小米等其他厂商的开放平台协议多有同类条款。中性表述
        //   既规避合规风险，也不会因为将来接入路径变化而变成错误引导。
        tip: '本机未检测到 Health Connect，暂不支持自动同步步数（厂商健康数据接口仍在申请资质）。请手动记录运动，数据同样计入热量缺口。',
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
