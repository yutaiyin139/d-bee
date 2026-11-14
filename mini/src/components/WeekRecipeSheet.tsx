import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import {
  WEEK_RECIPE_TITLE, WEEK_RECIPE_SUBTITLE, WEEK_RECIPE_EMPTY,
  WEEK_RECIPE_UNIT_MEAL, WEEK_RECIPE_UNIT_KCAL,
  WEEK_RECIPE_LABEL_TOTAL, WEEK_RECIPE_LABEL_MEALS, WEEK_RECIPE_LABEL_KCAL,
  HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  type WeekDayView,
} from '@dbee/shared'
import { listMealsBetween } from '../lib/api'
import { buildWeekRecipeView, currentWeekDates } from '../lib/myPage'
import './MyPageSheets.scss'

/** 「本周食谱」= 本周已记录餐次汇总，与主端同构。 */
export function WeekRecipeSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [rows, setRows] = useState<WeekDayView[]>([])

  useEffect(() => {
    let alive = true
    const week = currentWeekDates()
    void listMealsBetween(week[0], week[week.length - 1]).then((m) => {
      if (!alive) return
      setRows(buildWeekRecipeView(m))
      setState('ok')
    }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [])

  const totalMeals = rows.reduce((s, r) => s + r.count, 0)
  const totalKcal = rows.reduce((s, r) => s + r.kcal, 0)
  const maxKcal = Math.max(0, ...rows.map((r) => r.kcal))

  return (
    <View className='mp-mask' onClick={onClose}>
      <View className='mp-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='mp-head'>
          <Text className='mp-title'>{WEEK_RECIPE_TITLE}</Text>
          <View className='mp-close' onClick={onClose}><Text>×</Text></View>
        </View>
        <View className='mp-body'>
          <Text className='mp-helper'>{WEEK_RECIPE_SUBTITLE}</Text>
          {state === 'loading' ? <Text className='mp-helper'>{HEALTH_RECORD_LOADING}</Text> : null}
          {state === 'error' ? <Text className='mp-helper'>{HEALTH_RECORD_LOAD_ERROR}</Text> : null}
          {state === 'ok' && totalMeals === 0 ? <Text className='mp-helper'>{WEEK_RECIPE_EMPTY}</Text> : null}
          {state === 'ok' && totalMeals > 0 ? (
            <>
              <View className='mp-card'>
                <View className='mp-line'><Text>{WEEK_RECIPE_LABEL_TOTAL}</Text><Text className='mp-val'>{totalMeals} {WEEK_RECIPE_UNIT_MEAL} · {totalKcal} {WEEK_RECIPE_UNIT_KCAL}</Text></View>
                <View className='mp-line'><Text>{WEEK_RECIPE_LABEL_MEALS}</Text><Text className='mp-val'>{totalMeals}</Text></View>
                <View className='mp-line'><Text>{WEEK_RECIPE_LABEL_KCAL}</Text><Text className='mp-val'>{totalKcal} {WEEK_RECIPE_UNIT_KCAL}</Text></View>
              </View>
              <View className='mp-card'>
                {rows.map((r) => (
                  <View className='mp-line' key={r.date}>
                    <Text style={{ width: 96 }}>{r.label}</Text>
                    <View className='mp-bar-track'>
                      <View className='mp-bar-fill' style={{ width: `${maxKcal > 0 ? (r.kcal / maxKcal) * 100 : 0}%` }} />
                    </View>
                    <Text className='mp-val'>{r.count} {WEEK_RECIPE_UNIT_MEAL}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
        </View>
      </View>
    </View>
  )
}
