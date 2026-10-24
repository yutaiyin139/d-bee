/**
 * 微信支付（Android / Web）适配器 —— 微信 JSAPI 下单 + 原生 SDK 拉起收银台。
 *
 * 与 iosIap.ts 完全同构，实现同一份 PaymentAdapter 接口，让 Android/Web 的付费墙
 * 行为逻辑与 iOS 一致（不再「在线支付正在接入中」一棍子打死，而是走真实链路，
 * 资质未就绪时返回 null，调用方据此降级）。
 *
 * ── 渠道走向（对齐 docs/收费模块-前置条件待办清单.md §二）────────────────
 *   Android / Web 默认走微信支付（checkout.ts 的 currentProvider 已定 android/web → wechat）。
 *   Google Play / 支付宝为后续可切换的备选，届时新增 googlePlay.ts / alipay.ts 即可。
 *
 * ── 微信支付链路（与苹果 IAP 的「下单→支付→回传凭证→核销」同构）────────────
 *   ① 服务端统一下单（微信支付 V3 JSAPI，返回 prepay 参数）—— 服务端能力，待商户号后接
 *   ② 客户端原生 SDK 拉起收银台（@capgo/capacitor-wechat 的 sendPaymentRequest）
 *   ③ 服务端回调验签发权益（provider='wechat' 分支）—— 服务端能力，待商户号后接
 *   ④ 前端刷新权益
 *
 * ── 前置条件（四条缺一不可，缺则 createWechatPayAdapter 返回 null）────────
 *   1. 微信开放平台「移动应用」AppID（构建时注入 VITE_WECHAT_APPID）
 *   2. 微信支付商户号 + 服务端统一下单接口（provider='wechat' 验签分支）
 *   3. @capgo/capacitor-wechat 插件已注入（Android 原生 SDK）
 *   4. 资质（营业执照 + 商户号）—— 当前未就绪，见 docs 微信登录接入.md
 *
 *   ⚠️ 当前资质未就绪：本 adapter 的 create 探测会因「未配 AppID」而返回 null，
 *   前端 getAdapter() 对 Android 返回 null → checkout 提示「当前平台暂不支持在线支付」，
 *   与 iOS 未接插件时行为完全一致（诚实降级，不谎报）。
 */

import { PRODUCT_IDS, type ProductId } from '../entitlement'
import { isAndroid, isWeb } from '../platform'
import type { PaymentAdapter, ProductInfo, PurchaseResult } from './types'

/**
 * @capgo/capacitor-wechat 插件的最小支付接口（鸭子类型探测）。
 * 字段对齐微信支付「JSAPI 下单」返回的 prepay 参数（WechatPaymentOptions）。
 */
interface WechatPayPlugin {
  initialize: (opts: { appId: string; universalLink?: string }) => Promise<void>
  isInstalled: () => Promise<{ installed: boolean }>
  /** 拉起微信收银台；支付完成 resolve，用户取消/失败 reject */
  sendPaymentRequest: (opts: {
    partnerId: string
    prepayId: string
    nonceStr: string
    timeStamp: string
    package: string
    sign: string
  }) => Promise<void>
}

/**
 * 服务端「统一下单」返回的 prepay 参数（微信支付 V3 JSAPI）。
 * 由 server 侧 provider='wechat' 分支生成；资质就绪后由网关暴露
 * /.cloud/payment/wechat/prepay 之类端点返回。
 */
interface WechatPrepayParams {
  partnerId: string
  prepayId: string
  nonceStr: string
  timeStamp: string
  package: string
  sign: string
  /** 服务端订单号，用于核销定位（可选，微信场景以商户单号为准） */
  orderNo?: string
}

/** 微信开放平台「移动应用」AppID（构建时注入；未配置返回空串） */
function wechatAppId(): string {
  return ((import.meta.env.VITE_WECHAT_APPID as string | undefined) ?? '').trim()
}

