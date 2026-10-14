import type { ReactNode } from 'react'

interface RingProps {
  value: number
  max: number
  size?: number
  stroke?: number
  color?: string
  trackColor?: string
  children?: ReactNode
}

/** 通用环形进度，用于每日热量剩余展示 */
export function Ring({
  value,
  max,
  size = 216,
  stroke = 15,
  color = 'var(--honey)',
  trackColor = 'var(--bg-2)',
  children,
}: RingProps) {
  const safeMax = max > 0 ? max : 1
  const ratio = Math.max(0, Math.min(value / safeMax, 1))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = c * ratio

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="每日热量进度">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 0.45s cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </div>
    </div>
  )
}
