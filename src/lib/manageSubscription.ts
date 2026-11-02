/**
 * 「管理订阅」深链（App Store Guideline 3.1.2）。
 *
 * 为什么必须有它：3.1.2 要求含自动续期订阅的 App 提供「管理订阅」与「取消订阅」的
 * 可达入口。此前付费墙只有「恢复购买」（restorePurchases），Apple 对
 * 「仅恢复购买、无管理订阅入口」通常按 3.1.2 打回。
 *
 * 实现选择：跳 Apple 官方深链 `itms-apps://apps.apple.com/account/subscriptions`
 * —— 该页面由系统提供，可查看/取消全部订阅，**无需新增原生插件、无需改 Swift**，
 * 也不必实现 StoreKit 2 的 `showManageSubscriptions`（后者要写原生代码 + 重新编译）。
 *
 * 🔴 渲染条件必须是「iOS 端一律显示」，不能只在 `pro` 为真时显示：
 *   审核员用的是演示账户（非订阅态），若入口只对会员可见，审核员看不到 = 仍判缺失。
 *
 * 🔴 打开方式沿用本项目既有约定（见 privacyConsent.ts 的 exitApp、iosIap.ts 的插件探测）：
 *   **鸭子类型探测 `window.Capacitor.Plugins.App`，不 import @capacitor/app** ——
 *   Web 构建产物因此不引入 Capacitor 依赖、不增包体积；原生侧该插件已由
 *   capacitor.config.ts 的 ios.includePlugins 白名单纳入。
 */

/** Apple 订阅管理页（系统深链，全区域通用；中国区同样有效） */
const SUBSCRIPTIONS_URL = 'itms-apps://apps.apple.com/account/subscriptions'

interface CapAppPlugin {
  openUrl?: (opts: { url: string }) => Promise<{ completed?: boolean } | unknown>
}

function getAppPlugin(): CapAppPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.App as CapAppPlugin | undefined
  return p && typeof p.openUrl === 'function' ? p : null
}

/**
 * 打开系统「订阅管理」页。
 *
 * 优先走 Capacitor App.openUrl（原生容器内 `itms-apps:` 属非 http 协议，
 * WKWebView 不会自行跳转，必须由原生 `UIApplication.open` 处理）。
 * 插件缺失时降级 `location.href`，仍失败则返回 false 由调用方提示。
 *
 * @returns true = 已调起跳转；false = 无法打开（调用方应给用户可读提示）
 */
export async function openManageSubscriptions(): Promise<boolean> {
  const plugin = getAppPlugin()
  if (plugin?.openUrl) {
    try {
      const res = await plugin.openUrl({ url: SUBSCRIPTIONS_URL })
      // Capacitor 返回 { completed: boolean }；completed=false 表示系统未处理该 URL
      if (res && typeof res === 'object' && 'completed' in res && res.completed === false) {
        return false
      }
      return true
    } catch {
      /* 落到下方降级 */
    }
  }
  try {
    location.href = SUBSCRIPTIONS_URL
    return true
  } catch {
    return false
  }
}
