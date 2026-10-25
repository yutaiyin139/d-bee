/**
 * 支付宝（Android / Web）适配器 —— 支付宝 App 支付 SDK 拉起收银台。
 *
 * 与 iosIap.ts / wechatPay.ts 完全同构，实现同一份 PaymentAdapter 接口，
 * 让 Android/Web 的付费墙行为逻辑与 iOS 一致（资质未就绪时返回 null，调用方据此降级）。
 *
 * ── 渠道走向（2026-10-25 拍板）──────────────────────────────────────────
 *   Android / Web 支持「微信 + 支付宝」双渠道；本文件是支付宝分支。
 *   checkout.ts 的 getAdapter('alipay') 会路由到这里。
 *
 * ── 支付宝链路（与苹果 IAP 的「下单→支付→回传凭证→核销」同构）────────────
 *   ① 服务端统一下单（支付宝 App 支付 / 手机网站支付，返回 orderStr）—— 服务端能力，待商户号后接
 *   ② 客户端原生 SDK 拉起收银台（支付宝 SDK 的 payV2(orderStr)）
 *   ③ 服务端异步通知验签发权益（provider='alipay' 分支）—— 服务端能力，待商户号后接
 *   ④ 前端刷新权益
 *
 * ── 前置条件（缺则 createAlipayAdapter 返回 null）───────────────────────
 *   1. 支付宝开放平台「移动应用」AppID（构建时注入 VITE_ALIPAY_APPID）
 *   2. 支付宝商户号（企业主体）+ 服务端统一下单接口（provider='alipay' 验签分支）
 *   3. Capacitor 支付宝插件已注入（Android 原生 SDK）
 *   4. 资质（营业执照 + 对公账户）—— 对公账户下周三开，之后才能签支付宝企业应用
 *
 *   ⚠️ 当前资质未就绪：本 adapter 的 create 探测会因「未配 AppID」而返回 null，
 *   前端据此降级为诚实提示，与 iOS / 微信未接插件时的行为完全一致。
 */

import { PRODUCT_IDS, type ProductId } from '../entitlement'
import { isAndroid, isWeb } from '../platform'
import type { PaymentAdapter, ProductInfo, PurchaseResult } from './types'

/**
 * Capacitor 支付宝插件的最小支付接口（鸭子类型探测）。
 * 字段对齐支付宝 SDK「App 支付」返回形态：
 *   resultStatus: '9000' 支付成功 | '8000' 处理中 | '6001' 用户取消 | '4000' 失败
 */
interface AlipayPlugin {
  pay: (opts: { orderStr: string }) => Promise<{ resultStatus: string; result: string; memo: string }>
}

/**
 * 服务端「统一下单」返回的 orderStr（支付宝 App 支付）。
 * 由 server 侧 provider='alipay' 分支生成；资质就绪后由网关暴露
 * /.cloud/payment/alipay/prepay 之类端点返回。
 */
interface AlipayPrepayParams {
  /** 支付宝 SDK 拉起收银台所需的完整 orderStr */
  orderStr: string
  /** 服务端订单号，用于核销定位 */
  orderNo: string
}

/** 支付宝开放平台「移动应用」AppID（构建时注入；未配置返回空串） */
function alipayAppId(): string {
  return ((import.meta.env.VITE_ALIPAY_APPID as string | undefined) ?? '').trim()
}

function getPlugin(): AlipayPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.CapacitorAlipay
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<AlipayPlugin>
  if (typeof candidate.pay !== 'function') return null
  return candidate as AlipayPlugin
}

/**
 * 支付宝是否具备运行条件（平台 + AppID + 插件齐备）。
 * 资质未就绪（未配 AppID / 插件缺失 / 服务端统一下单未接）时返回 false。
 */
export function isAlipayAvailable(): boolean {
  if (!isAndroid() && !isWeb()) return false
  if (!alipayAppId()) return false
  return getPlugin() !== null
}

/**
 * 创建支付宝适配器。
 *
 * 支付宝是「一次性支付」（月/年订阅按预付费周期续费，无 StoreKit 式自动续订）：
 *   - fetchProducts 返回空（无商店本地化价格，商品价由服务端下单查价兜底）
 *   - purchase 拉起收银台，返回支付宝交易号 trade_no 作为 providerTxnId
 *   - restore 无「恢复购买」概念，返回空数组
 *
 * 资质未就绪时返回 null，与 createWechatPayAdapter 同构。
 */
export function createAlipayAdapter(): PaymentAdapter | null {
  if (!isAndroid() && !isWeb()) return null
  if (!alipayAppId()) return null
  const plugin = getPlugin()
  if (!plugin) return null

  return {
    async fetchProducts(): Promise<ProductInfo[]> {
      // 支付宝无商店本地化价格；返回空，付费墙回退硬编码 PRICE_TAG。
      // 真实价格以服务端下单查价为准（防篡改），这里仅作展示。
      return []
    },

    async purchase(productId: ProductId): Promise<PurchaseResult> {
      // ① 服务端统一下单（资质就绪后接入；当前占位抛出「暂未开通」）
      const prepay = await fetchPrepayParams(PRODUCT_IDS[productId])
      if (!prepay) {
        throw new Error('支付宝支付正在接入中，请稍后重试')
      }

      // ② 拉起收银台（用户取消/失败会 reject，由 checkout 统一转 cancelled/error）
      const res = await plugin.pay({ orderStr: prepay.orderStr })

      // resultStatus: 9000 成功 / 8000 处理中 / 6001 用户取消 / 4000 失败
      if (res.resultStatus === '6001') {
        throw new Error('取消支付')
      }
      if (res.resultStatus !== '9000') {
        throw new Error(`支付宝支付未完成（${res.resultStatus || '未知状态'}）`)
      }

      // ③ 凭证回传：支付宝以「商户订单号 + trade_no」为凭证（服务端据异步通知验签，
      //    客户端回传仅作核销定位，不作为信任依据 —— 与 Apple / 微信同一安全模型）
      return {
        providerTxnId: prepay.orderNo,
        receipt: res.result || '',
        productId,
      }
    },

    async restore(): Promise<PurchaseResult[]> {
      // 支付宝一次性支付无「恢复购买」概念（非订阅自动续期）；返回空数组，
      // restorePurchases 会据此提示「未找到可恢复的购买记录」。
      return []
    },
  }
}

/**
 * 服务端统一下单（占位）。
 *
 * 资质就绪后：调用网关 /.cloud/payment/alipay/prepay（或云端 RPC），
 * 服务端用商户号 + 签名生成 orderStr 返回。当前未接，返回 null 让
 * purchase 抛出「正在接入中」的诚实提示。
 */
async function fetchPrepayParams(_storeProductId: string): Promise<AlipayPrepayParams | null> {
  // TODO(资质就绪后补)：调用服务端支付宝统一下单接口，返回 orderStr。
  return null
}
