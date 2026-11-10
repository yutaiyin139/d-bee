/** 统一支付 checkout，以及 iOS 已扣款交易的持久化恢复闭环。 */

import { createPaymentOrder, verifyPaymentOrder } from '../api'
import { cloud } from '../../cloud'
import { PRODUCT_IDS, type ProductId } from '../entitlement'
import { kvGetJSON, kvSetJSON } from '../kv'
import { platformName } from '../platform'
import type { CheckoutResult, PaymentAdapter, PurchaseResult } from './types'

/**
 * 🔴 'google' 不是「已实装的支付渠道」（阶段 0 复核，总纲 L3 #11 结论修正）：
 *   `getAdapter()` 从未处理 'google'，Google Play Billing 也没有任何实现；
 *   但 `src/lib/api.ts` / `mini/src/lib/api.ts` 的**支付订单 provider 协议字段**
 *   同样枚举了 'google' —— 那是服务端协议枚举，只删这里会制造两端类型分叉。
 *   故保留并注明：这是协议字段，**不代表 Google Play 收费已支持**，勿当作已实现。
 */
export type PayProvider = 'apple' | 'google' | 'wechat' | 'alipay'

const PENDING_KEY = 'dbee.iap.pending-settlements.v1'
const PENDING_MESSAGE = 'App Store 已返回交易，但权益尚未确认。记录已保留，请保持原账号登录并恢复购买或稍后重启重试。'

interface PendingSettlement extends PurchaseResult {
  ownerId: string
  orderNo: string
  createdAt: string
}

interface RecoverySummary {
  total: number
  succeeded: number
  failed: number
}

const settlementInFlight = new Map<string, Promise<boolean>>()
let pendingWriteQueue: Promise<void> = Promise.resolve()
let recoveryQueue: Promise<void> = Promise.resolve()
let removeUpdateListener: (() => void) | null = null
let refreshEntitlement: (() => Promise<void>) | undefined

export async function getAdapter(provider?: PayProvider): Promise<PaymentAdapter | null> {
  const platform = platformName()
  if (platform === 'ios') {
    const { createIosIapAdapter } = await import('./iosIap')
    return createIosIapAdapter()
  }
  if (platform === 'android' || platform === 'web') {
    if (provider === 'alipay') {
      const { createAlipayAdapter } = await import('./alipay')
      return createAlipayAdapter()
    }
    const { createWechatPayAdapter } = await import('./wechatPay')
    return createWechatPayAdapter()
  }
  return null
}

async function currentOwnerId(): Promise<string | null> {
  try {
    const { data: session } = await cloud.auth.getSession()
    return session?.user?.id ?? null
  } catch {
    return null
  }
}

function isPendingSettlement(value: unknown): value is PendingSettlement {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<PendingSettlement>
  return !!(
    typeof p.ownerId === 'string' && p.ownerId &&
    typeof p.orderNo === 'string' && p.orderNo &&
    typeof p.providerTxnId === 'string' && p.providerTxnId &&
    typeof p.receipt === 'string' && p.receipt &&
    typeof p.productId === 'string' &&
    typeof p.createdAt === 'string'
  )
}

async function readPending(): Promise<PendingSettlement[]> {
  const value = await kvGetJSON<unknown>(PENDING_KEY, [])
  return Array.isArray(value) ? value.filter(isPendingSettlement) : []
}

/** 串行改写，避免购买回调与启动恢复同时读写时互相覆盖。 */
function mutatePending(mutator: (records: PendingSettlement[]) => PendingSettlement[]): Promise<void> {
  const operation = pendingWriteQueue.then(async () => {
    await kvSetJSON(PENDING_KEY, mutator(await readPending()))
  })
  pendingWriteQueue = operation.catch(() => undefined)
  return operation
}

function savePending(purchase: PurchaseResult, orderNo: string, ownerId: string): Promise<void> {
  return mutatePending((records) => [
    ...records.filter((p) => p.providerTxnId !== purchase.providerTxnId),
    { ...purchase, orderNo, ownerId, createdAt: new Date().toISOString() },
  ])
}

function removePending(providerTxnId: string): Promise<void> {
  return mutatePending((records) => records.filter((p) => p.providerTxnId !== providerTxnId))
}

/**
 * 服务端核销是发权益的唯一成功信号。iOS 只有核销成功才 finish；finish 失败也保留
 * 本地记录，下次利用服务端幂等重试，绝不出现「已扣款且交易消失但无权益」。
 */
