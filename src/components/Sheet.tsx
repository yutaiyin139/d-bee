import type { ReactNode } from 'react'
import { useModalA11y } from './useModalA11y'

interface SheetProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** 底部弹层，用于记餐等操作 */
export function Sheet({ title, onClose, children }: SheetProps) {
  const { dialogRef, closeRef } = useModalA11y(onClose)

  return (
    <div className="sheet-mask" onClick={onClose} role="presentation">
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="sheet-close" onClick={onClose} ref={closeRef} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
