/**
 * 我的页（对齐主工程 src/pages/ProfileScreen.tsx）。
 *
 * 差异点（小程序端能力诚实降级）：
 *  - 健康数据源：微信运动门面与主端同形状，真同步待类目资质（诚实降级）
 *  - 体重趋势图：主工程用 SVG LineChart，小程序端以列表形式展示（图表统一在报告页处理）
 *  - 数据导出：走 share.ts 占位（返回「正在接入」提示）
 *  - 会员升级：点「升级」跳 pages/paywall（兑换码解锁；小程序端无内购/微信外支付）
 *
 * 🔴 会员状态副标题**不是**本页自己拼的，而是调 @dbee/shared 的 `memberSubText`，
 *    与主端 ProfileScreen 共用同一个函数（2026-11-03 四端一致性修复，此前本页是一份
 *    残缺副本：缺 lifetime/pro 两个分支、免费档把剩余次数硬编码成 3）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Button, Input, Switch } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { IconCrown, IconDownload, IconTrash } from '../../components/Icons'
import {
  listWeightLogs, saveProfile, saveWeight, clearAllRecords, deleteAccount,
  exportAllData, buildMealsCsv,
  getProfile, getEntitlement, getPhotoQuota,
  type Entitlement, type Profile, type WeightLog,
} from '../../lib/api'
import { ACTIVITY_LABELS, GOAL_LABELS, calcTarget, todayKey } from '../../lib/nutrition'
import {
  AGE_LIMIT, HEIGHT_LIMIT, WEIGHT_LIMIT, STEP_GOAL_LIMIT, NICKNAME_RULE,
  type NumLimit, checkNumber, checkTargetWeightDiff, checkText,
  clampNumeric, firstError, rangeText, sanitizeNumeric,
} from '../../lib/validate'
import { exportJSON, exportText, isExportAvailable, EXPORT_UNAVAILABLE_MESSAGE } from '../../lib/share'
import { isHealthConnectable, getHealthVendor, connectHealth, disconnectHealth } from '../../lib/health'
import { openPaywall } from '../../lib/upsell'
import { openManageSubscriptions } from '../../lib/manageSubscription'
import { HONEY_PRICE } from '../../lib/invite'
import {
  CAPABILITY_NOTES,
  DATA_RIGHTS_NOTES,
  MINI_RECORDING_CAPS,
  isPro,
  isLifetime,
  memberSubText,
  DEFAULT_STEP_GOAL,
  quotaNotes,
} from '@dbee/shared'
import { TransparencyNotes } from '../../components/TransparencyNotes'
import { signOut } from '../../lib/auth'
import { SITE } from '../../content/legal'
import { copyText } from '../../lib/clipboard'
import { getNotifyPrefs, setNotifyPrefs, enableCheckinNotify, disableCheckinNotify, enableWaterNotify, disableWaterNotify } from '../../lib/notifications'
import './profile.scss'

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  // 会员状态（2026-11-03 修）：此前注释写「小程序端暂无 entitlements 拉取，先按免费版展示」，
  // pro/lifetime 声明后**从未被赋值** → 付费用户在「我的」页永远看到「免费版」+「升级」按钮，
  // 且剩余拍照次数被硬编码成 3（真实额度可能是 0 或已用完）。四端一致性要求下这是明确 bug。
  // 现照 mini/src/pages/paywall/paywall.tsx 的既有模式拉取权益（coach/report/scan/paywall
  // 四页早就这么做了，只有本页漏掉）。
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const pro = useMemo(() => isPro(entitlement), [entitlement])
  const lifetime = useMemo(() => isLifetime(entitlement), [entitlement])
  /**
   * 今日剩余拍照次数。null = 未加载完成、读不到（降级）或 Pro（不限次，无需展示数字）。
   * 🔴 传给 shared `memberSubText` 的降级语义刻意**比主端保守**，且这是对的：
   *      · 主端 getPhotoQuota 在 row 为 null 时返回满额 FREE_DAILY_AI（展示乐观值）
   *      · mini getPhotoQuota 失败时返回 { totalRemaining: 0, degraded: true }（fail-closed）
   *    mini 是 P0-B 之后才补的 fail-closed 实现（见 lib/api.ts:618 注释），比主端更严格。
   *    故 degraded 时传 null，让 memberSubText 输出「暂时读不到」而非编一个数字 ——
   *    宁可少显示，不可显示与真实额度不符的次数（用户可能据此以为还能拍照，实际会被拒）。
   */
  const [aiRemaining, setAiRemaining] = useState<number | null>(null)
  const [quotaDegraded, setQuotaDegraded] = useState(false)

  /** useDidShow 首次触发跳过标记（见下方 useDidShow 注释） */
  const shownOnce = useRef(false)

  // 身体数据编辑
  const [editing, setEditing] = useState(false)
  const [barriers] = useState<string[]>([])

  // 数据与隐私
  const [exporting, setExporting] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [dataMsg, setDataMsg] = useState('')
  const [dataErr, setDataErr] = useState('')

  // 注销账号（两步确认）
  const [confirmDeleteAcct, setConfirmDeleteAcct] = useState(false)
  const [deletingAcct, setDeletingAcct] = useState(false)
  // 退出登录（两步确认）
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  // 体重打卡
  const [weights, setWeights] = useState<WeightLog[]>([])
  const [weightInput, setWeightInput] = useState('')
  const [weightMsg, setWeightMsg] = useState('')

  // 通知提醒偏好（本地 kv）；P0.7 首帧默认关，随后由 useEffect 读 kv 覆盖（老用户已存 '1' 仍显示为开）
  const [notifCheckin, setNotifCheckin] = useState(false)
  const [notifWater, setNotifWater] = useState(false)
  useEffect(() => {
    void getNotifyPrefs().then((p) => {
      setNotifCheckin(p.checkin)
      setNotifWater(p.water)
    })
  }, [])

  async function toggleNotif(kind: 'checkin' | 'water', enabled: boolean) {
    if (kind === 'checkin') {
      setNotifCheckin(enabled)
      if (enabled) await enableCheckinNotify()
      else await disableCheckinNotify()
    } else {
      setNotifWater(enabled)
      if (enabled) await enableWaterNotify()
      else await disableWaterNotify()
    }
  }
  const [weightErr, setWeightErr] = useState('')
  const [savingWeight, setSavingWeight] = useState(false)

  // 编辑表单
  const [nickname, setNickname] = useState('')
  const [gender, setGender] = useState<'male' | 'female'>('female')
  const [age, setAge] = useState('28')
  const [height, setHeight] = useState('165')
  const [weight, setWeight] = useState('62')
  const [targetWeight, setTargetWeight] = useState('55')
  const [stepGoal, setStepGoal] = useState(String(DEFAULT_STEP_GOAL))
  const [healthMsg, setHealthMsg] = useState('')
  const [healthBusy, setHealthBusy] = useState(false)

  // 健康数据源状态机（严格对齐主端 ProfileScreen:76-137 / 578-604）
  const healthVendor = useMemo(() => getHealthVendor(), [])
  const healthConnected = profile?.health_connected === true

  async function handleConnectHealth() {
    if (healthBusy) return
    setHealthBusy(true)
    try {
      const r = await connectHealth()
      setHealthMsg(r.message)
      if (r.ok) setProfile((p) => (p ? { ...p, health_connected: true } : p))
    } catch {
      setHealthMsg('连接失败，请稍后重试。')
    } finally {
      setHealthBusy(false)
    }
  }

  async function handleDisconnectHealth() {
    if (healthBusy) return
    setHealthBusy(true)
    try {
      await disconnectHealth()
      setProfile((p) => (p ? { ...p, health_connected: false } : p))
      setHealthMsg('已解除连接，步数不再自动同步。')
    } catch {
      setHealthMsg('解除连接失败，请稍后重试。')
    } finally {
      setHealthBusy(false)
    }
  }
  const [activity, setActivity] = useState<keyof typeof ACTIVITY_LABELS>('light')
  const [goal, setGoal] = useState<'lose' | 'keep' | 'gain'>('lose')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})

  const target = useMemo(() => {
    const p = profile
    if (!p || !p.daily_calorie_target) return { calories: 1800, protein_g: 90, carb_g: 220, fat_g: 50 }
    return {
      calories: p.daily_calorie_target,
      protein_g: p.protein_target_g ?? 0,
      carb_g: p.carb_target_g ?? 0,
      fat_g: p.fat_target_g ?? 0,
    }
  }, [profile])

  const load = async () => {
    setLoading(true)
    try {
      const p = await getProfile()
      setProfile(p)
      if (p) {
        setNickname(p.nickname ?? '')
        setGender(p.gender ?? 'female')
        setAge(String(p.age ?? 28))
        setHeight(String(p.height_cm ?? 165))
        setWeight(String(p.current_weight_kg ?? 62))
        setTargetWeight(String(p.target_weight_kg ?? 55))
        setStepGoal(String(p.step_goal ?? DEFAULT_STEP_GOAL))
        setActivity((p.activity_level as keyof typeof ACTIVITY_LABELS) ?? 'light')
        setGoal(p.goal ?? 'lose')
        setWeightInput(String(p.current_weight_kg ?? ''))
      }
      setWeights(await listWeightLogs(30))
    } catch {
      /* 静默 */
    } finally {
      setLoading(false)
    }
    // 权益与额度**刻意放在 try/catch 之外**：它们各自有独立的失败降级
    // （权益读不到按免费档、额度读不到不谎报数字），不应因为读权益失败
    // 就让上面的体重记录也一起丢掉，反之亦然。
    await loadEntitlement()
  }

  /**
   * 拉取会员权益 + 今日剩余额度。
   *
   * 🔴 为什么单独抽出来：`useDidShow` 也要调它。profile 用 `navigateTo` 打开付费墙，
   *    兑换成功后 `navigateBack` 回来时本页**仍在页面栈里**，`useEffect` 不会重跑 ——
   *    不加 useDidShow 的话，用户兑换成功了却还看到「免费版 + 升级按钮」。
   *    这与 index.tsx:200 的 useDidShow 刷新登录态是同一类小程序生命周期坑。
   */
  async function loadEntitlement() {
    try {
      const ent = await getEntitlement()
      setEntitlement(ent)
      // Pro/终身不限拍照次数，不必再查额度（与主端 plan.tsx:80-85 同一处置）
      if (isPro(ent)) {
        setAiRemaining(null)
        setQuotaDegraded(false)
        return
      }
    } catch {
      // 读不到权益不阻塞使用，按免费档展示（对齐主端 plan.tsx:86-89）
      setEntitlement(null)
    }
    try {
      const q = await getPhotoQuota()
      setQuotaDegraded(q.degraded === true)
      setAiRemaining(q.degraded ? null : Math.max(0, q.totalRemaining))
    } catch {
      setQuotaDegraded(true)
      setAiRemaining(null)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /**
   * 回到本页时刷新会员状态与额度。
   *
   * 场景：本页「升级」按钮用 navigateTo 打开付费墙，用户兑换成功后 navigateBack 回来，
   * 本页仍在栈中、useEffect 不重跑 —— 不刷新的话会一直显示「免费版 + 升级」。
   *
   * 🔴 Taro 的 useDidShow **首次进入也会触发**，会与上面的 useEffect 重复发请求，
   *    故用 ref 跳过第一次（只刷权益/额度，不重跑整个 load()：体重记录等不必重拉）。
   */
  useDidShow(() => {
    if (!shownOnce.current) {
      shownOnce.current = true
      return
    }
    void loadEntitlement()
  })

  const num = (v: string, fb: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fb
  }

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

  function validateBody(): string {
    const a = checkNumber(age, AGE_LIMIT)
    const h = checkNumber(height, HEIGHT_LIMIT)
    const w = checkNumber(weight, WEIGHT_LIMIT)
    const tw = goal === 'keep' ? { ok: true, value: w.value, error: '' } : checkNumber(targetWeight, WEIGHT_LIMIT)
    const sg = checkNumber(stepGoal, STEP_GOAL_LIMIT)
    const diff = goal === 'keep' ? { ok: true, error: '' } : checkTargetWeightDiff(tw.value, w.value)
    const nick = nickname.trim() === '' ? { ok: true, error: '' } : checkText(nickname, NICKNAME_RULE)
    setFieldErr({
      age: a.error, height: h.error, weight: w.error, tw: tw.error || diff.error, nick: nick.error, stepGoal: sg.error,
    })
    return firstError(a.error, h.error, w.error, tw.error, diff.error, nick.error, sg.error)
  }

  async function submitBody() {
    const vErr = validateBody()
    if (vErr) { setErr(vErr); return }
    setSaving(true)
    setErr('')
    try {
      const w = num(weight, 62)
      const tw = goal === 'keep' ? w : num(targetWeight, w)
      const weeklyRate = goal === 'keep' ? 0 : Math.min(0.75, Math.max(0.25, w * 0.0075))
      const t = calcTarget({ gender, age: num(age, 28), heightCm: num(height, 165), weightKg: w, activity, goal, weeklyRateKg: weeklyRate })
      const saved = await saveProfile({
        nickname: nickname.trim() || null, gender,
        age: num(age, 28), height_cm: num(height, 165),
        current_weight_kg: w, target_weight_kg: tw,
        activity_level: activity, goal, weekly_rate_kg: weeklyRate,
        daily_calorie_target: t.calories, protein_target_g: t.protein_g,
        carb_target_g: t.carb_g, fat_target_g: t.fat_g,
        step_goal: num(stepGoal, DEFAULT_STEP_GOAL),
      })
      setProfile(saved)
      setWeightInput(String(w))
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function submitWeight() {
    const chk = checkNumber(weightInput, WEIGHT_LIMIT)
    if (!chk.ok || chk.value == null) {
      setWeightErr(chk.error || `请输入 ${rangeText(WEIGHT_LIMIT)} 之间的体重`)
      return
    }
    const w = chk.value
    setWeightErr('')
    setWeightMsg('')
    setSavingWeight(true)
    try {
      const date = todayKey()
      await saveWeight(date, w)
      const saved = await saveProfile({ current_weight_kg: w })
      setProfile(saved)
      setWeights(await listWeightLogs(30))
      setWeightMsg('已记录今天的体重')
    } catch (e) {
      setWeightErr(e instanceof Error ? e.message : '记录失败')
    } finally {
      setSavingWeight(false)
    }
  }

  /**
   * 数据导出门控：对齐主端 ProfileScreen:646/664「非 Pro → 提示并拉付费墙」。
   * 🔴 本端导出尚未实装，故非 Pro 提示里**保留** PIPL 第 45 条邮箱兜底路径 ——
   *    不能因为补了 Pro 门控就把数据复制权入口藏掉；Pro 用户仍走 share.ts 诚实占位。
   */
  function guardExport(): boolean {
    if (!pro) {
      setDataMsg(`数据导出是 Pro 功能，升级后可随时打包带走全部记录。${EXPORT_UNAVAILABLE_MESSAGE}`)
      void openPaywall('数据导出是 Pro 功能，升级后可随时打包带走全部记录。')
      return false
    }
    if (!isExportAvailable) {
      setDataMsg(EXPORT_UNAVAILABLE_MESSAGE)
      return false
    }
    return true
  }

  async function doExport() {
    setDataErr('')
    setDataMsg('')
    // 🔴 导出未实装时**不发网络请求**：exportAllData() 会拉全量数据再被占位丢弃，
    //   白跑一次请求还显示「导出中…」转圈，属「可见但不可用」误导（P2-A）。
    if (!guardExport()) return
    setExporting(true)
    try {
      const bundle = await exportAllData()
      const res = await exportJSON(bundle, `d-bee-export-${todayKey()}.json`, { title: 'D-Bee 数据导出', text: '这是你在 D-Bee 里记录的全部数据。' })
      setDataMsg(res.message)
    } catch (e) {
      setDataErr(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  async function doExportCsv() {
    setDataErr('')
    setDataMsg('')
    if (!guardExport()) return
    setExporting(true)
    try {
      const meals = (await exportAllData()).meal_entries
      if (meals.length === 0) {
        setDataMsg('还没有任何饮食记录，先去记一餐吧。')
        return
      }
      const csv = buildMealsCsv(meals)
      const res = await exportText(csv, `d-bee-饮食记录-${todayKey()}.csv`, 'text/csv;charset=utf-8')
      setDataMsg(res.message)
    } catch (e) {
      setDataErr(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  async function doClear() {
    setClearing(true)
    setDataErr('')
    setDataMsg('')
    try {
      await clearAllRecords()
      setWeights(await listWeightLogs(30))
      setConfirmClear(false)
      setDataMsg('已清空全部饮食、体重、饮水与运动记录。账号与身体档案保留。')
    } catch (e) {
      setDataErr(e instanceof Error ? e.message : '清空失败')
    } finally {
      setClearing(false)
    }
  }

  /**
   * 永久注销账号（2026-11-08 对齐主工程 A-5 整改）。
   * 此前是降级实现：只清 4 张记录表 + 清空档案字段 + 登出，`app_users` 身份行仍在，
   * 用户重新登录即可复活账号。现改调 `deleteAccount()` → 0045 RPC，服务端事务内
   * 删净 17 张业务表 + 身份行。成功后🔴**只**清本地会话，绝不能再调
   * `clearAllRecords()` / `saveProfile()`（后者会重建 profiles = 账号复活）。
   * 失败时保持登录态如实报错，不假装已注销。
   */
  async function doDeleteAccount() {
    setDeletingAcct(true)
    setDataErr('')
    setDataMsg('')
    try {
      await deleteAccount()
      setConfirmDeleteAcct(false)
      await doSignOut()
    } catch (e) {
      setDataErr(e instanceof Error ? e.message : '注销失败，请重试')
    } finally {
      setDeletingAcct(false)
    }
  }

  async function doSignOut() {
    try {
      await signOut()
      Taro.reLaunch({ url: '/pages/index/index' })
    } catch {
      Taro.reLaunch({ url: '/pages/index/index' })
    }
  }

  /**
   * 复制公示邮箱（「联系我们」行）。小程序无 mailto，复制是唯一可行路径。
   * 反馈文案与 legal.ts「四、个人信息的查阅、复制…联系我们」条目的承诺口径一致：
   * 「我们将在 15 个工作日内答复」—— 两处若不一致就等于给用户两个不同的时限。
   */
  async function copyContactEmail() {
    const ok = await copyText(SITE.contactEmail)
    Taro.showToast({
      title: ok ? `邮箱已复制：${SITE.contactEmail}` : `复制失败，请手动记录：${SITE.contactEmail}`,
      icon: 'none',
      duration: ok ? 2500 : 4000,   // 失败时给足时间手抄
    })
  }

  function goInvite() {
    Taro.navigateTo({ url: '/pages/invite/invite' })
  }

  function goRecipes() {
    Taro.navigateTo({ url: '/pages/recipes/recipes' })
  }

  function goLeaderboard() {
    Taro.navigateTo({ url: '/pages/leaderboard/leaderboard' })
  }

  /**
   * 会员状态卡片的副标题。2026-11-03 修：此前 mini 本页只有三个分支且免费档把剩余
   * 拍照次数**硬编码成 3**，兑换码与有效期两条信息完全缺失；现已改为调 shared 的
   * `memberSubText`，与主端 src/pages/ProfileScreen.tsx **同一个函数**（不是两份对齐的副本）。
   *
   * 🔴 额度降级时传 null 让 shared 输出「暂时读不到」，刻意比主端更保守：
   *    mini 的 getPhotoQuota 失败时返回 degraded=true，此时显示任何数字都是谎报
   *    （用户会据此以为还能拍照，实际会在识别时被 fail-closed 拒绝）。
   *    主端该路径返回满额 FREE_DAILY_AI，是 P0-B 之前的旧语义。
   *    这个差异是有意保留的端能力差异，**不要「为了一致」改回满额**。
   */
  const memberSub = useMemo(
    () => memberSubText(entitlement, quotaDegraded ? null : aiRemaining),
    [entitlement, aiRemaining, quotaDegraded],
  )

  if (loading) {
    return <View className='page'><View className='skeleton' style={{ height: 200 }} /></View>
  }

  return (
    <View className='page profile'>
      <View className='hero'>
        <Text className='hero-title'>我的</Text>
      </View>

      {/* 会员状态 */}
      <View className={`member-card ${pro ? 'is-pro' : ''}`}>
        <View className='member-left'>
          <IconCrown color={pro ? '#6b4a08' : '#6b655c'} size={20} />
          <View className='member-text'>
            <Text className='member-title'>{lifetime ? 'D-Bee 终身会员' : pro ? 'D-Bee Pro' : '免费版'}</Text>
            <Text className='member-sub'>{memberSub}</Text>
          </View>
        </View>
        {!pro && (
          <Button className='member-btn' onClick={() => void openPaywall()}>
            升级
          </Button>
        )}
      </View>

      {/* 管理订阅：对齐主端 PaywallSheet 3.1.2「一律可见」纪律，免费 / Pro / 终身均可达 */}
      <View className='card' onClick={() => {
        void openManageSubscriptions().then((ok) => {
          if (!ok) Taro.showToast({ title: '暂时打不开会员与订阅，请稍后重试', icon: 'none' })
        })
      }}>
        <View className='list-line'>
          <Text className='line-label'>👑 会员与订阅</Text>
          <Text className='line-val'>
            管理权益 <Text className='arrow'>›</Text>
          </Text>
        </View>
      </View>

      {/* 蜜糖积分入口 */}
      <View className='card' onClick={goInvite}>
        <View className='list-line'>
          <Text className='line-label'>🍯 蜜糖积分 · 邀请好友</Text>
          <Text className='line-val'>
            查看积分与兑换 <Text className='arrow'>›</Text>
          </Text>
        </View>
      </View>

      {/* 我的食谱 + 榜单入口（P2） */}
      <View className='card'>
        <View className='list-line' onClick={goRecipes}>
          <Text className='line-label'>🍱 我的食谱</Text>
          <Text className='line-val'>
            一键复记常吃的一餐 <Text className='arrow'>›</Text>
          </Text>
        </View>
        <View className='list-line' onClick={goLeaderboard} style={{ borderTop: '1px solid rgba(42,39,35,0.09)', marginTop: 8, paddingTop: 16 }}>
          <Text className='line-label'>🏆 自律榜单</Text>
          <Text className='line-val'>
            看看大家坚持了多久 <Text className='arrow'>›</Text>
          </Text>
        </View>
      </View>

      {/* 统计卡 */}
      <View className='stat-grid'>
        <View className='stat'>
          <Text className='stat-l'>每日热量预算</Text>
          <Text className='stat-v'>{target.calories}<Text className='stat-unit'>kcal</Text></Text>
        </View>
        <View className='stat'>
          <Text className='stat-l'>当前体重</Text>
          <Text className='stat-v'>{profile?.current_weight_kg ?? '—'}<Text className='stat-unit'>kg</Text></Text>
        </View>
        <View className='stat'>
          <Text className='stat-l'>蛋白质目标</Text>
          <Text className='stat-v'>{target.protein_g}<Text className='stat-unit'>g</Text></Text>
        </View>
        <View className='stat'>
          <Text className='stat-l'>碳水 / 脂肪</Text>
          {/* 🔴 小程序 <text> 会把每个嵌套 Text / 裸空格当断行机会，iOS 上 254g / 56g 会折行。
              改成 View(flex nowrap) + 三个独立 token，分隔符间距交给 CSS margin。 */}
          <View className='stat-v stat-v--pair'>
            <Text className='stat-pair'>{target.carb_g}<Text className='stat-unit'>g</Text></Text>
            <Text className='stat-sep'>/</Text>
            <Text className='stat-pair'>{target.fat_g}<Text className='stat-unit'>g</Text></Text>
          </View>
        </View>
      </View>

      {/* 身体数据与目标 */}
      <View className='card'>
        <View className='list-line' onClick={() => setEditing(true)}>
          <Text className='line-label'>身体数据与目标</Text>
          <Text className='line-val'>{GOAL_LABELS[goal]}<Text className='arrow'>›</Text></Text>
        </View>
        <View className='list-line'>
          <Text className='line-label'>身高 / 年龄 / 性别</Text>
          <Text className='line-val'>{profile?.height_cm ?? '—'}cm · {profile?.age ?? '—'}岁 · {gender === 'male' ? '男' : '女'}</Text>
        </View>
        <View className='list-line'>
          <Text className='line-label'>活动水平</Text>
          <Text className='line-val'>{ACTIVITY_LABELS[activity]}</Text>
        </View>
        <View className='list-line'>
          <Text className='line-label'>目标体重</Text>
          <Text className='line-val'>{profile?.target_weight_kg ?? '—'} kg</Text>
        </View>
        <View className='list-line'>
          <Text className='line-label'>每日步数目标</Text>
          <Text className='line-val'>{profile?.step_goal ?? DEFAULT_STEP_GOAL} 步</Text>
        </View>
      </View>

      {/* 体重打卡 */}
      <View className='section-title'><Text>体重打卡</Text></View>
      <View className='card'>
        <View className='weight-row'>
          <Input
            type='digit'
            value={weightInput}
            onInput={(e) => { setWeightInput(sanitizeNumeric(e.detail.value, { decimals: WEIGHT_LIMIT.decimals })); setWeightErr('') }}
            onBlur={(e) => setWeightInput(clampNumeric(e.detail.value, WEIGHT_LIMIT))}
            className='weight-input'
            placeholder='今天的体重（kg）'
          />
          <Button className='btn' onClick={() => void submitWeight()} disabled={savingWeight}>
            {savingWeight ? '记录中…' : '记录'}
          </Button>
        </View>
        {weightErr ? <View className='notice err'><Text>{weightErr}</Text></View> : null}
        {weightMsg ? <View className='notice ok'><Text>{weightMsg}</Text></View> : null}

        {weights.length > 0 ? (
          <View className='weight-list'>
            {weights.slice(0, 8).map((w) => (
              <View key={w.id ?? w.log_date} className='list-line'>
                <Text className='weight-date'>{w.log_date}</Text>
                <Text className='line-val'>{w.weight_kg} kg</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {barriers.length > 0 ? (
        <>
          <View className='section-title'><Text>你在意的问题</Text></View>
          <View className='card'>
            <View className='chips'>
              {barriers.map((b) => <Text key={b} className='chip'>{b}</Text>)}
            </View>
          </View>
        </>
      ) : null}

      {isHealthConnectable() ? (
        <>
          <View className='section-title'><Text>健康数据源</Text></View>
          <View className='card'>
            {/* 对齐主端 ProfileScreen:578-604：连接 / 已连接重连 / 解除连接 / 状态提示 */}
            <View className='list-line' onClick={() => void handleConnectHealth()}>
              <View className='line-label-wrap'>
                <Text className='line-label'>{healthVendor.label}</Text>
              </View>
              <Text className='line-val'>
                {healthBusy ? '处理中…' : healthConnected ? '已连接 · 点击重新授权' : healthVendor.canSync ? '连接' : '查看'}
                <Text className='arrow'>›</Text>
              </Text>
            </View>
            {healthConnected ? (
              <View className='list-line' onClick={() => void handleDisconnectHealth()}>
                <View className='line-label-wrap'>
                  <Text className='line-label'>解除连接</Text>
                </View>
                <Text className='arrow'>›</Text>
              </View>
            ) : null}
            {healthMsg ? <Text className='hint'>{healthMsg}</Text> : null}
            <Text className='hint'>{healthVendor.tip}</Text>
          </View>
        </>
      ) : null}

      {/* 通知提醒 */}
      <View className='section-title'><Text>通知提醒</Text></View>
      <View className='card'>
        <View className='list-line'>
          <View className='line-label-wrap'>
            <Text className='line-label'>每日打卡提醒</Text>
          </View>
          <Switch
            checked={notifCheckin}
            color='#F2A93B'
            onChange={(e) => void toggleNotif('checkin', e.detail.value)}
          />
        </View>
        <View className='list-line'>
          <View className='line-label-wrap'>
            <Text className='line-label'>饮水提醒</Text>
          </View>
          <Switch
            checked={notifWater}
            color='#F2A93B'
            onChange={(e) => void toggleNotif('water', e.detail.value)}
          />
        </View>
      </View>

      {/* 数据与隐私 */}
      <View className='section-title'><Text>数据与隐私</Text></View>
      <View className='card'>
        {/* 🔴 P2-A + 11-08 四端对齐：非 Pro 显示「Pro ›」并在点击时拉付费墙
            （与主端 ProfileScreen 一致）；Pro 且导出未实装时置灰 + 「即将上线」角标，
            与 legal.ts §五口径一致。刻意**不禁用点击** —— 点下去仍会给出「可通过邮箱
            申请副本」的提示，那是 PIPL 第 45 条复制权的真实兜底路径，不能因补了
            Pro 门控反而把这条权利入口藏掉。 */}
        <View className={pro && !isExportAvailable ? 'list-line list-line-muted' : 'list-line'} onClick={() => void doExport()}>
          <View className='line-label-wrap'>
            <IconDownload size={16} />
            <Text className='line-label'>导出全部数据（JSON）</Text>
          </View>
          {!pro
            ? <Text className='line-val'>Pro <Text className='arrow'>›</Text></Text>
            : isExportAvailable
              ? <Text className='line-val'>{exporting ? '导出中…' : '导出'}</Text>
              : <Text className='line-badge'>即将上线</Text>}
        </View>
        <View className={pro && !isExportAvailable ? 'list-line list-line-muted' : 'list-line'} onClick={() => void doExportCsv()}>
          <View className='line-label-wrap'>
            <IconDownload size={16} />
            <Text className='line-label'>导出饮食记录（CSV）</Text>
          </View>
          {!pro
            ? <Text className='line-val'>Pro <Text className='arrow'>›</Text></Text>
            : isExportAvailable
              ? <Text className='line-val'>{exporting ? '导出中…' : '导出'}</Text>
              : <Text className='line-badge'>即将上线</Text>}
        </View>
        <View className='list-line' onClick={() => !confirmClear && setConfirmClear(true)}>
          <View className='line-label-wrap'>
            <IconTrash size={16} />
            <Text className='line-label'>清空全部记录</Text>
          </View>
          <Text className='line-val'>
            {confirmClear ? (
              <View className='confirm-row'>
                <Button className='btn-text danger' onClick={() => void doClear()} disabled={clearing}>
                  {clearing ? '清空中…' : '确认清空'}
                </Button>
                <Button className='btn-text' onClick={() => setConfirmClear(false)}>取消</Button>
              </View>
            ) : (
              <Text>饮食 / 体重 / 饮水 / 运动 <Text className='arrow'>›</Text></Text>
            )}
          </Text>
        </View>
        {confirmClear ? (
          <View className='helper danger'><Text>⚠️ 将删除你的全部记录且不可恢复（账号与身体数据保留）。再点一次「确认清空」执行。</Text></View>
        ) : null}
        {dataMsg ? <View className='notice ok'><Text>{dataMsg}</Text></View> : null}
        {dataErr ? <View className='notice err'><Text>{dataErr}</Text></View> : null}
      </View>

      {/* 退出登录 */}
      {confirmSignOut ? (
        <View className='signout-row'>
          <Button className='btn btn-ghost' onClick={() => setConfirmSignOut(false)}>取消</Button>
          <Button className='btn btn-ghost danger-btn' onClick={() => void doSignOut()}>确认退出</Button>
        </View>
      ) : (
        <Button className='btn btn-ghost signout-btn' onClick={() => setConfirmSignOut(true)}>退出登录</Button>
      )}

      {/* 关于与协议 */}
      <View className='section-title' style={{ marginTop: 24 }}><Text>关于</Text></View>
      <View className='card'>
        <View className='list-line' onClick={() => Taro.navigateTo({ url: '/pages/legal/legal?id=terms' })}>
          <Text className='line-label'>用户协议</Text>
          <Text className='line-val'><Text className='arrow'>›</Text></Text>
        </View>
        <View className='list-line' onClick={() => Taro.navigateTo({ url: '/pages/legal/legal?id=privacy' })}>
          <Text className='line-label'>隐私政策</Text>
          <Text className='line-val'><Text className='arrow'>›</Text></Text>
        </View>
        <View className='list-line' onClick={() => Taro.navigateTo({ url: '/pages/legal/legal?id=disclaimer' })}>
          <Text className='line-label'>免责声明</Text>
          <Text className='line-val'><Text className='arrow'>›</Text></Text>
        </View>
        {/*
          🔴 「联系我们」（2026-11-05 补）。此前本卡片只有三条法律文档，但注销账号的
          提示文案（下方 confirmDeleteAcct 分支）与 legal.ts 正文都指引用户
          「通过『关于 → 联系我们』与客服联系」—— 而该入口在两端都**不存在**，
          属四端共有的失实指引（web 端连「关于」区块都没有）。本次两端一并补齐。
          🔴 2026-11-08 更正：注销已改为 App 内真删号（0045 RPC），本行邮箱现在**只作
          公示联系方式**，不再是注销的替代路径；下方注销提示不得再引导用户转客服。

          邮箱刻意**默认直接显示**在行内而非点击后才弹出：法律要求公示联系方式应
          「以显著方式」呈现，藏在交互后面等于没公示。点击整行 = 复制到剪贴板
          （小程序无 DOM、无 mailto，不能直接唤起邮件客户端，故复制是唯一可行路径，
          与 legal.tsx 备案号的既有交互口径一致）。
        */}
        <View className='list-line' onClick={() => void copyContactEmail()}>
          <Text className='line-label'>联系我们</Text>
          <Text className='line-val contact-val'>{SITE.contactEmail}</Text>
        </View>
        <View className='helper'>点击邮箱可复制；我们将在 15 个工作日内答复</View>
      </View>

      {/* 账号管理 */}
      <View className='section-title' style={{ marginTop: 24 }}><Text>账号管理</Text></View>
      <View className='card'>
        <View className='list-line' onClick={() => setConfirmDeleteAcct(true)}>
          <View className='line-label-wrap'>
            <IconTrash size={16} color='#d05c4e' />
            <Text className='line-label danger-text'>注销账号</Text>
          </View>
          <Text className='line-val'>
            {confirmDeleteAcct ? (
              <View className='confirm-row'>
                <Button className='btn-text danger' onClick={() => void doDeleteAccount()} disabled={deletingAcct}>
                  {deletingAcct ? '注销中…' : '确认注销'}
                </Button>
                <Button className='btn-text' onClick={() => setConfirmDeleteAcct(false)}>取消</Button>
              </View>
            ) : (
              <Text className='arrow'>›</Text>
            )}
          </Text>
        </View>
        {confirmDeleteAcct ? (
          <View className='helper danger'><Text>⚠️ 将永久删除你的账号及全部记录、身体档案与权益，并退出登录，操作不可恢复。</Text></View>
        ) : null}
      </View>

      {/* P1.6 数据权与退款 / P1.4 已有能力 / P1.5 次数规则：与主端共用 @dbee/shared 文案真源。
          🔴 额度文案用 MINI_RECORDING_CAPS（本端无扫码 / 包装识别）。 */}
      <TransparencyNotes title='你的数据与退款' notes={DATA_RIGHTS_NOTES} />
      <TransparencyNotes title='这些能力怎么算' notes={CAPABILITY_NOTES} />
      <TransparencyNotes title='次数怎么算' notes={quotaNotes(MINI_RECORDING_CAPS)} />

      <View className='bottom-space' />

      {/* 身体数据编辑弹层 */}
      {editing ? (
        <View className='sheet-mask' onClick={() => setEditing(false)}>
          <View className='sheet-panel' onClick={(e) => e.stopPropagation()}>
            <View className='sheet-head'>
              <Text className='sheet-title'>身体数据与目标</Text>
              <Text className='sheet-close' onClick={() => setEditing(false)}>×</Text>
            </View>
            <View className='sheet-body'>
              {err ? <View className='notice err'><Text>{err}</Text></View> : null}

              <View className='field'>
                <Text className='field-label'>昵称</Text>
                <Input
                  value={nickname}
                  maxlength={NICKNAME_RULE.max}
                  onInput={(e) => { setNickname(e.detail.value); if (fieldErr.nick) setFieldErr((p) => ({ ...p, nick: '' })) }}
                  placeholder='怎么称呼你'
                  className='field-input'
                />
                {fieldErr.nick ? <Text className='field-err'>{fieldErr.nick}</Text> : null}
              </View>

              <View className='field'>
                <Text className='field-label'>目标</Text>
                <View className='chips'>
                  {(Object.keys(GOAL_LABELS) as Array<keyof typeof GOAL_LABELS>).map((g) => (
                    <Button key={g} className={`chip ${goal === g ? 'active' : ''}`} onClick={() => setGoal(g)}>{GOAL_LABELS[g]}</Button>
                  ))}
                </View>
              </View>

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
                  type='number'
                  value={age}
                  onInput={(e) => typeNum(e.detail.value, AGE_LIMIT, setAge, 'age')}
                  onBlur={(e) => blurNum(e.detail.value, AGE_LIMIT, setAge, 'age')}
                  className='field-input'
                />
                {fieldErr.age ? <Text className='field-err'>{fieldErr.age}</Text> : null}
              </View>

              <View className='field'>
                <Text className='field-label'>身高（cm）</Text>
                <Input
                  type='digit'
                  value={height}
                  onInput={(e) => typeNum(e.detail.value, HEIGHT_LIMIT, setHeight, 'height')}
                  onBlur={(e) => blurNum(e.detail.value, HEIGHT_LIMIT, setHeight, 'height')}
                  className='field-input'
                />
                {fieldErr.height ? <Text className='field-err'>{fieldErr.height}</Text> : null}
              </View>

              <View className='field'>
                <Text className='field-label'>当前体重（kg）</Text>
                <Input
                  type='digit'
                  value={weight}
                  onInput={(e) => typeNum(e.detail.value, WEIGHT_LIMIT, setWeight, 'weight')}
                  onBlur={(e) => blurNum(e.detail.value, WEIGHT_LIMIT, setWeight, 'weight')}
                  className='field-input'
                />
                {fieldErr.weight ? <Text className='field-err'>{fieldErr.weight}</Text> : null}
              </View>

              {goal !== 'keep' ? (
                <View className='field'>
                  <Text className='field-label'>目标体重（kg）</Text>
                  <Input
                    type='digit'
                    value={targetWeight}
                    onInput={(e) => typeNum(e.detail.value, WEIGHT_LIMIT, setTargetWeight, 'tw')}
                    onBlur={(e) => blurNum(e.detail.value, WEIGHT_LIMIT, setTargetWeight, 'tw')}
                    className='field-input'
                  />
                  {fieldErr.tw ? <Text className='field-err'>{fieldErr.tw}</Text> : null}
                </View>
              ) : null}

              <View className='field'>
                <Text className='field-label'>活动水平</Text>
                <View className='chips'>
                  {(Object.keys(ACTIVITY_LABELS) as Array<keyof typeof ACTIVITY_LABELS>).map((a) => (
                    <Button key={a} className={`chip ${activity === a ? 'active' : ''}`} onClick={() => setActivity(a)}>{ACTIVITY_LABELS[a].split('，')[0]}</Button>
                  ))}
                </View>
              </View>

              <View className='field'>
                <Text className='field-label'>每日步数目标</Text>
                <Input
                  type='number'
                  value={stepGoal}
                  onInput={(e) => typeNum(e.detail.value, STEP_GOAL_LIMIT, setStepGoal, 'stepGoal')}
                  onBlur={(e) => blurNum(e.detail.value, STEP_GOAL_LIMIT, setStepGoal, 'stepGoal')}
                  className='field-input'
                />
                {fieldErr.stepGoal ? <Text className='field-err'>{fieldErr.stepGoal}</Text> : null}
              </View>

              <Text className='helper'>保存后会按新数据重新计算每日热量与营养素目标。历史记录不会被改动。</Text>
              <Button className='btn' onClick={() => void submitBody()} disabled={saving}>
                {saving ? '保存中…' : '保存并重新计算'}
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  )
}
