/**
 * 剪贴板抽象层。
 *
 * 解决 Web 端「http 非安全上下文」下 `navigator.clipboard` 不可用、原生 WebView 里
 * `navigator.clipboard` / `navigator.share` 也不可靠的问题，统一收敛成 copyText()。
 *
 * 降级顺序（由新到旧、由可靠到兜底）：
 *   1. 原生 Capacitor Clipboard 插件（鸭子类型探测，不 import 包，保持 Web 零依赖）
 *   2. navigator.clipboard.writeText（https / localhost 等安全上下文）
 *   3. document.execCommand('copy') + 隐藏 textarea（http 也能用，最可靠兜底）
 *
 * 微信小程序：无 DOM / 无 navigator.clipboard，走 wx.setClipboardData（规划中接入），
 * 不影响现有三端。
 *
 * 业务代码只关心「复制成没成功」，不关心平台差异。
 */

import { isWechatMiniProgram } from './platform'

/** 原生 Capacitor Clipboard 插件的最小结构 */
interface CapacitorClipboard {
  write: (opts: { string: string }) => Promise<void>
}

function getCapClipboard(): CapacitorClipboard | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.Clipboard
  if (!p || typeof p !== 'object') return null
  const c = p as Partial<CapacitorClipboard>
  if (typeof c.write !== 'function') return null
  return c as CapacitorClipboard
}

/** execCommand 兜底：http 非安全上下文下 navigator.clipboard 为 undefined 时仍能复制 */
function copyViaExecCommand(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    const selection = document.getSelection()
    const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (prevRange && selection) {
      selection.removeAllRanges()
      selection.addRange(prevRange)
    }
    return ok
  } catch {
    return false
  }
}

/**
 * 复制一段文本到剪贴板。
 * @returns 是否复制成功（供业务方决定是否提示用户手动复制）
 */
export async function copyText(text: string): Promise<boolean> {
  // 0) 微信小程序：无 DOM，走 wx.setClipboardData（规划中接入）。
  //    当前返回 false，不影响现有三端（小程序环境本就不会命中下方分支）。
  if (isWechatMiniProgram()) {
    return false
  }

  // 1) 原生插件（原生 App 内）
  const cap = getCapClipboard()
  if (cap) {
    try {
      await cap.write({ string: text })
      return true
    } catch {
      /* 落到下一级 */
    }
  }

  // 2) 标准异步剪贴板（安全上下文）
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 落到下一级 */
    }
  }

  // 3) execCommand 兜底（http 环境）
  return copyViaExecCommand(text)
}
