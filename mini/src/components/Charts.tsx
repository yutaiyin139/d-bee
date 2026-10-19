/**
 * 轻量图表组件（小程序端，SVG → base64 data URI）。
 *
 * 小程序无内联 <svg>，这里把主工程 src/components/Charts.tsx 的同一段 SVG
 * 序列化成 data URI 交给 <Image> 渲染，视觉与主工程 100% 一致。
 * 与 Ring.tsx / Icons.tsx 采用同一策略。
 *
 * 颜色：主工程用 CSS 变量（var(--honey) 等），小程序无 CSS 变量运行时，
 * 这里直接落成对应十六进制色值（见 tokens.scss）。
 */
import { Image, View, Text } from '@tarojs/components'

const W = 340

// 设计 token 色值（与 tokens.scss 对齐）
const C_HONEY = '#f2a93b'
const C_BLUE = '#3d7bb8'
const C_RED = '#d05c4e'
const C_GREEN = '#3f9463'
const C_LINE = 'rgba(42,39,35,0.09)'
const C_LINE2 = 'rgba(42,39,35,0.16)'
const C_INK3 = '#a39c90'
const C_SURFACE = '#ffffff'

function svgUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export interface LinePoint {
  label: string
  value: number
}

interface LineChartProps {
  points: LinePoint[]
  target?: number | null
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
  color = C_HONEY,
  emptyText = '还没有数据',
}: LineChartProps) {
  if (points.length === 0) {
    return <View className='chart-empty'><Text>{emptyText}</Text></View>
  }

  const values = points.map((p) => p.value)
  const all = target != null && Number.isFinite(target) ? [...values, target] : values
  let lo = Math.min(...all)
  let hi = Math.max(...all)
  if (hi - lo < 0.2) { lo -= 0.5; hi += 0.5 }
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
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`

  const gridVals = [hi, (hi + lo) / 2, lo]
  const last = points[points.length - 1]
  const labelIdx = points.length <= 3 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1]

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">`
  svg += `<defs><linearGradient id="lf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.22"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs>`

  for (const v of gridVals) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="${C_LINE}" stroke-width="1" stroke-dasharray="${v === (hi + lo) / 2 ? '3 4' : '0'}"/>`
    svg += `<text x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="9" fill="${C_INK3}">${fmt(v)}</text>`
  }

  if (target != null && Number.isFinite(target) && target >= lo && target <= hi) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(target)}" y2="${y(target)}" stroke="${C_BLUE}" stroke-width="1.2" stroke-dasharray="5 4"/>`
    svg += `<text x="${W - padR}" y="${y(target) - 5}" text-anchor="end" font-size="9" fill="${C_BLUE}">目标 ${fmt(target)}${unit}</text>`
  }

  svg += `<path d="${area}" fill="url(#lf)"/>`
  svg += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`

  if (points.length <= 20) {
    for (let i = 0; i < points.length; i++) {
      svg += `<circle cx="${x(i)}" cy="${y(points[i].value)}" r="${points.length === 1 ? 4 : 2.6}" fill="${C_SURFACE}" stroke="${color}" stroke-width="1.8"/>`
    }
  }

  if (points.length === 1) {
    svg += `<text x="${x(0)}" y="${y(points[0].value) - 10}" text-anchor="middle" font-size="9" fill="${C_INK3}">${fmt(points[0].value)}${unit}</text>`
  }

  if (points.length > 1) {
    svg += `<text x="${x(points.length - 1)}" y="${y(last.value) - 9}" text-anchor="end" font-size="9" fill="${C_INK3}" font-weight="600">${fmt(last.value)}${unit}</text>`
  }

  for (const i of labelIdx) {
    svg += `<text x="${x(i)}" y="${height - 7}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}" font-size="9" fill="${C_INK3}">${points[i].label}</text>`
  }

  svg += `</svg>`

  return (
    <Image
      src={svgUri(svg)}
      style={{ width: '100%', height: `${(height / W) * 100}%`, minHeight: `${height}px` }}
      mode='widthFix'
    />
  )
}

export interface Bar {
  label: string
  value: number
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
    return <View className='chart-empty'><Text>{emptyText}</Text></View>
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

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">`
  for (let i = 0; i < 2; i++) {
    const v = i === 0 ? hi : hi / 2
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="${C_LINE}" stroke-width="1" stroke-dasharray="${i ? '3 4' : '0'}"/>`
    svg += `<text x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="9" fill="${C_INK3}">${fmt(v)}</text>`
  }
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="${C_LINE2}" stroke-width="1"/>`

  bars.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2
    const h = Math.max(b.value > 0 ? 2 : 0, (b.value / hi) * plotH)
    svg += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, barW / 2)}" fill="${b.tone === 'over' ? C_RED : C_HONEY}" opacity="${b.value > 0 ? 1 : 0.25}"/>`
  })

  if (target != null && Number.isFinite(target) && target > 0 && target <= hi) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(target)}" y2="${y(target)}" stroke="${C_BLUE}" stroke-width="1.2" stroke-dasharray="5 4"/>`
    svg += `<text x="${W - padR}" y="${y(target) - 5}" text-anchor="end" font-size="9" fill="${C_BLUE}">目标 ${fmt(target)}</text>`
  }

  for (const i of labelIdx) {
    svg += `<text x="${padL + slot * i + slot / 2}" y="${height - 7}" text-anchor="middle" font-size="9" fill="${C_INK3}">${bars[i].label}</text>`
  }

  svg += `</svg>`

  return (
    <Image
      src={svgUri(svg)}
      style={{ width: '100%', height: `${(height / W) * 100}%`, minHeight: `${height}px` }}
      mode='widthFix'
    />
  )
}

/** 横向占比条（营养素供能比） */
export function RatioBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + Math.max(x.value, 0), 0)
  if (total <= 0) return <View className='chart-empty'><Text>还没有数据</Text></View>

  return (
    <>
      <View className='ratio-bar'>
        {segments.map((s) => (
          <View key={s.label} style={{ width: `${(Math.max(s.value, 0) / total) * 100}%`, background: s.color }} />
        ))}
      </View>
      <View className='ratio-legend'>
        {segments.map((s) => (
          <View key={s.label} className='ratio-item'>
            <View className='dot' style={{ background: s.color }} />
            <Text className='nm'>{s.label}</Text>
            <Text className='vl'>{Math.round((Math.max(s.value, 0) / total) * 100)}%</Text>
          </View>
        ))}
      </View>
    </>
  )
}

export { C_HONEY, C_BLUE, C_GREEN }
