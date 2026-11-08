/**
 * 微信小程序虚拟支付（米大师 xpay）适配器 —— 道具直购 `short_series_goods`。
 *
 * ## 为什么不是 `wx.requestPayment`
 *
 * 会员订阅属**虚拟商品**。微信对小程序内虚拟商品**强制**要求走虚拟支付
 * （`wx.requestVirtualPayment`，即米大师 xpay），普通商户支付
 * （`wx.requestPayment`）只允许实物/线下服务。用错通道是下架级违规，
 * 且普通支付的 JSAPI 下单在虚拟商品场景下会被平台拒绝。
 *
 * ## 链路（与 docs/P1-D在线支付实装前置清单-2026-11-03.md §二 的两个决策对齐）
 *
 * 微信是**推模式**：客户端 `success` 回调只代表「用户侧扣款完成」，
 * 权益发放的**唯一权威信号**是服务端的 `xpay_goods_deliver_notify` 推送。
 * 推送到达时间不可控且**通常晚于**客户端回调，故：
 *
 *   ① `create_payment_order`（RPC，服务端查价，客户端改不了金额）
 *   ② `POST /.cloud/payment/wechat/params`（服务端用 session_key 现算双签名）
 *   ③ `wx.requestVirtualPayment`（拉起收银台）
 *   ④ `POST /.cloud/payment/wechat/query` **有限重试轮询**（1.5s × 4）
 *      —— 推送已处理 → `{settled:true}`；未到 → `retry_later`，窗口内**绝不报错**
 *   ⑤ 窗口内仍未到账 → 返回 `settling` 状态 + 本地持久化订单号，
 *      下次进入付费墙 / 重启时再查一次（自愈路径，见 `recoverPending`）
 *
 * 🔴 决策 A（P1-D §二）：`settling` 与 `error` 必须是两个不同状态。
 *   把「回调延迟」报成「支付校验失败」= 用户已扣款却看到失败，最伤信任的一类 bug。
 * 🔴 决策 B：客户端回传的任何凭证都**不作为信任依据**；本文件压根不上传凭证，
 *   权益全靠服务端推送/查单落地，客户端只做「查询 + 刷新展示」。
 *
 * ## 🔴 signData 原样透传（最易翻车处）
 *
 * 服务端返回的 `signData` 是**已序列化的字符串**，双签名（paySig / signature）
 * 是对这个字符串的**逐字节**结果。前端一旦 `JSON.parse` 再 `JSON.stringify`，
 * 字段顺序或空格可能变化 → 签名失配 → `-15005 / -15006`。
 * 官方文档亦明确「该参数需以 string 形式传递」。故本文件只透传，绝不解析。
 *
 * ## 安全边界
 *
 * AppKey / session_key / EncodingAESKey 全在服务端，客户端只拿到**一次性签名结果**。
 * 本文件不含任何密钥，也不打印 signData 之外的支付细节（signData 内含我方订单号
 * 与价格，属可展示信息，不含密钥）。
 */
import Taro from '@tarojs/taro'
import { PRODUCT_IDS, type ProductId } from '@dbee/shared'
// 🔴 endpoint 取自 publicConfig 而非 cloud 实例：SDK 的 WorkBuddyCloud 类型
//   并未承诺暴露 endpoint 字段（只有构造入参有），读它属未定义行为；
//   publicConfig 是 cloud.ts 的单一真相源，与 backend.ts 的解析结果同源。
import { cloud, publicConfig } from './cloud'
import { kvGet, kvSet } from './kv'
import { errText } from './errmsg'

/** 虚拟支付接口最低基础库版本（官方文档：2.19.2 起支持） */
const MIN_SDK_VERSION = '2.19.2'

/** 待核销订单本地持久化键（推送丢失时的自愈入口） */
const PENDING_KEY = 'xpay.pendingOrders'

/** 待核销订单最长保留期（ms）。超过即认为服务端已对账完或订单作废，清掉避免无限堆积。 */
const PENDING_TTL_MS = 7 * 24 * 3600 * 1000

/** 网关支付端点前缀（与 server/lib/app.mjs 的 `W` 常量一致） */
const XPAY_BASE = '/.cloud/payment/wechat'

