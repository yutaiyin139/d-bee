/**
 * App 端第三方支付（微信 APP 支付 / 支付宝 App 支付）的网关客户端。
 *
 * 2026-11-09 用户定案：Android 必须能收款，Web 暂不收费只做引导，
 * **四端业务逻辑不变** —— 所以本文件不定义任何价格 / 权益 / 档位规则，
 * 只负责把 checkout 已经建好的那笔 `order_no` 送去做平台预下单，
 * 以及在支付完成后向网关确认「这笔单是否已发权益」。
 *
 * ── 端点契约（server/lib/apppay.mjs）──────────────────────────────────
 *   POST {endpoint}/.cloud/payment/apppay/prepay
 *     Bearer = 会话 access_token；body { order_no, product_id, provider }
 *     200 { order_no, provider, prepay: <平台参数> }
 *     503 = 商户号/证书/env 未配齐（诚实降级，绝不说「支付成功」）
 *   POST {endpoint}/.cloud/payment/apppay/query
 *     Bearer；body { order_no }
 *     200 { settled: boolean, status: 'pending'|'paid'|'refunded'|'cancelled' }
 *     服务端会**主动外呼平台查单**并在确认付款后立即补发权益（拉模式兜底）。
 *
 * ── 🔴 为什么 query 必须带有限重试 ────────────────────────────────────
 *   平台异步回调可能比 SDK 返回晚几秒。若一次查到 pending 就报 error，
 *   用户会看到「支付校验失败」但钱已经扣了 —— 这是资损级 UX 事故
 *   （xpay 侧同一条铁律：已扣款未确认 → settling，绝不报 error）。
 *   `checkout.ts` 的核销流程保持不变，故把等待收敛在本客户端内。
 */

import { cloud } from '../../cloud'
import { publicConfig } from '../../cloudConfig'
import { createNativeFetch } from '../originProxy'

export type AppPayProvider = 'wechat' | 'alipay'

/** 微信支付 V3「APP 下单」返回、客户端二次签名后的拉起参数 */
export interface WechatAppPrepay {
  partnerId: string
  prepayId: string
  nonceStr: string
  timeStamp: string
  package: string
  sign: string
}

/** 支付宝「App 支付」SDK payV2 所需的完整 orderStr */
export interface AlipayAppPrepay {
  orderStr: string
}

export type AppPrepay =
  | { provider: 'wechat'; orderNo: string; wechat: WechatAppPrepay }
  | { provider: 'alipay'; orderNo: string; alipay: AlipayAppPrepay }

interface GatewayResponse {
  ok: boolean
  status: number
  data: Record<string, unknown> | null
}

/** 查单兜底：间隔与次数与 mini 侧 xpay 的 settling 窗口同口径 */
const QUERY_ATTEMPTS = 4
const QUERY_INTERVAL_MS = 1500

