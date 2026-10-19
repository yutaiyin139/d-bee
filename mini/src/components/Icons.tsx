/**
 * 小程序端图标组件（对齐主工程 src/components/Icons.tsx）。
 *
 * 关键差异：微信/支付宝/抖音小程序没有内联 <svg> 原生组件，主工程的 SVG 无法直接复用。
 * 这里把每个图标的 SVG 序列化成 base64 data URI，用 <Image> 渲染，
 * 视觉上与主工程 100% 一致（同一套 path/stroke/fill）。
 *
 * 约定：
 *  - color 支持任意 CSS 颜色值（含主工程 var(--x)，但小程序无 CSS 变量运行时，
 *    调用方须传具体色值，如 '#b9740d'；这里已按主工程默认色预置）。
 *  - size 默认 18，单位 px（Taro Image 会用 rpx，这里用 style 指定 px）。
 */
import { Image } from '@tarojs/components'
import type { CSSProperties } from 'react'

interface IconProps {
  color?: string
  size?: number
  style?: CSSProperties
}

/** 把 SVG 字符串编码为 data URI（颜色未注入，用 currentColor 或直接拼进 stroke） */
function svgUri(body: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="24" height="24">${body}</svg>`
  // 用 encodeURIComponent 安全编码（含 # 等字符），小程序 Image 可解析
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function iconPath(body: (c: string) => string): (p: IconProps) => JSX.Element {
  return function Icon({ color = 'currentColor', size = 18, style }: IconProps) {
    // 小程序里 currentColor 无意义，落到默认墨色
    const c = color === 'currentColor' ? '#2a2723' : color
    return (
      <Image
        src={svgUri(body(c), c)}
        style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0, ...style }}
        mode='aspectFit'
      />
    )
  }
}

/** 刀叉：用于「已摄入」 */
export const IconFork = iconPath(
  (c) => `<path d="M7 3.5v6.2M4.6 3.5v3.9a2.4 2.4 0 004.8 0V3.5M7 13.7v6.8" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 3.5c-1.9 0-3.1 2.3-3.1 5.1s1.2 4.7 3.1 4.7v7.2" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
)

/** 实心圆豆：用于「蛋白质」 */
export const IconPea = iconPath(
  (c) => `<circle cx="12" cy="12" r="8.5" fill="${c}"/><circle cx="9.4" cy="9.6" r="2.1" fill="#fff" opacity="0.5"/>`,
)

/** 实心水滴：用于「碳水化合物 / 脂肪」 */
export const IconDrop = iconPath(
  (c) => `<path d="M12 3.2c3.2 4.1 6 7.6 6 10.8a6 6 0 11-12 0c0-3.2 2.8-6.7 6-10.8z" fill="${c}"/><path d="M9.2 14.6a2.9 2.9 0 002.4 2.7" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>`,
)

/** 火焰：用于「已消耗」「连续打卡」 */
export const IconFire = iconPath(
  (c) => `<path d="M12 3.5c.6 2.6 2.3 3.9 3.9 5.6 1.5 1.6 2.4 3.2 2.4 5.1A6.3 6.3 0 0112 20.5a6.3 6.3 0 01-6.3-6.3c0-2.4 1.3-4.3 2.8-5.6" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/><path d="M12 20.5c-1.7-.6-2.6-1.9-2.6-3.4 0-1.8 1.6-2.9 2.6-4.6 1 1.7 2.6 2.8 2.6 4.6 0 1.5-.9 2.8-2.6 3.4z" fill="${c}" opacity="0.35"/>`,
)

/** 水滴轮廓：用于「饮水」 */
export const IconWater = iconPath(
  (c) => `<path d="M12 3.2c3.2 4.1 6 7.6 6 10.8a6 6 0 11-12 0c0-3.2 2.8-6.7 6-10.8z" stroke="${c}" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.4 14.2a2.8 2.8 0 002.4 2.6" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`,
)

/** 跑步：用于「运动」 */
export const IconRun = iconPath(
  (c) => `<circle cx="14.5" cy="4.6" r="1.9" stroke="${c}" stroke-width="1.6"/><path d="M13.4 8.2l-3.4 2.3 1.8 3-2.5 4.3M13.4 8.2l3 1.2 2 2.6M13.4 8.2l.9 5.1 3.4 2M10.9 13.5l-3.7 1.4" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
)

/** 加号：用于「记一餐」等 */
export const IconPlus = iconPath(
  (c) => `<path d="M12 5v14M5 12h14" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
)

