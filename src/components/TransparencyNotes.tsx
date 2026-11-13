import { useState } from 'react'
import type { TransparencyNote } from '../lib/entitlement'

/**
 * 透明化文案的展示组件（P1.4 / P1.5 / P1.6；2026-11-12 改为默认收起）。
 *
 * 文案真源在 `@dbee/shared` 的 `content/transparency.ts`，本组件不持有任何文案副本。
 * 交互：默认收起，点标题行展开 —— 与首页「饮食体检」同一套手势（右侧药丸
 * 「展开 / 收起」+ 箭头翻转 + 详情区折叠）。Web / iOS / Android 共用本文件；
 * mini 端见 `mini/src/components/TransparencyNotes.tsx`，保持同款观感。
 *
 * 只用行内样式，避免为一块说明文字改动全局 styles.css（可单独回滚）。
 * 🔴 收起只改变「是否展示」，不改文案内容、不改数据来源：展开后仍逐条渲染 notes。
 * 🔴 刻意不持久化展开状态：这些是按需查阅的规则说明，默认收起才符合「简洁」，
 *    记住上次展开会让第二次进入又看到一长串，与本次诉求相反。
 */
export function TransparencyNotes({
  notes,
  title,
}: {
  notes: readonly TransparencyNote[]
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const label = title ?? '说明'

  return (
    <div style={{ marginTop: 14 }}>
      <button
        type="button"
        className="section-title"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          margin: '0 0 8px',
          padding: 0,
          border: 'none',
          background: 'none',
          fontFamily: 'inherit',
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--ink)',
          textAlign: 'left',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="hint" style={{ fontSize: 12, fontWeight: 400 }}>共 {notes.length} 条</span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '4px 9px',
              border: '1px solid var(--line-2)',
              borderRadius: 99,
              background: 'var(--surface)',
              color: 'var(--ink-2)',
              fontSize: 12,
              fontWeight: 400,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                fontSize: 11,
                lineHeight: 1,
                transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.25s ease',
              }}
            >▾</span>
            <span>{open ? '收起' : '展开'}</span>
          </span>
        </span>
      </button>

      <div
        style={{
          overflow: 'hidden',
          maxHeight: open ? `${notes.length * 160 + 40}px` : '0px',
          opacity: open ? 1 : 0,
          transition: 'max-height 0.32s ease, opacity 0.24s ease',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
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
    </div>
  )
}
