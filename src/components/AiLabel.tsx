/**
 * 「AI 生成」显式标识（《人工智能生成合成内容标识办法》第四条（一），2025-09-01 施行）。
 *
 * 办法要求：提供文本生成服务的，应当在交互场景界面、文字周边添加显著的提示标识。
 * 全站 AI 生成内容（问问小蜜、本期解读、拍照/文字/包装识别结果）统一走本组件，
 * 保证标识口径一致、样式可审计。配套的用户协议条款见 legal.ts「四之一」节。
 *
 * 两种形态：
 *   · <AiLabel />            —— 角标式徽章，贴在生成内容旁（默认）
 *   · <AiLabel inline />     —— 整行提示「内容由 AI 生成，仅供参考」，用于区块底部
 */

interface AiLabelProps {
  /** 整行提示形态（区块底部）；默认是徽章形态 */
  inline?: boolean
  /** 徽章文案覆盖（默认「AI 生成」） */
  text?: string
  style?: React.CSSProperties
}

export function AiLabel({ inline, text, style }: AiLabelProps) {
  if (inline) {
    return (
      <div className="ai-gen-note" style={style}>
        <span className="ai-badge">AI 生成</span>
        {text ?? '内容由 AI 生成，仅供参考，请核对后再作决定。'}
      </div>
    )
  }
  return (
    <span className="ai-badge" style={style} title="内容由 AI 生成，仅供参考">
      {text ?? 'AI 生成'}
    </span>
  )
}