/** 轮询节奏：1.5s × 4 ≈ 6s 窗口（P1-D §二-A 的建议值，与主端 checkout 同口径） */
const POLL_INTERVAL_MS = 1500
const POLL_ATTEMPTS = 4

/** 单次网关请求超时（ms）。查单会外呼微信，给足余量但不拖住 UI。 */
const HTTP_TIMEOUT_MS = 12_000

/* ── wx 最小接口（鸭子类型，避免引入完整平台类型包，同 bootReport.ts 风格）── */

interface VirtualPaymentFail {
  errMsg?: string
  errCode?: number
}

interface WxLike {
  requestVirtualPayment?: (opts: {
    signData: string
    paySig: string
    signature: string
    mode: string
    success?: (res: unknown) => void
    fail?: (err: VirtualPaymentFail) => void
    complete?: () => void
  }) => void
  canIUse?: (schema: string) => boolean
  getSystemInfoSync?: () => Record<string, unknown>
}

function getWx(): WxLike | null {
  try {
    const w = (globalThis as unknown as { wx?: WxLike }).wx
    return w && typeof w === 'object' ? w : null
  } catch {
    return null
  }
}

/**
 * 语义化版本比较（官方示例代码同款实现）。
 * @returns 1 = v1 更新，-1 = v1 更旧，0 = 相同；任一入参非字符串返回 0。
 */
export function compareVersion(v1: unknown, v2: unknown): number {
  if (typeof v1 !== 'string' || typeof v2 !== 'string') return 0
  const a = v1.split('.')
  const b = v2.split('.')
  const len = Math.max(a.length, b.length)
  while (a.length < len) a.push('0')
  while (b.length < len) b.push('0')
  for (let i = 0; i < len; i++) {
    const n1 = parseInt(a[i], 10)
    const n2 = parseInt(b[i], 10)
    if (n1 > n2) return 1
    if (n1 < n2) return -1
  }
  return 0
}

/**
 * 当前宿主是否具备虚拟支付能力。
 *
 * 判定顺序照官方建议：基础库 ≥ 2.19.2 **或** `canIUse('requestVirtualPayment')`。
 * 两个条件取「或」而非「与」—— 官方原文即如此，因为 canIUse 在部分版本上
 * 比 SDKVersion 字符串更可靠（宿主可能回填了能力但不改版本号）。
 *
 * 非微信端（支付宝 / 抖音小程序）恒 false：虚拟支付是微信专属能力。
 */
export function isXpaySupported(): boolean {
  if (process.env.TARO_ENV !== 'weapp') return false
  const wx = getWx()
  if (!wx) return false
  // 最终防线：接口不存在就一定不能调（低版本 + canIUse 都判不出时的兜底）
  if (typeof wx.requestVirtualPayment !== 'function') return false

  let sdkVersion = ''
  try {
    const info = wx.getSystemInfoSync?.()
    const v = info?.SDKVersion
    if (typeof v === 'string') sdkVersion = v
  } catch {
    sdkVersion = '' // 读不到版本号不影响判定，交给 canIUse
  }
  if (compareVersion(sdkVersion, MIN_SDK_VERSION) >= 0) return true

  try {
    return wx.canIUse?.('requestVirtualPayment') === true
  } catch {
    return false
  }
}

/* ── 网关调用（Taro.request；小程序无标准 fetch）────────────────────── */

/** 网关 CloudError 形状（server/lib/http.mjs cloudError） */
interface GatewayErrorBody {
  message?: string
  error?: string
}

class GatewayError extends Error {
  /** HTTP 状态码（0 = 网络层失败） */
  readonly status: number
  /** 服务端错误码（如 session_key_expired / xpay_not_configured） */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function accessToken(): Promise<string> {
  try {
    const { data } = await cloud.auth.getSession()
    return data?.accessToken ?? ''
  } catch {
    return ''
  }
}

/**
 * 调网关支付端点。
 * @throws GatewayError（4xx/5xx 或网络异常均转成它，调用方按 code/status 分流）
 */
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = await accessToken()
  if (!token) throw new GatewayError(401, 'unauthorized', '未登录或登录已过期')

