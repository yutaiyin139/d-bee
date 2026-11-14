import { useEffect, useMemo, useState } from 'react'
import { Sheet } from './Sheet'
import {
  HEALTH_RECORD_TITLE, HEALTH_RECORD_ANCHORS, HEALTH_RECORD_ANCHOR_ARIA,
  HEALTH_RECORD_COMPLETION, HEALTH_RECORD_LABELS, HEALTH_RECORD_UNITS,
  HEALTH_RECORD_MEAL_LABELS, HEALTH_RECORD_MACRO_LABELS, HEALTH_RECORD_MACRO_COLORS,
  HEALTH_RECORD_DISCLAIMER, HEALTH_RECORD_NO_MEDICAL,
  HEALTH_RECORD_EMPTY_MEAL, HEALTH_RECORD_EMPTY_WEIGHT, HEALTH_RECORD_EMPTY_EXERCISE,
  HEALTH_RECORD_NOT_CONNECTED, HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  buildMealSplitCore, buildExerciseWeekCore, buildWaterCore, buildTodayKcalCore, buildMacroRatioCore,
  HEALTH_PLAN_BMI_BANDS, HEALTH_PLAN_BMI_ARIA_PREFIX, HEALTH_PLAN_BMI_ARIA_TAIL,
  calcBmiCore, calcBmrCore, bmiBandOf, roundTo,
} from '@dbee/shared'
import type { MealEntry, WaterLog, ExerciseLog, WeightLog, Profile } from '../types'
import {
  listMealsByDate, listWaterByDate, listExerciseByDate, listWeightLogsAsc,
} from '../lib/api'
import { buildCompletion, currentWeekDates } from '../lib/myPage'
import { syncFromHealth, estimateActivityKcal } from '../lib/health'
import { todayKey } from '../lib/nutrition'

interface HealthRecordSheetProps {
  profile: Profile
  onClose: () => void
}

/**
 * 健康档案：单态 Sheet + 四段锚点，零新增字段、零空值占位卡、零医学结论。
 * 所有数字来自已有 6 张表，BMI 档位与免责说明复用体重管理方案真源。
 */
