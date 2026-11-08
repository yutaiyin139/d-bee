import {
  MINI_APP_NAME,
  MINI_ORDER_LINK,
  MINI_ORDER_QR,
  WEB_NO_CHARGE_TEXT,
  canGuideToMiniSale,
} from '../lib/miniOrderGuide'

/**
 * 「网页不收款」+「去微信小程序下单」引导区块。
 *
 * 付费墙（`pages/PaywallSheet.tsx`）与公开定价页（`pages/PricingSheet.tsx`）共用本组件，
 * 保证两处口径**逐字相同** —— 法务文案与页面展示不一致是微信/商店审核的驳回项，
 * 也是《广告法》第 4 条风险，不允许靠两份相似代码互相承诺。
 *
 * ## 两种形态（由构建期开关决定，见 lib/miniOrderGuide.ts）
 *
 * · `XPAY_SALE_ENABLED === false`（默认）：只渲染不收款声明 + 兑换码提示，
 *   **零处「下单/购买/小程序」引导字样** —— 与 mini 默认「免费提供、不销售任何商品」
 *   的公示保持一致。此时引导用户去小程序会撞上一个买不到东西的入口。
 * · `XPAY_SALE_ENABLED === true`：追加「在微信小程序内下单」引导，并按已配置的凭证
 *   择一渲染小程序码图片或 URL Link；两者都未配置时退化为「微信内搜索小程序名」文字，
 *   🔴 **绝不渲染点了没反应的死按钮**（那属于诱导性 UI）。
 *
 * @param showRedeemHint 是否附带兑换码提示。付费墙内为 true（下方就是兑换码输入框）；
 *                       公开定价页为 false（该页没有兑换码入口，提了就是指向不存在的功能）。
 */
export function MiniOrderGuide({ showRedeemHint = false }: { showRedeemHint?: boolean }) {
  const guide = canGuideToMiniSale()

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