  let res: Taro.request.SuccessCallbackResult<GatewayErrorBody | T>
  try {
    res = await Taro.request<GatewayErrorBody | T>({
      url: `${publicConfig.endpoint}${path}`,
      method: 'POST',
      timeout: HTTP_TIMEOUT_MS,
      header: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      data: body,
    })
  } catch (e) {
    // 网络层失败（DNS / 超时 / 域名未加白名单）→ status 0，与业务拒绝区分开
    throw new GatewayError(0, 'network', errText(e, '网络连接失败，请检查网络后重试'))
  }

  const status = res?.statusCode ?? 0
  if (status >= 200 && status < 300) return res.data as T

  const errBody = (res?.data ?? {}) as GatewayErrorBody
  throw new GatewayError(
    status,
    typeof errBody.error === 'string' && errBody.error ? errBody.error : 'http_error',
    typeof errBody.message === 'string' && errBody.message ? errBody.message : `请求失败（${status}）`,
  )
}

/* ── 服务端契约类型 ─────────────────────────────────────────────────── */

/** `POST /params` 的成功返回（server/lib/xpay.mjs）。导出供单测引用（tools/mini-xpay.test.ts）。 */
export interface XpayParams {
  mode: string
  /** 🔴 字符串，原样透传给 wx.requestVirtualPayment，禁止 parse 后重新 stringify */
  signData: string
  paySig: string
  signature: string
  env: number
  /** 订单已支付过时服务端返回此标记（幂等友好，不再产生新支付） */
  already_paid?: boolean
}

/** `POST /query` 的返回（server/lib/xpay.mjs）。导出供单测引用。 */
export interface XpayQueryResult {
  settled?: boolean
  paid?: boolean
  settling?: boolean
  refunded?: boolean
  retry_later?: boolean
  plan?: string
  code?: string
}

/* ── 购买结果（对齐主端 src/lib/payment/types.ts 的 CheckoutResult 语义）── */

export type XpayPurchaseResult =
  | { status: 'ok' }
  | { status: 'cancelled' }
  /** 🔴 已扣款但权益未确认（推送延迟/丢失）—— 绝不是 error，见文件头决策 A */
  | { status: 'settling'; message: string }
  | { status: 'error'; message: string }
  /** 能力不可用（低版本基础库 / 非微信端 / 服务端凭据未配） */
  | { status: 'unsupported'; message: string }

/** 权益到账后的刷新回调（调用方重拉 entitlement） */
export type OnGranted = () => Promise<void> | void

/* ── 错误码 → 可读文案（官方 errCode 表逐条对齐）────────────────────── */

/**
 * 把 `wx.requestVirtualPayment` 的 fail 回调翻译成用户能懂的话。
 *
 * 🔴 三类必须区别对待，不能一律「支付失败」：
 *   · **-2 = 用户主动取消** → 静默，不弹错误（正常行为，弹错误像出 bug）
 *   · **-15007 = session_key 过期** → 引导重新登录（重登会刷新 session_key）
 *   · **平台配置类（-15008/-15009/-15010/-15014/-15018）** → 明确说「暂不可用」，
 *     不引导用户反复重试（重试也不会好，是我方后台道具没发布/未生效）
 */
