/**
 * 统一支付抽象层 —— 类型与接口定义。
 *
 * 目标（见 docs/统一支付架构方案.md）：
 *   各端只实现「发起支付 + 回传凭证」两个动作，权益落库、幂等、防重全部走服务端。
 *   未来接新端（Android / Web / 小程序）= 新增一个 adapter 实现本接口，其余全复用。
 *
 * 约束：
 *   - 本文件只定义类型，不 import 任何原生支付插件，保证 Web 构建零新增依赖。
 *   - 具体平台适配器（iosIap.ts / googlePlay.ts / wechatPay.ts / alipay.ts）
 *     用「运行时鸭子类型探测」访问 Capacitor 插件（沿用 wechat.ts / originProxy.ts 风格）。
 */

import type { ProductId } from '../entitlement'

/** 商品信息（拉取自平台，用于展示付费墙价格） */
export interface ProductInfo {
  /** 商品 ID（与 App Store Connect / Google Play / 商户号一致） */
  productId: ProductId
  /** 本地化价格文案，如 "¥18.00" */
  price: string
  /** 本地化标题 */
  title: string
  /** 本地化描述 */
  description?: string
}

/** 一次购买的结果（含平台凭证，用于服务端核销） */
export interface PurchaseResult {
  /** 平台交易号（iOS transactionId / Google orderId / 微信支付宝交易号） */
  providerTxnId: string
  /** 原始凭证（iOS receipt base64 / Google purchaseToken / 微信支付宝回执） */
  receipt: string
  /** 商品 ID */
  productId: ProductId
}

/**
 * 支付适配器统一接口。每个平台一个实现。
 *
 * 各端差异：
 *   - iOS：StoreKit 2（StoreKit.Product / .purchase / Transaction.currentEntitlements）
 *   - Android：Google Play Billing Library
 *   - Web/小程序：微信支付 / 支付宝（拉起收银台或跳转）
 */
export interface PaymentAdapter {
  /** 拉取商品（含价格，用于展示付费墙） */
  fetchProducts(): Promise<ProductInfo[]>
  /** 发起购买，返回平台凭证 */
  purchase(productId: ProductId): Promise<PurchaseResult>
  /** 恢复购买（iOS/Google 订阅必需；微信支付宝一次性支付无需实现，返回空数组） */
  restore(): Promise<PurchaseResult[]>
  /** iOS：启动时取得已扣款但尚未 finish 的交易 */
  getUnfinishedPurchases?(): Promise<PurchaseResult[]>
  /** iOS：服务端核销成功后完成指定 StoreKit 交易 */
  finishPurchase?(providerTxnId: string): Promise<void>
  /** iOS：监听补单、Ask to Buy 批准、续订等后台交易 */
  onPurchaseUpdated?(listener: (purchase: PurchaseResult) => void): () => void
}

/** checkout 统一流程的最终结果 */
export type CheckoutResult =
  | { status: 'ok' }
  | { status: 'cancelled'; message?: string }
  /** Ask to Buy / 家长批准中，此时还没有可核销交易 */
  | { status: 'pending'; message: string }
  /** Apple 已返回交易，但服务端尚未确认权益；记录已保留并可重试 */
  | { status: 'pending_settlement'; message: string }
  | { status: 'error'; message: string }
