import { useMemo, useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { generatePlan } from '../../lib/ai'
import { saveProfile, grantHoney } from '../../lib/api'
import { ACTIVITY_LABELS, GOAL_LABELS, calcTarget } from '../../lib/nutrition'
import {
  AGE_LIMIT, HEIGHT_LIMIT, WEIGHT_LIMIT, type NumLimit,
  checkNumber, checkTargetWeightDiff, clampNumeric, rangeText, sanitizeNumeric,
} from '../../lib/validate'
import { NEWBIE_BONUS_AMOUNT, BONUS_TTL_DAYS } from '@dbee/shared'
import type { Profile } from '../../lib/api'
import './onboarding.scss'

const BARRIERS = [
  '管不住嘴', '外卖吃太多', '应酬喝酒', '熬夜吃夜宵', '不爱运动',
  '没时间做饭', '情绪化进食', '甜食奶茶难戒', '反复反弹',
]

const STEPS = ['goal', 'body', 'activity', 'barriers', 'result'] as const
type Step = (typeof STEPS)[number]

export default function Onboarding() {
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

  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})

  const num = (v: string, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  const bodyCheck = useMemo(() => {
    const a = checkNumber(age, AGE_LIMIT)
    const h = checkNumber(height, HEIGHT_LIMIT)
    const w = checkNumber(weight, WEIGHT_LIMIT)
    const tw = goal === 'keep' ? { ok: true, value: null, error: '' } : checkNumber(targetWeight, WEIGHT_LIMIT)
    const diff = goal === 'keep' ? { ok: true, error: '' } : checkTargetWeightDiff(tw.value, w.value)
    return { a, h, w, tw, diff }
  }, [age, height, weight, targetWeight, goal])

  const bodyOk = bodyCheck.a.ok && bodyCheck.h.ok && bodyCheck.w.ok && bodyCheck.tw.ok && bodyCheck.diff.ok

  function typeNum(raw: string, limit: NumLimit, set: (v: string) => void, field: string) {
    set(sanitizeNumeric(raw, { int: limit.int, decimals: limit.decimals }))
    if (fieldErr[field]) setFieldErr((p) => ({ ...p, [field]: '' }))
  }

  function blurNum(raw: string, limit: NumLimit, set: (v: string) => void, field: string) {
    const before = raw.trim()
    const fixed = clampNumeric(raw, limit)
    set(fixed)
    const chk = checkNumber(fixed, limit)
    if (before === '') {
      setFieldErr((p) => ({ ...p, [field]: '' }))
      return
    }
    if (fixed !== before && chk.ok) {
      setFieldErr((p) => ({ ...p, [field]: `${limit.label}已调整为 ${fixed} ${limit.unit}（可填 ${rangeText(limit)}）` }))
      return
    }
    setFieldErr((p) => ({ ...p, [field]: chk.error }))
  }

  const target = useMemo(() => {
    const w = num(weight, 62)
    const tw = goal === 'keep' ? w : num(targetWeight, w)
    const diff = Math.abs(tw - w)
    const weeklyRate = goal === 'keep' ? 0 : Math.min(0.75, Math.max(0.25, w * 0.0075))
    return {
      ...calcTarget({ gender, age: num(age, 28), heightCm: num(height, 165), weightKg: w, activity, goal, weeklyRateKg: weeklyRate }),
      targetWeightKg: tw,
      diffKg: Math.round(diff * 10) / 10,
      weeks: weeklyRate > 0 ? Math.ceil(diff / weeklyRate) : 0,
    }
  }, [gender, age, height, weight, targetWeight, activity, goal])

  const idx = STEPS.indexOf(step)
  const canNext =
    step === 'goal' ||
    (step === 'body' && bodyOk) ||
    step === 'activity' ||
    step === 'barriers' ||
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
    if (!bodyOk) {
      setSaveError('身体数据不合法，请返回上一步检查后再继续')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const w = num(weight, 62)
      const saved = await saveProfile({
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
      // 首次完善身体数据 → 一次性新手奖励（发蜜糖积分，不再发识别次数；数据库 UNIQUE 防重复）
      void grantHoney('newbie', 'newbie', NEWBIE_BONUS_AMOUNT, BONUS_TTL_DAYS)
      // 回到首页
      Taro.reLaunch({ url: '/pages/index/index' })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <View className='onboard-wrap'>
      <View className='onboard-progress'>
        {STEPS.map((s, i) => (
          <View key={s} className={`ob-bar ${i <= idx ? 'done' : ''}`} />
        ))}
      </View>

      <View className='onboard-body'>
        {step === 'goal' && (
          <>
            <Text className='ob-h2'>你想达成什么？</Text>
            <Text className='ob-desc'>先定方向，后面所有数字都围绕它来算。</Text>
            <View className='option-list'>
              {(Object.keys(GOAL_LABELS) as Array<keyof typeof GOAL_LABELS>).map((g) => (
                <Button key={g} className={`option ${goal === g ? 'active' : ''}`} onClick={() => setGoal(g)}>
                  <Text className='t'>{GOAL_LABELS[g]}</Text>
                  <Text className='d'>
                    {g === 'lose' ? '制造热量缺口，稳步掉秤' : g === 'keep' ? '维持当前体重与状态' : '增加热量盈余，增肌增重'}
                  </Text>
                </Button>
              ))}
            </View>
          </>
        )}

        {step === 'body' && (
          <>
            <Text className='ob-h2'>你的身体数据</Text>
            <Text className='ob-desc'>用于计算基础代谢，数据只存在你的账号里。</Text>

            <View className='field'>
              <Text className='field-label'>性别</Text>
              <View className='chips'>
                <Button className={`chip ${gender === 'female' ? 'active' : ''}`} onClick={() => setGender('female')}>女</Button>
                <Button className={`chip ${gender === 'male' ? 'active' : ''}`} onClick={() => setGender('male')}>男</Button>
              </View>
            </View>

            <View className='field'>
              <Text className='field-label'>年龄</Text>
              <Input
                className='field-input'
                type='number'
                placeholder='如 28'
                value={age}
                onInput={(e) => typeNum(e.detail.value, AGE_LIMIT, setAge, 'age')}
                onBlur={(e) => blurNum(e.detail.value, AGE_LIMIT, setAge, 'age')}
              />
              {fieldErr.age ? <Text className='err'>{fieldErr.age}</Text> : null}
            </View>

            <View className='field'>
              <Text className='field-label'>身高（cm）</Text>
              <Input
                className='field-input'
                type='digit'
                placeholder='如 165'
                value={height}
                onInput={(e) => typeNum(e.detail.value, HEIGHT_LIMIT, setHeight, 'height')}
                onBlur={(e) => blurNum(e.detail.value, HEIGHT_LIMIT, setHeight, 'height')}
              />
              {fieldErr.height ? <Text className='err'>{fieldErr.height}</Text> : null}
            </View>

            <View className='field'>
              <Text className='field-label'>当前体重（kg）</Text>
              <Input
                className='field-input'
                type='digit'
                placeholder='如 62'
                value={weight}
                onInput={(e) => typeNum(e.detail.value, WEIGHT_LIMIT, setWeight, 'weight')}
                onBlur={(e) => blurNum(e.detail.value, WEIGHT_LIMIT, setWeight, 'weight')}
              />
              {fieldErr.weight ? <Text className='err'>{fieldErr.weight}</Text> : null}
            </View>

            {goal !== 'keep' && (
              <View className='field'>
                <Text className='field-label'>目标体重（kg）</Text>
                <Input
                  className='field-input'
                  type='digit'
                  placeholder='如 55'
                  value={targetWeight}
                  onInput={(e) => typeNum(e.detail.value, WEIGHT_LIMIT, setTargetWeight, 'tw')}
                  onBlur={(e) => blurNum(e.detail.value, WEIGHT_LIMIT, setTargetWeight, 'tw')}
                />
                {fieldErr.tw ? <Text className='err'>{fieldErr.tw}</Text> : null}
                {!fieldErr.tw && !bodyCheck.diff.ok ? <Text className='err'>{bodyCheck.diff.error}</Text> : null}
              </View>
            )}

            {!bodyOk ? (
              <Text className='helper'>
                请先填写合法的身体数据：身高 {rangeText(HEIGHT_LIMIT)}、体重 {rangeText(WEIGHT_LIMIT)}、年龄 {rangeText(AGE_LIMIT)}。
              </Text>
            ) : null}
          </>
        )}

        {step === 'activity' && (
          <>
            <Text className='ob-h2'>平时的活动量</Text>
            <Text className='ob-desc'>这决定了你每天能消耗多少热量。</Text>
            <View className='option-list'>
              {(Object.keys(ACTIVITY_LABELS) as Array<keyof typeof ACTIVITY_LABELS>).map((a) => (
                <Button key={a} className={`option ${activity === a ? 'active' : ''}`} onClick={() => setActivity(a)}>
                  <Text className='t'>{ACTIVITY_LABELS[a]}</Text>
                </Button>
              ))}
            </View>
          </>
        )}

        {step === 'barriers' && (
          <>
            <Text className='ob-h2'>什么在拖你后腿？</Text>
            <Text className='ob-desc'>可多选，也可以直接跳过。AI 会针对这些具体问题给建议。</Text>
            <View className='chips wrap'>
              {BARRIERS.map((b) => (
                <Button
                  key={b}
                  className={`chip ${barriers.includes(b) ? 'active' : ''}`}
                  onClick={() => setBarriers((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))}
                >
                  {b}
                </Button>
              ))}
            </View>
          </>
        )}

        {step === 'result' && (
          <>
            <Text className='ob-h2'>你的每日目标</Text>
            <Text className='ob-desc'>按 Mifflin-St Jeor 公式结合你的数据算出。</Text>

            <View className='result-card'>
              <Text className='rc-label'>每日建议摄入</Text>
              <Text className='rc-num'>{target.calories}</Text>
              <Text className='rc-unit'>千卡 / 天</Text>
              <Text className='rc-sub'>
                基础消耗约 {target.tdee} kcal
                {target.weeks > 0 && goal === 'lose' ? ` · 预计 ${target.weeks} 周减到目标` : ''}
                {target.weeks > 0 && goal === 'gain' ? ` · 预计 ${target.weeks} 周增到目标` : ''}
              </Text>
            </View>

            <View className='stat-grid'>
              <View className='stat'>
                <Text className='l'>蛋白质</Text>
                <Text className='v'>{target.protein_g}<Text className='small'>g</Text></Text>
              </View>
              <View className='stat'>
                <Text className='l'>碳水</Text>
                <Text className='v'>{target.carb_g}<Text className='small'>g</Text></Text>
              </View>
              <View className='stat'>
                <Text className='l'>脂肪</Text>
                <Text className='v'>{target.fat_g}<Text className='small'>g</Text></Text>
              </View>
              <View className='stat'>
                <Text className='l'>{goal === 'keep' ? '维持体重' : '目标体重'}</Text>
                <Text className='v'>{target.targetWeightKg}<Text className='small'>kg</Text></Text>
              </View>
            </View>

            {planLoading ? (
              <View className='plan-skeleton'>
                <View className='ps-line' style={{ width: '60%' }} />
                <View className='ps-line' style={{ width: '100%' }} />
                <View className='ps-line' style={{ width: '88%' }} />
              </View>
            ) : null}

            {planError ? <Text className='notice err'>{planError}（不影响继续使用）</Text> : null}

            {plan ? (
              <View className='plan-card'>
                <Text className='pc-summary'>{plan.summary}</Text>
                {plan.advice.map((a, i) => (
                  <View key={i} className='pc-advice'>
                    <Text className='pc-idx'>{i + 1}</Text>
                    <Text className='pc-text'>{a}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {saveError ? <Text className='notice err'>{saveError}</Text> : null}
          </>
        )}
      </View>

      <View className='onboard-foot'>
        {idx > 0 ? (
          <Button className='btn btn-ghost ob-back' onClick={back} disabled={saving}>上一步</Button>
        ) : null}
        {step !== 'result' ? (
          <Button className='btn' onClick={next} disabled={!canNext}>继续</Button>
        ) : (
          <Button className='btn' onClick={finish} disabled={saving}>{saving ? '保存中…' : '开始记录'}</Button>
        )}
      </View>
    </View>
  )
}
