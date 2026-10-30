import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaymentAdapter, PurchaseResult } from '../src/lib/payment/types'

const mocks = vi.hoisted(() => ({
  ownerId: 'owner-a' as string | null,
  createOrder: vi.fn(),
  verify: vi.fn(),
  kvGetJSON: vi.fn(),
  kvSetJSON: vi.fn(),
  adapter: undefined as unknown as PaymentAdapter,
}))

vi.mock('../src/lib/api', () => ({
  createPaymentOrder: mocks.createOrder,
  verifyPaymentOrder: mocks.verify,
}))
vi.mock('../src/cloud', () => ({
  cloud: { auth: { getSession: async () => ({ data: { user: { id: mocks.ownerId } } }) } },
}))
vi.mock('../src/lib/kv', () => ({
  kvGetJSON: mocks.kvGetJSON,
  kvSetJSON: mocks.kvSetJSON,
}))
vi.mock('../src/lib/platform', () => ({ platformName: () => 'ios' }))
vi.mock('../src/lib/payment/iosIap', () => ({ createIosIapAdapter: () => mocks.adapter }))

const PENDING_KEY = 'dbee.iap.pending-settlements.v1'
const purchase: PurchaseResult = {
  providerTxnId: '100000000000001',
  receipt: 'receipt-base64',
  productId: 'pro_monthly',
}

