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
 *   iOS     → StoreKit 2（iosIap）
 *   Android → 微信支付（wechatPay；Google Play 为后续可切换备选）
 *   Web     → 微信支付（wechatPay）
 *   小程序  → wx.requestPayment（规划中，届时新增 miniprogram adapter 并在此返回）
 *
 * 各 create* 函数在「平台不符 / 资质未就绪 / 插件缺失」时返回 null，
 * 统一由 checkout 兜底为「当前平台暂不支持在线支付」的诚实提示。
 */
export async function getAdapter(): Promise<PaymentAdapter | null> {
  const platform = platformName()
  if (platform === 'ios') {
    const { createIosIapAdapter } = await import('./iosIap')
    return createIosIapAdapter()
  }
  if (platform === 'android' || platform === 'web') {
    const { createWechatPayAdapter } = await import('./wechatPay')
    return createWechatPayAdapter()
  }
  // TODO(资质就绪后补)：wechat-miniprogram → wx.requestPayment
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
 * 恢复购买（iOS / Google 订阅必需；微信支付宝一次性支付无此概念）。
 * 调用平台 adapter.restore() 拿回当前有效交易，逐个回传服务端幂等核销，
 * 全部核销完成后刷新权益。
 * @param onEntitlementGranted 权益刷新回调（调用方传入 PlanProvider.refresh）
 */
export async function restorePurchases(
  onEntitlementGranted?: () => Promise<void>,
): Promise<CheckoutResult> {
  const adapter = await getAdapter()
  if (!adapter) {
    return { status: 'error', message: '当前平台不支持恢复购买' }
  }
  try {
    const purchases = await adapter.restore()
    if (purchases.length === 0) {
      return { status: 'error', message: '未找到可恢复的购买记录' }
    }
    // 逐个回传凭证核销（服务端幂等，重复核销直接返回成功）
    let anyOk = false
    for (const p of purchases) {
      try {
        // 恢复场景没有「下单」步骤：直接用 provider_txn_id 走核销，
        // 订单号缺失时以「restore-<txnId>」作为幂等键兜底。
        const ok = await verifyPaymentOrder(
          `restore-${p.providerTxnId}`,
          p.providerTxnId,
          p.receipt,
        )
        if (ok) anyOk = true
      } catch {
        // 单条核销失败不中断，继续处理其余交易
      }
    }
    if (onEntitlementGranted) await onEntitlementGranted()
    return anyOk ? { status: 'ok' } : { status: 'error', message: '恢复购买失败，请稍后重试' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'error', message: message || '恢复购买失败，请重试' }
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
