import { useEffect, useState } from 'react'
import { IconCrown, IconGift } from '../components/Icons'
import { Sheet } from '../components/Sheet'
import type { DocId } from '../content/legal'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
  PRODUCTS,
  type ProductId,
} from '../lib/entitlement'
import { REDEEM_CODE_RULE } from '../lib/validate'
import { usePlan } from '../state/plan'
import { errText } from '../lib/errmsg'
import { checkout, getAdapter, restorePurchases, type PayProvider } from '../lib/payment/checkout'
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
  '扫条码不限次数永久免费',
  '文字描述识别、手动录入、体重饮水运动记录全部免费',
  'AI 问答不限次数（每分钟限 3 次防刷）',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  '连续打卡 7 天、完善资料再送拍照次数',
]

const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  'AI 问答不限流',
  '长文本 AI 复盘（本期解读）无限次',
  '个性化完整膳食计划、长期 AI 膳食规划',
  '宏量营养素深度分析',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天 + 数据导出`,
]

const PRICE_TAG: Record<string, string> = {
  proMonthly: '¥18 / 月',
  proYearly: '¥128 / 年（约 ¥10.7/月）',
  lifetime: '¥298 永久',
}

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
          {lifetime
            ? '你已是终身会员，全部功能永久解锁。'
            : entitlement?.pro_until
              ? `你已是 Pro 会员，有效期至 ${new Date(entitlement.pro_until).toLocaleDateString('zh-CN')}。`
              : '你已是 Pro 会员，所有功能已解锁。'}
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
          {/* 商品选择：iOS 点商品直接内购；Android/Web 先选中商品，再在下方选微信/支付宝 */}
          <div className="pay-grid" style={{ marginTop: 18 }}>
            {PRODUCTS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pay-option ${p.highlight ? 'is-hl' : ''} ${!isIOS() && selectedId === p.id ? 'is-sel' : ''}`}
                disabled={payingId !== null || busy || iosBlocked}
                aria-disabled={payingId !== null || busy || iosBlocked}
                onClick={() => {
                  if (iosBlocked) return
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
                    PRICE_TAG[p.id]
                  )}
                </div>
                {p.highlight && <div className="pay-option-tag">最划算</div>}
              </button>
            ))}
          </div>

          {/* Android/Web：选中商品后出现支付方式（微信 + 支付宝，2026-10-25 拍板） */}
          {!isIOS() && selectedId && (
            <div className="pay-methods" style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                type="button"
                className="btn"
                style={{ flex: 1 }}
                disabled={payingId !== null || busy}
                onClick={() => void buyProduct(selectedId, 'wechat')}
              >
                {payingProvider === 'wechat' && payingId === selectedId ? <span className="spinner" /> : '微信支付'}
              </button>
              <button
                type="button"
                className="btn"
                style={{ flex: 1 }}
                disabled={payingId !== null || busy}
                onClick={() => void buyProduct(selectedId, 'alipay')}
              >
                {payingProvider === 'alipay' && payingId === selectedId ? <span className="spinner" /> : '支付宝'}
              </button>
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
