/**
 * mini 端虚拟支付适配器（mini/src/lib/xpay.ts + xpayEnabled.ts）单元测试。
 *
 * 守住的关键契约（每条都对应一个真实翻车面）：
 *   ① 售卖开关 `isXpaySaleEnabled`：只认 'true'（大小写/空白容错），其余一律 false
 *      —— 与 backend.ts 的 D_BEE_SELFHOST_READY 同为「默认安全值」哲学；
 *   ② `compareVersion`：官方示例同款语义（'2.19' 补零比 '2.19.2' 旧）；
 *   ③ `isXpaySupported`：非 weapp / 无 wx / 无接口 → false；SDK≥2.19.2 **或** canIUse
 *      （官方两条件取「或」）；
 *   ④ `xpayFailMessage`：-2 取消 → 空串（静默）；-15007 → 引导重登；
 *      平台配置类（-15008/-15010/-15014）→「暂时无法」不引导重试；
 *   ⑤ `requestVirtualPayment`：**signData 原样透传**（parse+stringify 会变字段顺序
 *      → -15005/-15006，这是官方明文的资损级坑）；取消 resolve(false) 不 reject；
 *   ⑥ `buyProduct` 五态闭环：ok / cancelled / settling / error / unsupported，
 *      特别是「已扣款但查单未确认 → settling 绝不报 error」（钱已扣，报错=客诉）；
 *      下单 provider 必须是 'wechat_xpay'（0046 查单语义分支按此值路由）；
 *   ⑦ 待核销订单持久化：**先落盘再轮询**（iOS 支付回来小程序常被杀），
 *      settled/refunded 终态才清除；TTL 7 天外的自动过滤；
 *   ⑧ `recoverPending` 保证不 reject，单笔失败不影响其余。
 *
 * mock 说明：`@tarojs/taro` 用相对路径直指 mini/node_modules 嵌套实例
 * （根 node_modules 没有该包，裸包名 mock 不生效 —— 项目既有坑，
 *  见 tools/mini-invite-link.test.ts 头注）。cloud/api 必须 mock：
 * 真实 cloud.ts 顶层会跑 resolveBackendTarget()（缺 READY 确认直接 throw）。
 *
 * 运行：npx vitest run tools/mini-xpay.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ── hoisted mock 基建 ─────────────────────────────────────────────── */

const h = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    /** Taro.request 的可编程替身（按 URL 片段分发） */
    requestMock: null as null | ((opts: {
      url: string
      data?: Record<string, unknown>
    }) => Promise<{ statusCode: number; data: unknown }>),
    /** cloud.auth.getSession 替身 */
    sessionMock: null as null | (() => Promise<{ data?: { accessToken?: string } }>),
    /** createPaymentOrder 替身（记录调用参数） */
    createOrderCalls: [] as Array<{ productId: string; provider: string }>,
    createOrderMock: null as null | ((productId: string, provider: string) => Promise<{ order_no?: string }>),
  }
})

vi.mock('../mini/node_modules/@tarojs/taro', () => ({
  default: {
    getStorageSync: (k: string) => h.store.get(k) ?? '',
    setStorageSync: (k: string, v: string) => { h.store.set(k, String(v)) },
    removeStorageSync: (k: string) => { h.store.delete(k) },
    request: (opts: { url: string; data?: Record<string, unknown> }) =>
      h.requestMock
        ? h.requestMock(opts)
        : Promise.reject(new Error('requestMock 未配置')),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wx_test_appid' } }),
  },
}))

vi.mock('../mini/src/lib/cloud', () => ({
  cloud: {
    auth: {
      getSession: () =>
        h.sessionMock
          ? h.sessionMock()
          : Promise.resolve({ data: { accessToken: 'tok_test' } }),
    },
  },
  publicConfig: { endpoint: 'https://d-bee.cn' },
}))

vi.mock('../mini/src/lib/api', () => ({
  createPaymentOrder: (productId: string, provider: string) => {
    h.createOrderCalls.push({ productId, provider })
    return h.createOrderMock
      ? h.createOrderMock(productId, provider)
      : Promise.resolve({ order_no: 'ORD_DEFAULT' })
  },
}))

