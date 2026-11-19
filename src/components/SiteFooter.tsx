import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocId } from '../content/legal'
import { SITE } from '../content/legal'
import { isNative, isWeb } from '../lib/platform'
import { PricingSheet } from '../pages/PricingSheet'

/**
 * 站点页脚：法律文档入口 + 联系方式 + 备案号。
 *
 * 备案号走环境变量：VITE_ICP_BEIAN 未设置时该行不渲染
 * （备案审核期间展示假备案号属违规，故留空即隐藏）。
 *
 * 🔴 「联系我们」（2026-11-05 补）：此前本组件只有三份法律文档链接，但
 * ProfileScreen.tsx 的注销提示与 content/legal.ts 第五条正文都指引用户
 * 「通过『关于 → 联系我们』与客服联系」—— 而 web 端既没有「关于」区块
 * （全仓 grep 零命中），也没有任何「联系我们」入口，属指路指向不存在的入口。
 * mini 端同病（有「关于」卡片但缺「联系我们」条目）。本次两端一并补齐，
 * 并把两处文案改为「请通过『联系我们』…」—— 去掉「关于 →」前缀，
 * 因为两端承载位置本就不同（web 在页脚，mini 在「我的 → 关于」卡片），
 * 但两端都存在字面标签为「联系我们」的元素，故该指引在两端同时为真。
 *
 * ⚠️ 刻意分叉：web 用 `<a href="mailto:">` 直接唤起邮件客户端（浏览器环境可行）；
 * mini 端 ProfileScreen 对应位置用「点击复制邮箱 + showToast」—— 小程序无 DOM、
 * 无 mailto 协议，复制是唯一可行路径。两端**目标一致**（让用户拿到公示邮箱），
 * 手段因平台能力不同而分叉，属正当分叉，不要「顺手抹平」。
 * 另：邮箱默认直接显示而非点击后才出现 —— 法律要求公示联系方式应「以显著方式」呈现。
 */
export function SiteFooter({ onOpen }: { onOpen: (id: DocId) => void }) {
  /**
   * 公开定价页（未登录可见）。
   *
   * 🔴 入口**只在 Web 渲染**：iOS 的合法成交价是 App Store 本地化价格，
   * 既有纪律「绝不回退硬编码价」（PaywallSheet 的 iosPriceState）——
   * 在 iOS 上展示一份本地生成的价格属价格展示违规，也会与商店价不一致。
   * Android 有原生支付通道，走付费墙即可，不需要「仅展示」的第二入口。
   *
   * 放在页脚是因为它同时出现在登录页、今日页、我的页 —— 一处接入即全站可达
   * （含未登录访客），无需给三个页面各加 prop。
   */
  const [pricingOpen, setPricingOpen] = useState(false)
  const showPricingEntry = isWeb()

  /**
   * 🔴 App 备案号**只在原生壳渲染**（详见下方 JSX 处的注释：绑「应用」而非「域名」，
   *   在 Web 页面渲染会触发 verify-legal 的号段错配校验）。
   *   另外必须排除「Web 页面被塞进第三方 WebView」的情形——`isNative()` 判的是
   *   Capacitor 原生容器，微信内置浏览器打开 d-bee.cn 时它仍为 false，符合预期。
   */
  const showAppBeian = isNative() && Boolean(SITE.appIcp)

  return (
    <footer className="site-footer">
      <div className="site-footer-links">
        {showPricingEntry && (
          <>
            <button className="btn-text" onClick={() => setPricingOpen(true)}>
              会员定价
            </button>
            <span className="dot">·</span>
          </>
        )}
        <button className="btn-text" onClick={() => onOpen('terms')}>
          用户协议
        </button>
        <span className="dot">·</span>
        <button className="btn-text" onClick={() => onOpen('privacy')}>
          隐私政策
        </button>
        <span className="dot">·</span>
        <button className="btn-text" onClick={() => onOpen('disclaimer')}>
          免责声明
        </button>
        <span className="dot">·</span>
        <a className="btn-text" href={`mailto:${SITE.contactEmail}`}>
          联系我们
        </a>
      </div>

      <div className="site-footer-meta">
        <span>
          {SITE.nameEn}（{SITE.name}）{SITE.version}
        </span>
        <span className="dot">·</span>
        <span>{SITE.contactEmail}</span>
        <span className="dot">·</span>
        <span>营养数据仅供参考，不构成医疗建议</span>
      </div>

      {SITE.icp && (
        <div className="site-footer-meta">
          <a href={SITE.icpUrl} target="_blank" rel="noreferrer noopener">
            {SITE.icp}
          </a>
          {SITE.police && (
            <>
              <span className="dot">·</span>
              <a href={SITE.policeUrl} target="_blank" rel="noreferrer noopener">
                {SITE.police}
              </a>
            </>
          )}
          {/* 🔴 App 备案号（2026-11-18 下证，后缀 -3A）：工信部要求 App 在显著位置标注。
              门控 isNative() 是**硬性**的，不是样式偏好：
                · 网站 ICP（-2）绑域名 d-bee.cn → Web 页脚必须渲染；
                · App 备案（-3A）绑「应用」而非域名 → 在 Web 页面渲染属号段错配，
                  会被 deploy/verify-legal.mjs 的「出现期望号之外的其他备案号 = 疑似错填」
                  双向校验判 FAIL（它还会把 -3A 匹配成 -3，更难排查）。
              页脚由四端共用（AuthScreen / Dashboard / ProfileScreen 各渲染一次），
              一处接入即原生端全页面可达，满足「显著位置」要求。 */}
          {showAppBeian && (
            <>
              <span className="dot">·</span>
              <a href={SITE.icpUrl} target="_blank" rel="noreferrer noopener">
                App备案号 {SITE.appIcp}
              </a>
            </>
          )}
        </div>
      )}

      {/* portal 挂到 body：`.sheet-mask` 虽是 fixed，但页脚在 .app-shell(overflow-x:hidden)
          内，portal 到根可彻底规避祖先 overflow / 层叠上下文对弹层的裁剪与压层。 */}
      {pricingOpen &&
        createPortal(<PricingSheet onClose={() => setPricingOpen(false)} />, document.body)}
    </footer>
  )
}
