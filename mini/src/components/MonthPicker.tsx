/**
 * 月份日历选择器（对齐主工程 src/components/MonthPicker.tsx）。
 * 周日开头，可翻月、选中任意一天；有记录的日子带小圆点。
 */
import { useMemo, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { Sheet } from './Sheet'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function monthCells(year: number, month0: number): (string | null)[] {
  const lead = new Date(year, month0, 1).getDay()
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
  value: string
  today: string
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
    <Sheet title='选择日期' onClose={onClose}>
      <View className='cal-head'>
        <View className='cal-nav' onClick={() => shiftMonth(-1)}>‹</View>
        <Text className='cal-title'>{cursor.y} 年 {cursor.m + 1} 月</Text>
        <View className='cal-nav' onClick={() => shiftMonth(1)}>›</View>
      </View>

      <View className='cal-grid'>
        {WEEK.map((w) => (
          <Text key={w} className='cal-week'>{w}</Text>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <View key={`e${i}`} />
          const selected = d === value
          const isToday = d === today
          const future = d > today
          return (
            <View
              key={d}
              className={`cal-day mp-day ${selected ? 'is-selected' : ''} ${isToday ? 'cal-today' : ''} ${future ? 'is-future' : ''}`}
              onClick={() => onSelect(d)}
            >
              <Text>{Number(d.slice(-2))}</Text>
              {loggedSet.has(d) && <View className='mp-dot' />}
            </View>
          )
        })}
      </View>

      <View className='mp-foot'>
        <View className='btn-text' onClick={() => onSelect(today)}>回到今天</View>
        <Text className='mp-hint'>小圆点表示当天有记录</Text>
      </View>
    </Sheet>
  )
}
