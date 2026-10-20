/**
 * 键值存储抽象（小程序端，对齐主工程 src/lib/kv.ts）。
 *
 * 小程序端用 Taro Storage 实现，API 形状与主工程 kv 保持一致（kvGet/kvSet/kvRemove），
 * 供 upsell 等本地状态模块复用。
 */

import Taro from '@tarojs/taro'

/** 读字符串值，缺省返回 defaultValue */
export async function kvGet(key: string, defaultValue = ''): Promise<string> {
  try {
    const v = Taro.getStorageSync(key)
    if (v === '' || v === null || v === undefined) return defaultValue
    return String(v)
  } catch {
    return defaultValue
  }
}

/** 写字符串值 */
export async function kvSet(key: string, value: string): Promise<void> {
  try {
    Taro.setStorageSync(key, value)
  } catch {
    // ignore
  }
}

/** 删除键 */
export async function kvRemove(key: string): Promise<void> {
  try {
    Taro.removeStorageSync(key)
  } catch {
    // ignore
  }
}
