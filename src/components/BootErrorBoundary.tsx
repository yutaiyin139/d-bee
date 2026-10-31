import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 启动错误边界（2026-10-31 加，配合 index.html 内联自报面板）。
 *
 * 背景：项目此前没有任何 ErrorBoundary —— 组件树任何一处渲染期抛错，
 * React 18 会直接卸载整棵树，页面变成空白。在原生 WebView 里这表现为
 * 「纯白屏、无报错、状态栏正常」，与 cloudConfig 护栏 throw 的白屏
 * （模块求值期炸，React 根本没启动）外观完全一致，无法肉眼区分。
 *
 * 分工（两道白屏防线）：
 *   · index.html 内联脚本的 window.onerror → 模块求值期异常（import 即炸）
 *   · 本边界 componentDidCatch               → React 渲染期异常（挂载才炸）
 * 两者共用同一个可视化面板：window.__dbeeShowBootError（由内联脚本注入）。
 * 拿不到面板时（理论上不该发生，内联脚本先于一切模块执行）降级为组件内渲染纯文本。
 *
 * 设计约束：
 *   · 用 class 组件 —— ErrorBoundary 是 React 目前唯一必须用 class 的场景。
 *   · 错误信息展示完整 stack：这是开发排障面板，不是用户文案；
 *     原生包（内测/审核阶段）看到它的只有开发者与审核员。
 *     Web 端生产同样显示 —— 好过无声白屏，且 Web 端用户可开控制台自行查看。
 *   · 不 rethrow、不上报第三方 —— 零依赖、零网络请求（隐私门之前不允许发请求）。
 */
export class BootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; info: ErrorInfo | null }
> {
  state: { error: Error | null; info: ErrorInfo | null } = { error: null, info: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info })
    const show = (window as unknown as { __dbeeShowBootError?: (msg: string) => void })
      .__dbeeShowBootError
    const detail = `${error.stack || error.message}\n\n组件栈:\n${info.componentStack || '(无)'}`
    if (show) show(detail)
  }

  render(): ReactNode {
    const { error, info } = this.state
    if (!error) return this.props.children
    // 降级路径：内联面板不可用时，就地渲染可读的错误文本（仍然是「说话」而非白屏）
    return (
      <pre
        style={{
          position: 'fixed',
          inset: 0,
          margin: 0,
          overflow: 'auto',
          background: '#FCEBEB',
          color: '#791F1F',
          padding: '16px 14px 48px',
          font: '12px/1.6 -apple-system, BlinkMacSystemFont, monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          zIndex: 2147483646,
        }}
      >
        {'【D-Bee 启动自报】请把本页截图发给开发者\n\n▸ React 渲染期抛错\n\n' +
          (error.stack || error.message) +
          '\n\n组件栈:\n' +
          (info?.componentStack || '(无)')}
      </pre>
    )
  }
}