export function xpayFailMessage(errCode: number | undefined, errMsg: string | undefined): string {
  switch (errCode) {
    case -2:
      return '' // 取消：空串表示「不提示」
    case -1:
      return '支付未完成，请重试'
    case -4:
      return '本次支付被风控拦截，请稍后再试或联系客服'
    case -5:
      return '支付结果未知，请稍后在「会员与订阅」中刷新权益确认'
    case 1001:
    case -15001:
      return '支付参数有误，请稍后重试'
    case -15002:
      return '该订单已被使用，请重新发起购买'
    case -15003:
      return '微信支付系统繁忙，请稍后重试'
    case -15004:
      return '币种不支持，请联系客服'
    case -15005:
      return '支付校验失败（用户态签名），请重新登录后再试'
    case -15006:
      return '支付校验失败（支付签名），请稍后重试'
    case -15007:
      return '登录状态已过期，请重新登录后再购买'
    case -15008:
      return '支付通道尚未开通，暂时无法购买'
    case -15009:
      return '商品尚未上架，暂时无法购买'
    case -15010:
      return '该档位尚未上架，暂时无法购买'
    case -15011:
      return '当前版本不支持该支付环境，请更新小程序后重试'
    case -15012:
      return '支付通道繁忙，请重新发起购买'
    case -15013:
      return '价格校验失败，请更新小程序后重试'
    case -15014:
      return '商品刚刚上架，请约 10 分钟后再试'
    case -15016:
      return '支付参数格式有误，请更新小程序后重试'
    case -15017:
    case -15019:
      return '收款功能受限，暂时无法购买，请联系客服'
    case -15020:
    case -15021:
      return '操作过快，请稍候再试'
    case -15018:
      return '该档位审核未通过，暂时无法购买'
    default:
      // 未知错误码：带上原始码便于用户反馈时定位（errMsg 可能含平台内部信息，
      // 只截断展示，不整段抛给用户）
      return errCode != null
        ? `支付失败（错误码 ${errCode}）`
        : (errMsg ? String(errMsg).slice(0, 60) : '支付失败，请重试')
  }
}

/** 取消判定：errCode=-2，或部分宿主只回 errMsg（含 cancel 字样） */
function isCancel(errCode: number | undefined, errMsg: string | undefined): boolean {
  if (errCode === -2) return true
  return /cancel|取消/i.test(errMsg ?? '')
}

/* ── 待核销订单持久化（推送丢失时的自愈路径）────────────────────────── */

interface PendingOrder {
  orderNo: string
  productId: string
  ts: number
}

/**
 * 串行写队列：并发保存不会互相覆盖。
 * （对齐主端 checkout.ts:86-95 的同一思路 —— 读-改-写非原子，并发会丢单）
 */
let writeQueue: Promise<void> = Promise.resolve()

async function readPending(): Promise<PendingOrder[]> {
  try {
    const raw = await kvGet(PENDING_KEY, '')
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    const now = Date.now()
    return list.filter(
      (x): x is PendingOrder =>
        !!x && typeof x === 'object' &&
        typeof (x as PendingOrder).orderNo === 'string' &&
        now - Number((x as PendingOrder).ts ?? 0) < PENDING_TTL_MS,
    )
  } catch {
    return [] // 本地数据损坏不影响主流程：清空重来，权益仍可由服务端查单找回
  }
}

function savePending(order: PendingOrder): Promise<void> {
  const task = writeQueue.then(async () => {
    const list = await readPending()
    if (list.some((x) => x.orderNo === order.orderNo)) return
    list.push(order)
    // 只留最近 20 笔，防止极端情况下无限增长占满 Storage
    const trimmed = list.slice(-20)
    await kvSet(PENDING_KEY, JSON.stringify(trimmed))
  }, async () => { /* 前一次失败不阻断本次 */ })
  writeQueue = task.catch(() => undefined)
  return task
}

async function removePending(orderNo: string): Promise<void> {
  const task = writeQueue.then(async () => {
    const list = await readPending()
    const next = list.filter((x) => x.orderNo !== orderNo)
    if (next.length === list.length) return
    await kvSet(PENDING_KEY, JSON.stringify(next))
  }, async () => { /* 同上 */ })
  writeQueue = task.catch(() => undefined)
  return task
}

/* ── wx.requestVirtualPayment 的 Promise 包装 ───────────────────────── */

/**
 * 拉起虚拟支付收银台。
 *
 * 🔴 **官方明确「以 Promise 风格调用：不支持」**，必须用 success/fail 回调，
 *   这里手工包一层 Promise（不能直接 `await Taro.requestVirtualPayment(...)`）。
 *
 * @param params 服务端 `/params` 的原样返回（signData 是字符串，绝不重新序列化）
 * @returns `true` = 扣款成功；`false` = 用户取消
 * @throws Error（其余失败；message 已是可读文案）
 */
