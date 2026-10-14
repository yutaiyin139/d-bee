import { useEffect, useRef, useState } from 'react'
import { askCoach, type CoachContext } from '../lib/ai'
import { quotaExhaustedReason } from '../lib/entitlement'
import { usePlan } from '../state/plan'

interface CoachSheetProps {
  ctx: CoachContext
  onClose: () => void
}

interface Msg {
  role: 'user' | 'coach'
  text: string
}

export function CoachSheet({ ctx, onClose }: CoachSheetProps) {
  const { claimAiQuota, refundAiQuota, aiRemaining, openPaywall } = usePlan()
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'coach',
      text: '我是 D-Bee 小蜜 🐝 说说你的问题，比如「晚上饿了吃什么」「奶茶和拿铁哪个更友好」，我会结合你今天的数据来答。',
    },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  async function send() {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setErr('')
    setMessages((prev) => [...prev, { role: 'user', text: q }])
    setBusy(true)
    let claimed = false
    try {
      const quota = await claimAiQuota()
      if (!quota.allowed) {
        setErr('')
        openPaywall(quotaExhaustedReason())
        return
      }
      claimed = true
      const answer = await askCoach(q, ctx)
      setMessages((prev) => [...prev, { role: 'coach', text: answer }])
    } catch (e) {
      // AI 调用失败要把刚占用的额度退回去，不让用户白扣次数
      if (claimed) await refundAiQuota()
      setErr(e instanceof Error ? e.message : '回答失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-mask" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="AI 饮食助手">
        <div className="sheet-head">
          <h2>问问小蜜</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {aiRemaining !== null && (
              <span className="hint" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                今日剩 {aiRemaining} 次
              </span>
            )}
            <button className="sheet-close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </div>

        <div className="coach-body" ref={bodyRef}>
          {messages.map((m, i) => (
            <div key={i} className={`coach-msg ${m.role === 'user' ? 'mine' : ''}`}>
              {m.text}
            </div>
          ))}
          {busy && (
            <div className="coach-msg coach-thinking">
              <span className="spinner coach-spin" />
              正在结合你的数据思考…
            </div>
          )}
          {err && <div className="notice err">{err}</div>}
        </div>

        <div className="coach-input">
          <input
            placeholder="输入你的问题…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send()
            }}
          />
          <button className="btn" style={{ width: 88, flexShrink: 0 }} disabled={busy || !input.trim()} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
