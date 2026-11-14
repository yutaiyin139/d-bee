import { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import {
  HEALTH_RECORD_TITLE, HEALTH_RECORD_ANCHORS, HEALTH_RECORD_ANCHOR_ARIA,
  HEALTH_RECORD_COMPLETION, HEALTH_RECORD_LABELS, HEALTH_RECORD_UNITS,
  HEALTH_RECORD_MACRO_LABELS, HEALTH_RECORD_MACRO_COLORS,
  HEALTH_RECORD_DISCLAIMER, HEALTH_RECORD_NO_MEDICAL,
  HEALTH_RECORD_EMPTY_MEAL, HEALTH_RECORD_EMPTY_WEIGHT, HEALTH_RECORD_EMPTY_EXERCISE,
  HEALTH_RECORD_NOT_CONNECTED, HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  buildMealSplitCore, buildExerciseWeekCore, buildWaterCore, buildTodayKcalCore, buildMacroRatioCore,
  HEALTH_PLAN_BMI_BANDS, HEALTH_PLAN_BMI_ARIA_PREFIX, HEALTH_PLAN_BMI_ARIA_TAIL,
  calcBmiCore, calcBmrCore, bmiBandOf, roundTo,
} from '@dbee/shared'
import type { Profile, MealEntry, WaterLog, ExerciseLog, WeightLog } from '../lib/api'
import {
  listMealsByDate, listWaterByDate, listExerciseByDate, listWeightLogsAsc,
} from '../lib/api'
import { buildCompletion, currentWeekDates } from '../lib/myPage'
import { syncFromHealth, estimateActivityKcal } from '../lib/health'
import { todayKey } from '../lib/nutrition'
import './MyPageSheets.scss'

interface HealthRecordSheetProps {
  profile: Profile
  onClose: () => void
}

/**
 * 健康档案：单态 Sheet + 四段锚点，零新增字段、零空值占位卡、零医学结论。
 * 与主端 src/components/HealthRecordSheet.tsx 一一对应，文案与聚合函数共用 shared 真源。
 */
export function HealthRecordSheet({ profile, onClose }: HealthRecordSheetProps) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [anchor, setAnchor] = useState('')
  const [meals, setMeals] = useState<MealEntry[]>([])
  const [water, setWater] = useState<WaterLog[]>([])
  const [exercise, setExercise] = useState<ExerciseLog[]>([])
  const [weights, setWeights] = useState<WeightLog[]>([])
  const [steps, setSteps] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const week = currentWeekDates()
        const [m, w, exLists, wl] = await Promise.all([
          listMealsByDate(todayKey()),
          listWaterByDate(todayKey()),
          Promise.all(week.map((d) => listExerciseByDate(d))),
          listWeightLogsAsc(8),
        ])
        let st: number | null = null
        if (profile.health_connected) {
          try { st = (await syncFromHealth()).steps } catch { st = null }
        }
        if (!alive) return
        setMeals(m)
        setWater(w)
        setExercise(exLists.flat())
        setWeights(wl)
        setSteps(st)
        setState('ok')
      } catch {
        if (alive) setState('error')
      }
    })()
    return () => { alive = false }
  }, [profile.health_connected])

  const completion = useMemo(() => buildCompletion(profile), [profile])
  const bmi = calcBmiCore(profile.height_cm, profile.current_weight_kg)
  const band = bmiBandOf(bmi)
  const bandIndex = band ? HEALTH_PLAN_BMI_BANDS.findIndex((b) => b.key === band.key) : -1
  const bmiShown = bmi == null ? null : roundTo(bmi, 1)
  const bmr = calcBmrCore(profile.gender, profile.age, profile.height_cm, profile.current_weight_kg)
  const bmrShown = bmr == null ? null : roundTo(bmr, 0)
  const bmiAria = bmiShown == null || band == null
    ? '暂无 BMI 数据'
    : `${HEALTH_PLAN_BMI_ARIA_PREFIX}${bmiShown}，${band.label}${HEALTH_PLAN_BMI_ARIA_TAIL}`

  const split = useMemo(() => buildMealSplitCore(meals), [meals])
  const ratios = useMemo(() => buildMacroRatioCore(meals), [meals])
  const todayKcal = useMemo(() => buildTodayKcalCore(meals), [meals])
  const waterMl = useMemo(() => buildWaterCore(water), [water])
  const exWeek = useMemo(() => buildExerciseWeekCore(exercise), [exercise])
  const maxSplit = Math.max(0, ...split.map((s) => s.kcal))
  const activeKcal = estimateActivityKcal(steps ?? 0, profile.current_weight_kg, profile.height_cm)
  const recentWeights = weights.slice(-5).reverse()

  return (
    <View className='mp-mask' onClick={onClose}>
      <View className='mp-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='mp-head'>
          <Text className='mp-title'>{HEALTH_RECORD_TITLE}</Text>
          <View className='mp-close' onClick={onClose}><Text>×</Text></View>
        </View>
        <ScrollView scrollY scrollIntoView={anchor} className='mp-body'>
          <View style={{ marginBottom: 24 }} aria-role='progressbar' aria-label={HEALTH_RECORD_COMPLETION}>
            <View style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text className='mp-helper'>{HEALTH_RECORD_COMPLETION}</Text>
              <Text className='mp-muted'>{completion.filled} / {completion.total}</Text>
            </View>
            <View className='mp-progress-track'>
              <View className='mp-progress-fill' style={{ width: `${completion.percent}%` }} />
            </View>
            <Text className='mp-helper'>{completion.note}</Text>
          </View>

          <View className='mp-anchor-row'>
            {HEALTH_RECORD_ANCHORS.map((a, i) => (
              <View
                key={a}
                className='mp-anchor'
                aria-label={`${HEALTH_RECORD_ANCHOR_ARIA}${a}`}
                onClick={() => setAnchor(`hr-${i}`)}
              >
                <Text>{a}</Text>
              </View>
            ))}
          </View>

          {state === 'loading' ? <Text className='mp-helper'>{HEALTH_RECORD_LOADING}</Text> : null}
          {state === 'error' ? <Text className='mp-helper'>{HEALTH_RECORD_LOAD_ERROR}</Text> : null}

          {state === 'ok' ? (
            <>
              <View id='hr-0'>
                <Text className='mp-section'>{HEALTH_RECORD_ANCHORS[0]}</Text>
                <View className='mp-card mp-stat-grid'>
                  <View className='mp-stat'><Text className='mp-stat-l'>{HEALTH_RECORD_LABELS.height}</Text><Text className='mp-stat-v'>{profile.height_cm ?? '—'}<Text className='mp-stat-unit'> {HEALTH_RECORD_UNITS.cm}</Text></Text></View>
                  <View className='mp-stat'><Text className='mp-stat-l'>{HEALTH_RECORD_LABELS.weight}</Text><Text className='mp-stat-v'>{profile.current_weight_kg ?? '—'}<Text className='mp-stat-unit'> {HEALTH_RECORD_UNITS.kg}</Text></Text></View>
                  <View className='mp-stat'><Text className='mp-stat-l'>{HEALTH_RECORD_LABELS.bmi}</Text><Text className='mp-stat-v'>{bmiShown ?? '—'}</Text></View>
                  <View className='mp-stat'><Text className='mp-stat-l'>{HEALTH_RECORD_LABELS.bmr}</Text><Text className='mp-stat-v'>{bmrShown ?? '—'}<Text className='mp-stat-unit'> {HEALTH_RECORD_UNITS.kcal}</Text></Text></View>
                </View>
                <View className='mp-card'>
                  <View aria-role='img' aria-label={bmiAria} style={{ padding: '20px 0' }}>
                    <View style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                      <Text className='mp-muted'>{HEALTH_RECORD_LABELS.bmi} {bmiShown ?? '—'}</Text>
                      <Text className='mp-muted'>{band ? band.label : '暂无数据'}</Text>
                    </View>
                    <View style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden' }}>
                      {HEALTH_PLAN_BMI_BANDS.map((b) => <View key={b.key} style={{ flex: 1, background: b.color }} />)}
                    </View>
                  </View>
                  <Text className='mp-helper'>{HEALTH_RECORD_DISCLAIMER}</Text>
                </View>
                <View className='mp-card'>
                  <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.weightTrend}</Text></View>
                  {recentWeights.length === 0 ? (
                    <Text className='mp-helper'>{HEALTH_RECORD_EMPTY_WEIGHT}</Text>
                  ) : recentWeights.map((w) => (
                    <View className='mp-line' key={w.id ?? w.log_date}>
                      <Text className='mp-muted'>{w.log_date}</Text>
                      <Text className='mp-val'>{w.weight_kg} {HEALTH_RECORD_UNITS.kg}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View id='hr-1'>
                <Text className='mp-section'>{HEALTH_RECORD_ANCHORS[1]}</Text>
                <View className='mp-card'>
                  <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.healthStatus}</Text><Text className='mp-val'>{profile.health_connected ? '已连接' : '未连接'}</Text></View>
                  {profile.health_connected ? (
                    <>
                      <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.steps}</Text><Text className='mp-val'>{steps ?? 0} {HEALTH_RECORD_UNITS.step}</Text></View>
                      <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.activityKcal}</Text><Text className='mp-val'>{activeKcal} {HEALTH_RECORD_UNITS.kcal}</Text></View>
                    </>
                  ) : <Text className='mp-helper'>{HEALTH_RECORD_NOT_CONNECTED}</Text>}
                  <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.stepGoal}</Text><Text className='mp-val'>{profile.step_goal ?? 6000} {HEALTH_RECORD_UNITS.step}</Text></View>
                </View>
              </View>

              <View id='hr-2'>
                <Text className='mp-section'>{HEALTH_RECORD_ANCHORS[2]}</Text>
                {meals.length === 0 ? (
                  <View className='mp-card'><Text className='mp-helper'>{HEALTH_RECORD_EMPTY_MEAL}</Text></View>
                ) : (
                  <View className='mp-card'>
                    <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.todayKcal}</Text><Text className='mp-val'>{todayKcal} {HEALTH_RECORD_UNITS.kcal}</Text></View>
                    <Text className='mp-helper'>{HEALTH_RECORD_LABELS.mealSplit}</Text>
                    {split.map((s) => (
                      <View className='mp-line' key={s.label}>
                        <Text style={{ width: 72 }}>{s.label}</Text>
                        <View className='mp-bar-track'>
                          <View className='mp-bar-fill' style={{ width: `${maxSplit > 0 ? (s.kcal / maxSplit) * 100 : 0}%` }} />
                        </View>
                        <Text className='mp-val'>{s.kcal} {HEALTH_RECORD_UNITS.kcal}</Text>
                      </View>
                    ))}
                    <Text className='mp-helper'>{HEALTH_RECORD_LABELS.macroRatio}</Text>
                    <View style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden' }}>
                      {ratios.map((r, i) => (
                        <View key={HEALTH_RECORD_MACRO_LABELS[i]} style={{ width: `${r}%`, background: HEALTH_RECORD_MACRO_COLORS[i] }} />
                      ))}
                    </View>
                    <View style={{ display: 'flex', gap: 24, marginTop: 12 }}>
                      {ratios.map((r, i) => <Text className='mp-muted' key={HEALTH_RECORD_MACRO_LABELS[i]}>{HEALTH_RECORD_MACRO_LABELS[i]} {r}%</Text>)}
                    </View>
                  </View>
                )}
                <View className='mp-card'>
                  <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.water}</Text><Text className='mp-val'>{waterMl} {HEALTH_RECORD_UNITS.ml}</Text></View>
                </View>
              </View>

              <View id='hr-3'>
                <Text className='mp-section'>{HEALTH_RECORD_ANCHORS[3]}</Text>
                {exWeek.count === 0 ? (
                  <View className='mp-card'><Text className='mp-helper'>{HEALTH_RECORD_EMPTY_EXERCISE}</Text></View>
                ) : (
                  <View className='mp-card'>
                    <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.weekCount}</Text><Text className='mp-val'>{exWeek.count} {HEALTH_RECORD_UNITS.times}</Text></View>
                    <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.weekMinutes}</Text><Text className='mp-val'>{exWeek.minutes} {HEALTH_RECORD_UNITS.min}</Text></View>
                    <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.weekKcal}</Text><Text className='mp-val'>{exWeek.kcal} {HEALTH_RECORD_UNITS.kcal}</Text></View>
                  </View>
                )}
              </View>

              <Text className='mp-helper'>{HEALTH_RECORD_NO_MEDICAL}</Text>
            </>
          ) : null}
        </ScrollView>
      </View>
    </View>
  )
}
