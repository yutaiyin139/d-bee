import { useMemo, useState } from 'react'
import { monthGrid, todayKey } from '../lib/nutrition'
import { dayTone, type DayTone } from '../lib/report'

/**
 * 打卡月历（热力）：周一开头，按每日摄入相对预算着色。
 * 自律茄子把它叫「连续记录日历」——核心是让人一眼看到哪几天坚持了。
 */

const WEEKS = ['一', '二', '三', '四', '五', '六', '日']

const TONE_CLASS: Record<DayTone, string> = {
  empty: 'cal-empty',
  under: 'cal-under',
  on: 'cal-on',
  over: 'cal-over',
}

interface CalendarProps {
  /** 日期 → 当日总摄入 */
  kcalMap: Map<string, number>
  targetKcal: number
}

export function CalendarHeatmap({ kcalMap, targetKcal }: CalendarProps) {
  const now = new Date()
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() })
  const today = todayKey()

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor])

  const shiftMonth = (delta: number) => {
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  const loggedCount = cells.filter((c) => c !== null && kcalMap.has(c)).length

  return (
    <div className="calendar">
      <div className="cal-head">
        <button className="cal-nav" onClick={() => shiftMonth(-1)} aria-label="上个月">‹</button>
        <span className="cal-title">
          {cursor.y} 年 {cursor.m + 1} 月
          <span className="hint" style={{ marginLeft: 8, fontWeight: 400 }}>
            {loggedCount} 天打卡
          </span>
        </span>
        <button className="cal-nav" onClick={() => shiftMonth(1)} aria-label="下个月">›</button>
      </div>

      <div className="cal-grid">
        {WEEKS.map((w) => (
          <span key={w} className="cal-week">{w}</span>
        ))}
        {cells.map((date, i) => {
          if (date === null) return <span key={`e${i}`} />
          const kcal = kcalMap.get(date)
          const logged = kcal !== undefined
          const tone = dayTone(kcal ?? 0, logged, targetKcal)
          const isToday = date === today
          return (
            <span
              key={date}
              className={`cal-day ${TONE_CLASS[tone]} ${isToday ? 'cal-today' : ''}`}
              title={logged ? `${date} · ${Math.round(kcal!)} kcal` : `${date} · 未记录`}
            >
              {Number(date.slice(-2))}
            </span>
          )
        })}
      </div>

      <div className="cal-legend">
        <span><i className="cal-on" />达标</span>
        <span><i className="cal-under" />偏少</span>
        <span><i className="cal-over" />超标</span>
        <span><i className="cal-empty" />未记录</span>
      </div>
    </div>
  )
}