export function requestVirtualPayment(params: XpayParams): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const wx = getWx()
    if (!wx || typeof wx.requestVirtualPayment !== 'function') {
      reject(new Error('当前微信版本不支持虚拟支付，请更新微信后重试'))
      return
    }
    try {
      wx.requestVirtualPayment({
        // 🔴 原样透传：signData 是服务端序列化好的字符串，
        //   parse+stringify 会改变字段顺序导致 -15005/-15006 验签失败。
        signData: params.signData,
        paySig: params.paySig,
        signature: params.signature,
        mode: params.mode || 'short_series_goods',
        success: () => resolve(true),
        fail: (err) => {
          const code = err?.errCode
          const msg = err?.errMsg
          if (isCancel(code, msg)) {
            resolve(false)
            return
          }
          reject(new Error(xpayFailMessage(code, msg)))
        },
      })
    } catch (e) {
      // 接口抛同步异常（参数校验失败等）：转成可读错误，不让它冒成未处理异常
      reject(new Error(errText(e, '拉起支付失败，请重试')))
    }
  })
}

/* ── 查单轮询（权益到账的唯一客户端确认路径）────────────────────────── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询服务端查单，直到权益到账或用尽重试次数。
 *
 * 🔴 **本函数保证不 reject**（对齐主端 checkout.ts 的恢复函数契约）：
 *   查单是「尽力而为」的确认动作，任何失败都不应把已成功的支付报成失败。
 *
 * @param reconcile 是否强制外呼对账。前端支付后轮询**不要**传 true ——
 *   服务端对 paid 订单默认提前返回，省 access_token 配额并避开 268490015 频率限制。
 * @returns true = 权益已到账
 */
export async function pollUntilSettled(orderNo: string, attempts = POLL_ATTEMPTS): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(POLL_INTERVAL_MS)
    try {
      const r = await post<XpayQueryResult>(`${XPAY_BASE}/query`, { order_no: orderNo })
      if (r?.settled === true) return true
      // retry_later / settling / paid 但未 settled → 继续等（推送在路上）
      // refunded → 终态，不必再轮（理论上刚支付不会退款，防御性处理）
      if (r?.refunded === true) return false
    } catch {
      // 单次查单失败不终止轮询：网络抖动很常见，服务端推送仍是权威信号
    }
  }
  return false
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

/**
 * 购买一个档位（完整闭环）。
 *
 * @param productId 档位键（`ProductId`：proMonthly / proYearly / lifetime）
 * @param onGranted 权益到账后的刷新回调（重拉 entitlement）
 */
export async function buyProduct(productId: ProductId, onGranted?: OnGranted): Promise<XpayPurchaseResult> {
  if (!isXpaySupported()) {
    return {
      status: 'unsupported',
      message: '当前微信版本不支持虚拟支付，请更新微信后重试；也可在 iOS App 内购买。',
    }
  }

  const realProductId = PRODUCT_IDS[productId]
  if (!realProductId) return { status: 'error', message: '商品不存在' }

  let orderNo = ''
  try {
    // ① 下单：provider 固定 wechat_xpay —— 0046 的 verify_payment_order 按此值
    //   走「查单语义」分支；写 'wechat' 会落到「V3 商户号验签」分支（未实现，恒 false）。
    const order = await createOrder(realProductId)
    orderNo = order.orderNo

    // ② 取签名参数（服务端用 session_key 现算，客户端不接触任何密钥）
    const params = await post<XpayParams>(`${XPAY_BASE}/params`, {
      order_no: orderNo,
      appid: currentAppId(),
    })

    // 已支付过的订单：不再拉起收银台（微信同单号重复下单会 -15002）
    if (params?.already_paid === true) {
      await removePending(orderNo)
      await safeGrant(onGranted)
      return { status: 'ok' }
    }
    if (!params?.signData || !params?.paySig || !params?.signature) {
      return { status: 'error', message: '支付参数不完整，请稍后重试' }
    }

    // ③ 拉起收银台
    const paid = await requestVirtualPayment(params)
    if (!paid) return { status: 'cancelled' }

    // ④ 已扣款：先持久化订单号，再轮询确认。
    //   🔴 顺序不能反 —— 若先轮询、期间小程序被杀（iOS 上支付回来常被回收），
    //   订单号就丢了，只能靠用户手动联系客服。落盘后再轮询，重启可自愈。
    await savePending({ orderNo, productId: realProductId, ts: Date.now() })

    const settled = await pollUntilSettled(orderNo)
    if (settled) {
      await removePending(orderNo)
      await safeGrant(onGranted)
      return { status: 'ok' }
    }

    // ⑤ 窗口内未到账：settling，绝不报 error（文件头决策 A）
    return {
      status: 'settling',
      message: '支付已完成，会员权益正在到账（通常 1 分钟内）。若稍后仍未生效，请到「会员与订阅」点「刷新权益」，或重启小程序。',
    }
  } catch (e) {
    if (e instanceof GatewayError) {
      // 服务端明确拒绝：按 code 给可操作提示，而不是笼统「支付失败」
      if (e.code === 'session_key_expired' || e.status === 409) {
        return { status: 'error', message: '登录状态已过期，请重新登录后再购买' }
      }
      if (e.code === 'xpay_not_configured' || e.status === 503) {
        return { status: 'unsupported', message: '支付通道暂未开放，请稍后再试或使用兑换码解锁' }
      }
      if (e.code === 'unauthorized' || e.status === 401) {
        return { status: 'error', message: '请先登录后再购买' }
      }
      if (e.status === 0) {
        return { status: 'error', message: e.message }
      }
      return { status: 'error', message: e.message }
    }
    return { status: 'error', message: errText(e, '支付失败，请重试') }
  }
}