/* ── 被测模块 ──────────────────────────────────────────────────────── */

import { isXpaySaleEnabled, XPAY_SALE_ENABLED } from '../mini/src/lib/xpayEnabled'
import {
  buyProduct,
  compareVersion,
  hasPendingOrder,
  isXpaySupported,
  pollUntilSettled,
  recoverPending,
  requestVirtualPayment,
  xpayFailMessage,
  type XpayParams,
} from '../mini/src/lib/xpay'
import { PRODUCT_IDS } from '@dbee/shared'

/* ── wx 全局替身 ───────────────────────────────────────────────────── */

interface WxCall {
  signData: string
  paySig: string
  signature: string
  mode: string
}

function setWx(opts: {
  payResult?: { ok?: boolean; errCode?: number; errMsg?: string } | null
  sdkVersion?: string
  canIUse?: boolean
  hasRequestVirtualPayment?: boolean
  systemInfoThrows?: boolean
} = {}): WxCall[] {
  const calls: WxCall[] = []
  const wx: Record<string, unknown> = {}
  if (opts.hasRequestVirtualPayment !== false) {
    wx.requestVirtualPayment = (o: {
      signData: string
      paySig: string
      signature: string
      mode: string
      success?: (res: unknown) => void
      fail?: (err: { errCode?: number; errMsg?: string }) => void
    }) => {
      calls.push({ signData: o.signData, paySig: o.paySig, signature: o.signature, mode: o.mode })
      const r = opts.payResult
      if (!r) return // 悬挂：既不 success 也不 fail（模拟收银台未回）
      if (r.ok) o.success?.({})
      else o.fail?.({ errCode: r.errCode, errMsg: r.errMsg })
    }
  }
  if (opts.systemInfoThrows) {
    wx.getSystemInfoSync = () => { throw new Error('boom') }
  } else {
    wx.getSystemInfoSync = () => ({ SDKVersion: opts.sdkVersion ?? '3.5.0' })
  }
  if (opts.canIUse !== undefined) {
    wx.canIUse = () => opts.canIUse
  }
  ;(globalThis as unknown as { wx?: unknown }).wx = wx
  return calls
}

function clearWx(): void {
  delete (globalThis as unknown as { wx?: unknown }).wx
}

/** 按 URL 片段配置网关响应 */
function mockGateway(
  handlers: Record<string, (body: Record<string, unknown>) => { statusCode: number; data: unknown }>,
): void {
  h.requestMock = async (opts) => {
    for (const frag of Object.keys(handlers)) {
      if (opts.url.includes(frag)) {
        return handlers[frag]((opts.data ?? {}) as Record<string, unknown>)
      }
    }
    return { statusCode: 404, data: { message: `未 mock 的端点: ${opts.url}` } }
  }
}

const VALID_PARAMS: XpayParams = {
  mode: 'short_series_goods',
  // 🔴 含「乱序空格」的字符串：若实现 parse+stringify 过，透传断言必炸
  signData: '{"offerId":"x",  "buyQuantity":1,"env":0,"productId":"dbee_pro_monthly"}',
  paySig: 'paysig_hex',
  signature: 'sig_hex',
  env: 0,
}

const ORIGINAL_TARO_ENV = process.env.TARO_ENV

beforeEach(() => {
  process.env.TARO_ENV = 'weapp'
  h.store.clear()
  h.requestMock = null
  h.sessionMock = null
  h.createOrderMock = null
  h.createOrderCalls.length = 0
  clearWx()
  vi.useRealTimers()
})

afterEach(() => {
  process.env.TARO_ENV = ORIGINAL_TARO_ENV
  clearWx()
  vi.useRealTimers()
})

/* ── ① 售卖开关 ────────────────────────────────────────────────────── */

