import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { weekOf } from '../lib/nutrition'

/**
 * 首页周历条：周日开头，点选任意一天。
 * 手机上左右滑动翻周 —— 向左滑看未来一周、向右滑看过去一周。
 *
 * 用 Pointer Events 统一处理触摸与鼠标（桌面端也能拖），
 * CSS 里 touch-action: pan-y 让竖向滚动仍交给浏览器，横向拖动才归我们。
 */

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/** 拖动超过这个距离才算一次翻周 */
const SWIPE_THRESHOLD = 40
/** 一次翻一周 */
const SWIPE_DAYS = 7
/** 超过这个位移就认为用户在拖动，抬起后不要触发点选 */
const MOVE_TOLERANCE = 6

interface WeekStripProps {
  /** 当前选中日期 YYYY-MM-DD */
  date: string
  today: string
  /** 近半年内有记录的日期，用于给日子加小圆点 */
  loggedDates: string[]
  onPick: (date: string) => void
  /** 翻周：-7 上一周 / +7 下一周 */
  onShiftDays: (days: number) => void
}

export function WeekStrip({ date, today, loggedDates, onPick, onShiftDays }: WeekStripProps) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const active = useRef(false)
  const moved = useRef(false)
  const startX = useRef(0)
  const dx = useRef(0)

  const days = weekOf(date)

  function handleDown(e: ReactPointerEvent<HTMLDivElement>) {
    active.current = true
    moved.current = false
    startX.current = e.clientX
    dx.current = 0
    setDragging(true)
    // 捕获指针：手指/鼠标移出条外也能收到 move / up
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  function handleMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!active.current) return
    dx.current = e.clientX - startX.current
    if (Math.abs(dx.current) > MOVE_TOLERANCE) moved.current = true
    if (moved.current) setOffset(dx.current)
  }

  function handleUp() {
    if (!active.current) return
    active.current = false
    setDragging(false)
    setOffset(0)
    const d = dx.current
    dx.current = 0
    if (d <= -SWIPE_THRESHOLD) onShiftDays(SWIPE_DAYS)
    else if (d >= SWIPE_THRESHOLD) onShiftDays(-SWIPE_DAYS)
  }

  function handleCancel() {
    active.current = false
    setDragging(false)
    setOffset(0)
    dx.current = 0
  }

  return (
    <div
      className={`week-strip ${dragging ? 'is-dragging' : ''}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleCancel}
      role="group"
      aria-label="周历，左右滑动可切换周"
    >
      <div
        className="ws-track"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {days.map((d, i) => {
          const selected = d === date
          const future = d > today
          return (
            <button
              key={d}
              className={`ws-day ${selected ? 'is-selected' : ''} ${d === today ? 'is-today' : ''} ${future ? 'is-future' : ''}`}
              onClick={() => {
                // 拖动结束后紧跟的这次 click 不算点选
                if (moved.current) {
                  moved.current = false
                  return
                }
                onPick(d)
              }}
            >
              <span className="wd">{WEEK_LABELS[i]}</span>
              <span className="dn">{Number(d.slice(-2))}</span>
              <span className={`ws-dot ${loggedDates.includes(d) ? 'on' : ''}`} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