/** 下单（走数据库 RPC，服务端查价） */
async function createOrder(realProductId: string): Promise<{ orderNo: string }> {
  const { createPaymentOrder } = await import('./api')
  const order = await createPaymentOrder(realProductId, 'wechat_xpay')
  if (!order?.order_no) throw new Error('创建订单失败，请重试')
  return { orderNo: order.order_no }
}

/** 刷新权益失败不影响「已到账」这个事实（下次进页面会再读） */
async function safeGrant(onGranted?: OnGranted): Promise<void> {
  if (!onGranted) return
  try {
    await onGranted()
  } catch {
    // 刻意吞掉：权益已落库，把成功支付报成失败是更严重的错误
  }
}

/** 当前小程序 appid（session_key 与 appid 绑定，服务端要校验一致） */
function currentAppId(): string {
  try {
    const info = Taro.getAccountInfoSync()
    return info?.miniProgram?.appId ?? ''
  } catch {
    return ''
  }
}

/* ── 启动 / 进付费墙时的自愈恢复 ───────────────────────────────────── */

/**
 * 恢复所有待核销订单：逐笔查单，到账即刷新权益并清除本地记录。
 *
 * 触发时机：进入付费墙、App 启动登录后。这是「推送丢失 + 用户没等轮询完就退出」
 * 场景下用户拿回权益的**唯一**客户端路径（服务端另有对账兜底，但客户端
 * 主动查一次能让用户当场看到结果，而不是等运维脚本）。
 *
 * 🔴 **保证不 reject**（对齐主端 processRecovery 的契约）：恢复属尽力而为的
 *   后台补偿，任何失败都不应打断正常使用。
 *
 * @returns 本次成功到账的笔数（>0 时调用方应刷新权益展示）
 */
export async function recoverPending(onGranted?: OnGranted): Promise<number> {
  try {
    const list = await readPending()
    if (list.length === 0) return 0

    let succeeded = 0
    for (const p of list) {
      try {
        // 只查一次不轮询：恢复场景无需在 UI 上等 6 秒，查不到就留着下次再试
        const r = await post<XpayQueryResult>(`${XPAY_BASE}/query`, { order_no: p.orderNo })
        if (r?.settled === true) {
          succeeded++
          await removePending(p.orderNo)
        } else if (r?.refunded === true) {
          // 已退款是终态：清掉本地记录，不再反复查（权益由服务端 revoke 回收）
          await removePending(p.orderNo)
        }
      } catch {
        // 单笔失败不影响其余（网络抖动 / 服务端 5xx）
      }
    }
    if (succeeded > 0) await safeGrant(onGranted)
    return succeeded
  } catch {
    return 0
  }
}

/** 是否存在待核销订单（付费墙可据此提示「有一笔支付正在到账」） */
export async function hasPendingOrder(): Promise<boolean> {
  return (await readPending()).length > 0
}
