/**
 * 弹层（Modal / Sheet）无障碍通用逻辑。
 *
 * 收敛原先散落在 Sheet / AiConsent / CoachSheet / LogSheet 里各写一遍的行为：
 *   ① 打开时锁定 body 滚动，关闭时还原；
 *   ② 打开时把焦点移进弹层（默认落到关闭按钮或首个可聚焦元素）；
 *   ③ Tab / Shift+Tab 在弹层内循环，不外溢到底层页面（焦点圈定 focus trap）；
 *   ④ Escape 关闭；
 *   ⑤ 关闭后把焦点归还给打开前的元素，避免焦点丢失（VoiceOver 用户尤其重要）。
 *
 * 用法：
 *   const { dialogRef, closeRef } = useModalA11y(onClose)
 *   <div ref={dialogRef} role="dialog" aria-modal="true"> …
 *     <button ref={closeRef}>×</button> …
 */

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface ModalA11y {
  /** 挂到 role="dialog" 容器上 */
  dialogRef: RefObject<HTMLDivElement>
  /** 可选：挂到弹层内的关闭按钮，作为默认初始焦点 */
  closeRef: RefObject<HTMLButtonElement>
}

export function useModalA11y(onClose: () => void): ModalA11y {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  // 打开前获得焦点的元素，用于关闭后归还
  const restoreRef = useRef<HTMLElement | null>(null)
  // onClose 用 ref 承载，避免因每次渲染的新函数重复绑定 keydown
  const closeCb = useRef(onClose)
  closeCb.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    restoreRef.current = (document.activeElement as HTMLElement) ?? null

    // ① 锁滚动
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // ② 初始焦点：优先关闭按钮，否则第一个可聚焦元素，最后兜底到容器本身
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    const target = closeRef.current ?? focusables()[0]
    if (target) target.focus()
    else {
      // 容器需可聚焦才能承接焦点，避免直接落到底层
      dialog.setAttribute('tabindex', '-1')
      dialog.focus()
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeCb.current()
        return
      }
      if (e.key !== 'Tab' || !dialog) return
      const items = focusables().filter((el) => el.offsetParent !== null)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      // ⑤ 归还焦点
      try {
        restoreRef.current?.focus?.()
      } catch {
        /* 元素已卸载等情况，忽略 */
      }
    }
  }, [])

  return { dialogRef, closeRef }
}