function settlePurchase(
  adapter: PaymentAdapter,
  purchase: PurchaseResult,
  orderNo: string,
  ownerId: string | null,
  persistBeforeVerify = true,
): Promise<boolean> {
  const existing = settlementInFlight.get(purchase.providerTxnId)
  if (existing) return existing

  const operation = (async () => {
    const mustFinish = typeof adapter.finishPurchase === 'function'
    if (mustFinish && ownerId && persistBeforeVerify) await savePending(purchase, orderNo, ownerId)

    if (ownerId && (await currentOwnerId()) !== ownerId) return false
    const ok = await verifyPaymentOrder(orderNo, purchase.providerTxnId, purchase.receipt)
    if (!ok) return false

    if (mustFinish) {
      // 恢复流程先由服务端确认归属，再写待 finish 记录，避免他人交易的 409
      // 在本地留下错误 owner，反过来阻塞真正权益人的后续恢复。
      if (ownerId && !persistBeforeVerify) await savePending(purchase, orderNo, ownerId)
      await adapter.finishPurchase!(purchase.providerTxnId)
      await removePending(purchase.providerTxnId)
    }
    return true
  })().finally(() => {
    settlementInFlight.delete(purchase.providerTxnId)
  })
  settlementInFlight.set(purchase.providerTxnId, operation)
  return operation
}

async function refreshAfterGrant(): Promise<void> {
  try {
    await refreshEntitlement?.()
  } catch {
    // 权益已经落库；刷新失败不反向把成功支付报成失败，下次进入页面会再读。
  }
}

