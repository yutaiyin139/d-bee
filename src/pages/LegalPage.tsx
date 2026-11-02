import type { ReactNode } from 'react'
import type { DocId } from '../content/legal'
import { getDoc } from '../content/legal'

/**
 * 把法律文案里的 `**强调**` 渲染成 <strong>。
 *
 * 为什么需要它：`src/content/legal.ts` 用 markdown 星号标注关键限定语（如
 * 「集成但**未调用**」「**不会上传**到我们的服务器」）。此前本组件与
 * `tools/gen-legal-static.mjs` 都直出纯文本 → 用户和商店审核爬虫都会看到
 * 裸星号 `**尚未开放**`。两端已统一修复，渲染结果一致。
 *
 * 实现约束：
 *  - 用分段渲染而非 dangerouslySetInnerHTML —— 文案虽由我们自己维护，
 *    仍不给注入面（与生成器的 esc() 纪律一致）。
 *  - 成对性守卫：`**` 数量为奇数（切分后段数为偶数）说明文案漏写了一半标记。
 *    此时**剥掉星号、按纯文本渲染** —— 三种可能里选最安全的一种：照原样保留会
 *    露出裸星号（正是本函数要消除的缺陷）；按奇偶分段会把漏标记之后的正文全部
 *    误加粗（法律文案观感严重失真）；剥星号只丢失一次强调，正文完整。
 */
function rich(text: string): ReactNode {
  const parts = text.split('**')
  // 奇数个标记（偶数段）= 文案写漏，降级为纯文本（拼接即等于剥掉星号）
  if (parts.length % 2 === 0) return parts.join('')
  return parts.map((seg, i) => (i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg))
}

/**
 * 法律文档页（用户协议 / 隐私政策 / 免责声明）。
 *
 * 三份文档共用同一个渲染器：结构一致（标题 + 更新日期 + 小节），
 * 内容来自 src/content/legal.ts 的 DOCS，改文案不需要动组件。
 */
export function LegalPage({ id, onBack }: { id: DocId; onBack: () => void }) {
  const doc = getDoc(id)

  return (
    <div className="legal-overlay">
      <div className="page legal-page">
        <div className="page-top" />

        <div className="legal-head">
          <button className="btn-text" onClick={onBack}>
            ‹ 返回
          </button>
          <h1>{doc.title}</h1>
          <p className="helper">最后更新：{doc.updated}</p>
        </div>

        <div className="legal-body">
          <p>{rich(doc.intro)}</p>
          {doc.sections.map((s) => (
            <section key={s.h}>
              <h2>{s.h}</h2>
              {s.p?.map((t, i) => (
                <p key={i}>{rich(t)}</p>
              ))}
              {s.list && (
                <ul>
                  {s.list.map((t, i) => (
                    <li key={i}>{rich(t)}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={onBack}>
          我已阅读
        </button>
      </div>
    </div>
  )
}
