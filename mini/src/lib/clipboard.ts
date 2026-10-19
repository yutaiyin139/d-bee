/**
 * 剪贴板抽象层（小程序端）。
 * 微信/支付宝/抖音均无 DOM、无 navigator.clipboard，统一走 Taro.setClipboardData。
 * 业务代码只关心「复制成没成功」，不关心平台差异。
 */
import Taro from '@tarojs/taro'

/**
 * 复制一段文本到剪贴板。
 * @returns 是否复制成功（供业务方决定是否提示用户手动复制）
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await Taro.setClipboardData({ data: text })
    return true
  } catch {
    return false
  }
}
