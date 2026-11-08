/**
 * 「管理订阅」门面（小程序端）—— 严格对齐主工程 src/lib/manageSubscription.ts 的形状。
 *
 * 主端：跳 Apple 系统订阅管理页 `itms-apps://apps.apple.com/account/subscriptions`
 *       （App Store Guideline 3.1.2 硬要求，且入口**无论是否会员一律显示**）。
 * 小程序：本端即使开启虚拟支付售卖（`XPAY_SALE_ENABLED`，见 xpayEnabled.ts）也是
 *       **道具直购**（一次性购买时长、不自动续费），没有系统订阅可取消 ——
 *       legal.ts §一 的收费口径与此一致；对应语义是「查看 / 刷新当前会员权益」，
 *       故导航到会员权益页的管理区块。
 *
 * 🔴 平台适配只发生在「跳到哪里」；**逻辑形状两端一致**：
 *   · 同名导出 `openManageSubscriptions(): Promise<boolean>`；
 *   · 入口一律可见，不限 pro / lifetime；
 *   · 失败返回 false，由调用方给出可读提示，绝不静默。
 *
 * 道具直购**不需要**微信订阅管理深链（那是「连续包月自动扣款」才有的东西，
 * 本端无自动扣款，跳过去是空页）；legal.ts 口径已随售卖开关同源切换（2026-11-08），
 * 详见 paywall.tsx 文件头合规红线。
 */
import Taro from '@tarojs/taro'

/** 会员权益页的「管理」入口路径（`manage=1` 让页标题切到「会员与订阅」） */
export const MANAGE_SUBSCRIPTIONS_PATH = '/pages/paywall/paywall?manage=1'

export async function openManageSubscriptions(): Promise<boolean> {
  try {
    await Taro.navigateTo({ url: MANAGE_SUBSCRIPTIONS_PATH })
    return true
  } catch {
    return false
  }
}
