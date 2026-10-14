import { useMemo, useState } from 'react'
import { generatePlan } from '../lib/ai'
import { saveProfile } from '../lib/api'
import { ACTIVITY_LABELS, GOAL_LABELS, calcTarget } from '../lib/nutrition'
import type { Profile } from '../types'

interface OnboardingProps {
  nickname: string | null
  onDone: (p: Profile) => void
}

const BARRIERS = [
  '管不住嘴',
  '外卖吃太多',
  '应酬喝酒',
  '熬夜吃夜宵',
  '不爱运动',
  '没时间做饭',
  '情绪化进食',
  '甜食奶茶难戒',
  '反复反弹',
]

const STEPS = ['goal', 'body', 'activity', 'barriers', 'result'] as const
type Step = (typeof STEPS)[number]

export function Onboarding({ nickname, onDone }: OnboardingProps) {
  const [step, setStep] = useState<Step>('goal')

  const [goal, setGoal] = useState<'lose' | 'keep' | 'gain'>('lose')
  const [gender, setGender] = useState<'male' | 'female'>('female')
  const [age, setAge] = useState('28')
  const [height, setHeight] = useState('165')
  const [weight, setWeight] = useState('62')
  const [targetWeight, setTargetWeight] = useState('55')
  const [activity, setActivity] = useState<keyof typeof ACTIVITY_LABELS>('light')
  const [barriers, setBarriers] = useState<string[]>([])

  const [plan, setPlan] = useState<{ summary: string; advice: string[] } | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const num = (v: string, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  const target = useMemo(() => {
    const w = num(weight, 62)
    const tw = goal === 'keep' ? w : num(targetWeight, w)
    const diff = Math.abs(tw - w)
    // 每周减/增 0.5%–1% 体重，最多 0.75kg
    const weeklyRate = goal === 'keep' ? 0 : Math.min(0.75, Math.max(0.25, w * 0.0075))
    return {
      ...calcTarget({
        gender,
        age: num(age, 28),
        heightCm: num(height, 165),
        weightKg: w,
        activity,
        goal,
        weeklyRateKg: weeklyRate,
      }),
      targetWeightKg: tw,
      diffKg: Math.round(diff * 10) / 10,
      weeks: weeklyRate > 0 ? Math.ceil(diff / weeklyRate) : 0,
    }
  }, [gender, age, height, weight, targetWeight, activity, goal])

  const idx = STEPS.indexOf(step)
  const canNext =
    step === 'goal' ||
    step === 'body' ||
    step === 'activity' ||
    (step === 'barriers' && barriers.length > 0) ||
    step === 'result'

  function next() {
    const i = STEPS.indexOf(step)
    if (i < STEPS.length - 1) {
      const nxt = STEPS[i + 1]
      setStep(nxt)
      if (nxt === 'result') void loadPlan()
    }
  }

  function back() {
    const i = STEPS.indexOf(step)
    if (i > 0) setStep(STEPS[i - 1])
  }

  async function loadPlan() {
    setPlanLoading(true)
    setPlanError('')
    try {
      const res = await generatePlan({
        goal: GOAL_LABELS[goal],
        gender,
        age: num(age, 28),
        heightCm: num(height, 165),
        weightKg: num(weight, 62),
        targetWeightKg: target.targetWeightKg,
        activity: ACTIVITY_LABELS[activity],
        barriers,
        calories: target.calories,
      })
      setPlan(res)
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'AI 计划生成失败')
    } finally {
      setPlanLoading(false)
    }
  }

  async function finish() {
    setSaving(true)
    setSaveError('')
    try {
      const w = num(weight, 62)
      const saved = await saveProfile({
        nickname,
        gender,
        age: num(age, 28),
        height_cm: num(height, 165),
        start_weight_kg: w,
        current_weight_kg: w,
        target_weight_kg: target.targetWeightKg,
        activity_level: activity,
        goal,
        weekly_rate_kg: goal === 'keep' ? 0 : Math.min(0.75, Math.max(0.25, w * 0.0075)),
        daily_calorie_target: target.calories,
        protein_target_g: target.protein_g,
        carb_target_g: target.carb_g,
        fat_target_g: target.fat_g,
        barriers: barriers.join(','),
        plan_summary: plan ? JSON.stringify(plan) : null,
        onboarded: true,
      })
      onDone(saved)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-shell">
      <div className="onboard-wrap">
        <div className="onboard-top" />
        <div className="onboard-progress">
          {STEPS.map((s, i) => (
            <span key={s} className={i <= idx ? 'done' : ''} />
          ))}
        </div>

        <div className="onboard-body">
          {step === 'goal' && (
            <>
              <h2>你想达成什么？</h2>
              <p className="desc">先定方向，后面所有数字都围绕它来算。</p>
              <div className="option-list">
                {(Object.keys(GOAL_LABELS) as Array<keyof typeof GOAL_LABELS>).map((g) => (
                  <button key={g} className={`option ${goal === g ? 'active' : ''}`} onClick={() => setGoal(g)}>
                    <div>
                      <div className="t">{GOAL_LABELS[g]}</div>
                      <div className="d">
                        {g === 'lose' ? '制造热量缺口，稳步掉秤' : g === 'keep' ? '维持当前体重与状态' : '增加热量盈余，增肌增重'}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 'body' && (
            <>
              <h2>你的身体数据</h2>
              <p className="desc">用于计算基础代谢，数据只存在你的账号里。</p>
              <div className="field">
                <label>性别</label>
                <div className="chips">
                  <button className={`chip ${gender === 'female' ? 'active' : ''}`} onClick={() => setGender('female')}>
                    女
                  </button>
                  <button className={`chip ${gender === 'male' ? 'active' : ''}`} onClick={() => setGender('male')}>
                    男
                  </button>
                </div>
              </div>
              <div className="field">
                <label htmlFor="age">年龄</label>
                <input id="age" type="number" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="height">身高（cm）</label>
                <input id="height" type="number" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="weight">当前体重（kg）</label>
                <input id="weight" type="number" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
              </div>
              {goal !== 'keep' && (
                <div className="field">
                  <label htmlFor="tw">目标体重（kg）</label>
                  <input id="tw" type="number" inputMode="decimal" value={targetWeight} onChange={(e) => setTargetWeight(e.target.value)} />
                </div>
              )}
            </>
          )}

          {step === 'activity' && (
            <>
              <h2>平时的活动量</h2>
              <p className="desc">这决定了你每天能消耗多少热量。</p>
              <div className="option-list">
                {(Object.keys(ACTIVITY_LABELS) as Array<keyof typeof ACTIVITY_LABELS>).map((a) => (
                  <button key={a} className={`option ${activity === a ? 'active' : ''}`} onClick={() => setActivity(a)}>
                    <div className="t">{ACTIVITY_LABELS[a]}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 'barriers' && (
            <>
              <h2>什么在拖你后腿？</h2>
              <p className="desc">可多选。AI 会针对这些具体问题给建议。</p>
              <div className="chips" style={{ gap: 10 }}>
                {BARRIERS.map((b) => (
                  <button
                    key={b}
                    className={`chip ${barriers.includes(b) ? 'active' : ''}`}
                    onClick={() =>
                      setBarriers((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
                    }
                  >
                    {b}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 'result' && (
            <>
              <h2>你的每日目标</h2>
              <p className="desc">按 Mifflin-St Jeor 公式结合你的数据算出。</p>

              <div className="card" style={{ textAlign: 'center', padding: '24px 18px' }}>
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>每日建议摄入</div>
                <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: -1, margin: '4px 0 2px' }}>
                  {target.calories}
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>千卡 / 天</div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 10 }}>
                  基础消耗约 {target.tdee} kcal
                  {target.weeks > 0 && goal === 'lose' && ` · 预计 ${target.weeks} 周减到目标`}
                  {target.weeks > 0 && goal === 'gain' && ` · 预计 ${target.weeks} 周增到目标`}
                </div>
              </div>

              <div className="stat-grid" style={{ marginBottom: 14 }}>
                <div className="stat">
                  <div className="l">蛋白质</div>
                  <div className="v">{target.protein_g}<small>g</small></div>
                </div>
                <div className="stat">
                  <div className="l">碳水</div>
                  <div className="v">{target.carb_g}<small>g</small></div>
                </div>
                <div className="stat">
                  <div className="l">脂肪</div>
                  <div className="v">{target.fat_g}<small>g</small></div>
                </div>
                <div className="stat">
                  <div className="l">{goal === 'keep' ? '维持体重' : '目标体重'}</div>
                  <div className="v">{target.targetWeightKg}<small>kg</small></div>
                </div>
              </div>

              {planLoading && (
                <div className="card">
                  <div className="skeleton" style={{ height: 16, width: '60%', marginBottom: 10 }} />
                  <div className="skeleton" style={{ height: 13, width: '100%', marginBottom: 8 }} />
                  <div className="skeleton" style={{ height: 13, width: '88%' }} />
                </div>
              )}

              {planError && <div className="notice err">{planError}（不影响继续使用）</div>}

              {plan && (
                <div className="card">
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{plan.summary}</div>
                  {plan.advice.map((a, i) => (
                    <div key={i} style={{ display: 'flex', gap: 9, fontSize: 13.5, color: 'var(--ink-2)', marginBottom: 8 }}>
                      <span style={{ color: 'var(--honey-dark)', fontWeight: 600 }}>{i + 1}</span>
                      <span>{a}</span>
                    </div>
                  ))}
                </div>
              )}

              {saveError && <div className="notice err">{saveError}</div>}
            </>
          )}
        </div>

        <div className="onboard-foot">
          {idx > 0 && (
            <button className="btn btn-ghost" style={{ flex: '0 0 96px' }} onClick={back} disabled={saving}>
              上一步
            </button>
          )}
          {step !== 'result' ? (
            <button className="btn" onClick={next} disabled={!canNext}>
              继续
            </button>
          ) : (
            <button className="btn" onClick={finish} disabled={saving}>
              {saving ? <span className="spinner" /> : '开始记录'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
