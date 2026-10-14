import { useMemo, useState } from 'react'
import { Sheet } from './Sheet'

/**
 * 月份日历选择器：点右上角日期打开，可翻月、选中任意一天（含未来）。
 * 周日开头，与首页周历条保持一致；有记录的日子带小圆点。
 */

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 周日开头的整月网格，空位为 null */
function monthCells(year: number, month0: number): (string | null)[] {
  const lead = new Date(year, month0, 1).getDay() // 周日 = 0
  const daysInMonth = new Date(year, month0 + 1, 0).getDate()
  const cells: (string | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

interface MonthPickerProps {
  /** 当前选中日期 */
  value: string
  today: string
  /** 近半年内有记录的日期，用于打点 */
  loggedDates: string[]
  onSelect: (date: string) => void
  onClose: () => void
}

export function MonthPicker({ value, today, loggedDates, onSelect, onClose }: MonthPickerProps) {
  const [cursor, setCursor] = useState(() => {
    const [y, m] = value.split('-').map(Number)
    return { y, m: m - 1 }
  })

  const cells = useMemo(() => monthCells(cursor.y, cursor.m), [cursor])
  const loggedSet = useMemo(() => new Set(loggedDates), [loggedDates])

  function shiftMonth(delta: number) {
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  return (
    <Sheet title="选择日期" onClose={onClose}>
      <div className="cal-head">
        <button className="cal-nav" onClick={() => shiftMonth(-1)} aria-label="上个月">
          ‹
        </button>
        <span className="cal-title">
          {cursor.y} 年 {cursor.m + 1} 月
        </span>
        <button className="cal-nav" onClick={() => shiftMonth(1)} aria-label="下个月">
          ›
        </button>
      </div>

      <div className="cal-grid">
        {WEEK.map((w) => (
          <span key={w} className="cal-week">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <span key={`e${i}`} />
          const selected = d === value
          const isToday = d === today
          const future = d > today
          return (
            <button
              key={d}
              className={`cal-day mp-day ${selected ? 'is-selected' : ''} ${isToday ? 'cal-today' : ''} ${future ? 'is-future' : ''}`}
              onClick={() => onSelect(d)}
              aria-label={`选择 ${d}`}
            >
              {Number(d.slice(-2))}
              {loggedSet.has(d) && <i className="mp-dot" />}
            </button>
          )
        })}
      </div>

      <div className="mp-foot">
        <button className="btn-text" onClick={() => onSelect(today)}>
          回到今天
        </button>
        <span className="mp-hint">小圆点表示当天有记录</span>
      </div>
    </Sheet>
  )
}
