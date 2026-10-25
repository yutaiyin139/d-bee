import { useEffect, useRef, useState } from 'react'
import { View, Text, Input, Button, ScrollView } from '@tarojs/components'
import Taro, { useLoad, useDidShow } from '@tarojs/taro'
import { askCoach, type CoachContext } from '../../lib/ai'
import { COACH_QUESTION_RULE } from '../../lib/validate'
import { errText } from '../../lib/errmsg'
import {
  getProfile, listMealsByDate, listWaterByDate, listExerciseByDate, getEntitlement,
  type MealEntry, type WaterLog, type ExerciseLog, type Profile,
} from '../../lib/api'
import { todayKey, waterTargetMl } from '../../lib/nutrition'
import { isPro } from '@dbee/shared'
import { AiConsent } from '../../components/AiConsent'
import { grantAiConsent, hasAiConsent } from '../../lib/aiConsent'
import './coach.scss'

interface Msg {
  role: 'user' | 'coach'
  text: string
}

const COACH_RATE_LIMIT = 3
const COACH_RATE_WINDOW_MS = 60 * 1000

export default function Coach() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'coach',
      text: '我是 D-Bee 小蜜 🐝 说说你的问题，比如「晚上饿了吃什么」「奶茶和拿铁哪个更友好」，我会结合你今天的数据来答。',
    },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [pro, setPro] = useState(false)
  const [aiConsentOpen, setAiConsentOpen] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState('')
  const ctxRef = useRef<CoachContext>({
    goal: 'keep',
    targetKcal: 1800,
    eatenKcal: 0,
    burnedKcal: 0,
    proteinTarget: 90,
    proteinEaten: 0,
    waterMl: 0,
    waterTarget: 2000,
    topFoods: [],
    barriers: [],
  })
  const askTimesRef = useRef<number[]>([])

  useLoad(() => {
    void buildCtx()
  })

  // 拉取会员状态：Pro 不限流（与主工程 CoachSheet 对齐）。
  // 页面返回（如从邀请中心兑换 Pro 后）时刷新会员状态，避免限流误判。
  // 🔴 性能修复：此前 useLoad 与 useDidShow 各调一次 getEntitlement，而 Taro
  //   首次进入页面同样会触发 useDidShow（onLoad → onShow → onReady），
  //   导致会员状态被重复拉取。改为只在 useDidShow 拉。
  useDidShow(() => {
    void getEntitlement().then((ent) => setPro(isPro(ent))).catch(() => {})
  })

  /** 拉取今日实时数据，构造教练上下文（对齐主工程 Dashboard 的 coachCtx） */
  async function buildCtx() {
    try {
      const [p, meals, water, exercise] = await Promise.all([
        getProfile().catch(() => null),
        listMealsByDate(todayKey()).catch(() => [] as MealEntry[]),
        listWaterByDate(todayKey()).catch(() => [] as WaterLog[]),
        listExerciseByDate(todayKey()).catch(() => [] as ExerciseLog[]),
      ])
      setProfile(p)
      const eatenKcal = meals.reduce((s, m) => s + (m.calories ?? 0), 0)
      const proteinEaten = meals.reduce((s, m) => s + (m.protein_g ?? 0), 0)
      const waterMl = water.reduce((s, w) => s + (w.amount_ml ?? 0), 0)
      const burnedKcal = exercise.reduce((s, x) => s + (x.calories ?? 0), 0)
      ctxRef.current = {
        goal: p?.goal ?? 'keep',
        targetKcal: p?.daily_calorie_target ?? 1800,
        eatenKcal,
        burnedKcal,
        proteinTarget: p?.protein_target_g ?? 90,
        proteinEaten,
        waterMl,
        waterTarget: waterTargetMl(p?.current_weight_kg),
        topFoods: meals.slice(0, 5).map((m) => m.food_name),
        barriers: p?.barriers ? p.barriers.split(',') : [],
      }
    } catch {
      /* 拉取失败用默认上下文，不阻塞提问 */
    }
  }

  function rateLimitBlocked(): number {
    if (pro) return 0
    const now = Date.now()
    const windowStart = now - COACH_RATE_WINDOW_MS
    const recent = askTimesRef.current.filter((t) => t > windowStart)
    askTimesRef.current = recent
    if (recent.length >= COACH_RATE_LIMIT) {
      const oldest = recent[0]
      return Math.ceil((oldest + COACH_RATE_WINDOW_MS - now) / 1000)
    }
    return 0
  }

  async function ask(q: string) {
    if (!q || busy) return
    const waitSec = rateLimitBlocked()
    if (waitSec > 0) {
      setErr(`问得太快啦，请 ${waitSec} 秒后再提问（免费版每分钟最多 ${COACH_RATE_LIMIT} 次，Pro 不限）。`)
      return
    }
    setInput('')
    setErr('')
    setMessages((prev) => [...prev, { role: 'user', text: q }])
    askTimesRef.current.push(Date.now())
    setBusy(true)
    try {
      const answer = await askCoach(q, ctxRef.current)
      setMessages((prev) => [...prev, { role: 'coach', text: answer }])
    } catch (e) {
      setErr(errText(e, '回答失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  function send() {
    const q = input.trim()
    if (!q || busy) return
    if (!hasAiConsent(profile)) {
      setPendingQuestion(q)
      setAiConsentOpen(true)
      return
    }
    void ask(q)
  }

  return (
    <View className='coach-page'>
      <ScrollView className='coach-body' scrollY scrollIntoView='coach-bottom' scrollWithAnimation>
        {messages.map((m, i) => (
          <View key={i} className={`coach-msg ${m.role === 'user' ? 'mine' : ''}`}>
            <Text>{m.text}</Text>
          </View>
        ))}
        {busy && (
          <View className='coach-msg coach-thinking'>
            <Text>正在结合你的数据思考…</Text>
          </View>
        )}
        {err ? <View className='notice err'><Text>{err}</Text></View> : null}
        <View id='coach-bottom' />
      </ScrollView>

      <View className='coach-input'>
        <Input
          className='coach-input-field'
          placeholder='输入你的问题…'
          maxlength={COACH_QUESTION_RULE.max}
          value={input}
          confirmType='send'
          onInput={(e) => setInput(e.detail.value)}
          onConfirm={() => void send()}
        />
        <Button
          className='btn coach-send'
          disabled={busy || !input.trim()}
          onClick={() => void send()}
        >
          发送
        </Button>
      </View>

      {aiConsentOpen && (
        <AiConsent
          kind='coach'
          onAgree={async () => {
            await grantAiConsent(profile)
            setProfile((p) => (p ? { ...p, ai_consented: true } : p))
            setAiConsentOpen(false)
            if (pendingQuestion) {
              const q = pendingQuestion
              setPendingQuestion('')
              void ask(q)
            }
          }}
          onDecline={() => {
            setPendingQuestion('')
            setAiConsentOpen(false)
          }}
        />
      )}
    </View>
  )
}