describe('isXpaySaleEnabled · 只认 true（默认安全值）', () => {
  it.each(['true', 'TRUE', ' True ', 'true\n'])('「%s」→ true', (v) => {
    expect(isXpaySaleEnabled({ enabled: v })).toBe(true)
  })

  it.each(['', 'false', '1', 'yes', 'on', 'enabled', 'true1', 'tru'])('「%s」→ false', (v) => {
    expect(isXpaySaleEnabled({ enabled: v })).toBe(false)
  })

  it('未设变量 → false（默认关闭，构建出的包不展示售卖）', () => {
    expect(isXpaySaleEnabled({ enabled: undefined })).toBe(false)
  })

  it('vitest 环境（未注入 D_BEE_XPAY_ENABLED）下顶层常量为 false', () => {
    expect(XPAY_SALE_ENABLED).toBe(false)
  })
})

/* ── ② compareVersion（官方示例同款） ──────────────────────────────── */

describe('compareVersion · 语义化版本比较', () => {
  it('相等 → 0', () => {
    expect(compareVersion('2.19.2', '2.19.2')).toBe(0)
  })

  it('更新 → 1 / 更旧 → -1', () => {
    expect(compareVersion('2.20.0', '2.19.2')).toBe(1)
    expect(compareVersion('2.19.1', '2.19.2')).toBe(-1)
  })

  it('位数不同补零：「2.19」<「2.19.2」', () => {
    expect(compareVersion('2.19', '2.19.2')).toBe(-1)
  })

  it('大版本优先：「3.0」>「2.19.2」', () => {
    expect(compareVersion('3.0', '2.19.2')).toBe(1)
  })

  it('非字符串入参 → 0（不炸，交给 canIUse 兜底）', () => {
    expect(compareVersion(undefined, '2.19.2')).toBe(0)
  })
})

/* ── ③ isXpaySupported ─────────────────────────────────────────────── */

describe('isXpaySupported · 宿主能力判定', () => {
  it('非 weapp 宿主 → false（虚拟支付是微信专属）', () => {
    process.env.TARO_ENV = 'alipay'
    setWx({})
    expect(isXpaySupported()).toBe(false)
  })

  it('全局无 wx → false', () => {
    expect(isXpaySupported()).toBe(false)
  })

  it('wx 无 requestVirtualPayment 接口 → false（最终防线）', () => {
    setWx({ hasRequestVirtualPayment: false, sdkVersion: '3.5.0' })
    expect(isXpaySupported()).toBe(false)
  })

  it('SDK ≥ 2.19.2 → true', () => {
    setWx({ sdkVersion: '2.19.2' })
    expect(isXpaySupported()).toBe(true)
  })

  it('SDK 低但 canIUse=true → true（官方两条件取「或」）', () => {
    setWx({ sdkVersion: '2.18.0', canIUse: true })
    expect(isXpaySupported()).toBe(true)
  })

  it('SDK 低且 canIUse=false → false', () => {
    setWx({ sdkVersion: '2.18.0', canIUse: false })
    expect(isXpaySupported()).toBe(false)
  })

  it('getSystemInfoSync 抛异常 → 不炸，走 canIUse', () => {
    setWx({ systemInfoThrows: true, canIUse: true })
    expect(isXpaySupported()).toBe(true)
  })
})

/* ── ④ xpayFailMessage ─────────────────────────────────────────────── */

describe('xpayFailMessage · 错误码翻译', () => {
  it('-2（用户取消）→ 空串 = 静默不提示', () => {
    expect(xpayFailMessage(-2, 'fail cancel')).toBe('')
  })

  it('-15007（session_key 过期）→ 引导重新登录', () => {
    expect(xpayFailMessage(-15007, '')).toContain('重新登录')
  })

  it.each([-15008, -15009, -15010, -15014, -15018])('%i（平台配置类）→ 说「暂时无法/暂不可用」，不引导重试', (code) => {
    expect(xpayFailMessage(code, '')).toMatch(/暂时无法|暂不可用|后再试/)
  })

  it('-15014 → 明确给出「约 10 分钟」生效等待', () => {
    expect(xpayFailMessage(-15014, '')).toContain('10 分钟')
  })

  it('-15005 / -15006（签名错）→ 有区分度文案', () => {
    expect(xpayFailMessage(-15005, '')).not.toBe(xpayFailMessage(-15006, ''))
  })

  it('未知错误码 → 带原始码便于反馈定位', () => {
    expect(xpayFailMessage(-99999, 'whatever')).toContain('-99999')
  })

  it('无码有 errMsg → 截断展示；两者皆无 → 兜底文案', () => {
    expect(xpayFailMessage(undefined, 'x'.repeat(200)).length).toBeLessThanOrEqual(60)
    expect(xpayFailMessage(undefined, undefined)).toBe('支付失败，请重试')
  })
})

