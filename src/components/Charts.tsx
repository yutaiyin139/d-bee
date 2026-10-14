/**
 * 轻量图表组件（手写 SVG）。
 *
 * 不引入 ECharts / Recharts 这类重型库：本项目只需要两种图形（折线、柱状），
 * 自绘可以少背 200kB+ 的包，并且能直接复用页面已有的 CSS 变量与圆角语言。
 *
 * 两个组件都按同一套坐标规则绘制：viewBox 固定宽度，靠 CSS 撑满容器宽度等比缩放，
 * 因此不需要 ResizeObserver，也不会在布局抖动时重算。
 */

const W = 340

export interface LinePoint {
  label: string
  value: number
}

interface LineChartProps {
  points: LinePoint[]
  /** 参考线（如目标体重） */
  target?: number | null
  /** 数值格式化 */
  fmt?: (v: number) => string
  height?: number
  unit?: string
  color?: string
  emptyText?: string
}

export function LineChart({
  points,
  target,
  fmt = (v) => String(Math.round(v * 10) / 10),
  height = 168,
  unit = '',
  color = 'var(--honey)',
  emptyText = '还没有数据',
}: LineChartProps) {
  if (points.length === 0) {
    return <div className="chart-empty">{emptyText}</div>
  }

  const values = points.map((p) => p.value)
  const all = target != null && Number.isFinite(target) ? [...values, target] : values
  let lo = Math.min(...all)
  let hi = Math.max(...all)

  // 全部数值相同时给一个人造的上下界，否则线会贴在边框上
  if (hi - lo < 0.2) {
    lo -= 0.5
    hi += 0.5
  }
  const pad = (hi - lo) * 0.15
  lo -= pad
  hi += pad

  const padL = 36
  const padR = 12
  const padT = 14
  const padB = 24
  const plotW = W - padL - padR
  const plotH = height - padT - padB

  const x = (i: number) => padL + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1))
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(
    padT + plotH
  ).toFixed(1)} Z`

  const gridVals = [hi, (hi + lo) / 2, lo]
  const last = points[points.length - 1]
  // 标出首尾日期，中间点太多会糊成一片
  const labelIdx = points.length <= 3 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1]

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="趋势折线图">
      <defs>
        <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {gridVals.map((v, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--line)"
            strokeWidth="1"
            strokeDasharray={i === 0 || i === 2 ? '0' : '3 4'}
          />
          <text x={padL - 6} y={y(v) + 3.5} textAnchor="end" className="chart-tick">
            {fmt(v)}
          </text>
        </g>
      ))}

      {target != null && Number.isFinite(target) && target >= lo && target <= hi && (
        <g>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(target)}
            y2={y(target)}
            stroke="var(--blue)"
            strokeWidth="1.2"
            strokeDasharray="5 4"
          />
          <text x={W - padR} y={y(target) - 5} textAnchor="end" className="chart-tick chart-tick-target">
            目标 {fmt(target)}
            {unit}
          </text>
        </g>
      )}

      <path d={area} fill="url(#lineFill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

      {points.length <= 20 &&
        points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={points.length === 1 ? 4 : 2.6} fill="var(--surface)" stroke={color} strokeWidth="1.8" />
        ))}

      {points.length === 1 && (
        <text x={x(0)} y={y(points[0].value) - 10} textAnchor="middle" className="chart-tick">
          {fmt(points[0].value)}
          {unit}
        </text>
      )}

      {points.length > 1 && (
        <text x={x(points.length - 1)} y={y(last.value) - 9} textAnchor="end" className="chart-tick chart-tick-strong">
          {fmt(last.value)}
          {unit}
        </text>
      )}

      {labelIdx.map((i) => (
        <text key={i} x={x(i)} y={height - 7} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="chart-tick">
          {points[i].label}
        </text>
      ))}
    </svg>
  )
}

export interface Bar {
  label: string
  value: number
  /** 覆盖默认着色（如超标用警示色） */
  tone?: 'normal' | 'over'
}

interface BarChartProps {
  bars: Bar[]
  target?: number | null
  height?: number
  fmt?: (v: number) => string
  emptyText?: string
}

export function BarChart({
  bars,
  target,
  height = 160,
  fmt = (v) => String(Math.round(v)),
  emptyText = '还没有数据',
}: BarChartProps) {
  const maxVal = Math.max(...bars.map((b) => b.value), target ?? 0)
  if (bars.length === 0 || maxVal <= 0) {
    return <div className="chart-empty">{emptyText}</div>
  }

  const padL = 36
  const padR = 10
  const padT = 14
  const padB = 24
  const plotW = W - padL - padR
  const plotH = height - padT - padB
  const hi = maxVal * 1.12

  const y = (v: number) => padT + (1 - v / hi) * plotH
  const slot = plotW / bars.length
  const barW = Math.max(2, Math.min(slot * 0.66, 18))

  const labelIdx = bars.length <= 4 ? bars.map((_, i) => i) : [0, Math.floor((bars.length - 1) / 2), bars.length - 1]

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="每日摄入柱状图">
      {[hi, hi / 2].map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" strokeDasharray={i ? '3 4' : '0'} />
          <text x={padL - 6} y={y(v) + 3.5} textAnchor="end" className="chart-tick">
            {fmt(v)}
          </text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="var(--line-2)" strokeWidth="1" />

      {bars.map((b, i) => {
        const cx = padL + slot * i + slot / 2
        const h = Math.max(b.value > 0 ? 2 : 0, (b.value / hi) * plotH)
        return (
          <rect
            key={i}
            x={cx - barW / 2}
            y={padT + plotH - h}
            width={barW}
            height={h}
            rx={Math.min(3, barW / 2)}
            fill={b.tone === 'over' ? 'var(--red)' : 'var(--honey)'}
            opacity={b.value > 0 ? 1 : 0.25}
          />
        )
      })}

      {target != null && Number.isFinite(target) && target > 0 && target <= hi && (
        <g>
          <line x1={padL} x2={W - padR} y1={y(target)} y2={y(target)} stroke="var(--blue)" strokeWidth="1.2" strokeDasharray="5 4" />
          <text x={W - padR} y={y(target) - 5} textAnchor="end" className="chart-tick chart-tick-target">
            目标 {fmt(target)}
          </text>
        </g>
      )}

      {labelIdx.map((i) => (
        <text key={i} x={padL + slot * i + slot / 2} y={height - 7} textAnchor="middle" className="chart-tick">
          {bars[i].label}
        </text>
      ))}
    </svg>
  )
}

/** 横向占比条，用于营养素供能比 */
export function RatioBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + Math.max(x.value, 0), 0)
  if (total <= 0) return <div className="chart-empty">还没有数据</div>

  return (
    <>
      <div className="ratio-bar">
        {segments.map((s) => (
          <div key={s.label} style={{ width: `${(Math.max(s.value, 0) / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="ratio-legend">
        {segments.map((s) => (
          <div key={s.label}>
            <span className="dot" style={{ background: s.color }} />
            <span className="nm">{s.label}</span>
            <span className="vl">{Math.round((Math.max(s.value, 0) / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </>
  )
}
