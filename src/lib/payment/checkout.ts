/**
 * 统一支付 checkout 流程 —— 各端共用，与具体平台解耦。
 *
 * 四步（见 docs/统一支付架构方案.md）：
 *   ① 服务端下单 createPaymentOrder（服务端查价，防篡改）
 *   ② 平台支付 adapter.purchase（拿凭证）
 *   ③ 回传凭证 verifyPaymentOrder（服务端幂等发权益）
 *   ④ 刷新权益（由调用方持有 PlanProvider 的 refresh）
 *
 * 本模块不 import 具体平台插件，只依赖 PaymentAdapter 抽象；
 * 具体用哪个 adapter 由 getAdapter() 按 platformName() 选择。
 */

import { createPaymentOrder, verifyPaymentOrder } from '../api'
import { PRODUCT_IDS, type ProductId } from '../entitlement'
import { platformName } from '../platform'
import type { CheckoutResult, PaymentAdapter } from './types'

/**
 * 按当前平台选择支付适配器。
 * 当前只实现 iOS；Android / Web / 微信小程序接支付时在此补分支。
 * 微信小程序端规划走 wx.requestPayment，届时新增 miniprogram adapter 并在此返回。
 */
export async function getAdapter(): Promise<PaymentAdapter | null> {
  const platform = platformName()
  if (platform === 'ios') {
    const { createIosIapAdapter } = await import('./iosIap')
    return createIosIapAdapter()
  }
  // TODO(资质就绪后补)：android → googlePlay / wechatPay / alipay；
  //   web → wechatPay / alipay；wechat-miniprogram → wx.requestPayment
  return null
}

/**
 * 统一购买流程。
 * @param productId 商品 ID（PRODUCT_IDS 之一）
 * @param onEntitlementGranted 权益刷新回调（调用方传入 PlanProvider.refresh）
 */
export async function checkout(
  productId: ProductId,
  onEntitlementGranted?: () => Promise<void>,
): Promise<CheckoutResult> {
  const adapter = await getAdapter()
  if (!adapter) {
    return { status: 'error', message: '当前平台暂不支持在线支付' }
  }

  const provider = currentProvider()
  if (!provider) {
    return { status: 'error', message: '无法识别支付渠道' }
  }

  try {
    // ① 服务端下单（金额由服务端查价）
    const order = await createPaymentOrder(PRODUCT_IDS[productId], provider)

    // ② 平台支付（拿凭证）
    const result = await adapter.purchase(productId)

    // ③ 回传凭证，服务端幂等发权益
    const ok = await verifyPaymentOrder(order.order_no, result.providerTxnId, result.receipt)
    if (!ok) {
      return { status: 'error', message: '支付校验失败，请稍后重试或联系客服' }
    }

    // ④ 刷新权益
    if (onEntitlementGranted) await onEntitlementGranted()

    return { status: 'ok' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // 用户主动取消支付不算错误
    if (/cancel|取消|拒绝|denied/i.test(message)) {
      return { status: 'cancelled', message }
    }
    return { status: 'error', message: message || '支付失败，请重试' }
  }
}

/**
 * 由平台推导支付渠道标识（与服务端 provider 字段对齐）。
 * 微信小程序：微信支付（规划中，getAdapter 尚未实现小程序适配器，故 checkout 仍会
 * 走「暂不支持在线支付」的兜底，不影响现有三端）。
 */
function currentProvider(): 'apple' | 'google' | 'wechat' | 'alipay' | null {
  const platform = platformName()
  if (platform === 'ios') return 'apple'
  if (platform === 'android') return 'wechat' // Android 默认微信；未来可按需切换 google/alipay
  if (platform === 'web') return 'wechat'
  if (platform === 'wechat-miniprogram') return 'wechat'
  return null
}