/** 皇冠：用于「会员」 */
export const IconCrown = iconPath(
  (c) => `<path d="M4 17.5l-1.2-9 5 3.6L12 5.5l4.2 6.6 5-3.6-1.2 9H4z" stroke="${c}" stroke-width="1.7" stroke-linejoin="round"/><path d="M5 20h14" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>`,
)

/** 锁：用于「付费功能」 */
export const IconLock = iconPath(
  (c) => `<rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="${c}" stroke-width="1.7"/><path d="M8.2 10.5V8a3.8 3.8 0 017.6 0v2.5" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>`,
)

/** 下载：用于「导出」 */
export const IconDownload = iconPath(
  (c) => `<path d="M12 4v10m0 0l-3.8-3.8M12 14l3.8-3.8M5 19h14" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
)

/** 垃圾桶：用于「清空 / 注销」 */
export const IconTrash = iconPath(
  (c) => `<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 011.5-1.5h2A1.5 1.5 0 0114.5 5v1.5M6.5 6.5l.9 12a2 2 0 002 1.9h5.2a2 2 0 002-1.9l.9-12" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 10.5v6M14 10.5v6" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`,
)

/** 体重秤：用于「体重」 */
export const IconWeight = iconPath(
  (c) => `<rect x="3.5" y="7" width="17" height="13" rx="3" stroke="${c}" stroke-width="1.7"/><path d="M12 12.5l3-3" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/><path d="M8 7l1.6-2.6h4.8L16 7" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
)

/** 今日 tab（日历圆） */
export function IconToday({ active = false, size = 20 }: { active?: boolean; size?: number }) {
  const c = active ? '#b9740d' : '#2a2723'
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="24" height="24">` +
    `<circle cx="12" cy="12" r="8.2" stroke="${c}" stroke-width="1.7"/>` +
    `<circle cx="12" cy="12" r="3.1" fill="${active ? c : 'none'}" stroke="${c}" stroke-width="1.7"/>` +
    `</svg>`
  return (
    <Image
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`}
      style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0 }}
      mode='aspectFit'
    />
  )
}

/** 报告 tab（柱状图） */
export function IconChart({ active = false, size = 20 }: { active?: boolean; size?: number }) {
  const c = active ? '#b9740d' : '#2a2723'
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="24" height="24">` +
    `<path d="M4 20V9.5M10 20V4.5M16 20v-7M22 20H2" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>` +
    `</svg>`
  return (
    <Image
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`}
      style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0 }}
      mode='aspectFit'
    />
  )
}

/** 我的 tab（人像） */
export function IconMe({ active = false, size = 20 }: { active?: boolean; size?: number }) {
  const c = active ? '#b9740d' : '#2a2723'
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="24" height="24">` +
    `<circle cx="12" cy="8.4" r="3.7" stroke="${c}" stroke-width="1.7"/>` +
    `<path d="M4.6 20c.7-4 3.6-6.1 7.4-6.1s6.7 2.1 7.4 6.1" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>` +
    `</svg>`
  return (
    <Image
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`}
      style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0 }}
      mode='aspectFit'
    />
  )
}

/** 蜜蜂 Logo（对齐主工程 AuthScreen 的 brand hero 图标，含蜂蜜色椭圆身 + 深色花纹） */
export function IconBee({ size = 54 }: { size?: number }) {
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    `<ellipse cx="12" cy="14.5" rx="6" ry="5" fill="#f2a93b"/>` +
    `<path d="M8 6.2c0-1.7 1.2-2.9 2.6-2.9s2.4 1.1 2.4 2.6M16 6.4c0-1.6-1-2.7-2.3-2.7" stroke="#b9740d" stroke-width="1.5" fill="none" stroke-linecap="round"/>` +
    `<path d="M6 12.5h12M6 16.5h12" stroke="rgba(74,50,8,.45)" stroke-width="1.3" stroke-linecap="round"/>` +
    `</svg>`
  return (
    <Image
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`}
      style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0 }}
      mode='aspectFit'
    />
  )
}
