import type { KeyboardEvent } from 'react'

/**
 * 为 role="button" 的非原生按钮元素补键盘激活（Enter / Space）。
 *
 * 背景（WCAG 2.1.1 / Apple HIG）：`<div role="button" tabIndex={0}>` 只有鼠标点击，
 * 键盘用户按 Enter/Space 无反应。这些行内往往还嵌着原生 <button>（如「导出/取消」），
 * 直接改成原生 <button> 会造成「按钮套按钮」的非法嵌套，因此保留 div 结构、只补键盘语义。
 *
 * 仅响应直接落在该元素上的按键（e.target === e.currentTarget）：内部嵌套的原生
 * <button> 自己会处理 Enter/Space 并 stopPropagation，避免一次按键触发两次动作。
 */
export function onActivateKey(handler: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      handler()
    }
  }
}
