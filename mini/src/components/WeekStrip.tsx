/**
 * 首页周历条（对齐主工程 src/components/WeekStrip.tsx）。
 * 周日开头，点选任意一天；支持左右滑动翻周。
 * 小程序端用 Taro 的 touch 事件实现滑动，点选与滑动用位移阈值区分。
 */
import { useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { weekOf } from '../lib/nutrition'

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const SWIPE_THRESHOLD = 40
const SWIPE_DAYS = 7
const MOVE_TOLERANCE = 6

interface WeekStripProps {
  date: string
  today: string
  loggedDates: string[]
  onPick: (date: string) => void
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

  function handleDown(e: any) {
    active.current = true
    moved.current = false
    startX.current = e.touches[0].clientX
    dx.current = 0
    setDragging(true)
  }

  function handleMove(e: any) {
    if (!active.current) return
    dx.current = e.touches[0].clientX - startX.current
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

  return (
    <View
      className={`week-strip ${dragging ? 'is-dragging' : ''}`}
      onTouchStart={handleDown}
      onTouchMove={handleMove}
      onTouchEnd={handleUp}
      onTouchCancel={handleUp}
    >
      <View
        className='ws-track'
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {days.map((d, i) => {
          const selected = d === date
          const future = d > today
          return (
            <View
              key={d}
              className={`ws-day ${selected ? 'is-selected' : ''} ${d === today ? 'is-today' : ''} ${future ? 'is-future' : ''}`}
              onClick={() => {
                if (moved.current) {
                  moved.current = false
                  return
                }
                onPick(d)
              }}
            >
              <Text className='wd'>{WEEK_LABELS[i]}</Text>
              <Text className='dn'>{Number(d.slice(-2))}</Text>
              <View className={`ws-dot ${loggedDates.includes(d) ? 'on' : ''}`} />
            </View>
          )
        })}
      </View>
    </View>
  )
}