function createAdapter() {
  const unfinished = new Map<string, PurchaseResult>()
  const entitlements = new Map<string, PurchaseResult>()
  const listeners = new Set<(value: PurchaseResult) => void>()
  const adapter: PaymentAdapter = {
    fetchProducts: vi.fn(async () => []),
    purchase: vi.fn(async () => {
      unfinished.set(purchase.providerTxnId, purchase)
      entitlements.set(purchase.providerTxnId, purchase)
      return purchase
    }),
    restore: vi.fn(async () => [...entitlements.values()]),
    getUnfinishedPurchases: vi.fn(async () => [...unfinished.values()]),
    finishPurchase: vi.fn(async (id: string) => {
      unfinished.delete(id)
    }),
    onPurchaseUpdated: vi.fn((listener: (value: PurchaseResult) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
  return { adapter, unfinished, entitlements, listeners }
}

let store: ReturnType<typeof createAdapter>
let storage: Map<string, unknown>
let orderSequence = 0

async function loadCheckout() {
  // 保留原生交易和 Preferences，只重建 JS 模块，模拟 WKWebView/App 进程重启。
  vi.resetModules()
  return import('../src/lib/payment/checkout')
}

interface PendingRecord {
  providerTxnId: string
  ownerId: string
  orderNo: string
}

function pendingRecords(): PendingRecord[] {
  return (storage.get(PENDING_KEY) as PendingRecord[] | undefined) ?? []
}

async function flushUpdates() {
  await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ownerId = 'owner-a'
  orderSequence = 0
  storage = new Map()
  store = createAdapter()
  mocks.adapter = store.adapter
  mocks.createOrder.mockImplementation(async () => ({ order_no: `ORDER-${++orderSequence}` }))
  mocks.verify.mockResolvedValue(true)
  mocks.kvGetJSON.mockImplementation(async (_key: string, fallback: unknown) => storage.get(_key) ?? fallback)
  mocks.kvSetJSON.mockImplementation(async (key: string, value: unknown) => {
    storage.set(key, value)
  })
})

describe('iOS IAP 异常恢复闭环', () => {
  it('核销断网后不 finish，重启后利用持久化记录与 unfinished 恢复', async () => {
    mocks.verify.mockResolvedValueOnce(false)
    let checkoutModule = await loadCheckout()
    const result = await checkoutModule.checkout('pro_monthly', 'apple')

    expect(result.status).toBe('pending_settlement')
    expect(store.adapter.finishPurchase).not.toHaveBeenCalled()
    expect(pendingRecords()).toHaveLength(1)
    expect(pendingRecords()[0]).toMatchObject({ providerTxnId: purchase.providerTxnId, ownerId: 'owner-a' })

    store.listeners.clear()
    checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery()

    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(mocks.verify).toHaveBeenLastCalledWith('ORDER-1', purchase.providerTxnId, purchase.receipt)
    expect(store.adapter.finishPurchase).toHaveBeenCalledTimes(1)
    expect(pendingRecords()).toHaveLength(0)
    expect(store.unfinished.size).toBe(0)
  })

  it('购买后、本地记录写入前杀 App，也能从 StoreKit unfinished 恢复', async () => {
    store.unfinished.set(purchase.providerTxnId, purchase)
    expect(pendingRecords()).toHaveLength(0)

    const checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery()

    expect(mocks.verify).toHaveBeenCalledWith(
      `restore-${purchase.providerTxnId}`,
      purchase.providerTxnId,
      purchase.receipt,
    )
    expect(store.adapter.finishPurchase).toHaveBeenCalledWith(purchase.providerTxnId)
    expect(pendingRecords()).toHaveLength(0)
  })

  it('服务端已发权益但 finish 失败，重试保持记录并最终完成交易', async () => {
    vi.mocked(store.adapter.finishPurchase!).mockRejectedValueOnce(new Error('native finish failed'))
    let checkoutModule = await loadCheckout()
    const result = await checkoutModule.checkout('pro_monthly', 'apple')

    expect(result.status).toBe('error')
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    expect(pendingRecords()).toHaveLength(1)

    store.listeners.clear()
    checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery()

    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(store.adapter.finishPurchase).toHaveBeenCalledTimes(2)
    expect(pendingRecords()).toHaveLength(0)
  })

  it('同一交易重复回调只进行一次飞行中核销和一次 finish', async () => {
    let resolveVerification!: (value: boolean) => void
    mocks.verify.mockImplementation(() => new Promise<boolean>((resolve) => { resolveVerification = resolve }))
    const checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery()

    for (const listener of store.listeners) {
      listener(purchase)
      listener(purchase)
    }
    await flushUpdates()
    expect(mocks.verify).toHaveBeenCalledTimes(1)

    resolveVerification(true)
    await vi.waitFor(() => expect(store.adapter.finishPurchase).toHaveBeenCalledTimes(1))
    expect(pendingRecords()).toHaveLength(0)
  })

  it('切换 D-Bee 账号时不核销、不 finish 旧账号交易，切回后继续', async () => {
    mocks.verify.mockResolvedValueOnce(false)
    let checkoutModule = await loadCheckout()
    await checkoutModule.checkout('pro_monthly', 'apple')
    expect(mocks.verify).toHaveBeenCalledTimes(1)

    mocks.ownerId = 'owner-b'
    store.listeners.clear()
    checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery()
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    expect(store.adapter.finishPurchase).not.toHaveBeenCalled()
    expect(pendingRecords()[0].ownerId).toBe('owner-a')

    mocks.ownerId = 'owner-a'
    store.listeners.clear()
    checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery()
    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(store.adapter.finishPurchase).toHaveBeenCalledTimes(1)
    expect(pendingRecords()).toHaveLength(0)
  })

  it('手动恢复当前有效权益时走同一幂等核销闭环', async () => {
    store.entitlements.set(purchase.providerTxnId, purchase)
    const checkoutModule = await loadCheckout()
    const result = await checkoutModule.restorePurchases()

    expect(result.status).toBe('ok')
    expect(mocks.verify).toHaveBeenCalledWith(
      `restore-${purchase.providerTxnId}`,
      purchase.providerTxnId,
      purchase.receipt,
    )
    expect(store.adapter.finishPurchase).toHaveBeenCalledWith(purchase.providerTxnId)
  })

  it('后台续订更新自动核销、finish 并刷新权益', async () => {
    const refresh = vi.fn(async () => undefined)
    const renewal = { ...purchase, providerTxnId: '100000000000002' }
    const checkoutModule = await loadCheckout()
    await checkoutModule.initializePaymentRecovery(refresh)

    for (const listener of store.listeners) listener(renewal)
    await vi.waitFor(() => expect(store.adapter.finishPurchase).toHaveBeenCalledWith(renewal.providerTxnId))
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(mocks.verify).toHaveBeenCalledWith(
      `restore-${renewal.providerTxnId}`,
      renewal.providerTxnId,
      renewal.receipt,
    )
  })

  it('换 Apple ID 后以另一账号恢复已归属交易，拒绝记录不会阻塞原账号', async () => {
    store.entitlements.set(purchase.providerTxnId, purchase)
    store.unfinished.set(purchase.providerTxnId, purchase)
    mocks.ownerId = 'owner-b'
    mocks.verify.mockResolvedValueOnce(false)
    let checkoutModule = await loadCheckout()

    const rejected = await checkoutModule.restorePurchases()
    expect(rejected.status).toBe('pending_settlement')
    expect(pendingRecords()).toHaveLength(0)
    expect(store.adapter.finishPurchase).not.toHaveBeenCalled()

    mocks.ownerId = 'owner-a'
    store.listeners.clear()
    checkoutModule = await loadCheckout()
    const restored = await checkoutModule.restorePurchases()
    expect(restored.status).toBe('ok')
    expect(store.adapter.finishPurchase).toHaveBeenCalledWith(purchase.providerTxnId)
    expect(pendingRecords()).toHaveLength(0)
  })

  it('Ask to Buy 待批准时没有交易号，不调用核销或 finish', async () => {
    vi.mocked(store.adapter.purchase).mockRejectedValueOnce(
      Object.assign(new Error('waiting for approval'), { code: 'PENDING' }),
    )
    const checkoutModule = await loadCheckout()
    const result = await checkoutModule.checkout('pro_monthly', 'apple')

    expect(result.status).toBe('pending')
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(store.adapter.finishPurchase).not.toHaveBeenCalled()
    expect(pendingRecords()).toHaveLength(0)
  })
})
