import { useEffect, useState } from 'react'
import { IconCrown, IconGift } from '../components/Icons'
import { Sheet } from '../components/Sheet'
import type { DocId } from '../content/legal'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  FREE_HONEY_PRO_ITEM,
  FREE_NO_ADS_ITEM,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
  PRODUCTS,
  priceTag,
  proNoticeText,
  type ProductId,
} from '../lib/entitlement'
import { REDEEM_CODE_RULE } from '../lib/validate'
import { usePlan } from '../state/plan'
import { errText } from '../lib/errmsg'
import { checkout, getAdapter, restorePurchases, type PayProvider } from '../lib/payment/checkout'
import { openManageSubscriptions } from '../lib/manageSubscription'
import { isAlipayAvailable } from '../lib/payment/alipay'
import { isWechatPayAvailable } from '../lib/payment/wechatPay'
import { isIOS } from '../lib/platform'

/**
 * 付费墙。
 * 三档：免费 / Pro（月·年订阅）/ 终身买断。
 * 支付渠道（2026-10-25 拍板）：
 *   · iOS      → App 内购（StoreKit 2，点商品直接内购）
 *   · Android/Web → 微信支付 + 支付宝（先选商品，再选支付方式）
 * 权益写入云端 entitlements，换设备同样生效。资质未就绪时 checkout 诚实降级提示。
 */

const FREE_ITEMS = [
  `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别（识别成功才扣次数）`,
  `积分可再兑换拍照识别，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（50 积分/次）`,
  FREE_HONEY_PRO_ITEM,
  '扫条码不限次数永久免费',
  '文字描述识别、手动录入、体重饮水运动记录全部免费',
  'AI 问答不限次数（每分钟限 3 次防刷）',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  '连续打卡 7 天再送拍照次数',
  FREE_NO_ADS_ITEM,
]
// 🔴 「完善资料再送拍照次数」删去（2026-11-03，P2-D 同步小程序端 P0-C 结论）：
//   完善资料实际发的是**蜜糖积分**而非识别次数 —— src/state/plan.tsx:185
//   `grantHoney('newbie', 'newbie', NEWBIE_BONUS_AMOUNT, ...)`，代码注释原文
//   「发蜜糖积分，不再发识别次数」。全仓 `grantPhotoBonus(` 仅 'streak7' 一处调用，
//   签名里的 'newbie' 分支从无调用方。原文案属虚假承诺，且小程序端已于 P0-C
//   （commit 07a46ca）删除同一句，此处为主端漏改导致的四端文案分叉。
//   新手积分本身已由上面「积分可再兑换拍照识别」一条如实覆盖。

