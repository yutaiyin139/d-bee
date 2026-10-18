import { useEffect, useMemo, useState } from 'react'
import { Sheet } from '../components/Sheet'
import { SiteFooter } from '../components/SiteFooter'
import { LineChart } from '../components/Charts'
import type { DocId } from '../content/legal'
import { IconCrown, IconDownload, IconRun, IconTrash } from '../components/Icons'
import {
  buildMealsCsv,
  clearAllRecords,
  exportAllData,
  listMealsBetween,
  listWeightLogs,
  saveProfile,
  saveWeight,
} from '../lib/api'
import { FREE_REPORT_DAYS } from '../lib/entitlement'
import {
  ACTIVITY_LABELS,
  GOAL_LABELS,
  calcTarget,
  targetFromProfile,
  todayKey,
} from '../lib/nutrition'
import { usePlan } from '../state/plan'
import { exportJSON, exportText } from '../lib/share'
import { connectHealth, disconnectHealth, getHealthVendor, isHealthConnectable } from '../lib/health'
import {
  AGE_LIMIT,
  HEIGHT_LIMIT,
  NICKNAME_RULE,
  WEIGHT_LIMIT,
  STEP_GOAL_LIMIT,
  type NumLimit,
  checkNumber,
  checkTargetWeightDiff,
  checkText,
  clampNumeric,
  firstError,
  rangeText,
  sanitizeNumeric,
} from '../lib/validate'
import type { Profile, WeightLog } from '../types'
import { InviteCenter } from './InviteCenter'
import { errText } from '../lib/errmsg'

interface ProfileScreenProps {
  profile: Profile
  account: string
  onOpenLegal: (id: DocId) => void
  onProfileChanged: (p: Profile) => void
  onSignOut: () => void
}