async function gatewayPost(path: string, body: unknown): Promise<GatewayResponse> {
  const { data: session } = await cloud.auth.getSession()
  const accessToken = session?.accessToken
  if (!accessToken) throw new Error('请先登录，再购买会员')

  // 原生端 WebView 的 fetch 会被 CORS/Origin 校验拦住，须走 originProxy
  // 插件在原生层转发（与 cloud.ts 注入 SDK 的同一实现）；Web 端返回
  // undefined → 用全局 fetch（同源经 nginx，无跨域）。
  const doFetch = createNativeFetch() ?? fetch
  const resp = await doFetch(`${publicConfig.endpoint}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  const data = (await resp.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: resp.ok, status: resp.status, data }
}

function errorMessage(r: GatewayResponse, fallback: string): string {
  if (r.status === 503) return '支付服务尚未开通，请稍后重试'
  const msg = r.data?.message
  return typeof msg === 'string' && msg.trim() ? msg : fallback
}

/** 严格校验预下单响应，畸形结构一律当作失败，绝不把 undefined 传给原生 SDK。 */
function parsePrepay(r: GatewayResponse): AppPrepay {
  if (!r.ok || !r.data) throw new Error(errorMessage(r, '创建支付订单失败'))
  const orderNo = r.data.order_no
  const provider = r.data.provider
  const prepay = r.data.prepay
  if (typeof orderNo !== 'string' || !orderNo) throw new Error('支付响应缺少订单号')
  if (!prepay || typeof prepay !== 'object') throw new Error('支付响应缺少预下单参数')

  if (provider === 'alipay') {
    const p = prepay as Record<string, unknown>
    if (typeof p.orderStr !== 'string' || !p.orderStr) throw new Error('支付宝预下单参数不完整')
    return { provider: 'alipay', orderNo, alipay: { orderStr: p.orderStr } }
  }
  if (provider === 'wechat') {
    const p = prepay as Record<string, unknown>
    const keys = ['partnerId', 'prepayId', 'nonceStr', 'timeStamp', 'package', 'sign'] as const
    for (const k of keys) {
      if (typeof p[k] !== 'string' || !p[k]) throw new Error('微信预下单参数不完整')
    }
    return {
      provider: 'wechat',
      orderNo,
      wechat: {
        partnerId: p.partnerId as string,
        prepayId: p.prepayId as string,
        nonceStr: p.nonceStr as string,
        timeStamp: p.timeStamp as string,
        package: p.package as string,
        sign: p.sign as string,
      },
    }
  }
  throw new Error('支付响应的渠道类型无法识别')
}

/**
 * 向网关请求平台预下单。**复用 checkout 已创建的 order_no**（不另建单）。
 * 金额由服务端查 `payment_products` 决定，客户端传的 product_id 只用于校验归属。
 */
export async function requestAppPrepay(args: {
  orderNo: string
  productId: string
  provider: AppPayProvider
}): Promise<AppPrepay> {
  return parsePrepay(
    await gatewayPost('/.cloud/payment/apppay/prepay', {
      order_no: args.orderNo,
      product_id: args.productId,
      provider: args.provider,
    }),
  )
}

/**
 * 确认订单是否已发权益（供 `api.ts` 的 Android 核销分支调用）。
 *
 * 服务端每次被调都会：① 查本单状态；② 若仍 pending 就外呼平台查单，
 * 平台确认已付款则立即补发权益。故这里做有限重试即可覆盖回调延迟，
 * **不需要改 checkout.ts 的核销流程**（四端业务逻辑不变）。
 *
 * 返回值语义与 iOS 的 `verifyViaGateway` 完全对齐：
 *   · true / false —— 网关明确给出结果，调用方直接采信、不回退 RPC；
 *   · null —— 网关通道本身不可用（404/405 = 旧网关；503 = 支付 env 未配齐；
 *     网络异常），调用方回退数据库 RPC 保持旧行为。
 */
export async function verifyViaApppayGateway(orderNo: string): Promise<boolean | null> {
  for (let i = 0; i < QUERY_ATTEMPTS; i += 1) {
    let r: GatewayResponse
    try {
      r = await gatewayPost('/.cloud/payment/apppay/query', { order_no: orderNo })
    } catch {
      // 网络层异常（插件缺失 / DNS / 超时）→ 回退 RPC，不让支付因通道问题硬失败
      return null
    }
    if (r.status === 404 || r.status === 405 || r.status === 503) return null
    if (!r.ok) return false // 网关明确拒绝（402 验签失败 / 409 重放等）

    const settled = r.data?.settled === true
    const status = r.data?.status
    // 已确认付款（或订单已关闭/退款）→ 立即定论，不再等待
    if (settled || status === 'cancelled' || status === 'refunded') return settled
    if (i < QUERY_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, QUERY_INTERVAL_MS))
    }
  }
  // 窗口内回调始终未到：如实返回 false（上层提示「支付校验失败，请稍后重试」），
  // 但服务端订单与平台流水都还在，下次「恢复购买」/ 启动补单会继续核销。
  return false
}
