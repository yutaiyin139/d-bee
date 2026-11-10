import {
  APP_DOWNLOAD_LINK,
  APP_DOWNLOAD_QR,
  MINI_APP_NAME,
  MINI_ORDER_LINK,
  MINI_ORDER_QR,
  WEB_NO_CHARGE_TEXT,
  canGuideToAppSale,
  canGuideToMiniSale,
} from '../lib/miniOrderGuide'

/**
 * 「网页不收款」+「去微信端 / App 端下单」引导区块（2026-11-09 扩为双渠道）。
 *
 * 付费墙（`pages/PaywallSheet.tsx`）与公开定价页（`pages/PricingSheet.tsx`）共用本组件，
 * 保证两处口径**逐字相同** —— 法务文案与页面展示不一致是微信/商店审核的驳回项，
 * 也是《广告法》第 4 条风险，不允许靠两份相似代码互相承诺。
 *
 * 🔴 2026-11-09 用户定案：**Web 暂不收费**，靠引导到微信端 + App 端完成商业闭环；
 *    四端业务逻辑（定价 / 权益 / 免费额度 / 口径 / 数据面）一律不变。
 *    本组件只做**导流**，不创建订单、不收款、不调任何支付能力（护栏 18 + 20）。
 *
 * ## 两条渠道独立门控（见 lib/miniOrderGuide.ts）
 *
 * · `canGuideToMiniSale()` ← `D_BEE_XPAY_ENABLED`：微信端虚拟支付是否开放；
 * · `canGuideToAppSale()`  ← `D_BEE_APPPAY_ENABLED`：App 端 APP 支付是否开放。
 *   后者与 **Android 付费墙的支付按钮同源同值**（同一条 vite define），所以
 *   绝不可能出现「Web 引导去 App，进去却买不了」的情形。
 *
 * · 两者皆 false（默认）：只渲染不收款声明 + 兑换码提示，**零处引导字样**。
 * · 任一为 true：追加对应渠道引导，并按已配置凭证择一渲染二维码 / https 链接；
 *   两者都未配置时退化为「搜索名称」纯文字，🔴 **绝不渲染点了没反应的死按钮**。
 *
 * @param showRedeemHint 是否附带兑换码提示。付费墙内为 true（下方就是兑换码输入框）；
 *                       公开定价页为 false（该页没有兑换码入口，提了就是指向不存在的功能）。
 */
export function MiniOrderGuide({ showRedeemHint = false }: { showRedeemHint?: boolean }) {
  const guide = canGuideToMiniSale()
  const guideApp = canGuideToAppSale()

  return (
    <div className="notice info" style={{ marginTop: 14 }}>
      <div>{WEB_NO_CHARGE_TEXT}</div>

      {guide && (
        <>
          <div style={{ marginTop: 8 }}>
            如需购买会员，请在微信小程序「{MINI_APP_NAME}」内完成下单；
            实际可购档位与成交价格以小程序内展示为准。
          </div>
          {MINI_ORDER_QR && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <img
                src={MINI_ORDER_QR}
                alt={`${MINI_APP_NAME}小程序码`}
                style={{ width: 132, height: 132, borderRadius: 8, flexShrink: 0 }}
              />
              <span style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                用微信「扫一扫」打开小程序，进入后选择档位下单。
              </span>
            </div>
          )}
          {MINI_ORDER_LINK && (
            <a
              className="btn"
              href={MINI_ORDER_LINK}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: 10 }}
            >
              在手机微信中打开小程序下单
            </a>
          )}
          {!MINI_ORDER_QR && !MINI_ORDER_LINK && (
            <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
              在微信中搜索小程序「{MINI_APP_NAME}」，进入后选择档位下单。
            </div>
          )}
        </>
      )}

      {/* App 端渠道：与 Android 付费墙支付按钮同源同值，故引导必定指向可成交的 App */}
      {guideApp && (
        <>
          <div style={{ marginTop: 8 }}>
            如需购买会员，也可在「{MINI_APP_NAME}」App 内完成下单；
            实际可购档位与成交价格以 App 内展示为准。
          </div>
          {APP_DOWNLOAD_QR && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <img
                src={APP_DOWNLOAD_QR}
                alt={`${MINI_APP_NAME} App 下载二维码`}
                style={{ width: 132, height: 132, borderRadius: 8, flexShrink: 0 }}
              />
              <span style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                扫码下载 App，安装后进入会员页选择档位下单。
              </span>
            </div>
          )}
          {APP_DOWNLOAD_LINK && (
            <a
              className="btn"
              href={APP_DOWNLOAD_LINK}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: 10 }}
            >
              下载 App 并购买
            </a>
          )}
          {!APP_DOWNLOAD_QR && !APP_DOWNLOAD_LINK && (
            <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
              在应用商店搜索「{MINI_APP_NAME}」下载 App，进入后选择档位下单。
            </div>
          )}
        </>
      )}

      {showRedeemHint && (
        <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
          {/* 🔴 「免费获得」是 P1-E 合规红线：兑换码若变成付费取得（买码 / 加客服微信开通），
              等于绕开虚拟支付通道收款，属小米/华为下架级风险，绝不可改措辞。 */}
          也可在下方输入兑换码解锁（兑换码由邀请、活动等渠道免费获得，同样立即生效）。
        </div>
      )}
    </div>
  )
}
