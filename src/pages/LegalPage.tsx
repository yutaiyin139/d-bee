import type { DocId } from '../content/legal'
import { getDoc } from '../content/legal'

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
          <p>{doc.intro}</p>
          {doc.sections.map((s) => (
            <section key={s.h}>
              <h2>{s.h}</h2>
              {s.p?.map((t, i) => (
                <p key={i}>{t}</p>
              ))}
              {s.list && (
                <ul>
                  {s.list.map((t, i) => (
                    <li key={i}>{t}</li>
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
