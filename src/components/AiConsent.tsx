/**
 * AI 数据处理显式同意弹窗（P0-3 合规）。
 *
 * 触发时机：首次使用「AI 拍照识别」或「AI 教练」前。
 * 用户点击「同意」后写入 profiles.ai_consented；点击「不同意」保留手动记录能力，
 * 但禁用该 AI 功能。
 */

import { useState } from 'react'
import { useModalA11y } from './useModalA11y'

interface AiConsentProps {
  /** 弹窗类型：photo=拍照识别，coach=AI 问答 */
  kind: 'photo' | 'coach'
  /** 同意回调 */
  onAgree: () => void
  /** 拒绝回调（关闭弹窗并保留手动能力） */
  onDecline: () => void
}

const BODY: Record<AiConsentProps['kind'], { title: string; desc: string }> = {
  photo: {
    title: 'AI 拍照识别说明',
    desc: '使用「拍照识别」时，你所拍摄的食物照片会上传至视觉大模型进行分析，以返回热量与营养估算。识别完成后照片不会被长期保存。',
  },
  coach: {
    title: 'AI 饮食助手说明',
    desc: '使用「问问小蜜」时，你的提问与今日饮食记录摘要会发送至大模型，以生成个性化建议。对话内容不会被用于模型训练。',
  },
}

export function AiConsent({ kind, onAgree, onDecline }: AiConsentProps) {
  const [busy, setBusy] = useState(false)
  const body = BODY[kind]
  // Escape / 遮罩点击 = 「不同意」，与关闭按钮语义一致
  const { dialogRef, closeRef } = useModalA11y(onDecline)

  return (
    <div className="sheet-mask" onClick={onDecline} role="presentation">
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={body.title}
      >
        <div className="sheet-head">
          <h2>{body.title}</h2>
          <button className="sheet-close" onClick={onDecline} ref={closeRef} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="sheet-body" style={{ lineHeight: 1.7 }}>
          <p>{body.desc}</p>
          <p style={{ color: 'var(--ink-3)', fontSize: 13, marginTop: 8 }}>
            不同意仍可继续使用手动记录、文字录入、扫条码等非 AI 功能。
          </p>
        </div>
        <div className="sheet-foot" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onDecline} disabled={busy}>
            不同意
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setBusy(true)
              onAgree()
            }}
            disabled={busy}
          >
            {busy ? '保存中…' : '同意并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}
