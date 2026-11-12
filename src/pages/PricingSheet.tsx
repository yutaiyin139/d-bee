import { IconCrown } from '../components/Icons'
import { Sheet } from '../components/Sheet'
import { MiniOrderGuide } from '../components/MiniOrderGuide'
import { FREE_ITEMS, PRO_ITEMS } from '../content/membership'
import { TransparencyNotes } from '../components/TransparencyNotes'
import { FULL_RECORDING_CAPS, PRODUCTS, priceTag, quotaNotes } from '../lib/entitlement'

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
 *    没有购买按钮，也不调 `createPaymentOrder`。当前 Web 仅持 ICP **备案**
 *    （非经营性），据《互联网信息服务管理办法》第 11 条不得从事有偿服务。
 *    🔴 2026-11-09 用户定案：**Web 暂不收费，以「引导到微信端 + App 端购买」闭环**，
 *    这推翻了同日「办妥 ICP 经营许可证后本页可改为可购买」的改判 —— 不新增 Web
 *    收款能力、不启动 Web 支付通道、不为此办证，护栏 18 的「Web 零收款」语义
 *    继续有效。渠道隔离仍是硬约束（小程序运营规范 2.5.13 / 2.14.7 禁止引导至
 *    网站成交），本页引导只做导流，见 `docs/Web引导闭环与Android收款实装-2026-11-09.md`。
 * 2. **价格零副本**：三档价格一律走 `PRODUCTS` + `priceTag(p)`（真相源
 *    `@dbee/shared` 的 `PRICE_*`），权益清单走 `content/membership.ts`。
 *    护栏 `tools/web-no-payment.test.ts` 会扫本页是否出现写死的 `¥数字`。
 * 3. **引导口径与付费墙逐字相同**：「网页不收款 / 是否引导去小程序」由
 *    `components/MiniOrderGuide.tsx` 统一渲染，本页不自己拼一句话。
 *    售卖开关默认关闭时，本页与付费墙一样**零处「下单/购买」引导**。
 *
 * ## 当前不做的两件事（随实装/上架可解，非产品克制）
 *
 * · **不放兑换码输入框**：未登录状态下兑换无处落账，放了就是指向不存在的能力。
 *   故 `MiniOrderGuide` 传 `showRedeemHint={false}`（付费墙内才提示兑换码）。
 * · **不无条件写「也可在 iOS / Android App 内开通」**：iOS 尚未上架、
 *   Android 尚未开放收款时，对 Web 访客承诺一个装不到/买不了的渠道属引人误解表述。
 *   现由 `canGuideToAppSale()`（与 Android 支付按钮同源）门控，App 真能收款了才
 *   通过共用组件 `MiniOrderGuide` 如实给出；微信端同理受 `canGuideToMiniSale()` 门控。
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

      {/* P1.5：次数怎么算。文案真源在 @dbee/shared，Web / 原生端为全能力端。
          与官网 features.html 的「次数怎么算」逐字同源，避免站内/站外口径漂移。 */}
      <TransparencyNotes title="次数怎么算" notes={quotaNotes(FULL_RECORDING_CAPS)} />

      {/* 网页不收款声明 + （售卖开关开启时的）小程序下单引导，与付费墙同一实现 */}
      <MiniOrderGuide showRedeemHint={false} />

      <div className="helper" style={{ marginTop: 12, lineHeight: 1.7, fontSize: 12.5 }}>
        本页价格为统一定价，对所有用户一致，不因人定价。实际可购渠道与成交价格以对应购买页面展示为准。
      </div>
    </Sheet>
  )
}
