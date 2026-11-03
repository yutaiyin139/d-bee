import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import Taro, { useDidShow, useLoad, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import {
  IconDrop, IconFire, IconFork, IconPea, IconPlus, IconRun, IconWater,
  IconChart, IconMe, IconToday,
} from '../../components/Icons'
import { Ring } from '../../components/Ring'
import { WeekStrip } from '../../components/WeekStrip'
import { MonthPicker } from '../../components/MonthPicker'
import {
  listMealsByDate, listLoggedMeals, listWaterByDate, listExerciseByDate,
  addWater, addExercise, deleteExercise, deleteMeal, updateMealGrams, undoLastWater,
  getProfile, grantHoney, refundCheckinHoney, refundCheckinWater, refundCheckinExercise,
  settleInviteCheckin, unlockBadge, grantPhotoBonus, getMyInviteCode, listRecentMeals, insertMeals,
  type MealEntry, type MealSlim, type WaterLog, type ExerciseLog, type Profile,
} from '../../lib/api'
import { Sheet } from '../../components/Sheet'
import { AiLabel } from '../../components/AiLabel'
import {
  EXERCISES, exerciseKcal, formatDateShort, guessMealType, shiftDate,
  todayKey, waterTargetMl,
} from '../../lib/nutrition'
import { computeStreak, MILESTONES } from '../../lib/streak'
import {
  LEVEL_LABELS, levelOfScore, nextMealAdvice, summarizeEntries, categoryOf,
} from '../../lib/foodInsight'
import {
  CHECKIN_MEAL, CHECKIN_WATER, CHECKIN_EXERCISE,
  dailyCheckinHoney, streakMilestoneHoney,
} from '../../lib/invite'
import { STREAK_BADGES } from '../../lib/badge'
import { isSignedIn } from '../../lib/auth'
import {
  consumePendingInvite, getPendingInvite, readInviteFromEnterOptions,
  readInviteFromParams, setPendingInvite,
} from '../../lib/inviteLink'
import { STREAK_BONUS_AMOUNT, fmtNum, roundTo } from '@dbee/shared'
import './index.scss'

const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' } as const
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'] as const
type MealType = (typeof MEAL_ORDER)[number]

/** 手动录入的「最近吃过」快捷项（对齐主工程 LogSheet.tsx 的 RecentFood） */
interface RecentFood {
  name: string
  kcal: number
  grams: number | null
  protein_g: number
  carb_g: number
  fat_g: number
  count: number
  lastEaten: string
}

/**
 * 从历史记录聚合「最近吃过」：按食物名去重，取最近一次的营养值，按频次排序。
 * 与主工程 src/pages/LogSheet.tsx aggregateRecent 同口径（小程序额外带上
 * 热量与三大营养素，方便一键回填整条记录）。
 */
function aggregateRecent(list: MealEntry[]): RecentFood[] {
  const map = new Map<string, RecentFood>()
  for (const m of list) {
    const name = (m.food_name || '').trim()
    if (!name) continue
    const prev = map.get(name)
    if (prev) {
      prev.count += 1
      if ((m.created_at ?? '') > prev.lastEaten) {
        prev.lastEaten = m.created_at ?? ''
        prev.kcal = Number(m.calories) || 0
        prev.grams = m.grams ?? prev.grams
        prev.protein_g = Number(m.protein_g) || 0
        prev.carb_g = Number(m.carb_g) || 0
        prev.fat_g = Number(m.fat_g) || 0
      }
    } else {
      map.set(name, {
        name,
        kcal: Number(m.calories) || 0,
        grams: m.grams ?? null,
        protein_g: Number(m.protein_g) || 0,
        carb_g: Number(m.carb_g) || 0,
        fat_g: Number(m.fat_g) || 0,
        count: 1,
        lastEaten: m.created_at ?? '',
      })
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || (b.lastEaten > a.lastEaten ? 1 : -1))
    .slice(0, 12)
}

const MACRO_META = [
  { key: 'protein_g', label: '蛋白质', color: '#3f9463', icon: IconPea },
  { key: 'carb_g', label: '碳水化合物', color: '#f2a93b', icon: IconDrop },
  { key: 'fat_g', label: '脂肪', color: '#e8c93e', icon: IconDrop },
] as const

const STREAK_WINDOW_DAYS = 185
const ACTIVITY_EATBACK_RATIO = 0.5

export default function Index() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [logDate, setLogDate] = useState(todayKey())
  const [entries, setEntries] = useState<MealEntry[]>([])
  const [water, setWater] = useState<WaterLog[]>([])
  const [exercise, setExercise] = useState<ExerciseLog[]>([])
  const [recentMeals, setRecentMeals] = useState<MealSlim[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [inviteCode, setInviteCode] = useState('')

  // 原位编辑与删除确认
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editGrams, setEditGrams] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  // 运动录入
  const [exName, setExName] = useState(EXERCISES[0].name)
  const [exMinutes, setExMinutes] = useState('30')

  // 手动记一餐（P0-D）：对齐主工程 LogSheet 的 manual 模式。
  // 付费墙宣传「手动录入、体重饮水运动记录全部免费」，此前小程序端手动录入
  // 只存在于无入口的孤儿页 checkin.tsx，承诺不成立；现在首页可直接手动记。
  const [manualOpen, setManualOpen] = useState(false)
  const [manualMeal, setManualMeal] = useState<MealType>('snack')
  const [manualName, setManualName] = useState('')
  const [manualKcal, setManualKcal] = useState('')
  const [manualGrams, setManualGrams] = useState('')
  const [manualProtein, setManualProtein] = useState('')
  const [manualCarb, setManualCarb] = useState('')
  const [manualFat, setManualFat] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  const [recentFoods, setRecentFoods] = useState<RecentFood[]>([])

  const today = todayKey()

  // 分享卡片落地：从 query 读邀请码（?invite=CODE，兼容旧版 ?inviter=CODE）。
  // router.params 只在冷启动可靠；热启动（后台时点新卡片）只触发 onShow，
  // 故 useDidShow 里另用 getEnterOptionsSync 读「本次进入」的参数。
  const router = useRouter()

  /** 落地读码：本次进入的启动参数优先，页面 query 兜底 */
  function pickLandedInvite(): string {
    return readInviteFromEnterOptions() || readInviteFromParams(router.params as Record<string, unknown> | undefined)
  }

  // 冷启动时 onLoad 与 onShow 会先后各触发一次，两处都做「已登录→消费邀请码」，
  // 而 state（loggedIn）此刻尚未提交，闭包守卫拦不住并发。用一个 ref 记录
  // 「本次已发起消费」，保证 consumePendingInvite 不重复跑（bind_invite 幂等，
  // 但重复调用会白白多打一次 RPC 并可能计入风控）。
  const inviteConsumingRef = useRef(false)
  function ensureInviteConsumed() {
    if (inviteConsumingRef.current) return
    inviteConsumingRef.current = true
    void consumePendingInvite().finally(() => {
      inviteConsumingRef.current = false
    })
  }

  /**
   * 读到落地码则暂存；已登录立即消费（老用户重复点卡片，bind_invite 幂等）。
   *
   * 去重必要性：`getEnterOptionsSync()` 返回的是「**本次进入小程序**」的参数，
   * 同一次进入内恒定不变。而 onShow 在页面间来回时（首页 → 拍照识别 → 返回）
   * 会反复触发。若不去重，每次返回都会把**已消费并清除**的码重新存回 Storage
   * 再绑一次 —— bind_invite 会返回 'already'（幂等，不会重复发积分），
   * 但白白多打一次 RPC，还可能计入 60s/5 次的风控统计。
   * 用 ref 记住「本次进入已处理过的码」：只有读到**不同**的码（= 热启动点了
   * 新卡片）才重新暂存并绑定。
   */
  const handledEnterCodeRef = useRef('')
  function captureLandedInvite(signedIn: boolean) {
    const landed = pickLandedInvite()
    const isNewLanding = landed && landed !== handledEnterCodeRef.current
    if (isNewLanding) {
      handledEnterCodeRef.current = landed
      setPendingInvite(landed)
    }
    // 有新码，或还留着上次未绑成（非终态）的残留码 → 尝试消费
    if (signedIn && (isNewLanding || getPendingInvite())) ensureInviteConsumed()
  }

  useLoad(async () => {
    const ok = await isSignedIn()
    setLoggedIn(ok)
    captureLandedInvite(ok)
  })

  // 从登录页返回时刷新登录态：小程序是 navigateTo 打开登录页，登录成功后
  // 用户返回首页，而首页此时仍是 useLoad 时读到的 loggedIn=false，会一直
  // 卡在 auth gate（必须杀掉小程序重进）。onShow 在返回栈弹出时必触发。
  // 同时这里也是**热启动**的唯一入口：小程序在后台时用户点了新的分享卡片，
  // onLoad 不重跑、router.params 还是旧值，只有 getEnterOptionsSync 能拿到新码。
  useDidShow(async () => {
    if (loggedIn) {
      // 已在首页态下的热启动（如从聊天卡片直接切回）：只需补读落地码
      captureLandedInvite(true)
      return
    }
    const ok = await isSignedIn()
    if (!ok) return
    setLoggedIn(true)
    // 登录页已绑过码则这里是空操作；若当时会话未就绪（非终态）留了码，
    // 回首页这一刻会话通常已稳定，补一次消费。
    captureLandedInvite(true)
  })

  // 删除确认 3 秒自动复位
  useEffect(() => {
    if (pendingDeleteId == null) return
    const t = setTimeout(() => setPendingDeleteId(null), 3000)
    return () => clearTimeout(t)
  }, [pendingDeleteId])

  const target = useMemo(() => {
    const p = profile
    if (!p || !p.daily_calorie_target) {
      return { calories: 1800, protein_g: 90, carb_g: 220, fat_g: 50 }
    }
    return {
      calories: p.daily_calorie_target,
      protein_g: p.protein_target_g ?? 0,
      carb_g: p.carb_target_g ?? 0,
      fat_g: p.fat_target_g ?? 0,
    }
  }, [profile])

  const waterTarget = useMemo(() => waterTargetMl(profile?.current_weight_kg), [profile?.current_weight_kg])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [m, w, x, recent, p] = await Promise.all([
        listMealsByDate(logDate),
        listWaterByDate(logDate),
        listExerciseByDate(logDate),
        listLoggedMeals(shiftDate(today, -STREAK_WINDOW_DAYS), today),
        getProfile(),
      ])
      setEntries(m)
      setWater(w)
      setExercise(x)
      setRecentMeals(recent)
      if (p) setProfile(p)
      // 已登录但尚未完成引导 → 跳转新手引导（对齐主工程 loading→onboarding 阶段流转）
      if (p && !p.onboarded) {
        Taro.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (loggedIn) void load()
  }, [loggedIn, logDate])

  // 登录后拉取邀请码，供分享卡片带参
  useEffect(() => {
    if (!loggedIn) return
    void getMyInviteCode().then((code) => {
      if (code) setInviteCode(code)
    }).catch(() => {})
  }, [loggedIn])

  const loggedDates = useMemo(
    () => Array.from(new Set(recentMeals.map((r) => r.log_date))),
    [recentMeals],
  )

  const totals = useMemo(() => entries.reduce(
    (acc, e) => {
      acc.kcal += Number(e.calories) || 0
      acc.p += Number(e.protein_g) || 0
      acc.c += Number(e.carb_g) || 0
      acc.f += Number(e.fat_g) || 0
      acc.na += Number(e.sodium_mg) || 0
      acc.fb += Number(e.fiber_g) || 0
      acc.as += Number(e.added_sugar_g) || 0
      return acc
    },
    { kcal: 0, p: 0, c: 0, f: 0, na: 0, fb: 0, as: 0 },
  ), [entries])

  const waterMl = useMemo(() => water.reduce((s, w) => s + (Number(w.amount_ml) || 0), 0), [water])
  const burnKcal = useMemo(() => exercise.reduce((s, x) => s + (Number(x.calories) || 0), 0), [exercise])
  // 小程序暂无健康步数接入，有效消耗 = 手动运动（后续微信 getWeRunData 资质就绪后补充）
  const effectiveBurnKcal = burnKcal
  const netKcal = Math.round(totals.kcal - effectiveBurnKcal * ACTIVITY_EATBACK_RATIO)
  const remain = Math.round(target.calories - netKcal)
  const over = remain < 0
  const isToday = logDate === today

  const streak = useMemo(() => computeStreak(loggedDates, today), [loggedDates, today])

  // 小程序右上角「转发」与「分享到朋友圈」基础适配（P0-4）
  useShareAppMessage(() => {
    const title = streak.current > 0
      ? `我用 D-Bee 记录了今天的饮食，已连续打卡 ${streak.current} 天`
      : '我在用「自律蜜蜂」记录饮食、自律打卡，一起变自律吧！'
    const path = inviteCode ? `/pages/index/index?invite=${encodeURIComponent(inviteCode)}` : '/pages/index/index'
    return { title, path }
  })

  useShareTimeline(() => {
    const title = streak.current > 0
      ? `我用 D-Bee 记录了今天的饮食，已连续打卡 ${streak.current} 天`
      : '我在用「自律蜜蜂」记录饮食、自律打卡，一起变自律吧！'
    const query = inviteCode ? `invite=${encodeURIComponent(inviteCode)}` : ''
    return { title, query }
  })

  /* ── 积分与奖励结算引擎（严格对齐主工程 Dashboard，四端逻辑一致）── */

  // 连续打卡每满 7 天 → 自动发放识别次数奖励（7/14/21…各送 2 次识别）。
  // 以「当前连续段满周那天的日期」作 grant_key，每满一周发一次。
  useEffect(() => {
    if (streak.streak7Date) void grantPhotoBonus('streak7', streak.streak7Date, STREAK_BONUS_AMOUNT)
  }, [streak.streak7Date])

  // 每日打卡积分：记餐 +5 / 饮水达标 +2 / 运动 +2（仅「今天」结算，历史补记不发）。
  // 三项独立 reason + ref_id=当日日期，靠 UNIQUE 防重复。
  useEffect(() => {
    if (!isToday || loading) return
    const d = dailyCheckinHoney({
      mealCount: entries.length,
      waterMl,
      waterTargetMl: waterTarget,
      exerciseCount: exercise.length,
    })
    const date = today
    if (d.meal > 0) void grantHoney('checkin_meal', date, CHECKIN_MEAL)
    if (d.water > 0) void grantHoney('checkin_water', date, CHECKIN_WATER)
    if (d.exercise > 0) void grantHoney('checkin_exercise', date, CHECKIN_EXERCISE)
  }, [isToday, loading, entries.length, waterMl, waterTarget, exercise.length, today])

  // 连续打卡里程碑 → 发积分 + 点亮徽章。grant_key 用「里程碑达成日期」防重复。
  useEffect(() => {
    if (!streak.activeToday) return
    const honey = streakMilestoneHoney(streak.current)
    if (honey > 0) void grantHoney('streak_milestone', `${streak.current}d-${today}`, honey)
    const badgeKey = STREAK_BADGES[streak.current]
    if (badgeKey) void unlockBadge(badgeKey)
  }, [streak.current, streak.activeToday, today])

  // 受邀人 7 日打卡达标 → 结算双向奖励（新人 +200+7天Pro，邀请人 +250）。幂等。
  useEffect(() => {
    if (!isToday || loading || !profile?.invited_by) return
    if (entries.length > 0) void settleInviteCheckin()
  }, [isToday, loading, profile?.invited_by, entries.length])


  const byMeal = useMemo(() => {
    const map: Record<MealType, MealEntry[]> = { breakfast: [], lunch: [], dinner: [], snack: [] }
    for (const e of entries) {
      const k = (e.meal_type in map ? e.meal_type : 'snack') as MealType
      map[k].push(e)
    }
    return map
  }, [entries])

  const dayInsight = useMemo(() => summarizeEntries(entries, categoryOf), [entries])
  const eatenMeals = useMemo(() => new Set<string>(entries.map((e) => e.meal_type)), [entries])
  const advice = useMemo(() => nextMealAdvice(remain, eatenMeals), [remain, eatenMeals])

  const weekBars = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of recentMeals) map.set(m.log_date, (map.get(m.log_date) ?? 0) + (Number(m.calories) || 0))
    return Array.from({ length: 7 }, (_, i) => {
      const d = shiftDate(today, i - 6)
      return { date: d, kcal: Math.round(map.get(d) ?? 0), logged: map.has(d), isToday: d === today }
    })
  }, [recentMeals, today])

  const weekPeak = useMemo(() => Math.max(target.calories, ...weekBars.map((b) => b.kcal), 1), [target.calories, weekBars])

  const checkupLevel = dayInsight.avgScore === null ? null : levelOfScore(dayInsight.avgScore)
  const checkupTone = checkupLevel === 'great' || checkupLevel === 'good' ? 'is-good' : checkupLevel === 'ok' ? 'is-ok' : 'is-warn'

  // 饮食体检折叠状态（对齐主工程：默认展开，可折叠详情区）
  const [checkupCollapsed, setCheckupCollapsed] = useState(false)

  // 给你的建议（来自引导时 AI 生成的 plan_summary）
  const planAdvice = useMemo(() => {
    if (!profile?.plan_summary) return []
    try {
      const parsed = JSON.parse(profile.plan_summary) as { summary?: string; advice?: string[] }
      return parsed.advice ?? []
    } catch {
      return []
    }
  }, [profile?.plan_summary])

  const waterPct = Math.min(100, Math.round((waterMl / waterTarget) * 100))

  /* ── 交互 ── */

  async function handleDelete(id?: number) {
    if (!id) return
    if (pendingDeleteId !== id) { setPendingDeleteId(id); return }
    setPendingDeleteId(null)
    setError('')
    try {
      await deleteMeal(id)
      // 删除今日记录后收回当日打卡积分（幂等，防刷）
      if (logDate === today) void refundCheckinHoney(logDate)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  function startEdit(e: MealEntry) {
    if (e.id == null) return
    setEditingId(e.id)
    setEditGrams(String(Math.round(Number(e.grams) || 0)))
  }

  async function saveEdit() {
    if (editingId == null) return
    const g = Math.round(Number(editGrams) || 0)
    if (g < 1 || g > 2000) { setError('请输入 1–2000 克之间的份量'); return }
    setError('')
    try {
      await updateMealGrams(editingId, g)
      setEditingId(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败')
    }
  }

  async function handleWater(ml: number) {
    setError('')
    try { setWater(await addWater(logDate, ml)) } catch (e) { setError(e instanceof Error ? e.message : '记录饮水失败') }
  }

  /* ── 手动记一餐（P0-D）── */

  /**
   * 打开手动录入弹层。餐次默认按当前时间推断（guessMealType），
   * 补记历史日期时同样用时间推断，用户可在弹层内切换。
   * 「最近吃过」懒加载：只在打开弹层时拉一次 30 天记录，不拖慢首屏。
   */
  function openManualSheet(meal?: MealType) {
    setManualMeal(meal ?? guessMealType())
    setManualName(''); setManualKcal(''); setManualGrams('')
    setManualProtein(''); setManualCarb(''); setManualFat('')
    setError('')
    setManualOpen(true)
    if (recentFoods.length === 0) {
      void listRecentMeals(30, 200)
        .then((list) => setRecentFoods(aggregateRecent(list)))
        .catch(() => { /* 拉取失败不阻塞手动录入 */ })
    }
  }

  /** 点「最近吃过」快捷项 → 回填整条记录（名称/热量/克数/三大营养素） */
  function pickRecent(f: RecentFood) {
    setManualName(f.name)
    setManualKcal(f.kcal ? String(Math.round(f.kcal)) : '')
    setManualGrams(f.grams ? String(Math.round(f.grams)) : '')
    setManualProtein(f.protein_g ? String(f.protein_g) : '')
    setManualCarb(f.carb_g ? String(f.carb_g) : '')
    setManualFat(f.fat_g ? String(f.fat_g) : '')
  }

  /**
   * 保存手动记录。source='manual'（与主端 LogSheet 一致 → 报告与 AI 标识
   * 判定都不把它当 AI 生成内容）。营养字段可选，缺省 0；只强制名称与热量>0。
   */
  async function handleManualSave() {
    const name = manualName.trim()
    if (!name) { setError('请输入食物名称'); return }
    const kcal = Math.round(Number(manualKcal) || 0)
    if (kcal <= 0) { setError('请输入本份热量（kcal）'); return }
    if (kcal > 5000) { setError('单条热量过高，请核对是否填错'); return }
    const gramsRaw = Number(manualGrams) || 0
    const grams = gramsRaw > 0 ? Math.round(gramsRaw) : null
    const num = (s: string) => {
      const v = Number(s) || 0
      // 克数类营养素写库保留 2 位小数（与主端 LogSheet.tsx:233-238 同口径）
      return v > 0 ? roundTo(v, 2) : 0
    }
    setManualSaving(true)
    setError('')
    try {
      await insertMeals([{
        log_date: logDate,
        meal_type: manualMeal,
        food_name: name,
        quantity_text: grams ? `${grams} 克` : null,
        grams,
        calories: kcal,
        protein_g: num(manualProtein),
        carb_g: num(manualCarb),
        fat_g: num(manualFat),
        source: 'manual',
      }])
      setManualOpen(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setManualSaving(false)
    }
  }

  async function handleWaterUndo() {
    setError('')
    try {
      await undoLastWater(logDate)
      // 撤销饮水后收回当日 checkin_water 积分（若总量不再达标，幂等）
      if (logDate === today) void refundCheckinWater(logDate)
      setWater(await listWaterByDate(logDate))
    } catch (e) { setError(e instanceof Error ? e.message : '撤销失败') }
  }

  async function handleAddExercise() {
    setError('')
    const minutes = Math.max(1, Math.round(Number(exMinutes) || 0))
    const kcal = exerciseKcal(exName, minutes, profile?.current_weight_kg)
    try {
      setExercise(await addExercise({ log_date: logDate, name: exName, minutes, calories: kcal }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录运动失败')
    }
  }

  async function handleDelExercise(id?: number) {
    if (!id) return
    setError('')
    try {
      setExercise(await deleteExercise(id, logDate))
      // 删除运动后收回当日 checkin_exercise 积分（若当日已无运动，幂等）
      if (logDate === today) void refundCheckinExercise(logDate)
    } catch (e) { setError(e instanceof Error ? e.message : '删除失败') }
  }

  function goLogin() { Taro.navigateTo({ url: '/pages/login/login' }) }
  function goScan() { Taro.navigateTo({ url: '/pages/scan/scan' }) }

  /**
   * 「记一餐」双路入口（P0-D）：拍照识别（消耗额度）或手动录入（永久免费）。
   * 对齐主工程 LogSheet 的 photo/manual 模式选择。
   */
  function openAddMenu(meal?: MealType) {
    Taro.showActionSheet({ itemList: ['拍照识别', '手动录入'] })
      .then((res) => {
        if (res.tapIndex === 0) goScan()
        else if (res.tapIndex === 1) openManualSheet(meal)
      })
      .catch(() => { /* 用户取消 */ })
  }
  function goReport() { Taro.navigateTo({ url: '/pages/report/report' }) }
  function goProfile() { Taro.navigateTo({ url: '/pages/profile/profile' }) }
  function goInvite() { Taro.navigateTo({ url: '/pages/invite/invite' }) }
  function goCoach() { Taro.navigateTo({ url: '/pages/coach/coach' }) }
  function goLeaderboard() { Taro.navigateTo({ url: '/pages/leaderboard/leaderboard' }) }

  // 未登录：引导去登录
  if (!loggedIn) {
    return (
      <View className='index dash'>
        <View className='auth-gate'>
          <Text className='auth-title'>自律蜜蜂</Text>
          <Text className='auth-desc'>登录后记录你的每一餐，热量与营养一目了然。</Text>
          <Button className='btn-primary' onClick={goLogin}>登录 / 注册</Button>
        </View>
      </View>
    )
  }

  const exPreview = exerciseKcal(exName, Math.max(1, Math.round(Number(exMinutes) || 0)), profile?.current_weight_kg)

  return (
    <View className='index dash'>
      {/* 顶部：应用名 + 日期导航 */}
      <View className='dash-head'>
        <Text className='dash-title'>自律蜜蜂</Text>
        <View className='date-nav'>
          <Button className='date-arrow' onClick={() => setLogDate((d) => shiftDate(d, -1))}>‹</Button>
          <Button className='date-label' onClick={() => setPickerOpen((v) => !v)}>
            {isToday ? '今天' : formatDateShort(logDate)} ▾
          </Button>
          <Button className='date-arrow' onClick={() => setLogDate((d) => shiftDate(d, 1))}>›</Button>
        </View>
      </View>

      {/* 周历条：左右滑动翻周，点选任意一天 */}
      <WeekStrip
        date={logDate}
        today={today}
        loggedDates={loggedDates}
        onPick={setLogDate}
        onShiftDays={(days) => setLogDate((d) => shiftDate(d, days))}
      />

      {/* 月历选择器 */}
      {pickerOpen && (
        <MonthPicker
          value={logDate}
          today={today}
          loggedDates={loggedDates}
          onSelect={(d) => { setLogDate(d); setPickerOpen(false) }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {error ? <View className='notice err'><Text>{error}</Text></View> : null}

      {/* 热量卡 */}
      <View className='ring-card'>
        <View className='ring-row'>
          <View className='side-stat'>
            <View className='side-label'>
              <IconFork color='#b9740d' size={15} />
              <Text>已摄入</Text>
            </View>
            <Text className='side-num'>{Math.round(totals.kcal)}</Text>
          </View>

          <Ring value={Math.min(Math.max(netKcal, 0), target.calories)} max={target.calories} size={148} stroke={13}>
            <Text className={`ring-remain ${over ? 'over' : ''}`}>{Math.abs(remain)}</Text>
            <Text className='ring-sub'>{over ? '超出预算' : '剩余'}</Text>
          </Ring>

          <View className='side-stat'>
            <View className='side-label'>
              <Text>已消耗</Text>
              <IconFire color='#d05c4e' size={15} />
            </View>
            <Text className='side-num'>{Math.round(effectiveBurnKcal)}</Text>
          </View>
        </View>

        <View className='ring-macros'>
          {MACRO_META.map((m) => {
            const goal = target[m.key]
            const got = m.key === 'protein_g' ? totals.p : m.key === 'carb_g' ? totals.c : totals.f
            const ratio = goal > 0 ? Math.min(got / goal, 1) : 0
            const Icon = m.icon
            return (
              <View className='rm-col' key={m.key}>
                <View className='rm-head'>
                  <Icon color={m.color} size={13} />
                  <Text>{m.label}</Text>
                </View>
                <View className='rm-track'>
                  <View className='rm-fill' style={{ width: `${ratio * 100}%`, background: m.color }} />
                </View>
                <Text className='rm-val'>{Math.round(got)} / {goal}克</Text>
              </View>
            )
          })}
        </View>
      </View>

      {/* 饮食体检 */}
      {dayInsight.scanned > 0 && dayInsight.avgScore !== null && checkupLevel && (
        <View className='checkup-wrap'>
          <View className='section-title'>
            <Text>饮食体检</Text>
            <Text className='hint'>共 {dayInsight.scanned} 项 · 友好度 {dayInsight.avgScore}</Text>
          </View>
          <View className='card checkup'>
            <View className='checkup-verdict'>
              <View className={`cu-score ${checkupTone}`}>
                <Text>{dayInsight.avgScore}</Text>
              </View>
              <View className='cu-main'>
                <Text className={`cu-level ${checkupTone}`}>{LEVEL_LABELS[checkupLevel]}</Text>
                <Text className='cu-text'>{dayInsight.verdict}</Text>
              </View>
              <View
                className='checkup-toggle'
                onClick={() => setCheckupCollapsed((v) => !v)}
              >
                <Text className={`toggle-chevron ${checkupCollapsed ? 'is-folded' : ''}`}>▾</Text>
                <Text className='toggle-label'>{checkupCollapsed ? '展开' : '收起'}</Text>
              </View>
            </View>

            <View className={`checkup-detail ${checkupCollapsed ? 'is-folded' : ''}`}>
              {dayInsight.risks.length > 0 && (
                <View className='checkup-group'>
                  <Text className='cg-title risk'>建议留意</Text>
                  {dayInsight.risks.map((t) => (
                    <View className='cg-row' key={t.key}>
                      <Text className='cg-label'>{t.label}</Text>
                      <Text className='cg-badge'>{t.count} 项</Text>
                      <Text className='cg-reason'>{t.reason}</Text>
                      <Text className='cg-items'>
                        {t.items.join('、')}
                        {t.count > t.items.length ? ` 等 ${t.count} 项` : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {dayInsight.benefits.length > 0 && (
                <View className='checkup-group'>
                  <Text className='cg-title good'>值得肯定</Text>
                  {dayInsight.benefits.map((t) => (
                    <View className='cg-row' key={t.key}>
                      <Text className='cg-label'>{t.label}</Text>
                      <Text className='cg-badge good'>{t.count} 项</Text>
                      <Text className='cg-reason'>{t.reason}</Text>
                      <Text className='cg-items'>
                        {t.items.join('、')}
                        {t.count > t.items.length ? ` 等 ${t.count} 项` : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {(totals.na > 0 || totals.fb > 0) && (
                <View className='microline'>
                  {totals.na > 0 && <Text className='micro-pill'>今日钠 {fmtNum(totals.na, 0)} mg</Text>}
                  {totals.fb > 0 && <Text className='micro-pill'>膳食纤维 {fmtNum(totals.fb, 2)} g</Text>}
                  {totals.as > 0 && <Text className='micro-pill'>添加糖 {fmtNum(totals.as, 2)} g</Text>}
                </View>
              )}

              <Text className='helper'>
                按营养成分与烹调方式本地推算{dayInsight.aiAssisted > 0 ? `，其中 ${dayInsight.aiAssisted} 项参考了 AI 评分` : ''}，不消耗 AI 次数。仅供参考，不构成医疗建议。
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* 卡路里追踪 */}
      <View className={`advice-strip ${advice.over ? 'is-over' : ''}`}>
        <Text className='as-tag'>卡路里追踪</Text>
        <Text className='as-text'>{advice.text}</Text>
      </View>

      {/* 近 7 天热量迷你趋势 */}
      <View className='card card-tight mini-trend'>
        <View className='mt-head'>
          <Text className='mt-title'>近 7 天热量</Text>
          <Text className='mt-sub'>虚线为预算 {target.calories} kcal</Text>
        </View>
        <View className='mt-bars'>
          {weekBars.map((b) => {
            const h = Math.max(b.kcal > 0 ? 6 : 0, Math.round((b.kcal / weekPeak) * 100))
            const overDay = b.logged && b.kcal > target.calories * 1.1
            return (
              <View
                key={b.date}
                className={`mt-col ${b.isToday ? 'is-today' : ''}`}
                onClick={() => setLogDate(b.date)}
              >
                <Text className='mt-val'>{b.logged ? b.kcal : ''}</Text>
                <View className='mt-track'>
                  <View className={`mt-fill ${overDay ? 'is-over' : ''}`} style={{ height: `${h}%` }} />
                </View>
                <Text className='mt-day'>{Number(b.date.slice(-2))}</Text>
              </View>
            )
          })}
        </View>
      </View>

      {/* 连续打卡 */}
      <View className='streak-card'>
        <View className='streak-flame'>
          <IconFire color={streak.current > 0 ? '#b9740d' : '#a39c90'} size={22} />
        </View>
        <View className='streak-main'>
          <Text className='streak-num'>
            {streak.current > 0 ? `连续打卡 ${streak.current} 天` : isToday ? '今天还没记录，记一餐就开始' : '这天没有记录'}
          </Text>
          <Text className='streak-sub'>
            最长 {streak.longest} 天 · 累计 {streak.total} 天
            {streak.nextMilestone ? ` · 再坚持 ${streak.nextMilestone - streak.current} 天到 ${streak.nextMilestone} 天里程碑` : ''}
          </Text>
          {streak.current > 0 && MILESTONES.includes(streak.current) ? (
            <Text className='streak-hit'>🎉 达成 {streak.current} 天里程碑！</Text>
          ) : null}
        </View>
      </View>

      {/* 饮水 */}
      <View className='card'>
        <View className='water-head'>
          <View className='water-title'>
            <IconWater color='#3d7bb8' size={18} />
            <Text>饮水</Text>
          </View>
          <Text className='water-val'>{(waterMl / 1000).toFixed(2)} / {(waterTarget / 1000).toFixed(1)} L</Text>
        </View>
        <View className='macro-track'>
          <View className='macro-fill' style={{ width: `${waterPct}%`, background: '#3d7bb8' }} />
        </View>
        <View className='chip-row'>
          <Button className='chip water-chip' onClick={() => void handleWater(250)}>+250 ml</Button>
          <Button className='chip water-chip' onClick={() => void handleWater(500)}>+500 ml</Button>
          {water.length > 0 ? (
            <Button className='btn-text' onClick={() => void handleWaterUndo()}>撤销一杯</Button>
          ) : null}
        </View>
      </View>

      {/* 运动 */}
      <View className='card'>
        <View className='water-head'>
          <View className='water-title'>
            <IconRun color='#3f9463' size={18} />
            <Text>运动</Text>
          </View>
          {exercise.length > 0 ? (
            <Text className='water-val'>消耗 {Math.round(burnKcal)} kcal</Text>
          ) : null}
        </View>

        {exercise.length > 0 ? (
          <View className='ex-list'>
            {exercise.map((x) => (
              <View key={x.id} className='ex-row'>
                <Text className='ex-name'>{x.name} {x.minutes} 分钟</Text>
                <Text className='ex-kcal'>{Math.round(Number(x.calories))} kcal</Text>
                <Button className='entry-del' onClick={() => void handleDelExercise(x.id)}>×</Button>
              </View>
            ))}
          </View>
        ) : null}

        <View className='chips'>
          {EXERCISES.map((e) => (
            <Button key={e.name} className={`chip ${exName === e.name ? 'active' : ''}`} onClick={() => setExName(e.name)}>{e.name}</Button>
          ))}
        </View>
        <View className='ex-input-row'>
          <View className='stepper'>
            <Input type='number' value={exMinutes} onInput={(e) => setExMinutes(e.detail.value)} />
            <Text className='unit'>分钟</Text>
            <Text className='ex-est'>≈ {exPreview} kcal</Text>
          </View>
          <Button className='btn btn-ghost' onClick={() => void handleAddExercise()}>
            <IconPlus color='#2a2723' />
            记录
          </Button>
        </View>
      </View>

      {/* 餐次 */}
      <View className='section-title'>
        <Text>{isToday ? '今日餐次' : '这一天'}</Text>
        <Text className='hint'>{entries.length} 条记录</Text>
      </View>

      {loading ? (
        <View className='skeleton' />
      ) : (
        MEAL_ORDER.map((m) => {
          const list = byMeal[m]
          const kcal = Math.round(list.reduce((s, e) => s + (Number(e.calories) || 0), 0))
          return (
            <View className='meal-block' key={m}>
              <View className='meal-head'>
                <View className='left'>
                  <View className='meal-dot' />
                  <Text className='meal-name'>{MEAL_LABELS[m]}</Text>
                </View>
                <View className='meal-right'>
                  <Text className='meal-kcal'>{list.length ? `${kcal} kcal` : ''}</Text>
                  <Button className='meal-add' onClick={() => openAddMenu(m)}>+</Button>
                </View>
              </View>
              {list.length === 0 ? (
                <Text className='meal-empty'>还没有记录</Text>
              ) : (
                list.map((e) => (
                  <View className='entry' key={e.id ?? `${e.food_name}-${e.created_at}`}>
                    <View className='entry-main'>
                      <Text className='entry-name'>{e.food_name}</Text>
                      <Text className='entry-meta'>{e.quantity_text || ''}{e.ai_note ? ` · ${e.ai_note}` : ''}</Text>
                      {editingId === e.id ? (
                        <View className='entry-edit'>
                          <Input type='number' value={editGrams} onInput={(ev) => setEditGrams(ev.detail.value)} />
                          <Text>g</Text>
                          <Button className='btn-text' onClick={() => void saveEdit()}>保存</Button>
                          <Button className='btn-text' onClick={() => setEditingId(null)}>取消</Button>
                        </View>
                      ) : (
                        <Button className='btn-text edit-link' onClick={() => startEdit(e)}>编辑份量</Button>
                      )}
                    </View>
                    <Text className='entry-kcal'>{Math.round(Number(e.calories))}</Text>
                    <Button
                      className={`entry-del ${pendingDeleteId === e.id ? 'confirming' : ''}`}
                      onClick={() => void handleDelete(e.id)}
                    >
                      {pendingDeleteId === e.id ? '删除?' : '×'}
                    </Button>
                  </View>
                ))
              )}
            </View>
          )
        })
      )}

      {/* 给你的建议（引导时 AI 生成 → 《标识办法》第四条（一）加显式标识，P0-A） */}
      {planAdvice.length > 0 && (
        <View>
          <View className='section-title'>
            <View className='section-title-left'>
              <Text>给你的建议</Text>
              <AiLabel />
            </View>
          </View>
          <View className='card'>
            {planAdvice.map((a, i) => (
              <View key={i} className='plan-row'>
                <Text className='plan-idx'>{i + 1}</Text>
                <Text className='plan-text'>{a}</Text>
              </View>
            ))}
            <AiLabel inline text='建议由 AI 根据你的目标生成，可能存在误差，不构成医疗或营养建议。' />
          </View>
        </View>
      )}

      {/* 问问小蜜（AI 教练入口，对齐主工程 Dashboard coach-entry） */}
      <Button className='coach-entry' onClick={goCoach}>饮食上有拿不准的？问问小蜜 →</Button>

      {/* 站内轻榜单入口（P2-1，对齐主工程首页直达） */}
      <View className='invite-strip leaderboard-strip' onClick={goLeaderboard}>
        <Text className='is-ico'>🏆</Text>
        <View className='is-text'>
          <Text>自律榜单</Text>
          <Text className='is-small'>看看大家坚持了多久，连续打卡满 3 天即可上榜</Text>
        </View>
        <Text className='arrow'>›</Text>
      </View>

      {/* 邀请好友入口（拉新主入口，对齐主工程首页直达） */}
      <View className='invite-strip' onClick={goInvite}>
        <Text className='is-ico'>🍯</Text>
        <View className='is-text'>
          <Text>邀请好友一起自律</Text>
          <Text className='is-small'>你得蜜糖，好友得 7 天 Pro</Text>
        </View>
        <Text className='arrow'>›</Text>
      </View>

      <View className='bottom-space' />

      {/* 手动记一餐弹层（P0-D）：对齐主工程 LogSheet manual 模式。
          手动录入永久免费、不消耗任何额度，source='manual' 不算 AI 生成。 */}
      {manualOpen && (
        <Sheet title='手动记一餐' onClose={() => setManualOpen(false)}>
          <View className='manual-form'>
            <View className='chips'>
              {MEAL_ORDER.map((m) => (
                <Button key={m} className={`chip ${manualMeal === m ? 'active' : ''}`} onClick={() => setManualMeal(m)}>
                  {MEAL_LABELS[m]}
                </Button>
              ))}
            </View>
            <View className='mf-row'>
              <Input className='mf-input' placeholder='食物名称，如：燕麦粥' value={manualName} onInput={(e) => setManualName(e.detail.value)} />
            </View>
            <View className='mf-row'>
              <View className='mf-field'>
                <Input className='mf-input' type='number' placeholder='热量 kcal *' value={manualKcal} onInput={(e) => setManualKcal(e.detail.value)} />
                <Text className='mf-unit'>kcal</Text>
              </View>
              <View className='mf-field'>
                <Input className='mf-input' type='number' placeholder='份量（可选）' value={manualGrams} onInput={(e) => setManualGrams(e.detail.value)} />
                <Text className='mf-unit'>克</Text>
              </View>
            </View>
            <View className='mf-row'>
              <View className='mf-field'>
                <Input className='mf-input' type='digit' placeholder='蛋白质' value={manualProtein} onInput={(e) => setManualProtein(e.detail.value)} />
                <Text className='mf-unit'>g</Text>
              </View>
              <View className='mf-field'>
                <Input className='mf-input' type='digit' placeholder='碳水' value={manualCarb} onInput={(e) => setManualCarb(e.detail.value)} />
                <Text className='mf-unit'>g</Text>
              </View>
              <View className='mf-field'>
                <Input className='mf-input' type='digit' placeholder='脂肪' value={manualFat} onInput={(e) => setManualFat(e.detail.value)} />
                <Text className='mf-unit'>g</Text>
              </View>
            </View>
            {recentFoods.length > 0 && (
              <View className='mf-recent'>
                <Text className='mf-recent-title'>最近吃过（点按回填）</Text>
                <View className='mf-recent-list'>
                  {recentFoods.map((f) => (
                    <Button key={f.name} className='mf-recent-item' onClick={() => pickRecent(f)}>
                      <Text className='mf-rf-name'>{f.name}</Text>
                      <Text className='mf-rf-kcal'>{Math.round(f.kcal)} kcal</Text>
                    </Button>
                  ))}
                </View>
              </View>
            )}
            {error && <Text className='mf-error'>{error}</Text>}
            <Button className='btn-primary mf-save' loading={manualSaving} disabled={manualSaving} onClick={() => void handleManualSave()}>
              {manualSaving ? '保存中…' : `记到${isToday ? '今天' : formatDateShort(logDate)} · ${MEAL_LABELS[manualMeal]}`}
            </Button>
            <Text className='mf-note'>手动录入永久免费，不消耗识别次数</Text>
          </View>
        </Sheet>
      )}

      {/* 主操作「记一餐」吸底悬浮（P0-D：拍照识别 / 手动录入 双路） */}
      <Button className='btn fab-meal' onClick={() => openAddMenu()}>
        <IconPlus color='#4a3208' />
        <Text>记一餐</Text>
      </Button>

      {/* 底部导航（对齐主工程三 tab：今日 / 报告 / 我的） */}
      <View className='tabbar'>
        <View className='tab-item is-active' onClick={() => {}}>
          <IconToday active size={20} />
          <Text className='tab-label'>今日</Text>
        </View>
        <View className='tab-item' onClick={goReport}>
          <IconChart active={false} size={20} />
          <Text className='tab-label'>报告</Text>
        </View>
        <View className='tab-item' onClick={goProfile}>
          <IconMe active={false} size={20} />
          <Text className='tab-label'>我的</Text>
        </View>
      </View>
    </View>
  )
}
