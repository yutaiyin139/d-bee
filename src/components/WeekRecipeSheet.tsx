import { useEffect, useState } from 'react'
import { Sheet } from './Sheet'
import {
  WEEK_RECIPE_TITLE, WEEK_RECIPE_SUBTITLE, WEEK_RECIPE_EMPTY,
  WEEK_RECIPE_UNIT_MEAL, WEEK_RECIPE_UNIT_KCAL,
  WEEK_RECIPE_LABEL_TOTAL, WEEK_RECIPE_LABEL_MEALS, WEEK_RECIPE_LABEL_KCAL,
  HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  type WeekDayView,
} from '@dbee/shared'
import { listMealsBetween } from '../lib/api'
import { buildWeekRecipeView, currentWeekDates } from '../lib/myPage'

/** 「本周食谱」= 本周已记录餐次汇总，不是推荐食谱内容库。 */
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
    <Sheet title={WEEK_RECIPE_TITLE} onClose={onClose}>
      <div className="helper" style={{ marginBottom: 12 }}>{WEEK_RECIPE_SUBTITLE}</div>
      {state === 'loading' && <div className="helper">{HEALTH_RECORD_LOADING}</div>}
      {state === 'error' && <div className="notice err">{HEALTH_RECORD_LOAD_ERROR}</div>}
      {state === 'ok' && (totalMeals === 0
        ? <div className="helper">{WEEK_RECIPE_EMPTY}</div>
        : (
          <>
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="list-line">
                <span>{WEEK_RECIPE_LABEL_TOTAL}</span>
                <span className="val">{totalMeals} {WEEK_RECIPE_UNIT_MEAL} · {totalKcal} {WEEK_RECIPE_UNIT_KCAL}</span>
              </div>
              <div className="list-line">
                <span>{WEEK_RECIPE_LABEL_MEALS}</span>
                <span className="val">{totalMeals}</span>
              </div>
              <div className="list-line">
                <span>{WEEK_RECIPE_LABEL_KCAL}</span>
                <span className="val">{totalKcal} {WEEK_RECIPE_UNIT_KCAL}</span>
              </div>
            </div>
            <div className="card">
              {rows.map((r) => (
                <div className="list-line" key={r.date}>
                  <span style={{ minWidth: 48 }}>{r.label}</span>
                  <span style={{ flex: 1, margin: '0 12px' }}>
                    <span style={{ display: 'block', height: 8, borderRadius: 99, background: 'var(--bg-2)' }}>
                      <span style={{ display: 'block', height: 8, borderRadius: 99, background: 'var(--honey)', width: `${maxKcal > 0 ? (r.kcal / maxKcal) * 100 : 0}%` }} />
                    </span>
                  </span>
                  <span className="val">{r.count} {WEEK_RECIPE_UNIT_MEAL} · {r.kcal} {WEEK_RECIPE_UNIT_KCAL}</span>
                </div>
              ))}
            </div>
          </>
        ))}
    </Sheet>
  )
}
