import { IconCrown } from '../components/Icons'
import { Sheet } from '../components/Sheet'
import { MiniOrderGuide } from '../components/MiniOrderGuide'
import { FREE_ITEMS, PRO_ITEMS } from '../content/membership'
import { PRODUCTS, priceTag } from '../lib/entitlement'

/**
 * 公开定价页（未登录也可见，2026-11-08）。
 *
 * ## 为什么需要它
 *
 * 此前三档价格**只在登录后的付费墙内**展示，未登录访客完全看不到 —— 差距清单 #1。
 * 价格公开是《价格法》第 13 条「明码标价」的基本要求，也是用户注册前做决策的前提；
 * 藏在登录后既不友好，也容易被审核/监管认为「诱导注册后才告知收费」。
 *
 * ## 🔴 本页三条硬边界（改动前必读）
 *
 * 1. **零收款、零下单、零创建订单**：本页不 import `lib/payment/checkout`，
 *    没有任何购买按钮，也不调 `createPaymentOrder`。Web 不提供在线支付是 ICP
 *    经营许可证绕行方案的基石（见 `docs/Web端定价展示与小程序下单-现状梳理与改造方案`）。
 * 2. **价格零副本**：三档价格一律走 `PRODUCTS` + `priceTag(p)`（真相源
 *    `@dbee/shared` 的 `PRICE_*`），权益清单走 `content/membership.ts`。
 *    护栏 `tools/web-no-payment.test.ts` 会扫本页是否出现写死的 `¥数字`。
 * 3. **引导口径与付费墙逐字相同**：「网页不收款 / 是否引导去小程序」由
 *    `components/MiniOrderGuide.tsx` 统一渲染，本页不自己拼一句话。
 *    售卖开关默认关闭时，本页与付费墙一样**零处「下单/购买」引导**。
 *
 * ## 刻意不做的两件事
 *
 * · **不放兑换码输入框**：未登录状态下兑换无处落账，放了就是指向不存在的能力。
 *   故 `MiniOrderGuide` 传 `showRedeemHint={false}`（付费墙内才提示兑换码）。
 * · **不写「也可在 iOS / Android App 内开通」**：iOS 尚未上架、Android 尚未分发，
 *   对 Web 访客承诺一个装不到的渠道同属引人误解的表述。购买渠道只由开关门控的
 *   小程序引导如实给出，其余以「实际可购渠道以对应购买页面展示为准」兜住。
 */
export function PricingSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="会员定价" onClose={onClose}>
      <div className="notice info">
        基础记录功能永久免费；会员为可选项，用于解锁更多 AI 识别次数与更长期限的饮食报告。
      </div>

      {/* 三档价格：纯展示卡片，🔴 刻意用 div 而非 button ——
          本页无任何支付能力，用可交互元素会暗示「点了能买」（诱导性 UI）。 */}
      <div className="pay-grid" style={{ marginTop: 14 }}>
        {PRODUCTS.map((p) => (
          <div key={p.id} className={`pay-option ${p.highlight ? 'is-hl' : ''}`} aria-disabled="true">
            <div className="pay-option-name">{p.name}</div>
            <div className="pay-option-price">{priceTag(p)}</div>
            {p.highlight && <div className="pay-option-tag">最划算</div>}
          </div>
        ))}
      </div>

      <div className="pay-card pay-card-pro" style={{ marginTop: 16 }}>
        <div className="pay-badge">
          <IconCrown color="#6b4a08" size={16} />
          Pro / 终身
        </div>
        {PRO_ITEMS.map((t) => (
          <div className="pay-line" key={t}>
            <span className="tick">✓</span>
            {t}
          </div>
        ))}
      </div>

      <div className="pay-card">
        <div className="pay-badge pay-badge-free">免费版</div>
        {FREE_ITEMS.map((t) => (
          <div className="pay-line muted" key={t}>
            <span className="tick">·</span>
            {t}
          </div>
        ))}
      </div>

      {/* 网页不收款声明 + （售卖开关开启时的）小程序下单引导，与付费墙同一实现 */}
      <MiniOrderGuide showRedeemHint={false} />

      <div className="helper" style={{ marginTop: 12, lineHeight: 1.7, fontSize: 12.5 }}>
        本页价格为统一定价，对所有用户一致，不因人定价。实际可购渠道与成交价格以对应购买页面展示为准。
      </div>
    </Sheet>
  )
}
