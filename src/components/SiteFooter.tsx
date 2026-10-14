import type { DocId } from '../content/legal'
import { SITE } from '../content/legal'

/**
 * 站点页脚：法律文档入口 + 备案号。
 *
 * 备案号走环境变量：VITE_ICP_BEIAN 未设置时该行不渲染
 * （备案审核期间展示假备案号属违规，故留空即隐藏）。
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
      </div>

      <div className="site-footer-meta">
        <span>
          {SITE.nameEn}（{SITE.name}）{SITE.version}
        </span>
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