export function HealthRecordSheet({ profile, onClose }: HealthRecordSheetProps) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
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

  const jump = (i: number) => {
    document.getElementById(`hr-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const metric = (label: string, value: string, unit: string) => (
    <div className="stat" key={label}>
      <div className="l">{label}</div>
      <div className="v">{value}<small>{unit}</small></div>
    </div>
  )

  return (
    <Sheet title={HEALTH_RECORD_TITLE} onClose={onClose}>
      <div style={{ marginBottom: 12 }} role="progressbar" aria-valuenow={completion.percent} aria-valuemin={0} aria-valuemax={100} aria-label={HEALTH_RECORD_COMPLETION}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
          <span>{HEALTH_RECORD_COMPLETION}</span>
          <span>{completion.filled} / {completion.total}</span>
        </div>
        <div style={{ height: 8, borderRadius: 99, background: 'var(--bg-2)', overflow: 'hidden' }}>
          <div style={{ height: 8, borderRadius: 99, background: 'var(--honey)', width: `${completion.percent}%` }} />
        </div>
        <div className="helper" style={{ marginTop: 6 }}>{completion.note}</div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }} role="navigation" aria-label="健康档案板块">
        {HEALTH_RECORD_ANCHORS.map((a, i) => (
          <button
            key={a}
            className="chip"
            aria-label={`${HEALTH_RECORD_ANCHOR_ARIA}${a}`}
            onClick={() => jump(i)}
            style={{ flex: 1, minHeight: 44, fontSize: 12 }}
          >
            {a}
          </button>
        ))}
      </div>

      {state === 'loading' && <div className="helper">{HEALTH_RECORD_LOADING}</div>}
      {state === 'error' && <div className="notice err">{HEALTH_RECORD_LOAD_ERROR}</div>}

      {state === 'ok' && (
        <>
          <div id="hr-0">
            <div className="section-title">{HEALTH_RECORD_ANCHORS[0]}</div>
            <div className="stat-grid" style={{ marginBottom: 12 }}>
              {metric(HEALTH_RECORD_LABELS.height, profile.height_cm == null ? '—' : String(profile.height_cm), HEALTH_RECORD_UNITS.cm)}
              {metric(HEALTH_RECORD_LABELS.weight, profile.current_weight_kg == null ? '—' : String(profile.current_weight_kg), HEALTH_RECORD_UNITS.kg)}
              {metric(HEALTH_RECORD_LABELS.bmi, bmiShown == null ? '—' : String(bmiShown), '')}
              {metric(HEALTH_RECORD_LABELS.bmr, bmrShown == null ? '—' : String(bmrShown), HEALTH_RECORD_UNITS.kcal)}
            </div>
            <div className="card" style={{ marginBottom: 12 }}>
              <div role="img" aria-label={bmiAria} style={{ padding: '12px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                  <span>{HEALTH_RECORD_LABELS.bmi} {bmiShown == null ? '—' : bmiShown}</span>
                  <span>{band ? band.label : '暂无数据'}</span>
                </div>
                <div style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', height: 8, borderRadius: 99, overflow: 'hidden' }}>
                    {HEALTH_PLAN_BMI_BANDS.map((b) => <div key={b.key} style={{ flex: 1, background: b.color }} />)}
                  </div>
                  {bandIndex >= 0 && (
                    <div aria-hidden="true" style={{ position: 'absolute', top: -4, left: `${(bandIndex + 0.5) * 25}%`, width: 2, height: 16, background: 'var(--ink)' }} />
                  )}
                </div>
              </div>
              <div className="helper">{HEALTH_RECORD_DISCLAIMER}</div>
            </div>
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="list-line"><span>{HEALTH_RECORD_LABELS.weightTrend}</span></div>
              {recentWeights.length === 0
                ? <div className="helper" style={{ padding: '0 16px 12px' }}>{HEALTH_RECORD_EMPTY_WEIGHT}</div>
                : recentWeights.map((w) => (
                  <div className="list-line" key={w.id ?? w.log_date}>
                    <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>{w.log_date}</span>
                    <span className="val">{w.weight_kg} {HEALTH_RECORD_UNITS.kg}</span>
                  </div>
                ))}
            </div>
          </div>

          <div id="hr-1">
            <div className="section-title">{HEALTH_RECORD_ANCHORS[1]}</div>
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="list-line">
                <span>{HEALTH_RECORD_LABELS.healthStatus}</span>
                <span className="val">{profile.health_connected ? '已连接' : '未连接'}</span>
              </div>
              {profile.health_connected ? (
                <>
                  <div className="list-line">
                    <span>{HEALTH_RECORD_LABELS.steps}</span>
                    <span className="val">{steps ?? 0} {HEALTH_RECORD_UNITS.step}</span>
                  </div>
                  <div className="list-line">
                    <span>{HEALTH_RECORD_LABELS.activityKcal}</span>
                    <span className="val">{activeKcal} {HEALTH_RECORD_UNITS.kcal}</span>
                  </div>
                </>
              ) : (
                <div className="helper" style={{ padding: '0 16px 12px' }}>{HEALTH_RECORD_NOT_CONNECTED}</div>
              )}
              <div className="list-line">
                <span>{HEALTH_RECORD_LABELS.stepGoal}</span>
                <span className="val">{profile.step_goal ?? 6000} {HEALTH_RECORD_UNITS.step}</span>
              </div>
            </div>
          </div>

          <div id="hr-2">
            <div className="section-title">{HEALTH_RECORD_ANCHORS[2]}</div>
            {meals.length === 0 ? (
              <div className="card" style={{ marginBottom: 12 }}><div className="helper" style={{ padding: 12 }}>{HEALTH_RECORD_EMPTY_MEAL}</div></div>
            ) : (
              <div className="card" style={{ marginBottom: 12, padding: 12 }}>
                <div className="list-line" style={{ border: 0 }}>
                  <span>{HEALTH_RECORD_LABELS.todayKcal}</span>
                  <span className="val" style={{ fontSize: 18 }}>{todayKcal} {HEALTH_RECORD_UNITS.kcal}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '8px 0 12px' }}>{HEALTH_RECORD_LABELS.mealSplit}</div>
                {split.map((s) => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 36, fontSize: 12 }}>{s.label}</span>
                    <span style={{ flex: 1, height: 8, borderRadius: 99, background: 'var(--bg-2)', display: 'block' }}>
                      <span style={{ display: 'block', height: 8, borderRadius: 99, background: 'var(--honey)', width: `${maxSplit > 0 ? (s.kcal / maxSplit) * 100 : 0}%` }} />
                    </span>
                    <span style={{ width: 72, textAlign: 'right', fontSize: 12 }}>{s.kcal} {HEALTH_RECORD_UNITS.kcal}</span>
                  </div>
                ))}
                <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '12px 0 8px' }}>{HEALTH_RECORD_LABELS.macroRatio}</div>
                <div style={{ display: 'flex', height: 8, borderRadius: 99, overflow: 'hidden' }}>
                  {ratios.map((r, i) => (
                    <div key={HEALTH_RECORD_MACRO_LABELS[i]} style={{ width: `${r}%`, background: HEALTH_RECORD_MACRO_COLORS[i] }} />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12 }}>
                  {ratios.map((r, i) => <span key={HEALTH_RECORD_MACRO_LABELS[i]}>{HEALTH_RECORD_MACRO_LABELS[i]} {r}%</span>)}
                </div>
              </div>
            )}
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="list-line">
                <span>{HEALTH_RECORD_LABELS.water}</span>
                <span className="val">{waterMl} {HEALTH_RECORD_UNITS.ml}</span>
              </div>
            </div>
          </div>

          <div id="hr-3">
            <div className="section-title">{HEALTH_RECORD_ANCHORS[3]}</div>
            {exWeek.count === 0 ? (
              <div className="card" style={{ marginBottom: 12 }}><div className="helper" style={{ padding: 12 }}>{HEALTH_RECORD_EMPTY_EXERCISE}</div></div>
            ) : (
              <div className="card" style={{ marginBottom: 12 }}>
                <div className="list-line"><span>{HEALTH_RECORD_LABELS.weekCount}</span><span className="val">{exWeek.count} {HEALTH_RECORD_UNITS.times}</span></div>
                <div className="list-line"><span>{HEALTH_RECORD_LABELS.weekMinutes}</span><span className="val">{exWeek.minutes} {HEALTH_RECORD_UNITS.min}</span></div>
                <div className="list-line"><span>{HEALTH_RECORD_LABELS.weekKcal}</span><span className="val">{exWeek.kcal} {HEALTH_RECORD_UNITS.kcal}</span></div>
              </div>
            )}
          </div>

          <div className="helper" style={{ marginTop: 8 }}>{HEALTH_RECORD_NO_MEDICAL}</div>
        </>
      )}
    </Sheet>
  )
}
