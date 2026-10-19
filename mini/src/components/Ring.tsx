/**
 * 环形进度（对齐主工程 src/components/Ring.tsx）。
 *
 * 主工程用 SVG circle 画环；小程序无内联 SVG，这里把同一段 SVG circle
 * 序列化成 data URI 交给 <Image> 渲染，视觉与主工程 100% 一致
 * （同样的 track + progress + 圆角端点 strokeLinecap=round）。
 * 相比 conic-gradient 更稳（规避安卓微信内核不兼容 conic-gradient 的风险）。
 * 中央文字用绝对定位的 View 叠加在环图之上。
 */
import { Image, View } from '@tarojs/components'
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

function ringUri(size: number, stroke: number, ratio: number, color: string, trackColor: string): string {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = c * ratio
  const cx = size / 2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${trackColor}" stroke-width="${stroke}"/>` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 ${cx} ${cx})"/>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export function Ring({
  value,
  max,
  size = 148,
  stroke = 13,
  color = '#f2a93b',
  trackColor = '#f4efe4',
  children,
}: RingProps) {
  const safeMax = max > 0 ? max : 1
  const ratio = Math.max(0, Math.min(value / safeMax, 1))

  return (
    <View style={{ position: 'relative', width: `${size}px`, height: `${size}px`, flexShrink: 0 }}>
      <Image
        src={ringUri(size, stroke, ratio, color, trackColor)}
        style={{ width: `${size}px`, height: `${size}px` }}
        mode='aspectFit'
      />
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${size}px`,
          height: `${size}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </View>
  )
}
