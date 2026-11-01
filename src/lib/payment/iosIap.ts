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
      // 🔴 2026-11-01 二次修复：`plugin.addListener(...)` **这个调用本身**也要 try 包住。
      //   上一版只在回调体内加了 try，但真机截图（16:20）显示 unhandledrejection 仍在，
      //   栈帧 `onPurchaseUpdated@iosIap-*.js:1:1945` 精确落在 `.then(...)` 这一段 ——
      //   即异常来自「注册监听」这个动作，不是监听回调。
      //
      //   为什么上一版挂在链尾的 `.catch()` 没接住：Capacitor core 8.5.3 的
      //   `addListenerNative` 内部是
      //     const p = new Promise((resolve) => call.then(() => resolve({ remove })))
      //   —— `call.then()` **没有 rejection handler**。native 侧 addListener 失败时：
      //     ① 内部产生一条无人处理的 rejection（业务侧无法消除）；
      //     ② 返回的 `p` **永久 pending**，故挂在 `p` 链上的 `.catch()` 永不触发。
      //   结论：只能对「同步抛错」+「p 自身 reject」双保险，不能只靠链尾 `.catch()`。
      try {
        const pending = plugin.addListener('transactionUpdated', (transaction) => {
          // listener() 在 Capacitor 原生事件派发器里**同步**调用，抛错不被外层
          // Promise 的 .catch() 接住（那只覆盖「注册」），会冒成 window.onerror。
          try {
            const purchase = toPurchase(transaction)
            if (purchase) listener(purchase)
          } catch {
            // 监听回调失败不影响 App：getUnfinished 与手动 restore 仍是兜底。
          }
        })
        if (pending && typeof (pending as Promise<ListenerHandle>).then === 'function') {
          void (pending as Promise<ListenerHandle>)
            .then((h) => {
              // h.remove 在 Capacitor 的 deprecated 分支里可能是 undefined，
              // 调用前必须判空 —— 否则又是一条 unhandledrejection。
              if (disposed) void Promise.resolve(h?.remove?.()).catch(() => {})
              else handle = h
            })
            .catch((err) => {
              // 监听注册失败不阻断 App：启动时 getUnfinished 与手动 restore 仍是兜底。
              // 留痕便于在 Xcode Console / NativeDiagnostics 里定位（勿静默）。
              console.warn('[d-bee-diag] IAP transactionUpdated 监听注册失败', err?.message || err)
            })
        } else {
          console.warn('[d-bee-diag] IAP addListener 未返回 Promise，跳过后台交易监听')
        }
      } catch (err) {
        // 桥未就绪 / 插件缺失 / 同步抛错：静默降级，恢复能力靠 getUnfinished + 手动 restore。
        console.warn('[d-bee-diag] IAP 注册监听时同步抛错', (err as Error)?.message || err)
      }
      return () => {
        disposed = true
        // 🔴 remove() 返回 Promise，`void handle.remove()` 若 reject 同样成 unhandledrejection。
        if (handle) void Promise.resolve(handle.remove()).catch(() => {})
      }
    },
  }
  return cachedAdapter
}