const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  'AI 问答不限流',
  '长文本 AI 复盘（本期解读）无限次',
  '个性化完整膳食计划、长期 AI 膳食规划',
  '宏量营养素深度分析',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天 + 数据导出`,
]

// 🔴 此处曾有一份硬编码的 PRICE_TAG（{ proMonthly: '¥18 / 月', ... }），2026-11-03 删除：
//   它与 shared 的 PRICE_* 常量、PRODUCTS[].price 构成**三份互相独立的价格副本**，
//   改价必漏改。现统一走 @dbee/shared 的 priceTag(p) 从 PRODUCTS 生成，价格只剩
//   PRICE_* 一个真相源。回归测试见 tools/price-single-source.test.ts。
//   ⚠️ 注意 priceTag 只在 Android/Web 分支使用；iOS 分支仍只用 App Store 拉到的
//   真实价（见下方渲染注释），绝不回退到本地生成的价格文案 —— 商店价才是唯一合法成交价。

export function PaywallSheet({ onOpenLegal }: { onOpenLegal: (id: DocId) => void }) {
  const { paywall, closePaywall, redeem, pro, lifetime, entitlement, refresh } = usePlan()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [hint, setHint] = useState('')
  const [ok, setOk] = useState(false)
  // 正在支付的商品 id（null 表示无进行中支付）
  const [payingId, setPayingId] = useState<string | null>(null)
  // 正在支付的渠道（与 payingId 配套，用于区分微信/支付宝两个按钮的 spinner）
  const [payingProvider, setPayingProvider] = useState<PayProvider | null>(null)
  // Android/Web：用户选中的商品 id（先选商品，再选微信/支付宝支付方式）；iOS 无此概念
  const [selectedId, setSelectedId] = useState<ProductId | null>(null)
  // 商店本地化价格（iOS 打开付费墙时经 DbeeIap.getProducts 拉取）；
  // key = ProductId（'proMonthly' 等），value = 本地化价格文案（如 "¥18.00"）。
  const [storePrice, setStorePrice] = useState<Record<string, string>>({})
  // iOS 商品价格状态（HIG / App Store 3.1.2）：
  //   loading → 拉取中；ok → 用商店真实价格；error → 拉取失败。
  // 拉取失败时**禁止购买**而不是回退硬编码价：商店价才是唯一合法成交价，
  // 展示一个与实际扣款不一致的静态价既误导用户，也可能被审核认定为价格欺诈。
  const [iosPriceState, setIosPriceState] = useState<'loading' | 'ok' | 'error'>('loading')

  /**
   * 🔴 微信/支付宝通道**能力探测**（2026-11-06 修「可见但不可用」）。
   *
   * 此前按钮无条件渲染，点下去必返「当前平台暂不支持在线支付或支付组件需要升级」。
   * 根因不是资质没到位，而是 **web 端根本没有支付通道**：
   *   · `getPlugin()` 读 `window.Capacitor.Plugins.CapacitorWechat`，而 web 端
   *     `isNative()` 恒 false、`window.Capacitor` 不存在 → adapter 恒 null；
   *   · `@capgo/capacitor-wechat` 的 package.json 只声明 `{ios, android}`，**无 web 实现**；
   *   · 支付宝侧同理，且 `package.json` 连 alipay 插件依赖都没有。
   * `isWechatPayAvailable()` / `isAlipayAvailable()` 本来就为此而写，却全仓 0 处调用。
   *
   * 用**能力探测**而非 `isWeb()` 平台判断：资质就绪后 Android 插件装上，同一份代码
   * 自动恢复按钮，无需再改这里（架构铁律 #1：运行时探测，不写死平台分支）。
   * 每次打开付费墙重算一次 —— 插件注册在 Capacitor 启动时完成，打开时必然已稳定。
   */
  const [payChannels, setPayChannels] = useState({ wechat: false, alipay: false })
  useEffect(() => {
    if (!paywall.open || isIOS()) return
    setPayChannels({ wechat: isWechatPayAvailable(), alipay: isAlipayAvailable() })
  }, [paywall.open])
  const noPayChannel = !isIOS() && !payChannels.wechat && !payChannels.alipay

  // 付费墙每次打开时重置选中商品，避免上一次的选择残留高亮
  useEffect(() => {
    if (paywall.open) {
      setSelectedId(null)
      setErr('')
      setHint('')
    }
  }, [paywall.open])

  // iOS：付费墙每次打开时拉一次商店价格。失败则禁用购买（见 iosPriceState 注释）。
  // priceNonce 变化即重新拉取，供「重试」按钮使用（网络抖动/商店短暂不可用时可自救）。
  const [priceNonce, setPriceNonce] = useState(0)
  useEffect(() => {
    if (!paywall.open || !isIOS()) return
    let cancelled = false
    setIosPriceState('loading')
    setStorePrice({})
    void (async () => {
      try {
        const adapter = await getAdapter()
        // 插件不可用同样算失败：iOS 上没有内购通道，购买按钮必须禁用
        if (!adapter) {
          if (!cancelled) setIosPriceState('error')
          return
        }
        const products = await adapter.fetchProducts()
        if (cancelled) return
        if (products.length === 0) {
          setIosPriceState('error')
          return
        }
        const map: Record<string, string> = {}
        for (const p of products) map[p.productId] = p.price
        // 商店没返回全部在架商品时也视为失败，避免某个档位显示不出真实价格
        const missing = PRODUCTS.filter((p) => !map[p.id])
        if (missing.length > 0) {
          setIosPriceState('error')
          return
        }
        setStorePrice(map)
        setIosPriceState('ok')
      } catch {
        if (!cancelled) setIosPriceState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [paywall.open, priceNonce])

  // iOS 上商店价格未就绪 = 不允许发起购买（避免按硬编码价误导用户后实际扣款不符）
  const iosBlocked = isIOS() && iosPriceState !== 'ok'

  if (!paywall.open) return null

  /** 点击支付：iOS 走内购，Android/Web 走微信/支付宝，均由 checkout 统一分发 */
  async function buyProduct(id: ProductId, provider: PayProvider) {
    setErr('')
    setHint('')
    setPayingId(id)
    setPayingProvider(provider)
    try {
      const res = await checkout(id, provider, refresh)
      if (res.status === 'cancelled') {
        // 用户取消，静默返回，不报错
        return
      }
      if (res.status === 'error') {
        setErr(res.message)
        return
      }
      if (res.status === 'pending' || res.status === 'pending_settlement') {
        setHint(res.message)
        return
      }
      // 购买成功：刷新后关闭付费墙
      setOk(true)
      setTimeout(() => {
        closePaywall()
        setOk(false)
      }, 1400)
    } catch (e) {
      setErr(errText(e, '支付失败，请重试'))
    } finally {
      setPayingId(null)
      setPayingProvider(null)
    }
  }

  /** 恢复购买（仅 iOS 订阅） */
  async function restore() {
    setErr('')
    setHint('')
    setBusy(true)
    try {
      const res = await restorePurchases(refresh)
      if (res.status === 'error') {
        setErr(res.message)
        return
      }
      if (res.status === 'pending_settlement') {
        setHint(res.message)
        return
      }
      setOk(true)
      setTimeout(() => {
        closePaywall()
        setOk(false)
      }, 1400)
    } catch (e) {
      setErr(errText(e, '恢复购买失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  /** 管理订阅（仅 iOS，3.1.2）：跳系统订阅管理页，可查看/取消全部订阅 */
  async function manageSubscriptions() {
    setErr('')
    setHint('')
    const done = await openManageSubscriptions()
    if (!done) {
      setErr('无法打开订阅管理页，请在 iPhone「设置 → 你的头像 → 订阅」中管理。')
    }
  }

  async function submitCode() {
    if (!code.trim()) return
    setBusy(true)
    setErr('')
    try {
      const res = await redeem(code)
      if (res === 'bad') {
        setErr('兑换码不对，检查一下大小写和连字符。')
        return
      }
      if (res === 'used') {
        setErr('该兑换码已被使用。')
        return
      }
      setOk(true)
      setTimeout(() => {
        closePaywall()
        setOk(false)
        setCode('')
      }, 1400)
    } catch (e) {
      setErr(errText(e, '兑换失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const title = lifetime ? 'D-Bee 终身会员' : pro ? 'D-Bee Pro' : '升级 D-Bee'

  return (
    <Sheet title={title} onClose={closePaywall}>
      {paywall.reason && <div className="notice info">{paywall.reason}</div>}
      {hint && <div className="notice info">{hint}</div>}
      {pro && (
        <div className="notice ok">
          {/* 2026-11-03 四端一致性：整句收到 shared proNoticeText，与小程序端共用同一实现。
              此前这里直接 new Date(pro_until).toLocaleDateString('zh-CN')，输出取决于各端
              JS 引擎的 ICU/locale 数据（web/iOS/Android 与微信小程序并不同步），
              同一到期日可能给出不同文案。 */}
          {lifetime ? '你已是终身会员，全部功能永久解锁。' : proNoticeText(entitlement?.pro_until)}
        </div>
      )}

      {/* 三档权益对比 */}
      <div className="pay-card pay-card-pro">
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

      {/* 「管理订阅」入口（iOS 3.1.2 硬要求）。
          🔴 刻意放在 {!pro && ...} 之外 = iOS 端**无论是否会员都渲染**：
          审核员用的是演示账户（非订阅态），入口若只对会员可见，审核员看不到 = 仍判缺失。 */}
      {isIOS() && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: '100%', marginTop: 12, fontSize: 13 }}
          disabled={busy}
          onClick={() => void manageSubscriptions()}
        >
          管理订阅
        </button>
      )}

      {!pro && (
        <>
          {/* iOS 商店价格未就绪：明确告知并提供重试，禁止以硬编码价发起购买 */}
          {isIOS() && iosPriceState === 'error' && (
            <div className="notice err" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flex: 1 }}>暂时无法获取 App Store 商品价格，请检查网络后重试。</span>
              <button type="button" className="btn-text" style={{ flexShrink: 0 }} onClick={() => setPriceNonce((n) => n + 1)}>
                重试
              </button>
            </div>
          )}
          {/* 🔴 无可用支付通道（web 端现状）：如实告知，不再让用户点了才知道失败。
              引导两条真实可行的路：去 App 内开通，或用兑换码（下方入口始终可用）。 */}
          {noPayChannel && (
            <div className="notice info" style={{ marginTop: 14 }}>
              网页版暂不支持在线支付。你可以在 iOS / Android App 内开通会员，
              或在下方输入兑换码解锁（同样立即生效）。
            </div>
          )}
          {/* 商品选择：iOS 点商品直接内购；Android/Web 先选中商品，再在下方选微信/支付宝 */}
          <div className="pay-grid" style={{ marginTop: 18 }}>
            {PRODUCTS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pay-option ${p.highlight ? 'is-hl' : ''} ${!isIOS() && selectedId === p.id ? 'is-sel' : ''}`}
                disabled={payingId !== null || busy || iosBlocked || noPayChannel}
                aria-disabled={payingId !== null || busy || iosBlocked || noPayChannel}
                onClick={() => {
                  if (iosBlocked || noPayChannel) return
                  if (isIOS()) {
                    void buyProduct(p.id, 'apple')
                  } else {
                    setSelectedId(p.id)
                    setErr('')
                  }
                }}
              >
                <div className="pay-option-name">{p.name}</div>
                <div className="pay-option-price">
                  {isIOS() && payingId === p.id ? (
                    <span className="spinner" />
                  ) : isIOS() ? (
                    // iOS 只显示商店真实价：加载中显示占位，失败显示「—」，绝不回退硬编码价
                    iosPriceState === 'ok' ? storePrice[p.id] : iosPriceState === 'loading' ? '获取中…' : '—'
                  ) : (
                    priceTag(p)
                  )}
                </div>
                {p.highlight && <div className="pay-option-tag">最划算</div>}
              </button>
            ))}
          </div>

          {/* 订阅信息摘要（App Store 3.1.2(c) + Developer Program License Agreement Schedule 2 硬要求）：
              订阅前须清楚展示——订阅时长与价格、到期前 24 小时自动续订扣款、取消路径。
              价格以商店拉取的真实价为准（iosPriceState==='ok' 时引用），拉不到就不展示具体数字，
              与「绝不回退硬编码价」的护栏保持一致。 */}
          {isIOS() && (
            <div className="card" style={{ marginTop: 14, padding: '12px 14px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>订阅说明</div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
                · 月订阅：每 1 个月一期；年订阅：每 12 个月一期
                {iosPriceState === 'ok' && (
                  <>
                    ，价格分别为 {storePrice['proMonthly']} 与 {storePrice['proYearly']}（以 App Store 实际显示为准）
                  </>
                )}
                <br />
                · 确认购买后将从你的 Apple ID 账户扣款；订阅到期前 24 小时内自动续订并按当前周期价格扣款，除非你在到期 24 小时前关闭自动续订
                <br />
                · 取消路径：iPhone「设置 → 你的头像 → 订阅」，或本页面「管理订阅」按钮；取消后当前周期内权益仍可使用
                <br />
                · 终身买断为一次性购买，不含自动续订，权益永久有效
              </div>
            </div>
          )}

          {/* Android/Web：选中商品后出现支付方式（微信 + 支付宝，2026-10-25 拍板）。
              🔴 逐渠道能力探测：只渲染真正可用的通道，避免「按钮在但必失败」。
              web 端两渠道均不可用 → 整块不渲染，由上方 noPayChannel 提示接管。 */}
          {!isIOS() && selectedId && (payChannels.wechat || payChannels.alipay) && (
            <div className="pay-methods" style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              {payChannels.wechat && (
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  disabled={payingId !== null || busy}
                  onClick={() => void buyProduct(selectedId, 'wechat')}
                >
                  {payingProvider === 'wechat' && payingId === selectedId ? <span className="spinner" /> : '微信支付'}
                </button>
              )}
              {payChannels.alipay && (
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  disabled={payingId !== null || busy}
                  onClick={() => void buyProduct(selectedId, 'alipay')}
                >
                  {payingProvider === 'alipay' && payingId === selectedId ? <span className="spinner" /> : '支付宝'}
                </button>
              )}
            </div>
          )}

          {/* iOS 恢复购买（订阅制必需，否则 3.1.2 被拒） */}
          {isIOS() && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: '100%', marginTop: 12, fontSize: 13 }}
              disabled={busy || payingId !== null}
              onClick={() => void restore()}
            >
              {busy ? <span className="spinner" /> : '恢复购买'}
            </button>
          )}

          {/* 兑换码输入（仅 web/Android）：iOS 下隐藏，避免 Apple 3.1.1 认定绕过 IAP。
              蜂蜜兑换（邀请中心）不受影响，那是 earned 积分，属 3.1.1 允许的虚拟货币。 */}
          {!isIOS() && (
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="redeem">兑换码</label>
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  id="redeem"
                  placeholder="输入兑换码"
                  maxLength={REDEEM_CODE_RULE.max}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    setErr('')
                  }}
                  autoCapitalize="characters"
                />
                <button
                  className="btn btn-ghost"
                  style={{ width: 96, flexShrink: 0, fontSize: 14 }}
                  disabled={busy || !code.trim()}
                  onClick={submitCode}
                >
                  {busy ? <span className="spinner" /> : <><IconGift size={16} /> 兑换</>}
                </button>
              </div>
              {err && <div className="err">{err}</div>}
              {ok && <div className="ok-msg">购买成功，会员已生效 🐝</div>}
            </div>
          )}

          {/* 法律链接（3.1.2 硬要求：付费墙内须含《使用条款》《隐私政策》） */}
          <div className="helper" style={{ marginTop: 14, lineHeight: 1.7, fontSize: 12.5 }}>
            购买即表示你同意
            <button
              type="button"
              className="btn-text"
              onClick={() => onOpenLegal('terms')}
            >
              《使用条款》
            </button>
            与
            <button
              type="button"
              className="btn-text"
              onClick={() => onOpenLegal('privacy')}
            >
              《隐私政策》
            </button>
            。订阅可随时在系统设置中取消。
          </div>

          {/* 透明定价承诺：对标 Cal AI 动态定价/试用陷阱的差异化武器 */}
          <div className="card" style={{ marginTop: 14, background: 'var(--honey-soft, #FAEEDA)', border: 'none', padding: '12px 14px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--honey-dark)', marginBottom: 6 }}>我们的承诺</div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
              · 统一定价，对所有人一样，永不杀熟<br />
              · 订阅可随时取消，无隐藏扣费、无自动续费陷阱<br />
              · 免费版永久可用，不逼你付费
            </div>
          </div>
        </>
      )}
    </Sheet>
  )
}
