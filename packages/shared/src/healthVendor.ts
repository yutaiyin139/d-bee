/**
 * 健康数据来源标识（WX-4 · 0053 迁移）。
 *
 * 背景：`profiles.health_connected` 是单布尔、跨端共享。用户在 iPhone App 连了
 * Apple 健康 → 小程序里 `isHealthConnected()` 也返回 true → 误判「微信运动已连接」
 * 并触发同步，属假绿（规划 §11「连接态串台」）。
 *
 * 正解：连接时额外写 `profiles.health_vendor` 记录数据来源，读取端按「本端期望的来源」
 * 严格匹配。本文件集中放四端共用的纯类型 / 纯函数，零环境依赖。
 */

/** 云端 `profiles.health_vendor` 的合法值（与 0053 迁移 CHECK 约束一致）。 */
export type HealthVendorDb = 'apple' | 'health_connect' | 'huawei' | 'xiaomi' | 'werun'

export const HEALTH_VENDOR_DB_VALUES: readonly HealthVendorDb[] = [
  'apple', 'health_connect', 'huawei', 'xiaomi', 'werun',
] as const

/**
 * 品牌 vendor（各端 detectHealthVendor().vendor）→ 云端来源值。
 * 仅映射**会写连接态**的真同步端；其余（web / vivo / oppo / android-other / none）
 * 返回 null —— 这些端不写也不参与来源判定，调用方据此隐藏连接入口。
 */
export function healthVendorToDb(vendor: string): HealthVendorDb | null {
  switch (vendor) {
    case 'apple': return 'apple'
    case 'huawei': return 'huawei'
    case 'xiaomi': return 'xiaomi'
    case 'wechat-miniprogram': return 'werun'
    default: return null
  }
}

/**
 * 本端连接态判定（杜绝跨端串台）。
 *
 * @param connected     云端 `health_connected`
 * @param storedVendor  云端 `health_vendor`（连接时写入的来源）
 * @param expectedVendor 本端期望的来源
 *
 * 规则：
 *  - health_connected !== true → 未连接；
 *  - 新数据（storedVendor 有值）→ 严格按来源匹配，杜绝串台；
 *  - 旧数据（storedVendor 为空）→ 回退为 health_connected 布尔，兼容 0053 之前
 *    只写了布尔、没写来源的旧包/老用户，避免升级后连接态无故丢失（D3「兼容旧包」）。
 */
export function isVendorConnected(
  connected: boolean | null | undefined,
  storedVendor: string | null | undefined,
  expectedVendor: HealthVendorDb,
): boolean {
  if (connected !== true) return false
  if (!storedVendor) return true
  return storedVendor === expectedVendor
}
