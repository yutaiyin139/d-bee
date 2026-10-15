import { useState } from 'react'
import { IconCrown, IconGift } from '../components/Icons'
import { Sheet } from '../components/Sheet'
import {
  FREE_DAILY_AI,
  FREE_INSIGHT_PER_WEEK,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
  PRODUCTS,
} from '../lib/entitlement'
import { usePlan } from '../state/plan'

/**
 * 付费墙。
 * 三档：免费 / Pro（月·年订阅）/ 终身买断。
 * 真实支付（微信 / 支付宝 / App 内购）待企业资质就绪后接入；当前用兑换码解锁，
 * 权益写入云端 entitlements，换设备同样生效。界面上对这一点明确告知。
 */

const FREE_ITEMS = [
  `每日 ${FREE_DAILY_AI} 次 AI 拍照识别`,
  '文字描述、扫条码、手动录入、体重饮水运动记录全部免费',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  `AI 周解读每 ${FREE_INSIGHT_PER_WEEK} 次`,
  '连续打卡 7 天、完善资料再送拍照次数',
]

const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天 + 数据导出`,
  'AI 周解读不限次',
  '后续新功能优先体验',
]

const PRICE_TAG: Record<string, string> = {
  proMonthly: '¥18 / 月',
  proYearly: '¥128 / 年（约 ¥10.7/月）',
  lifetime: '¥328 永久',
}

export function PaywallSheet() {
  const { paywall, closePaywall, redeem, pro, lifetime, entitlement } = usePlan()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)

  if (!paywall.open) return null

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
      setOk(true)
      setTimeout(() => {
        closePaywall()
        setOk(false)
        setCode('')
      }, 1400)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '兑换失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const title = lifetime ? 'D-Bee 终身会员' : pro ? 'D-Bee Pro' : '升级 D-Bee'

  return (
    <Sheet title={title} onClose={closePaywall}>
      {paywall.reason && <div className="notice info">{paywall.reason}</div>}
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
          {/* 商品选择（真实支付接入前为展示，点击提示「接入中」） */}
          <div className="pay-grid" style={{ marginTop: 18 }}>
            {PRODUCTS.map((p) => (
              <div key={p.id} className={`pay-option ${p.highlight ? 'is-hl' : ''}`}>
                <div className="pay-option-name">{p.name}</div>
                <div className="pay-option-price">{PRICE_TAG[p.id]}</div>
                {p.highlight && <div className="pay-option-tag">最划算</div>}
              </div>
            ))}
          </div>

          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="redeem">兑换码</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                id="redeem"
                placeholder="例如 DBEE-PRO-2026"
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
            {ok && <div className="ok-msg">兑换成功，终身会员已生效 🐝</div>}
          </div>

          <div className="helper" style={{ lineHeight: 1.7 }}>
            在线支付（微信 / 支付宝 / 应用商店内购）正在接入中，上线前可先用兑换码体验完整功能。
          </div>
        </>
      )}
    </Sheet>
  )
}
