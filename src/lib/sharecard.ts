/**
 * 分享卡片绘制核心（纯 Canvas，零平台依赖）。
 *
 * 三端（Web / Android WebView / iOS WKWebView）行为一致，不引入 html2canvas，
 * 不依赖任何需要网络加载的 webfont（只用系统字体栈）。
 *
 * 卡片内容全部走固定模板（非用户输入正文），无 UGC 合规风险。
 * 尺寸统一 720×960（3:4，适配朋友圈/微信卡片）。
 */

export interface CheckinCardData {
  /** 连续打卡天数 */
  streak: number
  /** 最长连续 */
  longest: number
  /** 累计打卡天数 */
  total: number
  /** 下一个里程碑（无则 null） */
  nextMilestone: number | null
  /** 今日三项打卡完成情况 */
  checkin: { meal: boolean; water: boolean; exercise: boolean }
  /** 今日摄入 / 目标 kcal（可选，0 表示不展示） */
  kcal?: number
  kcalTarget?: number
}

export interface BadgeCardData {
  name: string
  desc: string
  emoji: string
}

export interface InviteCardData {
  code: string
  link: string
}

const W = 720
const H = 960

// 品牌色（与全局 --honey / --honey-dark 对齐）
const BRAND = '#F5A623'
const BRAND_DARK = '#C77F0A'
const INK = '#2B2B2B'
const INK_2 = '#6B6B6B'
const INK_3 = '#9B9B9B'
const LINE = '#E8E0D2'
const SOFT = '#FBF3E4'
const GREEN = '#4CAF7D'

