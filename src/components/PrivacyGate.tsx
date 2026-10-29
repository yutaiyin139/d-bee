import { useEffect, useState } from 'react'
import type { DocId } from '../content/legal'
import { SITE } from '../content/legal'
import { hasPrivacyConsent, peekPrivacyConsent, exitApp, grantPrivacyConsent } from '../lib/privacyConsent'
import { readLegalFromUrl, syncLegalUrl } from '../lib/legalRoute'
import { LegalPage } from '../pages/LegalPage'

/**
 * 首次启动隐私政策同意门（P0 合规）。
 *
 * 满足国内安卓商店的硬性四要素（华为/小米缺它直接拒审，OPPO 明确驳回过）：
 *   ① 独立弹框、不可跳过、**不默认勾选** —— 无任何 checkbox，只能点按钮表态；
 *   ② 《用户协议》《隐私政策》是**可点击链接**，点了能直接打开全文；
 *   ③ 「同意」+「不同意并退出」两个按钮，点不同意**直接关闭 App**；
 *   ④ 明示「点击同意即表示你已阅读并同意上述协议」。
 *
 * 🔴 挂载位置很关键：必须在 `main.tsx` 里包住 `<App />`，**不能**放进 App.tsx。
 * 因为 App 内的 PlanProvider 一挂载就调 getEntitlement / getPhotoQuota，
 * 那就是「未取得同意先发起网络请求采集」，比不弹窗更严重的违规。
 *
 * 🔴 法律深链放行：商店/备案/ASC 审核员会直接访问 `/legal/privacy`，OPPO 的隐私
 * 政策自动化审核也直接抓取该 URL。未同意时若渲染整个 App 会连带发起网络请求，
 * 故此处**只渲染 LegalPage 全文**——审核员读得到完整政策，且零网络请求。
 *
 * z-index 取 50：低于 .legal-overlay(60)，让用户点链接时文档页盖在本弹窗之上，
 * 读完返回仍回到本弹窗（同意状态未给出前不放行）。
 */
export function PrivacyGate({ children }: { children: React.ReactNode }) {
  /**
   * 三态：null=正在读取本地同意状态，true=已同意，false=未同意。
   * 初值走同步预览：Web 端 localStorage 可同步读，直接得到结果、首屏零白屏
   * （对商店的隐私政策自动化审核很关键，白屏期抓取会被判「页面无法加载」）；
   * 原生端无同步存储，返回 null，由下方 effect 走异步 Preferences 读取。
   */
  const [consent, setConsent] = useState<boolean | null>(() => peekPrivacyConsent())
  /**
   * 未同意状态下命中的法律深链（审核员/爬虫直达 /legal/privacy）。
   * 做成可变 state 而非一次性初值：用户点「返回」时要清掉它，才能落回同意门 ——
   * 若用 history.back()，审核员直接落地该 URL 时无历史记录，会退到空白页。
   */
  const [deepLink, setDeepLink] = useState<DocId | null>(() => readLegalFromUrl())
  /** 用户在弹窗内点开阅读的文档；非 null 时文档页盖在弹窗之上 */
  const [viewing, setViewing] = useState<DocId | null>(null)
  /** 点了「不同意」：原生已调起退出，Web 端降级为不可用页 */
  const [declined, setDeclined] = useState(false)

  // 仅当同步预览给不出结论（原生端无同步存储）时才异步读取。
  // 只读本地存储，不发任何网络请求 —— 这是「同意前零采集」的落点。
  useEffect(() => {
    if (peekPrivacyConsent() !== null) return // Web 端已在 useState 初值里同步拿到结果
    let alive = true
    void hasPrivacyConsent().then((ok) => {
      if (alive) setConsent(ok)
    })
    return () => {
      alive = false
    }
  }, [])

  async function handleAgree() {
    await grantPrivacyConsent()
    setConsent(true)
  }

  async function handleDecline() {
    setDeclined(true)
    // 原生端真正退出进程；Web 端无 exitApp，停在「已退出」页（不放行）
    await exitApp()
  }

  // 读取同意状态期间不渲染任何内容：App 未挂载 → 不可能发出请求
  if (consent === null) return null

  if (consent) return <>{children}</>

  // 未同意 + 外部直达法律深链：只给文档全文（审核员/爬虫场景），不发任何网络请求。
  // 「返回」清掉深链并同步 URL 到根路径 → 落回同意门；不能用 history.back()，
  // 审核员直接落地该 URL 时无历史记录，back() 会退到空白页。
  if (deepLink) {
    return (
      <LegalPage
        id={deepLink}
        onBack={() => {
          setDeepLink(null)
          syncLegalUrl(null)
        }}
      />
    )
  }

  if (declined) {
    return (
      <div className="privacy-gate">
        <div className="privacy-card">
          <h1>需同意后才能使用</h1>
          <p className="privacy-body">
            你选择了不同意《用户协议》与《隐私政策》，{SITE.name}无法为你提供服务。
            如需使用，请重新启动应用并点击「同意并继续」。
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="privacy-gate" role="dialog" aria-modal="true" aria-label="用户协议与隐私政策">
        <div className="privacy-card">
          <h1>用户协议与隐私政策</h1>
          <p className="privacy-body">
            欢迎使用{SITE.name}（{SITE.nameEn}）。我们非常重视你的个人信息保护。
            在你开始使用前，请务必仔细阅读并充分理解
            <button type="button" className="privacy-link" onClick={() => setViewing('terms')}>
              《用户协议》
            </button>
            与
            <button type="button" className="privacy-link" onClick={() => setViewing('privacy')}>
              《隐私政策》
            </button>
            ，特别是其中涉及个人信息收集与使用、以及你所享有权利的条款。
          </p>
          <p className="privacy-body">
            我们仅收集为提供饮食记录服务所必需的信息（手机号或邮箱、你主动填写的身体数据与记录），
            不会用于广告投放，也不会出售你的个人信息。
          </p>
          <p className="privacy-tip">点击「同意并继续」即表示你已阅读并同意上述协议。</p>

          <div className="privacy-actions">
            <button type="button" className="btn btn-ghost" onClick={() => void handleDecline()}>
              不同意并退出
            </button>
            {/* 用 .btn（蜂蜜色实底）而非 .btn-primary —— 后者在 styles.css 中不存在
                （AiConsent.tsx 里那处是无效类名，靠 .btn 兜底），此处不沿用该笔误 */}
            <button type="button" className="btn" onClick={() => void handleAgree()}>
              同意并继续
            </button>
          </div>
        </div>
      </div>

      {viewing && <LegalPage id={viewing} onBack={() => setViewing(null)} />}
    </>
  )
}
