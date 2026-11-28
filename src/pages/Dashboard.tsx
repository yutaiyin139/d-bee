import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconDrop, IconFire, IconFork, IconPea, IconPlus, IconRun, IconWater } from '../components/Icons'
import { FoodTagList } from '../components/FoodTags'
import { MonthPicker } from '../components/MonthPicker'
import { Ring } from '../components/Ring'
import { SiteFooter } from '../components/SiteFooter'
import { WeekStrip } from '../components/WeekStrip'
import type { DocId } from '../content/legal'
import {
  addExercise,
  addWater,
  deleteExercise,
  deleteMeal,
  grantHoney,
  listExerciseByDate,
  listLoggedMeals,
  listMealsByDate,
  listWaterByDate,
  refundCheckinExercise,
  refundCheckinHoney,
  refundCheckinWater,
  settleInviteCheckin,
  undoLastWater,
  unlockBadge,
  updateMealGrams,
} from '../lib/api'
import { explainMeal, LlmFeatureError, type CoachContext } from '../lib/ai'
import { AiConsent } from '../components/AiConsent'
import { grantAiConsent, hasAiConsent } from '../lib/aiConsent'
import { STREAK_BADGES } from '../lib/badge'
import { AI_REDEEM_DAILY_LIMIT, FREE_DAILY_AI, HEALTH_SYNC_INTERVAL_MS, MEAL_PAYWALL_REASON, proDaysLeft } from '../lib/entitlement'
import { categoryOf } from '../lib/foods'
import { LEVEL_LABELS, levelOfScore, nextMealAdvice, summarizeEntries } from '../lib/foodInsight'
import { ACTIVITY_EATBACK_RATIO, connectHealth, DEFAULT_STEP_GOAL, estimateActivityKcal, getHealthVendor, healthConnectInstallOffered, healthStatusHint, isHealthConnectable, isHealthConnectAvailable, isHealthConnected, isUsableHealthStatus, openHealthConnect, probeHealthConnectAvailability, syncFromHealth, type HealthSyncData } from '../lib/health'
import { isAndroid } from '../lib/platform'
import { CHECKIN_EXERCISE, CHECKIN_MEAL, CHECKIN_WATER, dailyCheckinHoney, streakMilestoneHoney } from '../lib/invite'
import { errText } from '../lib/errmsg'
import { kvGet, kvSet } from '../lib/kv'
import { EXERCISES, exerciseKcal, formatDateShort, guessMealType, shiftDate, targetFromProfile, todayKey, waterTargetMl } from '../lib/nutrition'
import { createShareCanvas, drawCheckinCard, canvasToBlob } from '../lib/sharecard'
import { shareImage } from '../lib/share'
import { computeStreak, MILESTONES } from '../lib/streak'
import { GRAMS_LIMIT, MINUTES_LIMIT, checkNumber, clampNumeric, sanitizeNumeric } from '../lib/validate'
import { fmtNum } from '../lib/numfmt'
import { usePlan } from '../state/plan'
import { MEAL_LABELS, MEAL_ORDER } from '../types'
import type { ExerciseLog, MealEntry, MealSlim, MealType, Profile, WaterLog } from '../types'
import { CoachSheet } from './CoachSheet'
import { InviteCenter } from './InviteCenter'
import { LeaderboardSheet } from './LeaderboardSheet'
import { LogSheet } from './LogSheet'

interface DashboardProps {
  profile: Profile
  onOpenLegal: (id: DocId) => void
}

// 配色对应参考稿：蛋白质绿、碳水橙、脂肪黄
const MACRO_META = [
  { key: 'protein_g', label: '蛋白质', color: 'var(--green)', icon: IconPea },
  { key: 'carb_g', label: '碳水化合物', color: 'var(--honey)', icon: IconDrop },
  { key: 'fat_g', label: '脂肪', color: 'var(--yellow)', icon: IconDrop },
] as const

const STREAK_WINDOW_DAYS = 185

// 健康数据自动同步间隔已下沉 @dbee/shared（HEALTH_SYNC_INTERVAL_MS），四端同源。

/**
 * 把一次同步结果翻译成「该写回哪些状态」。
 *
 * 🔴 抽成模块级纯函数而非在组件里写两遍：自动轮询（applySync）与手动连接
 *    （handleConnectHealth）必须**逐条同规则**，否则会出现「轮询说空、手动连接说
 *    正在读取」的自相矛盾。单一真相源也便于单测直接覆盖分支。
 *
 * 规则：
 *  · isUsableHealthStatus（ok/empty/no_plugin）→ 写回数值；其中 **empty 也要给一句
 *    可见说明**（今天确实没数据 ≠ 功能坏了，静默会让用户误判）。
 *  · 其余（denied/error/unavailable/not_ready，error 含读数超时降级）→ **不写回数值**
 *    （原生此时回 0，写回会把用户已有步数抹成 0），只显示引导文案。
 */
function healthSyncView(
  data: HealthSyncData,
  vendorLabel: string,
  isHealthConnectVendor: boolean,
): { steps: number; activeKcal: number; hint: string; writeValues: boolean } {
  if (isUsableHealthStatus(data.status)) {
    return {
      steps: data.steps,
      activeKcal: data.activeKcal,
      hint:
        data.status === 'empty'
          ? healthStatusHint(data.status, vendorLabel, isHealthConnectVendor)
          : '',
      writeValues: true,
    }
  }
  return {
    steps: 0,
    activeKcal: 0,
    hint: healthStatusHint(data.status, vendorLabel, isHealthConnectVendor),
    writeValues: false,
  }
}

