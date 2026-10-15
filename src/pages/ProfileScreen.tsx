import { useEffect, useMemo, useState } from 'react'
import { Sheet } from '../components/Sheet'
import { SiteFooter } from '../components/SiteFooter'
import { LineChart } from '../components/Charts'
import type { DocId } from '../content/legal'
import { IconCrown, IconDownload, IconTrash } from '../components/Icons'
import {
  clearAllRecords,
  exportAllData,
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
import { exportJSON } from '../lib/share'
import type { Profile, WeightLog } from '../types'

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
  const [activity, setActivity] = useState<keyof typeof ACTIVITY_LABELS>(
    (profile.activity_level as keyof typeof ACTIVITY_LABELS) ?? 'light',
  )
  const [goal, setGoal] = useState<'lose' | 'keep' | 'gain'>(profile.goal ?? 'lose')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

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

  async function submitBody() {
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
      })
      onProfileChanged(saved)
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function submitWeight() {
    const w = Number(weightInput)
    if (!Number.isFinite(w) || w < 20 || w > 300) {
      setWeightErr('请输入 20–300 之间的体重')
      return
    }
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
      // 导出通道由 lib/share 决定：Web 走浏览器下载，原生走 Filesystem + 分享面板
      const res = await exportJSON(bundle, `d-bee-export-${todayKey()}.json`, {
        title: 'D-Bee 数据导出',
        text: '这是你在 D-Bee 里记录的全部数据。',
      })
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
            value={weightInput}
            onChange={(e) => {
              setWeightInput(e.target.value)
              setWeightErr('')
            }}
            style={{
              flex: 1,
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

      <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={onSignOut}>
        退出登录
      </button>

      <SiteFooter onOpen={onOpenLegal} />

      {editing && (
        <Sheet title="身体数据与目标" onClose={() => setEditing(false)}>
          {err && <div className="notice err">{err}</div>}
          <div className="field">
            <label htmlFor="nick">昵称</label>
            <input id="nick" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="怎么称呼你" />
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
            <input id="e-age" type="number" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="e-height">身高（cm）</label>
            <input id="e-height" type="number" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="e-weight">当前体重（kg）</label>
            <input id="e-weight" type="number" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
          {goal !== 'keep' && (
            <div className="field">
              <label htmlFor="e-tw">目标体重（kg）</label>
              <input id="e-tw" type="number" inputMode="decimal" value={targetWeight} onChange={(e) => setTargetWeight(e.target.value)} />
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