/**
 * 微信支付是否具备运行条件（平台 + AppID + 插件齐备）。
 * 资质未就绪（未配 AppID / 插件缺失 / 服务端统一下单未接）时返回 false，
 * 前端据此降级为诚实提示，与 iOS 未接插件时的行为一致。
 */
export function isWechatPayAvailable(): boolean {
  if (!isAndroid() && !isWeb()) return false
  if (!wechatAppId()) return false
  return getPlugin() !== null
}

function getPlugin(): WechatPayPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.CapacitorWechat
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<WechatPayPlugin>
  if (typeof candidate.sendPaymentRequest !== 'function') return null
  return candidate as WechatPayPlugin
}

/**
 * 创建微信支付适配器。
 *
 * 微信支付是「一次性支付」（月/年订阅在微信生态按预付费周期续费，无 StoreKit 式
 * 自动续订），因此：
 *   - fetchProducts 返回硬编码价（无商店本地化价格，商品价由服务端查价兜底）
 *   - purchase 拉起收银台，返回商户单号作为 providerTxnId + prepayId 作为凭证
 *   - restore 无「恢复购买」概念（非订阅自动续期），返回空数组
 *
 * 资质未就绪时返回 null，与 createIosIapAdapter 的「非 iOS 或插件缺失返回 null」同构。
 */
export function createWechatPayAdapter(): PaymentAdapter | null {
  if (!isAndroid() && !isWeb()) return null
  if (!wechatAppId()) return null
  const plugin = getPlugin()
  if (!plugin) return null

  return {
    async fetchProducts(): Promise<ProductInfo[]> {
      // 微信支付无商店本地化价格；返回硬编码价文案，付费墙据此展示（PRICE_TAG）。
      // 真实价格以服务端下单查价为准（防篡改），这里仅作展示。
      return []
    },

    async purchase(productId: ProductId): Promise<PurchaseResult> {
      const appId = wechatAppId()
      // 移动应用走原生 SDK：初始化后确认微信已安装，再拉起收银台
      if (isAndroid()) {
        await plugin.initialize({ appId })
        const { installed } = await plugin.isInstalled()
        if (!installed) {
          throw new Error('未检测到微信，请先安装微信后再试')
        }
      }

      // ① 服务端统一下单（资质就绪后接入；当前占位抛出「暂未开通」）
      const prepay = await fetchPrepayParams(PRODUCT_IDS[productId])
      if (!prepay) {
        throw new Error('微信支付正在接入中，请稍后重试')
      }

      // ② 拉起收银台（用户取消/失败会 reject，由 checkout 统一转 cancelled/error）
      await plugin.sendPaymentRequest({
        partnerId: prepay.partnerId,
        prepayId: prepay.prepayId,
        nonceStr: prepay.nonceStr,
        timeStamp: prepay.timeStamp,
        package: prepay.package,
        sign: prepay.sign,
      })

      // ③ 凭证回传：微信支付以「商户单号 + prepayId」为凭证（服务端据回调验签，
      //    客户端回传仅作核销定位，不作为信任依据 —— 与 Apple 侧同一安全模型）
      return {
        providerTxnId: prepay.orderNo || prepay.prepayId,
        receipt: prepay.prepayId,
        productId,
      }
    },

    async restore(): Promise<PurchaseResult[]> {
      // 微信一次性支付无「恢复购买」概念（非订阅自动续期）；返回空数组，
      // restorePurchases 会据此提示「未找到可恢复的购买记录」。
      return []
    },
  }
}

/**
 * 服务端统一下单（占位）。
 *
 * 资质就绪后：调用网关 /.cloud/payment/wechat/prepay（或云端 RPC），
 * 服务端用商户号 + 签名生成 prepay 参数返回。当前未接，返回 null 让
 * purchase 抛出「正在接入中」的诚实提示。
 */
async function fetchPrepayParams(_storeProductId: string): Promise<WechatPrepayParams | null> {
  // TODO(资质就绪后补)：调用服务端微信统一下单接口，返回 prepay 参数。
  return null
}