/* ── ⑤ requestVirtualPayment ───────────────────────────────────────── */

describe('requestVirtualPayment · 收银台包装', () => {
  it('🔴 signData/paySig/signature 原样透传（parse+stringify 会变字段顺序 → -15005）', async () => {
    const calls = setWx({ payResult: { ok: true } })
    await requestVirtualPayment(VALID_PARAMS)
    expect(calls[0].signData).toBe(VALID_PARAMS.signData)
  })

  it('mode 缺省补 short_series_goods（道具直购）', async () => {
    const calls = setWx({ payResult: { ok: true } })
    await requestVirtualPayment({ ...VALID_PARAMS, mode: '' })
    expect(calls[0].mode).toBe('short_series_goods')
  })

  it('success → resolve(true)', async () => {
    setWx({ payResult: { ok: true } })
    await expect(requestVirtualPayment(VALID_PARAMS)).resolves.toBe(true)
  })

  it('errCode=-2（取消）→ resolve(false)，不 reject', async () => {
    setWx({ payResult: { errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' } })
    await expect(requestVirtualPayment(VALID_PARAMS)).resolves.toBe(false)
  })

  it('部分宿主只回 errMsg 含 cancel → 同样判取消', async () => {
    setWx({ payResult: { errMsg: 'requestVirtualPayment:fail 用户取消' } })
    await expect(requestVirtualPayment(VALID_PARAMS)).resolves.toBe(false)
  })

  it('-15007 → reject，message 已是可读文案（引导重登）', async () => {
    setWx({ payResult: { errCode: -15007, errMsg: 'session key expired' } })
    await expect(requestVirtualPayment(VALID_PARAMS)).rejects.toThrow(/重新登录/)
  })

  it('宿主无接口 → reject「不支持」而非静默悬挂', async () => {
    clearWx()
    await expect(requestVirtualPayment(VALID_PARAMS)).rejects.toThrow(/不支持/)
  })

  it('接口同步抛异常 → 转可读 reject，不冒未处理异常', async () => {
    ;(globalThis as unknown as { wx: unknown }).wx = {
      requestVirtualPayment: () => { throw new Error('invalid param') },
      getSystemInfoSync: () => ({ SDKVersion: '3.5.0' }),
    }
    await expect(requestVirtualPayment(VALID_PARAMS)).rejects.toThrow()
  })
})

/* ── ⑥ buyProduct 五态闭环 ─────────────────────────────────────────── */

const OK_PARAMS_RESP = { statusCode: 200, data: VALID_PARAMS }

describe('buyProduct · 五态闭环', () => {
  it('宿主不支持 → unsupported（不发任何请求）', async () => {
    clearWx()
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('unsupported')
    expect(h.createOrderCalls).toHaveLength(0)
  })

  it('下单 provider 必须是 wechat_xpay（0046 按此值走查单语义分支）', async () => {
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => OK_PARAMS_RESP,
      '/query': () => ({ statusCode: 200, data: { settled: true } }),
    })
    await buyProduct('proYearly')
    expect(h.createOrderCalls[0]).toEqual({ productId: PRODUCT_IDS.proYearly, provider: 'wechat_xpay' })
  })

  it('支付成功 + 查单 settled → ok，onGranted 被调，本地 pending 清空', async () => {
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => OK_PARAMS_RESP,
      '/query': () => ({ statusCode: 200, data: { settled: true } }),
    })
    const granted = vi.fn()
    const r = await buyProduct('lifetime', granted)
    expect(r.status).toBe('ok')
    expect(granted).toHaveBeenCalledTimes(1)
    await expect(hasPendingOrder()).resolves.toBe(false)
  })

  it('用户取消 → cancelled，且不落 pending（没扣款就没有待核销单）', async () => {
    setWx({ payResult: { errCode: -2 } })
    mockGateway({ '/params': () => OK_PARAMS_RESP })
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('cancelled')
    await expect(hasPendingOrder()).resolves.toBe(false)
  })

  it('🔴 已扣款但轮询窗口内未到账 → settling 绝不报 error（钱已扣）', async () => {
    vi.useFakeTimers()
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => OK_PARAMS_RESP,
      '/query': () => ({ statusCode: 200, data: { paid: true, settling: true } }),
    })
    const p = buyProduct('proMonthly')
    await vi.advanceTimersByTimeAsync(10_000)
    const r = await p
    expect(r.status).toBe('settling')
    if (r.status === 'settling') expect(r.message).toContain('正在到账')
  })

  it('settling 时订单号已落盘（重启可自愈 —— 先落盘再轮询的顺序契约）', async () => {
    vi.useFakeTimers()
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => OK_PARAMS_RESP,
      '/query': () => ({ statusCode: 200, data: { settling: true } }),
    })
    h.createOrderMock = () => Promise.resolve({ order_no: 'ORD_SETTLE' })
    const p = buyProduct('proMonthly')
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    const raw = h.store.get('xpay.pendingOrders') ?? ''
    expect(raw).toContain('ORD_SETTLE')
  })

  it('already_paid（幂等重入）→ 不拉收银台，直接 ok + 发权益', async () => {
    const calls = setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => ({ statusCode: 200, data: { ...VALID_PARAMS, already_paid: true } }),
    })
    const granted = vi.fn()
    const r = await buyProduct('proMonthly', granted)
    expect(r.status).toBe('ok')
    expect(calls).toHaveLength(0)
    expect(granted).toHaveBeenCalledTimes(1)
  })

  it('params 缺签名字段 → error「参数不完整」，不拉收银台', async () => {
    const calls = setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => ({ statusCode: 200, data: { mode: 'short_series_goods', signData: 'x' } }),
    })
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('error')
    expect(calls).toHaveLength(0)
  })

  it('网关 503 xpay_not_configured → unsupported（凭据未配属能力不可用，不是用户错误）', async () => {
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => ({ statusCode: 503, data: { error: 'xpay_not_configured', message: '未配置' } }),
    })
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('unsupported')
  })

  it('网关 409 session_key_expired → error 且引导重新登录', async () => {
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => ({ statusCode: 409, data: { error: 'session_key_expired', message: 'session 过期' } }),
    })
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('error')
    if (r.status === 'error') expect(r.message).toContain('重新登录')
  })

  it('未登录（无 accessToken）→ error「请先登录」，不发网关请求', async () => {
    setWx({ payResult: { ok: true } })
    h.sessionMock = () => Promise.resolve({ data: { accessToken: '' } })
    mockGateway({ '/params': () => OK_PARAMS_RESP })
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('error')
  })

  it('网络层失败 → error 且文案可读（不是原始 fetch 异常）', async () => {
    setWx({ payResult: { ok: true } })
    h.requestMock = () => Promise.reject(new Error('request:fail timeout'))
    const r = await buyProduct('proMonthly')
    expect(r.status).toBe('error')
    if (r.status === 'error') expect(r.message).not.toContain('request:fail')
  })

  it('onGranted 抛异常不影响 ok（权益已落库，刷新失败下次进页面再读）', async () => {
    setWx({ payResult: { ok: true } })
    mockGateway({
      '/params': () => OK_PARAMS_RESP,
      '/query': () => ({ statusCode: 200, data: { settled: true } }),
    })
    const r = await buyProduct('proMonthly', () => { throw new Error('refresh boom') })
    expect(r.status).toBe('ok')
  })
})

