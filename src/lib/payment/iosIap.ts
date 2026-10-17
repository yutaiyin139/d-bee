/**
 * iOS App 内购（IAP）适配器 —— StoreKit 2 骨架。
 *
 * ⚠️ 当前状态（2026-10-17）：骨架，尚未在 Mac 上编译验证。
 *   - 原生侧还没有 StoreKit 插件（package.json 无 IAP 依赖）。
 *   - 本文件用「运行时鸭子类型探测」预留插件接口（沿用 wechat.ts / originProxy.ts 风格），
 *     真实原生插件（建议自研 dbee-iap 插件，StoreKit 2）后续在 Mac 上接入后，
 *     只需让插件的实现满足下面的 IapPlugin 接口，本文件其余代码无需改动。
 *
 * StoreKit 2 的关键点（实现原生插件时对照）：
 *   - 商品：Product.products(for: [String]) 拉取，displayPrice 本地化价格
 *   - 购买：Product.purchase(options:) → VerificationResult，需要 appStoreReceiptURL 拿收据
 *   - 恢复：Transaction.currentEntitlements 过滤未撤销交易
 *   - 凭证：purchase 返回的 transactionID + 收据（receipt base64），回传给服务端 verifyReceipt
 *
 * 本适配器只做「发起支付 + 回传凭证」，权益落库由服务端 verify_payment_order 完成。
 */

import { PRODUCT_IDS, type ProductId } from '../entitlement'
import { isIOS } from '../platform'
import type { PaymentAdapter, ProductInfo, PurchaseResult } from './types'

/** 自研 dbee-iap 原生插件的最小接口（StoreKit 2 封装） */
interface IapPlugin {
  /** 拉取商品（含本地化价格） */
  getProducts: (opts: { productIds: string[] }) => Promise<{
    products: Array<{ productId: string; title: string; description: string; price: string }>
  }>
  /** 发起购买，返回交易号 + 收据 base64 */
  purchase: (opts: { productId: string }) => Promise<{
    transactionId: string
    receipt: string
    productId: string
  }>
  /** 恢复已购项目 */
  restore: () => Promise<{
    transactions: Array<{ transactionId: string; receipt: string; productId: string }>
  }>
}

function getPlugin(): IapPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.DbeeIap
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<IapPlugin>
  if (typeof candidate.getProducts !== 'function' || typeof candidate.purchase !== 'function') return null
  return candidate as IapPlugin
}

/** 创建 iOS IAP 适配器；非 iOS 环境或插件缺失时返回 null */
export function createIosIapAdapter(): PaymentAdapter | null {
  if (!isIOS()) return null
  const plugin = getPlugin()
  if (!plugin) return null

  return {
    async fetchProducts(): Promise<ProductInfo[]> {
      const res = await plugin.getProducts({ productIds: Object.values(PRODUCT_IDS) })
      return res.products.map((p) => ({
        productId: p.productId as ProductId,
        price: p.price,
        title: p.title,
        description: p.description,
      }))
    },

    async purchase(productId: ProductId): Promise<PurchaseResult> {
      const res = await plugin.purchase({ productId: PRODUCT_IDS[productId] })
      return {
        providerTxnId: res.transactionId,
        receipt: res.receipt,
        productId,
      }
    },

    async restore(): Promise<PurchaseResult[]> {
      const res = await plugin.restore()
      return res.transactions.map((t) => ({
        providerTxnId: t.transactionId,
        receipt: t.receipt,
        productId: t.productId as ProductId,
      }))
    },
  }
}
