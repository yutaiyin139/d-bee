/**
 * 打卡月历热力（对齐主工程 src/components/Calendar.tsx）。
 * 周一开头，按每日摄入相对预算着色。小程序用 View 网格实现。
 */
import { useMemo, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { monthGrid, todayKey } from '../lib/nutrition'
import { dayTone, type DayTone } from '../lib/report'

const WEEKS = ['一', '二', '三', '四', '五', '六', '日']

const TONE_CLASS: Record<DayTone, string> = {
  empty: 'cal-empty',
  under: 'cal-under',
  on: 'cal-on',
  over: 'cal-over',
}

interface CalendarProps {
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
    <View className='calendar'>
      <View className='cal-head'>
        <View className='cal-nav' onClick={() => shiftMonth(-1)}>‹</View>
        <Text className='cal-title'>
          {cursor.y} 年 {cursor.m + 1} 月
          <Text className='hint' style={{ marginLeft: '16px', fontWeight: 400 }}>
            {loggedCount} 天打卡
          </Text>
        </Text>
        <View className='cal-nav' onClick={() => shiftMonth(1)}>›</View>
      </View>

      <View className='cal-grid'>
        {WEEKS.map((w) => (
          <Text key={w} className='cal-week'>{w}</Text>
        ))}
        {cells.map((date, i) => {
          if (date === null) return <View key={`e${i}`} />
          const kcal = kcalMap.get(date)
          const logged = kcal !== undefined
          const tone = dayTone(kcal ?? 0, logged, targetKcal)
          const isToday = date === today
          return (
            <View key={date} className={`cal-day ${TONE_CLASS[tone]} ${isToday ? 'cal-today' : ''}`}>
              <Text>{Number(date.slice(-2))}</Text>
            </View>
          )
        })}
      </View>

      <View className='cal-legend'>
        <View className='cal-legend-item'><View className='cal-swatch cal-on' /><Text>达标</Text></View>
        <View className='cal-legend-item'><View className='cal-swatch cal-under' /><Text>偏少</Text></View>
        <View className='cal-legend-item'><View className='cal-swatch cal-over' /><Text>超标</Text></View>
        <View className='cal-legend-item'><View className='cal-swatch cal-empty' /><Text>未记录</Text></View>
      </View>
    </View>
  )
}