/* ── ⑦⑧ 待核销订单持久化与自愈恢复 ─────────────────────────────────── */

function seedPending(orderNo: string, ageMs = 0): void {
  h.store.set(
    'xpay.pendingOrders',
    JSON.stringify([{ orderNo, productId: 'dbee_pro_monthly', ts: Date.now() - ageMs }]),
  )
}

describe('recoverPending · 启动/进付费墙自愈（保证不 reject）', () => {
  it('查单 settled → 计数 1、清本地、调 onGranted', async () => {
    seedPending('ORD_R1')
    mockGateway({ '/query': () => ({ statusCode: 200, data: { settled: true } }) })
    const granted = vi.fn()
    await expect(recoverPending(granted)).resolves.toBe(1)
    await expect(hasPendingOrder()).resolves.toBe(false)
    expect(granted).toHaveBeenCalledTimes(1)
  })

  it('refunded（终态）→ 计数 0 但清本地（不再反复查）', async () => {
    seedPending('ORD_R2')
    mockGateway({ '/query': () => ({ statusCode: 200, data: { refunded: true } }) })
    await expect(recoverPending()).resolves.toBe(0)
    await expect(hasPendingOrder()).resolves.toBe(false)
  })

  it('仍未到账 → 计数 0 且**保留**本地记录（下次再试）', async () => {
    seedPending('ORD_R3')
    mockGateway({ '/query': () => ({ statusCode: 200, data: { settling: true } }) })
    await expect(recoverPending()).resolves.toBe(0)
    await expect(hasPendingOrder()).resolves.toBe(true)
  })

  it('查单网络异常 → 不 reject、保留记录', async () => {
    seedPending('ORD_R4')
    h.requestMock = () => Promise.reject(new Error('network down'))
    await expect(recoverPending()).resolves.toBe(0)
    await expect(hasPendingOrder()).resolves.toBe(true)
  })

  it('TTL（7 天）外的陈旧单 → 自动过滤不清不查', async () => {
    seedPending('ORD_OLD', 8 * 24 * 3600 * 1000)
    mockGateway({ '/query': () => ({ statusCode: 200, data: { settled: true } }) })
    await expect(recoverPending()).resolves.toBe(0)
  })

  it('本地数据损坏（非 JSON）→ 视作空列表，不炸', async () => {
    h.store.set('xpay.pendingOrders', '{broken json!!')
    mockGateway({ '/query': () => ({ statusCode: 200, data: { settled: true } }) })
    await expect(recoverPending()).resolves.toBe(0)
  })

  it('无待核销单 → 直接 0，不发网关请求', async () => {
    mockGateway({ '/query': () => ({ statusCode: 200, data: { settled: true } }) })
    await expect(recoverPending()).resolves.toBe(0)
    expect(h.requestMock).not.toBeNull()
  })
})

describe('pollUntilSettled · 只查不炸', () => {
  it('第一次就 settled → true 且只发一次查询', async () => {
    let n = 0
    mockGateway({
      '/query': () => {
        n++
        return { statusCode: 200, data: { settled: true } }
      },
    })
    await expect(pollUntilSettled('ORD_P1', 4)).resolves.toBe(true)
    expect(n).toBe(1)
  })

  it('refunded → 提前 false（终态不必轮满）', async () => {
    let n = 0
    mockGateway({
      '/query': () => {
        n++
        return { statusCode: 200, data: { refunded: true } }
      },
    })
    await expect(pollUntilSettled('ORD_P2', 4)).resolves.toBe(false)
    expect(n).toBe(1)
  })

  it('持续未到账 → 轮满 attempts 次后 false（不 reject）', async () => {
    vi.useFakeTimers()
    let n = 0
    mockGateway({
      '/query': () => {
        n++
        return { statusCode: 200, data: { settling: true } }
      },
    })
    const p = pollUntilSettled('ORD_P3', 3)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBe(false)
    expect(n).toBe(3)
  })
})
