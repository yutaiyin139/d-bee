/** iOS StoreKit 2 适配器：交易只有经服务端核销后才允许 finish。 */

import { PRODUCT_IDS, type ProductId } from '../entitlement'
import { isIOS } from '../platform'
import type { PaymentAdapter, ProductInfo, PurchaseResult } from './types'

interface NativeTransaction {
  status: 'purchased'
  transactionId: string
  receipt: string
  productId: string
}

type NativePurchase = NativeTransaction | { status: 'pending'; productId: string }

interface ListenerHandle {
  remove: () => Promise<void>
}

interface IapPlugin {
  getProducts: (opts: { productIds: string[] }) => Promise<{
    products: Array<{ productId: string; title: string; description: string; price: string }>
  }>
  purchase: (opts: { productId: string }) => Promise<NativePurchase>
  restore: () => Promise<{ transactions: NativeTransaction[] }>
  getUnfinished: () => Promise<{ transactions: NativeTransaction[] }>
  finishTransaction: (opts: { transactionId: string }) => Promise<{ finished: boolean }>
  addListener: (
    eventName: 'transactionUpdated',
    listener: (transaction: NativeTransaction) => void,
  ) => Promise<ListenerHandle>
}

/** 带稳定代码的错误，checkout 不再依赖系统错误文案猜测取消/待批准。 */
export class IosIapError extends Error {
  constructor(public readonly code: 'CANCELLED' | 'PENDING' | 'FAILED', message: string) {
    super(message)
    this.name = 'IosIapError'
  }
}

function storeIdToProductId(storeId: string): ProductId | null {
  for (const [key, id] of Object.entries(PRODUCT_IDS)) {
    if (id === storeId) return key as ProductId
  }
  return null
}

function toPurchase(transaction: NativeTransaction): PurchaseResult | null {
  const productId = storeIdToProductId(transaction.productId)
  if (!productId || !transaction.transactionId || !transaction.receipt) return null
  return {
    providerTxnId: transaction.transactionId,
    receipt: transaction.receipt,
    productId,
  }
}

function normalizeError(error: unknown): IosIapError {
  const e = error as { code?: string; message?: string }
  const message = e?.message || String(error)
  if (e?.code === 'USER_CANCELLED' || /cancel|取消|denied/i.test(message)) {
    return new IosIapError('CANCELLED', message)
  }
  return new IosIapError('FAILED', message || 'App Store 支付失败')
}

function getPlugin(): IapPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.DbeeIap
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<IapPlugin>
  if (
    typeof candidate.getProducts !== 'function' ||
    typeof candidate.purchase !== 'function' ||
    typeof candidate.restore !== 'function' ||
    typeof candidate.getUnfinished !== 'function' ||
    typeof candidate.finishTransaction !== 'function' ||
    typeof candidate.addListener !== 'function'
  ) {
    return null
  }
  return candidate as IapPlugin
}

let cachedAdapter: PaymentAdapter | null = null

/** 非 iOS、旧版插件或插件缺失时返回 null；旧插件不允许继续走不安全的提前 finish。 */
export function createIosIapAdapter(): PaymentAdapter | null {
  if (!isIOS()) return null
  if (cachedAdapter) return cachedAdapter
  const plugin = getPlugin()
  if (!plugin) return null

  const toPurchases = (transactions: NativeTransaction[]): PurchaseResult[] =>
    transactions.map(toPurchase).filter((p): p is PurchaseResult => p !== null)

  cachedAdapter = {
    async fetchProducts(): Promise<ProductInfo[]> {
      const res = await plugin.getProducts({ productIds: Object.values(PRODUCT_IDS) })
      return res.products
        .map((p) => ({ productId: storeIdToProductId(p.productId), info: p }))
        .filter((p): p is { productId: ProductId; info: (typeof res.products)[number] } => p.productId !== null)
        .map(({ productId, info }) => ({
          productId,
          price: info.price,
          title: info.title,
          description: info.description,
        }))
    },

    async purchase(productId: ProductId): Promise<PurchaseResult> {
      try {
        const res = await plugin.purchase({ productId: PRODUCT_IDS[productId] })
        if (res.status === 'pending') {
          throw new IosIapError('PENDING', '购买正在等待批准，批准后会自动恢复核销')
        }
        const purchase = toPurchase(res)
        if (!purchase) throw new Error('App Store 返回了无效或不完整的交易')
        return purchase
      } catch (error) {
        if (error instanceof IosIapError) throw error
        throw normalizeError(error)
      }
    },

    async restore(): Promise<PurchaseResult[]> {
      const res = await plugin.restore()
      return toPurchases(res.transactions)
    },

    async getUnfinishedPurchases(): Promise<PurchaseResult[]> {
      const res = await plugin.getUnfinished()
      return toPurchases(res.transactions)
    },

    async finishPurchase(providerTxnId: string): Promise<void> {
      await plugin.finishTransaction({ transactionId: providerTxnId })
    },

    onPurchaseUpdated(listener: (purchase: PurchaseResult) => void): () => void {
      let disposed = false
      let handle: ListenerHandle | null = null
      void plugin
        .addListener('transactionUpdated', (transaction) => {
          const purchase = toPurchase(transaction)
          if (purchase) listener(purchase)
        })
        .then((h) => {
          if (disposed) void h.remove()
          else handle = h
        })
        .catch(() => {
          // 启动时 getUnfinished 与手动 restore 仍是兜底，监听失败不阻断 App。
        })
      return () => {
        disposed = true
        if (handle) void handle.remove()
      }
    },
  }
  return cachedAdapter
}