export function ProfileScreen({ profile, account, onOpenLegal, onProfileChanged, onSignOut }: ProfileScreenProps) {
  const { pro, lifetime, aiRemaining, openPaywall, entitlement } = usePlan()
  const target = useMemo(() => targetFromProfile(profile), [profile])
  const [editing, setEditing] = useState(false)
  const [barriers] = useState<string[]>(() => (profile.barriers ? profile.barriers.split(',') : []))

  // 数据与隐私
  const [exporting, setExporting] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [dataMsg, setDataMsg] = useState('')
  const [dataErr, setDataErr] = useState('')

  // 注销账号（Apple 5.1.1(v) 合规入口）：两步确认
  const [confirmDeleteAcct, setConfirmDeleteAcct] = useState(false)
  const [deletingAcct, setDeletingAcct] = useState(false)
  // 退出登录与「清空记录 / 注销账号」保持同一标准：两步确认，防误触登出
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  // 健康数据源（可重连 / 可解除连接；连接意图存云端 profiles.health_connected）
  const healthVendor = useMemo(() => getHealthVendor(), [])
  const [healthTip, setHealthTip] = useState('')
  const [healthBusy, setHealthBusy] = useState(false)
  async function handleConnectHealth() {
    if (healthBusy) return
    setHealthBusy(true)
    try {
      const res = await connectHealth()
      if (res.message) setHealthTip(res.message)
      if (res.ok) {
        onProfileChanged({ ...profile, health_connected: true, health_connected_at: new Date().toISOString() })
      }
    } finally {
      setHealthBusy(false)
    }
  }
  async function handleDisconnectHealth() {
    if (healthBusy) return
    setHealthBusy(true)
    try {
      await disconnectHealth()
      onProfileChanged({ ...profile, health_connected: false, health_connected_at: null })
      setHealthTip('已解除连接，可随时重新连接。')
    } finally {
      setHealthBusy(false)
    }
  }

  // 蜜糖积分中心
  const [inviteOpen, setInviteOpen] = useState(false)

  const [weights, setWeights] = useState<WeightLog[]>([])
  const [weightInput, setWeightInput] = useState(String(profile.current_weight_kg ?? ''))
  const [weightMsg, setWeightMsg] = useState('')
  const [weightErr, setWeightErr] = useState('')
  const [savingWeight, setSavingWeight] = useState(false)

  // 体重趋势：把降序列表反转成升序给折线图，目标体重作参考线
  const weightPoints = useMemo(
    () =>
      weights
        .slice()
        .reverse()
        .map((w) => ({ label: w.log_date.slice(5), value: Number(w.weight_kg) || 0 })),
    [weights],
  )

  // 减重里程碑：当前体重 vs 起始体重
  const weightMilestone = useMemo(() => {
    const start = Number(profile.start_weight_kg)
    const cur = Number(profile.current_weight_kg)
    if (!Number.isFinite(start) || !Number.isFinite(cur) || start <= 0 || cur <= 0) return null
    const delta = start - cur
    if (delta >= 0.5) return { text: `已减重 ${Math.round(delta * 10) / 10} kg`, good: true }
    if (delta <= -0.5) return { text: `较起始 +${Math.round(-delta * 10) / 10} kg`, good: false }
    return null
  }, [profile.start_weight_kg, profile.current_weight_kg])

  // 身体数据编辑
  const [nickname, setNickname] = useState(profile.nickname ?? '')
  const [gender, setGender] = useState<'male' | 'female'>(profile.gender ?? 'female')
  const [age, setAge] = useState(String(profile.age ?? 28))
  const [height, setHeight] = useState(String(profile.height_cm ?? 165))
  const [weight, setWeight] = useState(String(profile.current_weight_kg ?? 62))
  const [targetWeight, setTargetWeight] = useState(String(profile.target_weight_kg ?? 55))
  const [stepGoal, setStepGoal] = useState(String(profile.step_goal ?? 6000))
  const [activity, setActivity] = useState<keyof typeof ACTIVITY_LABELS>(
    (profile.activity_level as keyof typeof ACTIVITY_LABELS) ?? 'light',
  )
  const [goal, setGoal] = useState<'lose' | 'keep' | 'gain'>(profile.goal ?? 'lose')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  /** 身体数据字段的行内校验提示 */
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})

  useEffect(() => {
    void (async () => {
      try {
        setWeights(await listWeightLogs(30))
      } catch {
        /* 静默：体重列表失败不阻塞页面 */
      }
    })()
  }, [])

  const num = (v: string, fb: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fb
  }

  /** 输入过程：过滤非法字符 */
  function typeNum(raw: string, limit: NumLimit, set: (v: string) => void, field: string) {
    set(sanitizeNumeric(raw, { int: limit.int, decimals: limit.decimals }))
    if (fieldErr[field]) setFieldErr((p) => ({ ...p, [field]: '' }))
  }

  /** 失焦：夹回边界，并在发生纠正时说明原因 */
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

  /** 校验身体数据表单，写回行内提示并返回第一条错误 */
  function validateBody(): string {
    const a = checkNumber(age, AGE_LIMIT)
    const h = checkNumber(height, HEIGHT_LIMIT)
    const w = checkNumber(weight, WEIGHT_LIMIT)
    const tw = goal === 'keep' ? { ok: true, value: w.value, error: '' } : checkNumber(targetWeight, WEIGHT_LIMIT)
    const sg = checkNumber(stepGoal, STEP_GOAL_LIMIT)
    const diff = goal === 'keep' ? { ok: true, error: '' } : checkTargetWeightDiff(tw.value, w.value)
    // 昵称允许留空（云端存 null），只在填了内容时校验长度
    const nick = nickname.trim() === '' ? { ok: true, error: '' } : checkText(nickname, NICKNAME_RULE)
    setFieldErr({
      age: a.error,
      height: h.error,
      weight: w.error,
      tw: tw.error || diff.error,
      nick: nick.error,
      stepGoal: sg.error,
    })
    return firstError(a.error, h.error, w.error, tw.error, diff.error, nick.error, sg.error)
  }

  async function submitBody() {
    const vErr = validateBody()
    if (vErr) {
      setErr(vErr)
      return
    }
    setSaving(true)
    setErr('')
    try {
      const w = num(weight, 62)
      const tw = goal === 'keep' ? w : num(targetWeight, w)
      const weeklyRate = goal === 'keep' ? 0 : Math.min(0.75, Math.max(0.25, w * 0.0075))
      const t = calcTarget({
        gender,
        age: num(age, 28),
        heightCm: num(height, 165),
        weightKg: w,
        activity,
        goal,
        weeklyRateKg: weeklyRate,
      })
      const saved = await saveProfile({
        nickname: nickname.trim() || null,
        gender,
        age: num(age, 28),
        height_cm: num(height, 165),
        current_weight_kg: w,
        target_weight_kg: tw,
        activity_level: activity,
        goal,
        weekly_rate_kg: weeklyRate,
        daily_calorie_target: t.calories,
        protein_target_g: t.protein_g,
        carb_target_g: t.carb_g,
        fat_target_g: t.fat_g,
        step_goal: num(stepGoal, 6000),
      })
      onProfileChanged(saved)
      setEditing(false)
    } catch (e) {
      setErr(errText(e, '保存失败'))
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
      onProfileChanged(saved)
      setWeights(await listWeightLogs(30))
      setWeightMsg('已记录今天的体重')
    } catch (e) {
      setWeightErr(errText(e, '记录失败'))
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
      // 导出通道由 lib/share 决定：Web 走浏览器下载，原生走 Filesystem + 分享面板
      const res = await exportJSON(bundle, `d-bee-export-${todayKey()}.json`, {
        title: 'D-Bee 数据导出',
        text: '这是你在 D-Bee 里记录的全部数据。',
      })
      setDataMsg(res.message)
    } catch (e) {
      setDataErr(errText(e, '导出失败'))
    } finally {
      setExporting(false)
    }
  }

  /** 饮食记录 CSV 导出：供用户用 Excel 做营养结构综合分析（自律茄子坑 3 的补位） */
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
      setDataErr(errText(e, '导出失败'))
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
      setDataErr(errText(e, '清空失败'))
    } finally {
      setClearing(false)
    }
  }

  /**
   * 注销账号（降级实现）。
   * 云端当前不提供删除 auth 账号的能力（SDK 无 deleteUser、admin 端点只读），
   * 因此这里做「清空全部数据 + 登出」的本地数据删除，并明确告知：彻底注销账号
   * 需联系客服人工处理。这满足 Apple 5.1.1(v) 的「App 内提供删除入口」最低要求。
   */
  async function doDeleteAccount() {
    setDeletingAcct(true)
    setDataErr('')
    setDataMsg('')
    try {
      await clearAllRecords()
      // 也清掉身体档案，避免残留可识别个人信息
      try {
        await saveProfile({ nickname: null, barriers: null, plan_summary: null })
      } catch {
        // 档案清理失败不阻断登出
      }
      setConfirmDeleteAcct(false)
      onSignOut()
    } catch (e) {
      setDataErr(errText(e, '注销失败，请重试'))
    } finally {
      setDeletingAcct(false)
    }
  }

  return (
    <div className="page">
      <div className="page-top" />
      <div className="hero">
        <h1>我的</h1>
        <p>{account}</p>
      </div>

      {/* 会员状态 */}
      <div className={`member-card ${pro ? 'is-pro' : ''}`}>
        <div className="member-left">
          <IconCrown color={pro ? '#6b4a08' : 'var(--ink-2)'} size={20} />
          <div>
            <div className="member-title">
              {lifetime ? 'D-Bee 终身会员' : pro ? 'D-Bee Pro' : '免费版'}
            </div>
            <div className="member-sub">
              {lifetime
                ? entitlement?.redeemed_code
                  ? `已通过兑换码 ${entitlement.redeemed_code} 永久解锁`
                  : '全部功能已永久解锁'
                : pro
                  ? entitlement?.pro_until
                    ? `有效期至 ${new Date(entitlement.pro_until).toLocaleDateString('zh-CN')}`
                    : '全部功能已解锁'
                  : `今日剩拍照 ${aiRemaining ?? 0} 次 · 报告看近 ${FREE_REPORT_DAYS} 天`}
            </div>
          </div>
        </div>
        {!pro && (
          <button className="member-btn" onClick={() => openPaywall()}>
            升级
          </button>
        )}
      </div>

      {/* 蜜糖积分入口 */}
      <div className="card" style={{ marginBottom: 14, cursor: 'pointer' }} onClick={() => setInviteOpen(true)} role="button" tabIndex={0}>
        <div className="list-line">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 16 }}>🍯</span> 蜜糖积分 · 邀请好友
          </span>
          <span className="val">
            查看积分与兑换
            <span className="arrow" style={{ marginLeft: 6 }}>›</span>
          </span>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat">
          <div className="l">每日热量预算</div>
          <div className="v">{target.calories}<small>kcal</small></div>
        </div>
        <div className="stat">
          <div className="l">当前体重</div>
          <div className="v">{profile.current_weight_kg ?? '—'}<small>kg</small></div>
        </div>
        <div className="stat">
          <div className="l">蛋白质目标</div>
          <div className="v">{target.protein_g}<small>g</small></div>
        </div>
        <div className="stat">
          <div className="l">碳水 / 脂肪</div>
          <div className="v">
            {target.carb_g}<small>g</small> / {target.fat_g}<small>g</small>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="list-line" onClick={() => setEditing(true)} role="button" tabIndex={0}>
          <span>身体数据与目标</span>
          <span className="val">
            {GOAL_LABELS[goal]}
            <span className="arrow" style={{ marginLeft: 6 }}>›</span>
          </span>
        </div>
        <div className="list-line">
          <span>身高 / 年龄 / 性别</span>
          <span className="val">
            {profile.height_cm ?? '—'}cm · {profile.age ?? '—'}岁 · {gender === 'male' ? '男' : '女'}
          </span>
        </div>
        <div className="list-line">
          <span>活动水平</span>
          <span className="val">{ACTIVITY_LABELS[activity]}</span>
        </div>
        <div className="list-line" style={{ alignItems: 'flex-start' }}>
          <span style={{ flexShrink: 0 }}>目标体重</span>
          <span className="val" style={{ textAlign: 'right' }}>{profile.target_weight_kg ?? '—'} kg</span>
        </div>
        <div className="list-line">
          <span>每日步数目标</span>
          <span className="val">{profile.step_goal ?? 6000} 步</span>
        </div>
      </div>

      <div className="section-title">体重打卡</div>
      <div className="card">
        {weightMilestone && (
          <div className={`milestone-banner ${weightMilestone.good ? 'is-good' : ''}`} style={{ marginBottom: 12 }}>
            {weightMilestone.good ? '🎉' : '📈'} {weightMilestone.text}
            {weightMilestone.good && ' · 继续保持'}
          </div>
        )}
        {weightPoints.length >= 2 && (
          <div style={{ marginBottom: 12 }}>
            <LineChart
              points={weightPoints}
              target={profile.target_weight_kg != null ? Number(profile.target_weight_kg) : null}
              unit="kg"
              color="var(--green)"
              fmt={(v) => String(Math.round(v * 10) / 10)}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="number"
            inputMode="decimal"
            min={WEIGHT_LIMIT.min}
            max={WEIGHT_LIMIT.max}
            value={weightInput}
            onChange={(e) => {
              setWeightInput(sanitizeNumeric(e.target.value, { decimals: WEIGHT_LIMIT.decimals }))
              setWeightErr('')
            }}
            onBlur={(e) => setWeightInput(clampNumeric(e.target.value, WEIGHT_LIMIT))}
            style={{
              flex: 1,
              minWidth: 0,
              height: 48,
              borderRadius: 14,
              border: '1px solid var(--line-2)',
              background: 'var(--surface)',
              padding: '0 14px',
              outline: 'none',
            }}
            placeholder="今天的体重（kg）"
          />
          <button className="btn" style={{ width: 108, flexShrink: 0 }} disabled={savingWeight} onClick={submitWeight}>
            {savingWeight ? <span className="spinner" /> : '记录'}
          </button>
        </div>
        {weightErr && <div className="notice err" style={{ marginTop: 12, marginBottom: 0 }}>{weightErr}</div>}
        {weightMsg && <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>{weightMsg}</div>}

        {weights.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {weights.slice(0, 8).map((w) => (
              <div key={w.id ?? w.log_date} className="list-line">
                <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>{w.log_date}</span>
                <span className="val">{w.weight_kg} kg</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {barriers.length > 0 && (
        <>
          <div className="section-title">你在意的问题</div>
          <div className="card">
            <div className="chips">
              {barriers.map((b) => (
                <span key={b} className="chip" style={{ pointerEvents: 'none' }}>{b}</span>
              ))}
            </div>
          </div>
        </>
      )}

      {isHealthConnectable() && (
        <>
          <div className="section-title">健康数据源</div>
          <div className="card">
            <div className="list-line" onClick={handleConnectHealth} role="button" tabIndex={0} aria-disabled={healthBusy}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconRun color="var(--green)" size={16} />
                {healthVendor.label}
              </span>
              <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                  {healthBusy ? '处理中…' : profile.health_connected ? '已连接 · 点击重新授权' : healthVendor.canSync ? '连接' : '查看'}
                </span>
                <span className="arrow">›</span>
              </span>
            </div>
            {healthTip && <div className="notice" style={{ margin: 10, fontSize: 13 }}>{healthTip}</div>}
            {profile.health_connected && (
              <div className="list-line" onClick={handleDisconnectHealth} role="button" tabIndex={0} aria-disabled={healthBusy}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>解除连接</span>
                </span>
                <span className="val">
                  <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>{healthBusy ? '处理中…' : ''}</span>
                  <span className="arrow">›</span>
                </span>
              </div>
            )}
            <div className="hint" style={{ padding: '0 16px 12px' }}>
              步数一直为 0？到 iOS「设置 &gt; 健康 &gt; 数据访问权限 &gt; 自律蜜蜂」确认已勾选步数与活动能量。
              未来将支持 Health Connect、华为运动健康、小米运动健康等更多数据源。
            </div>
          </div>
        </>
      )}

      <div className="section-title">数据与隐私</div>
      <div className="card">
        <div className="list-line" onClick={() => !pro && openPaywall('数据导出是 Pro 功能，升级后可随时打包带走全部记录。')} role="button" tabIndex={0}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconDownload size={16} />
            导出全部数据（JSON）
          </span>
          <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {pro ? (
              <button className="btn-text" disabled={exporting} onClick={(e) => { e.stopPropagation(); void doExport() }}>
                {exporting ? '导出中…' : '导出'}
              </button>
            ) : (
              <>
                Pro
                <span className="arrow">›</span>
              </>
            )}
          </span>
        </div>
        <div className="list-line" onClick={() => !pro && openPaywall('数据导出是 Pro 功能，升级后可随时打包带走全部记录。')} role="button" tabIndex={0}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconDownload size={16} />
            导出饮食记录（CSV）
          </span>
          <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {pro ? (
              <button className="btn-text" disabled={exporting} onClick={(e) => { e.stopPropagation(); void doExportCsv() }}>
                {exporting ? '导出中…' : '导出'}
              </button>
            ) : (
              <>
                Pro
                <span className="arrow">›</span>
              </>
            )}
          </span>
        </div>
        <div className="list-line" onClick={() => !confirmClear && setConfirmClear(true)} role="button" tabIndex={0}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconTrash size={16} />
            清空全部记录
          </span>
          <span className="val">
            {confirmClear ? (
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn-text" style={{ color: 'var(--red)' }} disabled={clearing} onClick={(e) => { e.stopPropagation(); void doClear() }}>
                  {clearing ? '清空中…' : '确认清空'}
                </button>
                <button className="btn-text" style={{ color: 'var(--ink-3)' }} onClick={(e) => { e.stopPropagation(); setConfirmClear(false) }}>
                  取消
                </button>
              </span>
            ) : (
              <>
                饮食 / 体重 / 饮水 / 运动
                <span className="arrow" style={{ marginLeft: 6 }}>›</span>
              </>
            )}
          </span>
        </div>
        {confirmClear && (
          <div className="helper" style={{ color: 'var(--red)', marginBottom: 4 }}>
            ⚠️ 将删除你的全部记录且不可恢复（账号与身体数据保留）。再点一次「确认清空」执行。
          </div>
        )}
        {dataMsg && <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>{dataMsg}</div>}
        {dataErr && <div className="notice err" style={{ marginTop: 12, marginBottom: 0 }}>{dataErr}</div>}
      </div>

      {confirmSignOut ? (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmSignOut(false)}>
            取消
          </button>
          <button className="btn btn-ghost" style={{ flex: 1, color: 'var(--red)', borderColor: 'var(--red)' }} onClick={onSignOut}>
            确认退出
          </button>
        </div>
      ) : (
        <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setConfirmSignOut(true)}>
          退出登录
        </button>
      )}

      <div className="section-title" style={{ marginTop: 24 }}>账号管理</div>
      <div className="card">
        <div className="list-line" onClick={() => setConfirmDeleteAcct(true)} role="button" tabIndex={0}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red)' }}>
            <IconTrash size={16} />
            注销账号
          </span>
          <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {confirmDeleteAcct ? (
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn-text" style={{ color: 'var(--red)' }} disabled={deletingAcct} onClick={(e) => { e.stopPropagation(); void doDeleteAccount() }}>
                  {deletingAcct ? '注销中…' : '确认注销'}
                </button>
                <button className="btn-text" style={{ color: 'var(--ink-3)' }} onClick={(e) => { e.stopPropagation(); setConfirmDeleteAcct(false) }}>
                  取消
                </button>
              </span>
            ) : (
              <span className="arrow" style={{ marginLeft: 6 }}>›</span>
            )}
          </span>
        </div>
        {confirmDeleteAcct && (
          <div className="helper" style={{ color: 'var(--red)', marginBottom: 4 }}>
            ⚠️ 将删除你的全部记录与身体档案并退出登录，不可恢复。如需彻底注销账号，请通过「关于 → 联系我们」与客服联系。
          </div>
        )}
      </div>

      <SiteFooter onOpen={onOpenLegal} />

      {inviteOpen && <InviteCenter onClose={() => setInviteOpen(false)} />}

      {editing && (
        <Sheet title="身体数据与目标" onClose={() => setEditing(false)}>
          {err && <div className="notice err">{err}</div>}
          <div className="field">
            <label htmlFor="nick">昵称</label>
            <input
              id="nick"
              value={nickname}
              maxLength={NICKNAME_RULE.max}
              onChange={(e) => {
                setNickname(e.target.value)
                if (fieldErr.nick) setFieldErr((p) => ({ ...p, nick: '' }))
              }}
              placeholder="怎么称呼你"
            />
            {fieldErr.nick && <div className="err">{fieldErr.nick}</div>}
          </div>
          <div className="field">
            <label>目标</label>
            <div className="chips">
              {(Object.keys(GOAL_LABELS) as Array<keyof typeof GOAL_LABELS>).map((g) => (
                <button key={g} className={`chip ${goal === g ? 'active' : ''}`} onClick={() => setGoal(g)}>
                  {GOAL_LABELS[g]}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>性别</label>
            <div className="chips">
              <button className={`chip ${gender === 'female' ? 'active' : ''}`} onClick={() => setGender('female')}>女</button>
              <button className={`chip ${gender === 'male' ? 'active' : ''}`} onClick={() => setGender('male')}>男</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="e-age">年龄</label>
            <input
              id="e-age"
              type="number"
              inputMode="numeric"
              min={AGE_LIMIT.min}
              max={AGE_LIMIT.max}
              value={age}
              onChange={(e) => typeNum(e.target.value, AGE_LIMIT, setAge, 'age')}
              onBlur={(e) => blurNum(e.target.value, AGE_LIMIT, setAge, 'age')}
            />
            {fieldErr.age && <div className="err">{fieldErr.age}</div>}
          </div>
          <div className="field">
            <label htmlFor="e-height">身高（cm）</label>
            <input
              id="e-height"
              type="number"
              inputMode="decimal"
              min={HEIGHT_LIMIT.min}
              max={HEIGHT_LIMIT.max}
              value={height}
              onChange={(e) => typeNum(e.target.value, HEIGHT_LIMIT, setHeight, 'height')}
              onBlur={(e) => blurNum(e.target.value, HEIGHT_LIMIT, setHeight, 'height')}
            />
            {fieldErr.height && <div className="err">{fieldErr.height}</div>}
          </div>
          <div className="field">
            <label htmlFor="e-weight">当前体重（kg）</label>
            <input
              id="e-weight"
              type="number"
              inputMode="decimal"
              min={WEIGHT_LIMIT.min}
              max={WEIGHT_LIMIT.max}
              value={weight}
              onChange={(e) => typeNum(e.target.value, WEIGHT_LIMIT, setWeight, 'weight')}
              onBlur={(e) => blurNum(e.target.value, WEIGHT_LIMIT, setWeight, 'weight')}
            />
            {fieldErr.weight && <div className="err">{fieldErr.weight}</div>}
          </div>
          {goal !== 'keep' && (
            <div className="field">
              <label htmlFor="e-tw">目标体重（kg）</label>
              <input
                id="e-tw"
                type="number"
                inputMode="decimal"
                min={WEIGHT_LIMIT.min}
                max={WEIGHT_LIMIT.max}
                value={targetWeight}
                onChange={(e) => typeNum(e.target.value, WEIGHT_LIMIT, setTargetWeight, 'tw')}
                onBlur={(e) => blurNum(e.target.value, WEIGHT_LIMIT, setTargetWeight, 'tw')}
              />
              {fieldErr.tw && <div className="err">{fieldErr.tw}</div>}
            </div>
          )}
          <div className="field">
            <label>活动水平</label>
            <div className="chips">
              {(Object.keys(ACTIVITY_LABELS) as Array<keyof typeof ACTIVITY_LABELS>).map((a) => (
                <button key={a} className={`chip ${activity === a ? 'active' : ''}`} onClick={() => setActivity(a)}>
                  {ACTIVITY_LABELS[a].split('，')[0]}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="e-step-goal">每日步数目标</label>
            <input
              id="e-step-goal"
              type="number"
              inputMode="numeric"
              min={STEP_GOAL_LIMIT.min}
              max={STEP_GOAL_LIMIT.max}
              value={stepGoal}
              onChange={(e) => typeNum(e.target.value, STEP_GOAL_LIMIT, setStepGoal, 'stepGoal')}
              onBlur={(e) => blurNum(e.target.value, STEP_GOAL_LIMIT, setStepGoal, 'stepGoal')}
            />
            {fieldErr.stepGoal && <div className="err">{fieldErr.stepGoal}</div>}
          </div>
          <div className="helper" style={{ marginBottom: 16 }}>
            保存后会按新数据重新计算每日热量与营养素目标。历史记录不会被改动。
          </div>
          <button className="btn" disabled={saving} onClick={submitBody}>
            {saving ? <span className="spinner" /> : '保存并重新计算'}
          </button>
        </Sheet>
      )}
    </div>
  )
}