export function Dashboard({ profile, onOpenLegal }: DashboardProps) {
  const { pro, lifetime, entitlement, aiRemaining, openPaywall, grantStreakBonus } = usePlan()
  const [logDate, setLogDate] = useState(todayKey())
  const [entries, setEntries] = useState<MealEntry[]>([])
  const [water, setWater] = useState<WaterLog[]>([])
  const [exercise, setExercise] = useState<ExerciseLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sheetMeal, setSheetMeal] = useState<MealType | null>(null)
  const [coachOpen, setCoachOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 邀请中心直接在本页可达：增长主入口不再只藏在「我的」二级页
  const [inviteOpen, setInviteOpen] = useState(false)
  // 站内轻榜单（P2-1）：首页直达入口
  const [leaderboardOpen, setLeaderboardOpen] = useState(false)
  const [mealNote, setMealNote] = useState('')
  const [mealBusy, setMealBusy] = useState(false)
  const [mealErr, setMealErr] = useState('')
  const [mealConsentOpen, setMealConsentOpen] = useState(false)

  // 原位编辑与删除确认：避免竞品「提交后不能改」「误触删除」两个差评点
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editGrams, setEditGrams] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  // 删除确认态：3 秒内未二次确认则自动复位，避免红色「删除?」残留导致后续误删
  useEffect(() => {
    if (pendingDeleteId == null) return
    const t = setTimeout(() => setPendingDeleteId(null), 3000)
    return () => clearTimeout(t)
  }, [pendingDeleteId])

  // 健康连接：品牌识别 + 连接状态（云端）+ 步数/活动能量 + 提示
  // HC probe 时序：Health Connect 可用性是异步探测的跨进程查询，缓存未热时
  // getHealthVendor()/isHealthConnectable() 读到的是保守 false。故挂载时 probe 一次，
  // 完成后置 hcReady 触发这两个 useMemo 重算（非 Android 恒不触发，零开销；
  // probe 幂等且结果缓存，重复挂载不重复打跨进程查询）。
  const [hcEpoch, setHcEpoch] = useState(0)
  useEffect(() => {
    if (!isAndroid()) return
    let alive = true
    const bump = () => {
      void probeHealthConnectAvailability(true).then(() => {
        if (alive) setHcEpoch((n) => n + 1)
      })
    }
    bump()
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const healthVendor = useMemo(() => getHealthVendor(), [hcEpoch])
  // 是否支持健康数据源连接（仅原生 App：iOS HealthKit / 华为·小米 Health Kit / Health Connect）。
  // Web 端恒 false：不显示任何健康同步/连接相关提示。
  const healthConnectable = useMemo(() => isHealthConnectable(), [hcEpoch])
  const [healthConnected, setHealthConnected] = useState(false)
  const [healthSteps, setHealthSteps] = useState(0)
  const [healthActiveKcal, setHealthActiveKcal] = useState(0)
  const [healthTip, setHealthTip] = useState('')
  // 同步异常提示（授权被拒/出错/资质未就绪等）；与 healthTip（连接动作反馈）分开，
  // 避免自动轮询的异常提示把用户刚看到的连接结果顶掉
  const [healthSyncHint, setHealthSyncHint] = useState('')
  /**
   * 🔴 首次读数是否**已有结论**（成功/空/出错/超时都算），默认 false。
   *
   * 为什么必须有：旧实现只靠 `!hasHealthData`（步数与活动能量都为 0）来判断
   * 「还在读取中」，但「读完了、今天确实是 0 步 / 读数超时降级」**同样**满足
   * `!hasHealthData` → 「正在读取今天的步数，稍候自动展示」这句永驻不消失，
   * 用户看到的就是「连接成功了，但一直没有反应」（2026-11-18 小米 15 Ultra 实测）。
   * 「读取进行中」与「读取已结束但无数据」是两种必须区分开的状态，
   * 只有真实拿到过一次读数结果才允许把文案从「正在读取」切走。
   */
  const [healthSyncSettled, setHealthSyncSettled] = useState(false)
  // 步数目标：优先用户自定义（profile.step_goal），缺省用默认值
  const stepGoal = profile.step_goal && profile.step_goal > 0 ? profile.step_goal : DEFAULT_STEP_GOAL
  // 是否已有健康数据（步数或活动能量任一 > 0）：决定是否渲染健康数据块，避免空块观感差
  const hasHealthData = healthSteps > 0 || healthActiveKcal > 0
  // 数据源是否为 Health Connect（Android 统一层）：denied 的权限入口措辞与 iOS 不同
  const isHealthConnectVendor = healthVendor.vendor === 'health_connect'

  // 饮食体检伸缩：默认展开，点击右上角折叠/展开详情区；折叠偏好记忆到本地，下次打开保持
  const [checkupCollapsed, setCheckupCollapsed] = useState(false)

  // 健康连接：挂载时读云端连接状态；已连接则自动同步步数/活动能量。
  // ① visibilitychange：从系统健康设置页切回 App 时立即回检并刷新
  //   （授权可能刚在设置里完成，回到 App 必须立即可见，而不是等下次登录）。
  // ② 定时轮询：已连接后每 60s 拉一次当天步数/活动能量，步数走路时实时上涨、
  //   自动刷新「今天还没动」/进度条，无需手动刷新页面。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined

    /**
     * 把同步结果落到状态。
     * ⚠️ 只有 isUsableHealthStatus 才写回数值：授权被拒 / 查询报错 / 设备不支持时，
     * 原生返回的 steps 是 0，直接写回会把用户已有的步数抹成 0（且看不出原因）。
     * 这些情况改为显示 healthStatusHint 的引导文案，数值保持上一次成功读到的结果。
     * 🔴 任何分支都必须置 healthSyncSettled=true：读数一旦有了结论（哪怕是「今天
     * 真的 0 步」或「超时降级」），UI 就不能再声称「正在读取」。
     */
    function applySync(data: Awaited<ReturnType<typeof syncFromHealth>>) {
      if (!alive) return
      setHealthSyncSettled(true)
      const v = healthSyncView(data, healthVendor.label, isHealthConnectVendor)
      if (v.writeValues) {
        setHealthSteps(v.steps)
        setHealthActiveKcal(v.activeKcal)
      }
      setHealthSyncHint(v.hint)
    }

    async function refreshHealth() {
      // Web 端不支持健康数据源，直接跳过（不读云端连接态，也不渲染同步提示）
      if (!healthConnectable) return
      const connected = await isHealthConnected()
      if (!alive) return
      setHealthConnected(connected)
      if (connected) {
        applySync(await syncFromHealth())
      }
    }

    void refreshHealth()
    // 定时自动同步：仅在已连接时才轮询（未连接时无数据可拉）
    timer = setInterval(() => {
      if (!healthConnectable) return
      void isHealthConnected().then((connected) => {
        if (!alive || !connected) return
        void syncFromHealth().then(applySync)
      })
    }, HEALTH_SYNC_INTERVAL_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshHealth()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // 依赖 healthConnectable/healthVendor：hcReady 翻转后（HC probe 完成）重跑一次，
    // 使轮询与提示读到 probe 后的正确值；两者均为 useMemo 稳定值，正常只跑一次。
    // isHealthConnectVendor 由 healthVendor 派生，列出仅为满足 exhaustive-deps。
  }, [healthConnectable, healthVendor, isHealthConnectVendor])

  // 折叠偏好：挂载时从本地读取一次，之后用户切换时写回（异步、静默，失败不影响交互）
  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await kvGet('ui.checkup.collapsed', null)
      if (!alive) return
      if (c === '1') setCheckupCollapsed(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  function toggleCheckup() {
    setCheckupCollapsed((v) => {
      const next = !v
      void kvSet('ui.checkup.collapsed', next ? '1' : '0')
      return next
    })
  }

  // 打卡：需要近半年的「有记录日期」集合；同时留一份近窗记录用于卡路里趋势。
  // 0040：这里只保存窄投影（日期 + 热量），首页用不到营养素明细。
  const [loggedDates, setLoggedDates] = useState<string[]>([])
  const [recentMeals, setRecentMeals] = useState<MealSlim[]>([])
  const today = todayKey()

  const target = useMemo(() => targetFromProfile(profile), [profile])
  const waterTarget = useMemo(() => waterTargetMl(profile.current_weight_kg), [profile.current_weight_kg])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [m, w, x, recent] = await Promise.all([
        listMealsByDate(logDate),
        listWaterByDate(logDate),
        listExerciseByDate(logDate),
        // 0040：首页只需要「日期 + 热量」，改窄投影（载荷降到全字段的 ~1/10，
        // 仍是一次请求）。营养素明细只有报告页需要，仍走 listMealsBetween。
        listLoggedMeals(shiftDate(today, -STREAK_WINDOW_DAYS), today),
      ])
      setEntries(m)
      setWater(w)
      setExercise(x)
      setRecentMeals(recent)
      setLoggedDates(Array.from(new Set(recent.map((r) => r.log_date))))
    } catch (e) {
      setError(errText(e, '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [logDate, today])

  useEffect(() => {
    void load()
  }, [load])

  const totals = useMemo(
    () =>
      entries.reduce(
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
      ),
    [entries],
  )

  const waterMl = useMemo(() => water.reduce((s, w) => s + (Number(w.amount_ml) || 0), 0), [water])
  const burnKcal = useMemo(() => exercise.reduce((s, x) => s + (Number(x.calories) || 0), 0), [exercise])

  // 健康数据源 = 手动运动的有效补充，不是替代：
  //   - 拿得到健康数据（活动能量或步数 > 0）→ 参与计算
  //   - 拿不到（未连接 / 无数据）→ 完全不影响，手动运动照常算
  // 活动能量（activeEnergyBurned）已含全天活动（含手动运动），若再叠加手动运动 burnKcal
  // 会重复计。故「活动能量」与「手动运动」二者取较大者，避免高估消耗、保证数据合理。
  const activityKcal = useMemo(() => {
    if (healthActiveKcal > 0) return healthActiveKcal
    return estimateActivityKcal(healthSteps, profile.current_weight_kg, profile.height_cm)
  }, [healthActiveKcal, healthSteps, profile.current_weight_kg, profile.height_cm])
  // 有效运动消耗：活动能量与手动运动取较大者（防止重复计、保守不虚高）
  const effectiveBurnKcal = Math.max(burnKcal, activityKcal)
  // 净摄入 = 摄入 − 有效运动消耗；活动部分按 50% 计入「可吃回」，让缺口更真实
  const netKcal = Math.round(totals.kcal - effectiveBurnKcal * ACTIVITY_EATBACK_RATIO)

  const remain = Math.round(target.calories - netKcal)
  const over = remain < 0
  const isToday = logDate === today

  const streak = useMemo(() => computeStreak(loggedDates, today), [loggedDates, today])

  // 连续打卡每满 7 天 → 自动发放识别次数奖励（7/14/21…各送 2 次识别）。
  // 以「当前连续段第 7 天的日期」作 grant_key，同一连续段只发一次；
  // 数据库 UNIQUE(owner_id, source, grant_key) 兜底防重复。
  useEffect(() => {
    if (pro) return
    if (streak.streak7Date) void grantStreakBonus(streak.streak7Date)
  }, [streak.streak7Date, pro, grantStreakBonus])

  // 每日打卡积分：记餐 +5 / 饮水达标 +2 / 运动 +2（仅「今天」结算，历史补记不发，
  // 避免切日期刷分）。三项独立 reason + ref_id=当日日期，靠 UNIQUE 防重复。
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

  // 受邀人 7 日打卡达标 → 结算双向奖励（新人 +200+7天Pro，邀请人 +250）。
  // 幂等：settle_invite_checkin 内部用 reason+ref_id UNIQUE 防重复，达标不足时静默返回 false。
  useEffect(() => {
    if (!isToday || loading || !profile.invited_by) return
    if (entries.length > 0) void settleInviteCheckin()
  }, [isToday, loading, profile.invited_by, entries.length])

  const byMeal = useMemo(() => {
    const map: Record<MealType, MealEntry[]> = { breakfast: [], lunch: [], dinner: [], snack: [] }
    for (const e of entries) {
      const k = (e.meal_type in map ? e.meal_type : 'snack') as MealType
      map[k].push(e)
    }
    return map
  }, [entries])

  const planAdvice = useMemo(() => {
    if (!profile.plan_summary) return []
    try {
      const parsed = JSON.parse(profile.plan_summary) as { summary?: string; advice?: string[] }
      return parsed.advice ?? []
    } catch {
      return []
    }
  }, [profile.plan_summary])

  /** 当日饮食体检：规则引擎本地计算，离线可用、不消耗 AI 额度 */
  const dayInsight = useMemo(() => summarizeEntries(entries, categoryOf), [entries])

  async function explainThisMeal() {
    if (!pro) {
      openPaywall(MEAL_PAYWALL_REASON)
      return
    }
    if (!hasAiConsent(profile)) {
      setMealConsentOpen(true)
      return
    }
    setMealBusy(true)
    setMealErr('')
    try {
      const text = await explainMeal({
        kcal: Math.round(totals.kcal),
        protein: Math.round(totals.p),
        carb: Math.round(totals.c),
        fat: Math.round(totals.f),
        foods: entries.map((e) => e.food_name).filter(Boolean).slice(0, 12),
      })
      setMealNote(text)
    } catch (e) {
      if (e instanceof LlmFeatureError && e.code === 'pro_required') openPaywall(MEAL_PAYWALL_REASON)
      else if (e instanceof LlmFeatureError && e.code === 'gate_unavailable') setMealErr('AI 服务暂不可用，请稍后重试')
      else setMealErr(errText(e, '解读失败，请稍后重试'))
    } finally {
      setMealBusy(false)
    }
  }

  /** 卡路里追踪：把剩余额度按还没吃的餐次拆开，给出下一餐的参考上限 */
  const eatenMeals = useMemo(() => new Set<string>(entries.map((e) => e.meal_type)), [entries])
  const advice = useMemo(() => nextMealAdvice(remain, eatenMeals), [remain, eatenMeals])

  /** 近 7 天热量迷你趋势（数据已在近窗查询里，不再额外请求） */
  const weekBars = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of recentMeals) {
      map.set(m.log_date, (map.get(m.log_date) ?? 0) + (Number(m.calories) || 0))
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = shiftDate(today, i - 6)
      return { date: d, kcal: Math.round(map.get(d) ?? 0), logged: map.has(d), isToday: d === today }
    })
  }, [recentMeals, today])

  const weekPeak = useMemo(
    () => Math.max(target.calories, ...weekBars.map((b) => b.kcal), 1),
    [target.calories, weekBars],
  )

  const checkupLevel = dayInsight.avgScore === null ? null : levelOfScore(dayInsight.avgScore)
  const checkupTone = checkupLevel === 'great' || checkupLevel === 'good' ? 'is-good' : checkupLevel === 'ok' ? 'is-ok' : 'is-warn'

  // 传给 AI 助手的实时状态
  const coachCtx: CoachContext = useMemo(
    () => ({
      goal: profile.goal ?? 'keep',
      targetKcal: target.calories,
      eatenKcal: totals.kcal,
      burnedKcal: burnKcal,
      proteinTarget: target.protein_g,
      proteinEaten: totals.p,
      waterMl,
      waterTarget,
      topFoods: entries.slice(0, 5).map((e) => e.food_name),
      barriers: profile.barriers ? profile.barriers.split(',') : [],
    }),
    [profile, target, totals, burnKcal, waterMl, waterTarget, entries],
  )

  async function handleDelete(id?: number) {
    if (!id) return
    // 第一次点击进入「待确认」态，二次点击才真正删除，防误触
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id)
      return
    }
    setPendingDeleteId(null)
    setError('')
    // 删除前记住该记录的 log_date，删除后若当天再无饮食记录则收回打卡积分（防刷）
    const target = entries.find((e) => e.id === id)
    const logDate = target?.log_date
    try {
      await deleteMeal(id)
      // 删除的是「今天」的记录且当天已无其它饮食记录 → 收回 checkin_meal 积分
      if (logDate && logDate === today) void refundCheckinHoney(logDate)
      // 删除后统一刷新：当日列表、运动饮水与打卡状态都依赖日期窗数据
      await load()
    } catch (e) {
      setError(errText(e, '删除失败'))
    }
  }

  function startEdit(e: MealEntry) {
    if (e.id == null) return
    setEditingId(e.id)
    setEditGrams(String(Math.round(Number(e.grams) || 0)))
  }

  async function saveEdit() {
    if (editingId == null) return
    const chk = checkNumber(editGrams, GRAMS_LIMIT)
    if (!chk.ok || chk.value == null) {
      setError(chk.error || `请输入 ${GRAMS_LIMIT.min}–${GRAMS_LIMIT.max} ${GRAMS_LIMIT.unit} 之间的份量`)
      return
    }
    const g = chk.value
    setSavingEdit(true)
    setError('')
    try {
      await updateMealGrams(editingId, g)
      setEditingId(null)
      await load()
    } catch (e) {
      setError(errText(e, '修改失败'))
    } finally {
      setSavingEdit(false)
    }
  }

  async function handleWater(ml: number) {
    setError('')
    try {
      setWater(await addWater(logDate, ml))
    } catch (e) {
      setError(errText(e, '记录饮水失败'))
    }
  }

  async function handleWaterUndo() {
    setError('')
    try {
      await undoLastWater(logDate)
      setWater(await listWaterByDate(logDate))
      // 撤销后若当日饮水不再达标，收回 checkin_water 积分（防刷）
      if (logDate === today) void refundCheckinWater(logDate)
    } catch (e) {
      setError(errText(e, '撤销失败'))
    }
  }

  // 运动快捷录入
  const [exName, setExName] = useState(EXERCISES[0].name)
  const [exMinutes, setExMinutes] = useState('30')
  /** 输入过程中的分钟数（空串/非法时按最小值预览，避免 NaN） */
  const exMinutesNum = useMemo(() => {
    const chk = checkNumber(exMinutes, MINUTES_LIMIT)
    return chk.ok && chk.value != null ? chk.value : MINUTES_LIMIT.min
  }, [exMinutes])
  const exPreview = useMemo(
    () => exerciseKcal(exName, exMinutesNum, profile.current_weight_kg),
    [exName, exMinutesNum, profile.current_weight_kg],
  )

  async function handleAddExercise() {
    setError('')
    try {
      setExercise(await addExercise({ log_date: logDate, name: exName, minutes: exMinutesNum, calories: exPreview }))
    } catch (e) {
      setError(errText(e, '记录运动失败'))
    }
  }

  async function handleDelExercise(id?: number) {
    if (!id) return
    setError('')
    try {
      setExercise(await deleteExercise(id, logDate))
      // 删除后若当日已无运动记录，收回 checkin_exercise 积分（防刷）
      if (logDate === today) void refundCheckinExercise(logDate)
    } catch (e) {
      setError(errText(e, '删除失败'))
    }
  }

  // 连接健康：调 HealthKit 授权 → 走完后存云端状态 + 按钮消失 + 自动同步
  const [healthConnecting, setHealthConnecting] = useState(false)
  async function handleConnectHealth() {
    if (healthConnecting) return
    setHealthConnecting(true)
    try {
      const res = await connectHealth()
      if (res.message) setHealthTip(res.message)
      if (res.ok) {
        setHealthConnected(true)
        const data = await syncFromHealth()
        // 与自动同步共用 healthSyncView（单一真相源，两路不可能规则漂移）。
        // 🔴 读数一有结论就置 settled（含「今天 0 步」/「超时降级」），
        //    否则「正在读取今天的步数」会永驻 —— 用户看到的就是「连上了但没反应」。
        setHealthSyncSettled(true)
        const v = healthSyncView(data, healthVendor.label, isHealthConnectVendor)
        if (v.writeValues) {
          setHealthSteps(v.steps)
          setHealthActiveKcal(v.activeKcal)
        }
        setHealthSyncHint(v.hint)
      }
    } finally {
      setHealthConnecting(false)
    }
  }

  /**
   * 🔴 手动「重新读取」：读数超时 / 出错 / 今天为空时给用户的主动出口。
   *
   * 为什么必须有：自动轮询 60s 一次，但用户盯着「今天还没有系统健康数据」时
   * 不会想到要等一分钟；而超时降级后更需要一个立刻重试的按钮，否则用户只能
   * 杀进程重开（体感＝功能坏了）。与自动轮询同一套 healthSyncView，规则不漂移。
   */
  const [healthRefreshing, setHealthRefreshing] = useState(false)
  async function handleRefreshHealth() {
    if (healthRefreshing || !healthConnectable) return
    setHealthRefreshing(true)
    // 重新读取时先收回「已有结论」，让 UI 回到「正在读取」态（诚实反映真实进行中）
    setHealthSyncSettled(false)
    try {
      const data = await syncFromHealth()
      setHealthSyncSettled(true)
      const v = healthSyncView(data, healthVendor.label, isHealthConnectVendor)
      if (v.writeValues) {
        setHealthSteps(v.steps)
        setHealthActiveKcal(v.activeKcal)
      }
      setHealthSyncHint(v.hint)
    } finally {
      setHealthRefreshing(false)
    }
  }

  const waterPct = Math.min(100, Math.round((waterMl / waterTarget) * 100))

  // 分享打卡卡：完成今日打卡后出现的「分享我的自律」按钮
  const [sharingCard, setSharingCard] = useState(false)
  const [shareCardMsg, setShareCardMsg] = useState('')

  async function handleShareCheckin() {
    setSharingCard(true)
    setShareCardMsg('')
    try {
      const canvas = createShareCanvas()
      drawCheckinCard(canvas, {
        streak: streak.current,
        longest: streak.longest,
        total: streak.total,
        nextMilestone: streak.nextMilestone,
        checkin: {
          meal: entries.length > 0,
          water: waterMl >= waterTarget,
          exercise: exercise.length > 0,
        },
        kcal: Math.round(totals.kcal),
        kcalTarget: target.calories,
      })
      const blob = await canvasToBlob(canvas)
      const res = await shareImage(blob, {
        filename: `d-bee-checkin-${today}.png`,
        title: '自律蜜蜂 · 今日打卡',
        text: '我在「自律蜜蜂」坚持记录饮食，一起变自律吧！',
      })
      setShareCardMsg(res.message)
    } catch (e) {
      setShareCardMsg(errText(e, '生成分享卡失败'))
    } finally {
      setSharingCard(false)
    }
  }

  const checkinDone = entries.length > 0

  return (
    <div className="page page-with-fab">
      <div className="page-top" />

      {/* 顶部：应用名 + 日期导航（点日期打开日历选任意一天） */}
      <div className="dash-head">
        <h1>自律蜜蜂</h1>
        <div className="date-nav">
          <button className="date-arrow" onClick={() => setLogDate((d) => shiftDate(d, -1))} aria-label="前一天">
            ‹
          </button>
          <button className="date-label" onClick={() => setPickerOpen(true)} aria-label="打开日历选择日期">
            {isToday ? '今天' : formatDateShort(logDate)}
            <span className="dl-caret">▾</span>
          </button>
          <button
            className="date-arrow"
            onClick={() => setLogDate((d) => shiftDate(d, 1))}
            aria-label="后一天"
          >
            ›
          </button>
        </div>
      </div>

      {/* 周历：左右滑动翻周，点选任意一天；有记录的日子带小圆点 */}
      <WeekStrip
        date={logDate}
        today={today}
        loggedDates={loggedDates}
        onPick={setLogDate}
        onShiftDays={(days) => setLogDate((d) => shiftDate(d, days))}
      />

      {error && <div className="notice err">{error}</div>}

      {/* 热量卡：已摄入 / 环形剩余 / 已消耗 + 三大营养素（参考自律茄子） */}
      <div className="ring-card">
        <div className="ring-row">
          <div className="side-stat">
            <div className="side-label">
              <IconFork color="var(--honey-dark)" size={15} />
              已摄入
            </div>
            <div className="side-num">{Math.round(totals.kcal)}</div>
          </div>

          <Ring value={Math.min(Math.max(netKcal, 0), target.calories)} max={target.calories} size={148} stroke={13}>
            <div className="ring-center">
              <div className={`ring-remain ${over ? 'over' : ''}`}>{Math.abs(remain)}</div>
              <div className="ring-sub">{over ? '超出预算' : '剩余'}</div>
            </div>
          </Ring>

          <div className="side-stat">
            <div className="side-label">
              已消耗
              <IconFire color="var(--red)" size={15} />
            </div>
            <div className="side-num">{Math.round(effectiveBurnKcal)}</div>
            {activityKcal > burnKcal && (
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                含活动 {Math.round(activityKcal)}
              </div>
            )}
          </div>
        </div>

        <div className="ring-macros">
          {MACRO_META.map((m) => {
            const goal = target[m.key]
            const got = m.key === 'protein_g' ? totals.p : m.key === 'carb_g' ? totals.c : totals.f
            const ratio = goal > 0 ? Math.min(got / goal, 1) : 0
            const Icon = m.icon
            return (
              <div className="rm-col" key={m.key}>
                <div className="rm-head">
                  <Icon color={m.color} size={13} />
                  <span>{m.label}</span>
                </div>
                <div className="rm-track">
                  <div className="rm-fill" style={{ width: `${ratio * 100}%`, background: m.color }} />
                </div>
                <div className="rm-val">
                  {fmtNum(got, 2)} / {goal}克
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 饮食体检：招牌功能上移到这里，一记完餐立刻可见（规则引擎本地算，不消耗 AI 额度） */}
      {dayInsight.scanned > 0 && dayInsight.avgScore !== null && checkupLevel && (
        <>
          <div className="section-title">
            饮食体检
            <span className="hint">共 {dayInsight.scanned} 项 · 友好度 {dayInsight.avgScore}</span>
          </div>
          <div className="card checkup">
            <div className="checkup-verdict">
              <span className={`cu-score ${checkupTone}`}>{dayInsight.avgScore}</span>
              <span className="cu-main">
                <span className={`cu-level ${checkupTone}`}>{LEVEL_LABELS[checkupLevel]}</span>
                <span className="cu-text">{dayInsight.verdict}</span>
              </span>
              <button
                className="checkup-toggle"
                onClick={toggleCheckup}
                aria-expanded={!checkupCollapsed}
                aria-label={checkupCollapsed ? '展开体检详情' : '收起体检详情'}
              >
                <span className={`toggle-chevron ${checkupCollapsed ? 'is-folded' : ''}`}>▾</span>
                <span className="toggle-label">{checkupCollapsed ? '展开' : '收起'}</span>
              </button>
            </div>

            <div className={`checkup-detail ${checkupCollapsed ? 'is-folded' : ''}`}>
              {dayInsight.risks.length > 0 && (
                <div className="checkup-group">
                  <div className="cg-title risk">建议留意</div>
                  {dayInsight.risks.map((t) => (
                    <div className="cg-row" key={t.key}>
                      <span className="cg-label">{t.label}</span>
                      <span className="cg-badge">{t.count} 项</span>
                      <span className="cg-reason">{t.reason}</span>
                      <span className="cg-items">
                        {t.items.join('、')}
                        {t.count > t.items.length ? ` 等 ${t.count} 项` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {dayInsight.benefits.length > 0 && (
                <div className="checkup-group">
                  <div className="cg-title good">值得肯定</div>
                  {dayInsight.benefits.map((t) => (
                    <div className="cg-row" key={t.key}>
                      <span className="cg-label">{t.label}</span>
                      <span className="cg-badge good">{t.count} 项</span>
                      <span className="cg-reason">{t.reason}</span>
                      <span className="cg-items">
                        {t.items.join('、')}
                        {t.count > t.items.length ? ` 等 ${t.count} 项` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {(totals.na > 0 || totals.fb > 0) && (
                <div className="microline" style={{ marginTop: 10 }}>
                  {/* 钠以 mg 计、量级较大，按惯例取整；纤维与添加糖按 g 计，统一保留 2 位小数。
                      旧写法 Math.round(x * 10) / 10 既是 1 位小数，也有乘法舍入缺陷（见 numfmt.ts）。 */}
                  {totals.na > 0 && (
                    <span className="micro-pill">今日钠 {fmtNum(totals.na, 0)} mg</span>
                  )}
                  {totals.fb > 0 && (
                    <span className="micro-pill">膳食纤维 {fmtNum(totals.fb, 2)} g</span>
                  )}
                  {totals.as > 0 && (
                    <span className="micro-pill">添加糖 {fmtNum(totals.as, 2)} g</span>
                  )}
                </div>
              )}

              <div className="helper" style={{ marginTop: 4, lineHeight: 1.7 }}>
                按营养成分与烹调方式本地推算
                {dayInsight.aiAssisted > 0 ? `，其中 ${dayInsight.aiAssisted} 项参考了 AI 评分` : ''}，
                不消耗 AI 次数。仅供参考，不构成医疗建议。
              </div>
              <button className="btn-text" style={{ marginTop: 8 }} disabled={mealBusy} onClick={() => void explainThisMeal()}>
                {mealBusy ? '正在解读…' : '解读这一餐'}
              </button>
              {mealNote && <div className="helper" style={{ marginTop: 8, lineHeight: 1.7 }}>模型建议：{mealNote}</div>}
              {mealErr && <div className="notice err" style={{ marginTop: 8 }}>{mealErr}</div>}
            </div>
          </div>
        </>
      )}

      {/* 卡路里追踪：下一餐的参考额度 */}
      <div className={`advice-strip ${advice.over ? 'is-over' : ''}`}>
        <span className="as-tag">卡路里追踪</span>
        <span className="as-text">{advice.text}</span>
      </div>

      {/* 卡路里追踪：近 7 天热量迷你趋势 */}
      <div className="card card-tight mini-trend">
        <div className="mt-head">
          <span className="mt-title">近 7 天热量</span>
          <span className="mt-sub">虚线为预算 {target.calories} kcal</span>
        </div>
        <div className="mt-bars">
          {weekBars.map((b) => {
            const h = Math.max(b.kcal > 0 ? 6 : 0, Math.round((b.kcal / weekPeak) * 100))
            const overDay = b.logged && b.kcal > target.calories * 1.1
            return (
              <button
                key={b.date}
                className={`mt-col ${b.isToday ? 'is-today' : ''}`}
                onClick={() => setLogDate(b.date)}
                title={b.logged ? `${b.date} · ${b.kcal} kcal` : `${b.date} · 未记录`}
              >
                <span className="mt-val">{b.logged ? b.kcal : ''}</span>
                <span className="mt-track">
                  <span
                    className={`mt-fill ${overDay ? 'is-over' : ''}`}
                    style={{ height: `${h}%` }}
                  />
                </span>
                <span className="mt-day">{Number(b.date.slice(-2))}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 打卡卡片 */}
      <div className="streak-card">
        <div className="streak-flame">
          <IconFire color={streak.current > 0 ? 'var(--honey-dark)' : 'var(--ink-3)'} size={22} />
        </div>
        <div className="streak-main">
          <div className="streak-num">
            {streak.current > 0 ? <>连续打卡 <b>{streak.current}</b> 天</> : isToday ? '今天还没记录，记一餐就开始' : '这天没有记录'}
          </div>
          <div className="streak-sub">
            最长 {streak.longest} 天 · 累计 {streak.total} 天
            {streak.nextMilestone && <> · 再坚持 {streak.nextMilestone - streak.current} 天到 {streak.nextMilestone} 天里程碑</>}
          </div>
          {streak.current > 0 && MILESTONES.includes(streak.current) && (
            <div className="streak-hit">🎉 达成 {streak.current} 天里程碑！</div>
          )}
        </div>
        {checkinDone && (
          <button className="btn-text" style={{ alignSelf: 'flex-start', color: 'var(--honey-dark)', fontSize: 13 }} disabled={sharingCard} onClick={() => void handleShareCheckin()}>
            {sharingCard ? '生成中…' : '分享我的自律'}
          </button>
        )}
      </div>
      {shareCardMsg && (
        <div className="notice" style={{ marginBottom: 12, fontSize: 13 }}>{shareCardMsg}</div>
      )}

      {/* 饮水 */}
      <div className="card">
        <div className="water-head">
          <div className="water-title">
            <IconWater color="var(--blue)" size={18} />
            <span>饮水</span>
          </div>
          <span className="water-val">
            <b>{(waterMl / 1000).toFixed(2)}</b> / {(waterTarget / 1000).toFixed(1)} L
          </span>
        </div>
        <div className="macro-track" style={{ margin: '10px 0 12px' }}>
          <div className="macro-fill" style={{ width: `${waterPct}%`, background: 'var(--blue)' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="chip water-chip" onClick={() => void handleWater(250)}>+250 ml</button>
          <button className="chip water-chip" onClick={() => void handleWater(500)}>+500 ml</button>
          {water.length > 0 && (
            <button className="btn-text" style={{ marginLeft: 'auto', color: 'var(--ink-3)' }} onClick={handleWaterUndo}>
              撤销一杯
            </button>
          )}
        </div>
      </div>

      {/* 运动 */}
      <div className="card">
        <div className="water-head">
          <div className="water-title">
            <IconRun color="var(--green)" size={18} />
            <span>运动</span>
          </div>
          <span className="water-val">
            {exercise.length > 0 ? (
              <>
                消耗 <b>{Math.round(burnKcal)}</b> kcal
              </>
            ) : healthConnectable && hasHealthData ? (
              <span style={{ fontSize: 13 }}>今日 <b>{healthSteps.toLocaleString()}</b> 步</span>
            ) : healthConnectable && healthConnected ? (
              // 🔴 读数已有结论（含「今天确实 0 步」/「超时降级」）就不能再声称「正在同步」，
              //    否则这句与卡片里的「正在读取」一起永驻 = 用户看到的「一直没有反应」。
              healthSyncSettled ? (
                <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>今日 <b>0</b> 步</span>
              ) : (
                <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>正在同步步数…</span>
              )
            ) : healthConnectable ? (
              <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>连接运动健康，自动同步步数</span>
            ) : null}
          </span>
        </div>

        {healthConnectable && !healthConnected && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 10px' }}>
              {/* 🔴 按钮文案必须受 canSync 约束（2026-11-18 华为 P40）：
                  原先恒显示「连接{label}」，不看 canSync —— 而华为/无 HC 的小米机型
                  厂商通道恒返回 not_ready，永远连不上，等于给一个点了必然失败的按钮
                  （违反铁律 #13 零假功能）。canSync=false 时如实降级为「查看说明」。
                  ProfileScreen 的同名按钮早已按 canSync 分叉，这里此前漏了 → 两处口径不一致。 */}
              <button
                className="chip chip-connect"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                disabled={healthConnecting}
                onClick={handleConnectHealth}
              >
                <IconRun color="var(--green)" size={13} />
                {healthConnecting
                  ? '处理中…'
                  : healthConnectInstallOffered()
                    ? '安装健康连接'
                    : healthVendor.canSync
                      ? `连接${healthVendor.label}`
                      : `查看${healthVendor.label}说明`}
              </button>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                {healthConnectInstallOffered()
                  ? '安装后，手表和手环的步数才能从系统健康读进来'
                  : healthVendor.canSync
                    ? '同步步数与活动能量，自动计入活动消耗'
                    : '本机型暂不支持自动同步，可手动记录运动'}
              </span>
            </div>
            {/* 🔴 必须带修饰类（notice warn）：`.notice` 基类只有圆角/内边距/字号，
                **没有 background 与 color** → 裸 className="notice" 渲染出的是一段
                与卡片同底色的普通小字，插在一条语义雷同的常驻说明上方，用户完全看不出
                变化，观感就是「点了没反应」（2026-11-18 华为 P40 实测根因之一）。 */}
            {healthTip && (
              <div className="notice warn" style={{ margin: '0 0 10px', fontSize: 13 }}>{healthTip}</div>
            )}
          </>
        )}

        {/* 同步异常引导：授权被拒 / 读取出错 / 厂商资质未就绪。
            与「连接结果提示（healthTip）」独立展示——自动轮询发现的问题不该静默吞掉，
            否则用户只看到步数不动，误以为「同步功能坏了」。
            🔴 同样补 warn 修饰类，理由见上。 */}
        {healthConnectable && healthSyncHint && (
          <div className="notice warn" style={{ margin: '0 0 10px', fontSize: 13 }}>
            {healthSyncHint}
            {isHealthConnectVendor && isHealthConnectAvailable() && (
              <button type="button" className="btn-text" style={{ marginLeft: 8 }} onClick={() => void openHealthConnect('settings')}>
                打开健康连接
              </button>
            )}
          </div>
        )}

        {healthConnectable && healthConnected && hasHealthData && (
          <div style={{ margin: '8px 0 12px' }}>
            {/* 步数行：图标 + 标题 + 「今日步数 / 目标」 + 进度条 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: 'var(--green-50, #EAF3DE)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <IconRun color="var(--green)" size={16} />
              </span>
              <span style={{ fontSize: 14, fontWeight: 500 }}>步数</span>
              <span style={{ marginLeft: 'auto', fontSize: 14 }}>
                <b>{healthSteps.toLocaleString()}</b>
                <span style={{ color: 'var(--ink-3)' }}> / {stepGoal.toLocaleString()}</span>
              </span>
            </div>
            <div className="macro-track" style={{ margin: '8px 0 12px' }}>
              <div className="macro-fill" style={{
                width: `${Math.min(100, Math.round((healthSteps / stepGoal) * 100))}%`,
                background: 'var(--green)',
              }} />
            </div>
            {/* 活动能量行：火焰图标 + 「其他 · 健康」 + 大卡 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: 'var(--honey-50, #FAEEDA)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <IconFire color="var(--honey-dark)" size={16} />
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  其他
                  <span style={{
                    fontSize: 11, color: 'var(--red)', background: 'var(--red-50, #FCEBEB)',
                    borderRadius: 6, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 3,
                  }}>❤ 健康</span>
                </span>
                <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{healthActiveKcal} 大卡</span>
              </div>
            </div>
          </div>
        )}

        {healthConnectable && healthConnected && !hasHealthData && (
          <div style={{ margin: '8px 0 12px', fontSize: 13, color: 'var(--ink-3)' }}>
            {healthSyncSettled ? (
              <>
                {/* 读数已有结论但无数值（empty / error / denied / unavailable）：
                    如实说明 + 给「重新读取」出口，绝不再声称「正在读取」。 */}
                已连接 {healthVendor.label}，但今天还没读到步数数据。
                <button
                  className="btn-text"
                  style={{ marginLeft: 6 }}
                  disabled={healthRefreshing}
                  onClick={() => void handleRefreshHealth()}
                >
                  {healthRefreshing ? '读取中…' : '重新读取'}
                </button>
              </>
            ) : (
              <>已连接 {healthVendor.label}，正在读取今天的步数，稍候自动展示。</>
            )}
          </div>
        )}

        {exercise.length > 0 && (
          <div style={{ margin: '4px 0 10px' }}>
            {exercise.map((x) => (
              <div key={x.id} className="ex-row">
                <span className="ex-name">{x.name} {x.minutes} 分钟</span>
                <span className="ex-kcal">{Math.round(Number(x.calories))} kcal</span>
                <button className="entry-del" onClick={() => void handleDelExercise(x.id)} aria-label="删除">×</button>
              </div>
            ))}
          </div>
        )}

        <div className="chips chips-scroll" style={{ marginBottom: 10 }}>
          {EXERCISES.map((e) => (
            <button key={e.name} className={`chip ${exName === e.name ? 'active' : ''}`} onClick={() => setExName(e.name)}>
              {e.name}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="stepper" style={{ flex: 1 }}>
            <input
              type="number"
              inputMode="numeric"
              min={MINUTES_LIMIT.min}
              max={MINUTES_LIMIT.max}
              value={exMinutes}
              onChange={(e) => setExMinutes(sanitizeNumeric(e.target.value, { int: true }))}
              onBlur={(e) => setExMinutes(clampNumeric(e.target.value, MINUTES_LIMIT))}
            />
            <span className="unit">分钟</span>
            <span className="ex-est">≈ {exPreview} kcal</span>
          </div>
          <button className="btn btn-ghost" style={{ width: 96, flexShrink: 0 }} onClick={handleAddExercise}>
            <IconPlus color="var(--ink)" />
            记录
          </button>
        </div>
      </div>

      <div className="section-title">
        {isToday ? '今日餐次' : '这一天'}
        <span className="hint">{entries.length} 条记录</span>
      </div>

      {loading ? (
        <>
          <div className="skeleton" style={{ height: 68, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 68, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 68 }} />
        </>
      ) : (
        MEAL_ORDER.map((m) => {
          const list = byMeal[m]
          const kcal = Math.round(list.reduce((s, e) => s + (Number(e.calories) || 0), 0))
          return (
            <div className="meal-block" key={m}>
              <div className={`meal-head ${list.length ? 'has-items' : ''}`}>
                <div className="left">
                  <span className="meal-dot" />
                  <span className="meal-name">{MEAL_LABELS[m]}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span className="meal-kcal">{list.length ? `${kcal} kcal` : ''}</span>
                  <button className="meal-add" onClick={() => setSheetMeal(m)} aria-label={`添加${MEAL_LABELS[m]}`}>
                    <IconPlus />
                  </button>
                </div>
              </div>
              {list.length === 0 ? (
                <div className="meal-empty">还没有记录</div>
              ) : (
                list.map((e) => (
                  <div className="entry" key={e.id ?? `${e.food_name}-${e.created_at}`}>
                    <div className="entry-main">
                      <div className="entry-name">{e.food_name}</div>
                      <div className="entry-meta">
                        {e.quantity_text || ''}
                        {e.ai_note ? ` · ${e.ai_note}` : ''}
                      </div>
                      {editingId === e.id ? (
                        <div className="entry-edit" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={GRAMS_LIMIT.min}
                            max={GRAMS_LIMIT.max}
                            value={editGrams}
                            onChange={(ev) => setEditGrams(sanitizeNumeric(ev.target.value, { int: true }))}
                            onBlur={(ev) => setEditGrams(clampNumeric(ev.target.value, GRAMS_LIMIT))}
                            style={{ width: 76, height: 32, borderRadius: 10, border: '1px solid var(--line-2)', background: 'var(--surface)', padding: '0 8px', outline: 'none' }}
                            aria-label="份量克数"
                          />
                          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>g</span>
                          <button className="btn-text" style={{ color: 'var(--honey-dark)' }} disabled={savingEdit} onClick={() => void saveEdit()}>
                            {savingEdit ? '保存中…' : '保存'}
                          </button>
                          <button className="btn-text" style={{ color: 'var(--ink-3)' }} onClick={() => setEditingId(null)}>
                            取消
                          </button>
                        </div>
                      ) : (
                        <button className="btn-text" style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, padding: 0 }} onClick={() => startEdit(e)}>
                          编辑份量
                        </button>
                      )}
                    </div>
                    <span className="entry-kcal">{Math.round(Number(e.calories))}</span>
                    <button
                      className={`entry-del ${pendingDeleteId === e.id ? 'confirming' : ''}`}
                      onClick={() => void handleDelete(e.id)}
                      aria-label={pendingDeleteId === e.id ? '再次点击确认删除' : '删除'}
                      title={pendingDeleteId === e.id ? '再次点击确认删除' : '删除'}
                      style={pendingDeleteId === e.id ? { background: 'var(--red)', color: '#fff' } : undefined}
                    >
                      {pendingDeleteId === e.id ? '删除?' : '×'}
                    </button>
                  </div>
                ))
              )}
            </div>
          )
        })
      )}

      {/* 饮食体检：已上移到热量卡之后（见上方），这里不再重复 */}

      {planAdvice.length > 0 && (
        <>
          <div className="section-title">给你的建议</div>
          <div className="card">
            {planAdvice.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 9, fontSize: 13.5, color: 'var(--ink-2)', marginBottom: i === planAdvice.length - 1 ? 0 : 9 }}>
                <span style={{ color: 'var(--honey-dark)', fontWeight: 600 }}>{i + 1}</span>
                <span>{a}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <button className="btn btn-ghost coach-entry" onClick={() => setCoachOpen(true)}>
        饮食上有拿不准的？问问小蜜 →
      </button>

      {/* 站内轻榜单入口（P2-1）：自律榜 + 邀请榜，首页直达 */}
      <button className="invite-strip leaderboard-strip" onClick={() => setLeaderboardOpen(true)}>
        <span className="is-ico">🏆</span>
        <span className="is-text">
          自律榜单
          <small>看看大家坚持了多久，连续打卡满 3 天即可上榜</small>
        </span>
        <span className="arrow">›</span>
      </button>

      {!pro && (
        <>
          <div className="helper" style={{ textAlign: 'center', marginTop: 6 }}>
            免费版每日 {FREE_DAILY_AI} 次拍照识别，今日还剩 {aiRemaining ?? 0} 次，可用积分再兑 {AI_REDEEM_DAILY_LIMIT} 次
          </div>
          {/* 转化触点①：额度耗尽时埋「升级会员」入口 —— 功能被卡住的瞬间付费意愿最强，
              点开付费墙。引导开关（xpay/apppay）关闭时付费墙只展示价格与兑换码，零引导字眼，
              不触碰「零引导」合规红线。 */}
          <button className="invite-strip upgrade-strip" onClick={() => openPaywall('quota')}>
            <span className="is-ico">⚡</span>
            <span className="is-text">
              升级会员，无限次拍照识别
              <small>解锁不限次 AI 识别 + 完整报告</small>
            </span>
            <span className="arrow">›</span>
          </button>
          {/* 拉新入口：首页直达，不再只藏在「我的」二级页 */}
          <button className="invite-strip" onClick={() => setInviteOpen(true)}>
            <span className="is-ico">🍯</span>
            <span className="is-text">
              邀请好友一起自律
              <small>你得蜜糖，好友得 7 天 Pro</small>
            </span>
            <span className="arrow">›</span>
          </button>
        </>
      )}

      {/* 转化触点②：Pro 临到期续费提醒（一次性卖 → 持续收）。仅 pro 且非 lifetime、
          且距到期 ≤7 天时展示；点开付费墙引导续费。 */}
      {pro && !lifetime && (() => {
        const daysLeft = proDaysLeft(entitlement?.pro_until)
        if (daysLeft == null || daysLeft > 7) return null
        return (
          <button className="invite-strip upgrade-strip" onClick={() => openPaywall('renew')}>
            <span className="is-ico">⏳</span>
            <span className="is-text">
              {`会员还剩 ${daysLeft} 天到期`}
              <small>续费继续享无限次识别，别让进度中断</small>
            </span>
            <span className="arrow">›</span>
          </button>
        )
      })()}

      {pickerOpen && (
        <MonthPicker
          value={logDate}
          today={today}
          loggedDates={loggedDates}
          onSelect={(d) => {
            setLogDate(d)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {sheetMeal && (
        <LogSheet
          logDate={logDate}
          initialMeal={sheetMeal}
          budget={advice.budget}
          budgetText={advice.text}
          onClose={() => setSheetMeal(null)}
          onSaved={() => {
            setSheetMeal(null)
            void load()
          }}
          onOpenInviteCenter={() => {
            setSheetMeal(null)
            setInviteOpen(true)
          }}
        />
      )}

      {coachOpen && <CoachSheet ctx={coachCtx} onClose={() => setCoachOpen(false)} />}
      {mealConsentOpen && (
        <AiConsent
          kind="advice"
          onAgree={async () => {
            await grantAiConsent(profile)
            setMealConsentOpen(false)
            void explainThisMeal()
          }}
          onDecline={() => setMealConsentOpen(false)}
        />
      )}

      {/* 首页也放页脚：备案号与法律文档入口必须在首页可达 */}
      <SiteFooter onOpen={onOpenLegal} />

      {/*
        主操作「记一餐」改为吸底悬浮：原先压在页面最底部，要滚过 10+ 张卡片才够得到。
        悬浮后任意滚动位置一键记录；各餐次行的「+」仍保留作为就地补录入口。
        z-index 25 —— 高于内容、低于 tabbar(30) 与各类弹层(60/70)，弹层打开时自动被盖住。
      */}
      <button
        className="btn fab-meal"
        onClick={() => setSheetMeal(guessMealType())}
        aria-label="记一餐"
      >
        <IconPlus color="#4a3208" />
        记一餐
      </button>

      {inviteOpen && <InviteCenter onClose={() => setInviteOpen(false)} />}

      {leaderboardOpen && <LeaderboardSheet onClose={() => setLeaderboardOpen(false)} />}
    </div>
  )
}