/** 圆角矩形路径 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 统一字体 */
function font(size: number, weight = 400): string {
  return `${weight} ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
}

/** 绘制品牌头部（logo emoji + 名称），返回头部底部的 y 坐标 */
function drawBrand(ctx: CanvasRenderingContext2D, subtitle: string): number {
  // 顶部色带
  ctx.fillStyle = BRAND
  ctx.fillRect(0, 0, W, 8)

  ctx.fillStyle = BRAND
  ctx.beginPath()
  ctx.arc(56, 72, 26, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#fff'
  ctx.font = font(26)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('🐝', 56, 73)

  ctx.fillStyle = INK
  ctx.font = font(30, 700)
  ctx.textAlign = 'left'
  ctx.fillText('自律蜜蜂', 92, 62)

  ctx.fillStyle = INK_3
  ctx.font = font(20)
  ctx.fillText(subtitle, 92, 96)

  return 128
}

/** 绘制底部 CTA（下载提示 + 品牌 footer） */
function drawFooter(ctx: CanvasRenderingContext2D): void {
  const y = H - 96
  ctx.fillStyle = SOFT
  roundRect(ctx, 40, y, W - 80, 56, 28)
  ctx.fill()

  ctx.fillStyle = BRAND_DARK
  ctx.font = font(22, 600)
  ctx.textAlign = 'left'
  ctx.fillText('下载「自律蜜蜂」，一起变自律', 64, y + 28)

  ctx.fillStyle = INK_3
  ctx.font = font(17)
  ctx.textAlign = 'right'
  ctx.fillText('扫描下方说明或搜索应用商店', W - 64, y + 28)
}

/** 画打勾圆圈 */
function drawCheck(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ok: boolean): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = ok ? GREEN : LINE
  ctx.fill()
  if (ok) {
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x - r * 0.45, y)
    ctx.lineTo(x - r * 0.1, y + r * 0.4)
    ctx.lineTo(x + r * 0.5, y - r * 0.35)
    ctx.stroke()
  }
}

/**
 * 卡片 1：每日打卡卡
 */
export function drawCheckinCard(canvas: HTMLCanvasElement, data: CheckinCardData): void {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, W, H)

  drawBrand(ctx, '今日自律打卡')

  // 核心数据：连续天数
  ctx.textAlign = 'center'
  ctx.fillStyle = INK
  ctx.font = font(120, 700)
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(String(data.streak), W / 2 - 70, 290)

  ctx.fillStyle = INK_2
  ctx.font = font(40)
  ctx.textAlign = 'left'
  ctx.fillText('连续自律', W / 2 - 10, 275)
  ctx.fillText('天', W / 2 - 10, 315)

  // 进度条：当前连续 → 下一里程碑
  let progY = 360
  if (data.nextMilestone) {
    ctx.fillStyle = INK_3
    ctx.font = font(22)
    ctx.textAlign = 'center'
    ctx.fillText(`距 ${data.nextMilestone} 天里程碑还差 ${data.nextMilestone - data.streak} 天`, W / 2, progY - 14)

    const trackX = 90
    const trackW = W - 180
    const ratio = Math.min(data.streak / data.nextMilestone, 1)
    ctx.fillStyle = LINE
    roundRect(ctx, trackX, progY, trackW, 14, 7)
    ctx.fill()
    ctx.fillStyle = BRAND
    if (ratio > 0) {
      roundRect(ctx, trackX, progY, Math.max(trackW * ratio, 14), 14, 7)
      ctx.fill()
    }
    progY += 40
  }

  // 历史小结
  ctx.fillStyle = INK_3
  ctx.font = font(22)
  ctx.textAlign = 'center'
  ctx.fillText(`最长 ${data.longest} 天 · 累计 ${data.total} 天`, W / 2, progY + 10)
  progY += 40

  // 今日完成三格
  const items = [
    { label: '记一餐', ok: data.checkin.meal },
    { label: '饮水', ok: data.checkin.water },
    { label: '运动', ok: data.checkin.exercise },
  ]
  const gap = 70
  const startX = W / 2 - gap
  items.forEach((it, i) => {
    const cx = startX + i * gap
    drawCheck(ctx, cx, progY + 40, 26, it.ok)
    ctx.fillStyle = it.ok ? INK : INK_3
    ctx.font = font(24, it.ok ? 600 : 400)
    ctx.textAlign = 'center'
    ctx.fillText(it.label, cx, progY + 96)
  })
  progY += 130

  // 热量小结（可选）
  if (data.kcal && data.kcalTarget) {
    ctx.fillStyle = SOFT
    roundRect(ctx, 90, progY, W - 180, 64, 16)
    ctx.fill()
    ctx.fillStyle = INK_2
    ctx.font = font(24)
    ctx.textAlign = 'center'
    ctx.fillText(`今日摄入 ${data.kcal} / 目标 ${data.kcalTarget} kcal`, W / 2, progY + 40)
    progY += 84
  }

  // 一句话文案
  ctx.fillStyle = INK
  ctx.font = font(30, 600)
  ctx.textAlign = 'center'
  ctx.fillText('我在「自律蜜蜂」坚持记录饮食，', W / 2, progY + 20)
  ctx.fillText('一起变自律吧！', W / 2, progY + 60)

  drawFooter(ctx)
}

/**
 * 卡片 2：成就徽章卡
 */
export function drawBadgeCard(canvas: HTMLCanvasElement, data: BadgeCardData): void {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, W, H)

  drawBrand(ctx, '成就徽章')

  // 徽章主体
  const cx = W / 2
  const cy = 320
  ctx.fillStyle = SOFT
  ctx.beginPath()
  ctx.arc(cx, cy, 130, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = BRAND
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(cx, cy, 130, 0, Math.PI * 2)
  ctx.stroke()

  ctx.font = font(100)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(data.emoji || '🏆', cx, cy + 4)

  // 徽章名
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = INK
  ctx.font = font(48, 700)
  ctx.textAlign = 'center'
  ctx.fillText(data.name, cx, 500)

  ctx.fillStyle = INK_2
  ctx.font = font(28)
  ctx.fillText(data.desc, cx, 548)

  // 一句话文案
  ctx.fillStyle = INK
  ctx.font = font(30, 600)
  ctx.fillText('我在「自律蜜蜂」解锁了新成就，', cx, 640)
  ctx.fillText('坚持记录让我更自律！', cx, 680)

  drawFooter(ctx)
}

/**
 * 卡片 3：邀请卡
 */
export function drawInviteCard(canvas: HTMLCanvasElement, data: InviteCardData): void {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, W, H)

  drawBrand(ctx, '邀请好友一起自律')

  // 邀请码大字号
  ctx.fillStyle = INK_2
  ctx.font = font(26)
  ctx.textAlign = 'center'
  ctx.fillText('我的邀请码', W / 2, 240)

  ctx.fillStyle = BRAND_DARK
  ctx.font = font(96, 700)
  ctx.fillText(data.code || '————', W / 2, 360)

  // 分隔线
  ctx.fillStyle = LINE
  ctx.fillRect(90, 420, W - 180, 2)

  // 说明文案
  ctx.fillStyle = INK
  ctx.font = font(30, 600)
  ctx.fillText('输入邀请码注册，', W / 2, 500)
  ctx.fillText('双方都能获得积分奖励！', W / 2, 540)

  ctx.fillStyle = INK_2
  ctx.font = font(24)
  ctx.fillText('识别下方说明或复制链接打开', W / 2, 600)

  // 链接（短化显示）
  const link = data.link.replace(/^https?:\/\//, '')
  ctx.fillStyle = INK_3
  ctx.font = font(20)
  ctx.fillText(link, W / 2, 640)

  drawFooter(ctx)
}

/** Canvas → PNG Blob */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('生成图片失败'))
    }, 'image/png')
  })
}

/** 便捷：创建离屏 canvas */
export function createShareCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}