/** 统一购买流程：下单 → 商店交易 → 服务端核销 → finish → 刷新权益。 */
export async function checkout(
  productId: ProductId,
  provider: PayProvider,
  onEntitlementGranted?: () => Promise<void>,
): Promise<CheckoutResult> {
  refreshEntitlement = onEntitlementGranted ?? refreshEntitlement
  const adapter = await getAdapter(provider)
  if (!adapter) return { status: 'error', message: '当前平台暂不支持在线支付或支付组件需要升级' }

  try {
    const ownerId = provider === 'apple' ? await currentOwnerId() : null
    if (provider === 'apple' && !ownerId) {
      return { status: 'error', message: '请先登录，再购买会员' }
    }

    const order = await createPaymentOrder(PRODUCT_IDS[productId], provider)
    // 第三方收银台需要复用这同一笔 order_no 作为平台商户单号（见 types.ts 注释）；
    // iOS IAP 忽略该参数。业务流程「下单 → 支付 → 核销」不变。
    const result = await adapter.purchase(productId, order.order_no)
    const ok = await settlePurchase(adapter, result, order.order_no, ownerId)
    if (!ok) {
      return adapter.finishPurchase
        ? { status: 'pending_settlement', message: PENDING_MESSAGE }
        : { status: 'error', message: '支付校验失败，请稍后重试或联系客服' }
    }

    await refreshAfterGrant()
    return { status: 'ok' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const code = (e as { code?: string } | null)?.code
    if (code === 'PENDING') {
      return { status: 'pending', message: '购买正在等待批准。批准后会自动完成权益确认，无需重复购买。' }
    }
    if (code === 'CANCELLED' || /cancel|取消|拒绝|denied/i.test(message)) {
      return { status: 'cancelled', message }
    }
    return { status: 'error', message: message || '支付失败，请重试' }
  }
}

async function processRecovery(adapter: PaymentAdapter, includeEntitlements: boolean): Promise<RecoverySummary> {
  const ownerId = await currentOwnerId()
  if (!ownerId) return { total: 0, succeeded: 0, failed: 0 }

  const purchases = new Map<string, PurchaseResult>()
  if (includeEntitlements) {
    for (const p of await adapter.restore()) purchases.set(p.providerTxnId, p)
  }
  if (adapter.getUnfinishedPurchases) {
    try {
      for (const p of await adapter.getUnfinishedPurchases()) purchases.set(p.providerTxnId, p)
    } catch {
      // 本地记录仍能继续核销；原生查询失败不阻断手动恢复。
    }
  }

  const pending = await readPending()
  for (const p of pending) {
    if (p.ownerId === ownerId && !purchases.has(p.providerTxnId)) purchases.set(p.providerTxnId, p)
  }

  let total = 0
  let succeeded = 0
  let failed = 0
  for (const purchase of purchases.values()) {
    const saved = pending.find((p) => p.providerTxnId === purchase.providerTxnId)
    if (saved && saved.ownerId !== ownerId) continue
    total += 1
    const orderNo = saved?.orderNo ?? `restore-${purchase.providerTxnId}`
    try {
      const ok = await settlePurchase(adapter, purchase, orderNo, ownerId, false)
      if (ok) succeeded += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { total, succeeded, failed }
}

function queueRecovery(adapter: PaymentAdapter, includeEntitlements: boolean): Promise<RecoverySummary> {
  const operation = recoveryQueue.then(() => processRecovery(adapter, includeEntitlements))
  recoveryQueue = operation.then(() => undefined, () => undefined)
  return operation
}

/**
 * App 启动/登录后调用：监听后台交易并恢复 unfinished + 本地待核销记录。
 * 监听只注册一次，后续登录会更新权益刷新回调并重新执行恢复。
 *
 * 🔴 2026-11-01 契约：**本函数保证不 reject**。IAP 恢复属「尽力而为」的后台补偿，
 *   任何失败都不应打断登录后的正常使用（真机实证：注册监听失败曾冒成
 *   unhandledrejection，在 App 完全可用时弹出自报面板）。恢复未完成时记录保留，
 *   下次启动/登录或用户手动「恢复购买」会继续。
 */
export async function initializePaymentRecovery(
  onEntitlementGranted?: () => Promise<void>,
): Promise<void> {
  refreshEntitlement = onEntitlementGranted ?? refreshEntitlement
  if (platformName() !== 'ios') return

  // 兜底外壳：即使内部出现未预料的抛错，也只降级、绝不向调用方 reject。
  try {
    const adapter = await getAdapter('apple')
    if (!adapter) return

    if (!removeUpdateListener && adapter.onPurchaseUpdated) {
      // 🔴 2026-11-01 二次修复：连 `adapter.onPurchaseUpdated(...)` **这个调用本身**也要 try。
      //   真机截图（16:20）栈帧 `T3@index-*.js:1263:19486` 经本地产物列号映射，
      //   逐字对应 `zf=t.onPurchaseUpdated(r=>{...` —— 异常发生在「注册监听」这一步，
      //   而非回调内部，故上一版只给回调体加 try 完全没覆盖到。
      try {
        removeUpdateListener = adapter.onPurchaseUpdated((purchase) => {
          void (async () => {
            const ownerId = await currentOwnerId()
            if (!ownerId) return
            const saved = (await readPending()).find(
              (p) => p.providerTxnId === purchase.providerTxnId,
            )
            if (saved && saved.ownerId !== ownerId) return
            try {
              const ok = await settlePurchase(
                adapter,
                purchase,
                saved?.orderNo ?? `restore-${purchase.providerTxnId}`,
                ownerId,
                false,
              )
              if (ok) await refreshAfterGrant()
            } catch {
              // 记录保留；下次启动、登录或手动恢复会继续。
            }
          })().catch(() => {
            // 兜底：任何未预期异常都不冒泡为 unhandledrejection。
          })
        })
      } catch {
        // 插件桥未就绪/缺失：跳过后台监听，恢复能力靠下方 queueRecovery 与手动 restore。
        removeUpdateListener = null
      }
    }

    // queueRecovery → processRecovery 内部 currentOwnerId()/readPending() 同样无 try 保护，
    // 由外层这个 catch 统一兜住（恢复失败不阻断登录后的正常使用）。
    const summary = await queueRecovery(adapter, false)
    if (summary.succeeded > 0) await refreshAfterGrant()
  } catch {
    // 后台恢复整体失败：静默降级。待核销记录仍在本地，下次启动/登录/手动恢复会继续。
  }
}

/** 用户主动恢复购买：除 unfinished 外，也扫描当前有效权益。 */
export async function restorePurchases(
  onEntitlementGranted?: () => Promise<void>,
): Promise<CheckoutResult> {
  refreshEntitlement = onEntitlementGranted ?? refreshEntitlement
  const adapter = await getAdapter()
  if (!adapter) return { status: 'error', message: '当前平台不支持恢复购买' }

  try {
    const summary = await queueRecovery(adapter, true)
    if (summary.succeeded > 0) await refreshAfterGrant()
    if (summary.total === 0) return { status: 'error', message: '未找到可恢复的购买记录' }
    if (summary.failed > 0) return { status: 'pending_settlement', message: PENDING_MESSAGE }
    return { status: 'ok' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'error', message: message || '恢复购买失败，请重试' }
  }
}
