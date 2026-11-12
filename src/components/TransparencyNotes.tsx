import type { TransparencyNote } from '../lib/entitlement'

/**
 * 透明化文案的纯展示组件（P1.4 / P1.5 / P1.6）。
 *
 * 文案真源在 `@dbee/shared` 的 `content/transparency.ts`，本组件不持有任何文案副本。
 * 只用行内样式，避免为一块说明文字改动全局 styles.css（可单独回滚）。
 */
export function TransparencyNotes({
  notes,
  title,
}: {
  notes: readonly TransparencyNote[]
  title?: string
}) {
  return (
    <div style={{ marginTop: 14 }}>
      {title ? (
        <div className="section-title" style={{ marginBottom: 8 }}>{title}</div>
      ) : null}
      <div className="card" style={{ padding: '4px 14px' }}>
        {notes.map((n, i) => (
          <div
            key={n.label}
            style={{
              padding: '9px 0',
              borderTop: i === 0 ? 'none' : '1px solid rgba(42,39,35,0.08)',
              lineHeight: 1.65,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{n.label}</div>
            <div className="helper" style={{ lineHeight: 1.65, margin: 0 }}>{n.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
