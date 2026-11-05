import type { DocId } from '../content/legal'
import { SITE } from '../content/legal'

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
  return (
    <footer className="site-footer">
      <div className="site-footer-links">
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
        </div>
      )}
    </footer>
  )
}
