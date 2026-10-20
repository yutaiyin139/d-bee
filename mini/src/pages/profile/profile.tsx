/**
 * 我的页（对齐主工程 src/pages/ProfileScreen.tsx）。
 *
 * 差异点（小程序端能力诚实降级）：
 *  - 健康数据源：isHealthConnectable() 恒 false → 隐藏该区块
 *  - 体重趋势图：主工程用 SVG LineChart，小程序端以列表形式展示（图表统一在报告页处理）
 *  - 数据导出：走 share.ts 占位（返回「正在接入」提示）
 *  - 会员升级：小程序端暂无支付，点「升级」给出诚实提示
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, Button, Input, Switch } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { IconCrown, IconDownload, IconTrash } from '../../components/Icons'
import {
  listWeightLogs, saveProfile, saveWeight, clearAllRecords,
  exportAllData, listMealsBetween, buildMealsCsv,
  getProfile, type Profile, type WeightLog,
} from '../../lib/api'
import { ACTIVITY_LABELS, GOAL_LABELS, calcTarget, todayKey } from '../../lib/nutrition'
import {
  AGE_LIMIT, HEIGHT_LIMIT, WEIGHT_LIMIT, STEP_GOAL_LIMIT, NICKNAME_RULE,
  type NumLimit, checkNumber, checkTargetWeightDiff, checkText,
  clampNumeric, firstError, rangeText, sanitizeNumeric,
} from '../../lib/validate'
import { exportJSON, exportText } from '../../lib/share'
import { isHealthConnectable } from '../../lib/health'
import { HONEY_PRICE } from '../../lib/invite'
import { FREE_REPORT_DAYS } from '@dbee/shared'
import { signOut } from '../../lib/auth'
import { getNotifyPrefs, setNotifyPrefs, enableCheckinNotify, disableCheckinNotify, enableWaterNotify, disableWaterNotify } from '../../lib/notifications'
import './profile.scss'

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  // 会员状态（小程序端暂无 entitlements 拉取，先按免费版展示）
  const [pro, setPro] = useState(false)
  const [lifetime, setLifetime] = useState(false)

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

  // 通知提醒偏好（打卡提醒 / 饮水提醒，存本地 kv）
  const [notifCheckin, setNotifCheckin] = useState(true)
  const [notifWater, setNotifWater] = useState(true)
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
  const [stepGoal, setStepGoal] = useState('6000')
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
        setStepGoal(String(p.step_goal ?? 6000))
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
  }

  useEffect(() => {
    void load()
  }, [])

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
        step_goal: num(stepGoal, 6000),
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

  async function doExport() {
    setExporting(true)
    setDataErr('')
    setDataMsg('')
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
    setExporting(true)
    setDataErr('')
    setDataMsg('')
    try {
      const meals = await listMealsBetween('1970-01-01', '2999-12-31')
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

  async function doDeleteAccount() {
    setDeletingAcct(true)
    setDataErr('')
    setDataMsg('')
    try {
      await clearAllRecords()
      try {
        await saveProfile({ nickname: null, barriers: null, plan_summary: null })
      } catch {
        /* 档案清理失败不阻断登出 */
      }
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

  function goInvite() {
    Taro.navigateTo({ url: '/pages/invite/invite' })
  }

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
            <Text className='member-sub'>
              {lifetime ? '全部功能已永久解锁' : pro ? '全部功能已解锁' : `今日剩拍照 3 次 · 报告看近 ${FREE_REPORT_DAYS} 天`}
            </Text>
          </View>
        </View>
        {!pro && (
          <Button className='member-btn' onClick={() => Taro.navigateTo({ url: '/pages/paywall/paywall' })}>
            升级
          </Button>
        )}
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
          <Text className='stat-v'>{target.carb_g}<Text className='stat-unit'>g</Text> / {target.fat_g}<Text className='stat-unit'>g</Text></Text>
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
          <Text className='line-val'>{profile?.step_goal ?? 6000} 步</Text>
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
            <Text className='hint'>小程序端暂不支持连接健康数据</Text>
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
        <View className='list-line' onClick={() => void doExport()}>
          <View className='line-label-wrap'>
            <IconDownload size={16} />
            <Text className='line-label'>导出全部数据（JSON）</Text>
          </View>
          <Text className='line-val'>{exporting ? '导出中…' : '导出'}</Text>
        </View>
        <View className='list-line' onClick={() => void doExportCsv()}>
          <View className='line-label-wrap'>
            <IconDownload size={16} />
            <Text className='line-label'>导出饮食记录（CSV）</Text>
          </View>
          <Text className='line-val'>{exporting ? '导出中…' : '导出'}</Text>
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
          <View className='helper danger'><Text>⚠️ 将删除你的全部记录与身体档案并退出登录，不可恢复。如需彻底注销账号，请通过「关于 → 联系我们」与客服联系。</Text></View>
        ) : null}
      </View>

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
