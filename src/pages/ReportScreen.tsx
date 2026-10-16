import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarHeatmap } from '../components/Calendar'
import { BarChart, LineChart, RatioBar } from '../components/Charts'
import { IconLock, IconPlus, IconWeight } from '../components/Icons'
import { generateReportInsight } from '../lib/ai'
import { listMealsBetween, listWeightLogsAsc, saveWeight } from '../lib/api'
import { FREE_REPORT_DAYS } from '../lib/entitlement'
import { shiftDate, todayKey } from '../lib/nutrition'
import {
  computeReport,
  forecastGoal,
  kcalByDate,
  monthCompareFromMeals,
  weightTrendTone,
  type Forecast,
  type MonthCompare,
  type ReportData,
} from '../lib/report'
import { usePlan } from '../state/plan'
import { WEIGHT_LIMIT, checkNumber, clampNumeric, rangeText, sanitizeNumeric } from '../lib/validate'
import type { MealEntry, Profile, WeightLog } from '../types'
import { errText } from '../lib/errmsg'

interface ReportScreenProps {
  profile: Profile
}

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
]

const STREAK_WINDOW_DAYS = 185

/** 把 YYYY-MM-DD 压成 M/D，图表轴上够用 */
function shortDate(key: string) {
  const [, m, d] = key.split('-').map(Number)
  return `${m}/${d}`
}

function fmtForecastDate(key: string) {
  const [y, m, d] = key.split('-').map(Number)
  return `${y} 年 ${m} 月 ${d} 日`
}

function ForecastCard({ forecast, targetWeight }: { forecast: Forecast; targetWeight: number | null }) {
  if (forecast.state === 'insufficient') {
    return (
      <div className="card">
        <div className="empty-state" style={{ padding: '18px 10px' }}>
          体重记录还太少（至少 3 次、跨 5 天），暂时算不出趋势。
          <br />
          每天称一称，记录越多预测越准。
        </div>
      </div>
    )
  }
  if (forecast.state === 'wrong_direction') {
    return (
      <div className="card">
        <div className="forecast-line warn">
          按目前的体重趋势，方向和目标相反（每周约 {forecast.slopePerWeek! > 0 ? '+' : ''}
          {forecast.slopePerWeek} kg）。先回到热量缺口，再来看预测。
        </div>
      </div>
    )
  }
  if (forecast.state === 'reached') {
    return (
      <div className="card">
        <div className="forecast-line good">已经到达目标体重附近，接下来把保持当成新目标就好。</div>
      </div>
    )
  }
  return (
    <div className="card">
      <div className="forecast-line">
        按当前节奏（每周 {forecast.slopePerWeek! > 0 ? '+' : ''}
        {forecast.slopePerWeek} kg），预计 <b>{forecast.weeks}</b> 周、
        约在 <b>{fmtForecastDate(forecast.date!)}</b> 达到目标体重 {targetWeight} kg。
      </div>
      <div className="helper" style={{ marginTop: 8 }}>
        基于现有记录的线性推算，体重波动很正常，仅供参考，不是承诺。
      </div>
    </div>
  )
}

export function ReportScreen({ profile }: ReportScreenProps) {
  const { pro, openPaywall } = usePlan()
  const [days, setDays] = useState(7)
  const [recentMeals, setRecentMeals] = useState<MealEntry[]>([])
  const [weights, setWeights] = useState<WeightLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [insight, setInsight] = useState<{ summary: string; points: string[] } | null>(null)
  const [insightBusy, setInsightBusy] = useState(false)
  const [insightError, setInsightError] = useState('')

  const [weightDraft, setWeightDraft] = useState('')
  const [savingWeight, setSavingWeight] = useState(false)

  const today = todayKey()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [m, w] = await Promise.all([
        listMealsBetween(shiftDate(today, -STREAK_WINDOW_DAYS), today),
        listWeightLogsAsc(365),
      ])
      setRecentMeals(m)
      setWeights(w)
    } catch (e) {
      setError(errText(e, '加载报告失败'))
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => {
    void load()
  }, [load])

  // 切换区间后旧的解读不再对应新数据，直接清掉避免误导
  useEffect(() => {
    setInsight(null)
    setInsightError('')
  }, [days])

  const report: ReportData = useMemo(
    () => computeReport(recentMeals, weights, profile, days),
    [recentMeals, weights, profile, days],
  )

  // 日历与月对比用同一份近窗数据
  const kcalMap = useMemo(() => kcalByDate(recentMeals), [recentMeals])
  const monthCmp: MonthCompare = useMemo(() => monthCompareFromMeals(recentMeals, today), [recentMeals, today])

  const tone = weightTrendTone(report.weightChange, profile.goal ?? 'keep')
  const todayWeight = weights.find((w) => w.log_date === today)?.weight_kg

  const bars = useMemo(
    () =>
      report.daily.map((d) => ({
        label: shortDate(d.date),
        value: Math.round(d.kcal),
        tone: d.kcal > report.targetKcal * 1.1 ? ('over' as const) : ('normal' as const),
      })),
    [report.daily, report.targetKcal],
  )

  const weightPoints = useMemo(
    () => report.weightSeries.map((w) => ({ label: shortDate(w.date), value: w.weight })),
    [report.weightSeries],
  )

  const forecast = useMemo(
    () => forecastGoal(report.weightSeries, profile.goal ?? 'keep', profile.target_weight_kg ?? null),
    [report.weightSeries, profile.goal, profile.target_weight_kg],
  )

  const mealTotal = report.mealSplit.reduce((s, m) => s + m.kcal, 0)

  function pickRange(next: number) {
    if (!pro && next > FREE_REPORT_DAYS) {
      openPaywall(`免费版可以看近 ${FREE_REPORT_DAYS} 天的报告，30 天趋势与导出是 Pro 功能。`)
      return
    }
    setDays(next)
  }

  async function handleSaveWeight() {
    const chk = checkNumber(weightDraft, WEIGHT_LIMIT)
    if (!chk.ok || chk.value == null) {
      setError(chk.error || `请输入 ${rangeText(WEIGHT_LIMIT)} 之间的体重`)
      return
    }
    const v = chk.value
    setSavingWeight(true)
    setError('')
    try {
      await saveWeight(today, v)
      setWeightDraft('')
      await load()
    } catch (e) {
      setError(errText(e, '保存体重失败'))
    } finally {
      setSavingWeight(false)
    }
  }

  async function handleInsight() {
    // 长文本 AI 复盘（本期解读）为会员专属：免费用户弹付费墙，Pro/终身可无限次生成
    if (!pro) {
      openPaywall('「本期解读」是 AI 长文本复盘，属于 Pro 会员专属功能。升级后可无限次生成，并获得周复盘、长期膳食规划与宏量营养素深度分析。')
      return
    }
    setInsightBusy(true)
    setInsightError('')
    try {
      const res = await generateReportInsight({
        days: report.days,
        loggedDays: report.loggedDays,
        avgKcal: report.avgKcal,
        targetKcal: report.targetKcal,
        onTargetDays: report.onTargetDays,
        overDays: report.overDays,
        avgProtein: report.avgProtein,
        proteinTarget: report.proteinTarget,
        proteinRatio: report.proteinRatio,
        carbRatio: report.carbRatio,
        fatRatio: report.fatRatio,
        mealSplit: report.mealSplit,
        topFoods: report.topFoods,
        weightChange: report.weightChange,
        goal: profile.goal ?? 'keep',
      })
      setInsight(res)
    } catch (e) {
      setInsightError(errText(e, '生成解读失败，请重试'))
    } finally {
      setInsightBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-top" />
      <div className="hero">
        <h1>饮食报告</h1>
        <p>
          {shortDate(report.rangeStart)} – {shortDate(report.rangeEnd)} · 共 {report.loggedDays} 天有记录
        </p>
      </div>

      <div className="segment">
        {RANGES.map((r) => (
          <button key={r.days} className={days === r.days ? 'active' : ''} onClick={() => pickRange(r.days)}>
            {r.label}
            {!pro && r.days > FREE_REPORT_DAYS && <IconLock color="currentColor" size={11} />}
          </button>
        ))}
      </div>

      {error && <div className="notice err">{error}</div>}

      {loading ? (
        <>
          <div className="skeleton" style={{ height: 180, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 120 }} />
        </>
      ) : report.loggedDays === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '28px 12px' }}>
            这段时间还没有记录。
            <br />
            去「今日」记上几餐，报告就有内容了。
          </div>
        </div>
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            <div className="stat">
              <div className="l">日均摄入</div>
              <div className="v">
                {report.avgKcal}
                <small>kcal</small>
              </div>
              <div className="stat-sub">预算 {report.targetKcal} kcal</div>
            </div>
            <div className="stat">
              <div className="l">达标 / 超标</div>
              <div className="v">
                {report.onTargetDays}
                <small>天</small>
                <span className="stat-sep">/</span>
                {report.overDays}
                <small>天</small>
              </div>
              <div className="stat-sub">共记录 {report.loggedDays} 天</div>
            </div>
          </div>

          {/* 打卡日历 */}
          <div className="section-title">
            打卡日历
            <span className="hint">按当日摄入相对预算着色</span>
          </div>
          <div className="card">
            <CalendarHeatmap kcalMap={kcalMap} targetKcal={report.targetKcal} />
          </div>

          {/* 本月 vs 上月 */}
          {monthCmp.thisMonthAvg != null && monthCmp.deltaPct != null && (
            <div className="month-cmp">
              {monthCmp.deltaPct === 0
                ? '本月日均摄入与上月持平。'
                : monthCmp.deltaPct > 0
                  ? `本月日均 ${monthCmp.thisMonthAvg} kcal，比上月多 ${monthCmp.deltaPct}%。`
                  : `本月日均 ${monthCmp.thisMonthAvg} kcal，比上月少 ${Math.abs(monthCmp.deltaPct)}%。`}
            </div>
          )}

          <div className="section-title">
            每日热量
            <span className="hint">虚线为每日预算</span>
          </div>
          <div className="card">
            <BarChart bars={bars} target={report.targetKcal} />
          </div>

          <div className="section-title">营养素供能比</div>
          <div className="card">
            <RatioBar
              segments={[
                { label: '蛋白质', value: report.proteinRatio, color: 'var(--honey)' },
                { label: '碳水', value: report.carbRatio, color: 'var(--blue)' },
                { label: '脂肪', value: report.fatRatio, color: 'var(--green)' },
              ]}
            />
            <div className="helper" style={{ marginTop: 12 }}>
              日均 蛋 {report.avgProtein} g（目标 {report.proteinTarget} g）· 碳 {report.avgCarb} g · 脂 {report.avgFat} g
            </div>
          </div>

          <div className="section-title">
            体重曲线
            {report.weightChange !== null && (
              <span className={`hint trend-${tone}`}>
                {report.weightChange > 0 ? '+' : ''}
                {report.weightChange} kg
              </span>
            )}
          </div>
          <div className="card">
            <LineChart
              points={weightPoints}
              target={profile.target_weight_kg ?? null}
              unit="kg"
              color="var(--honey)"
              emptyText="这段时间还没记录体重"
            />
            <div className="weight-row">
              <div className="weight-input">
                <IconWeight />
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min={WEIGHT_LIMIT.min}
                  max={WEIGHT_LIMIT.max}
                  placeholder={todayWeight ? String(todayWeight) : '今日体重'}
                  value={weightDraft}
                  onChange={(e) => setWeightDraft(sanitizeNumeric(e.target.value, { decimals: WEIGHT_LIMIT.decimals }))}
                  onBlur={(e) => setWeightDraft(clampNumeric(e.target.value, WEIGHT_LIMIT))}
                />
                <span className="unit">kg</span>
              </div>
              <button className="btn btn-ghost" disabled={savingWeight || !weightDraft} onClick={handleSaveWeight}>
                {savingWeight ? <span className="spinner" /> : '记录'}
              </button>
            </div>
            {profile.target_weight_kg != null && (
              <div className="helper" style={{ marginTop: 10 }}>
                目标体重 {profile.target_weight_kg} kg
                {profile.current_weight_kg != null && <> · 当前 {profile.current_weight_kg} kg</>}
              </div>
            )}
          </div>

          {profile.goal !== 'keep' && profile.target_weight_kg != null && (
            <>
              <div className="section-title">进度预测</div>
              <ForecastCard forecast={forecast} targetWeight={profile.target_weight_kg} />
            </>
          )}

          {report.topFoods.length > 0 && (
            <>
              <div className="section-title">
                常吃的食物
                <span className="hint">Top {report.topFoods.length}</span>
              </div>
              <div className="card card-tight">
                {report.topFoods.map((f) => (
                  <div className="food-row" key={f.name}>
                    <div style={{ minWidth: 0 }}>
                      <div className="nm">{f.name}</div>
                      <div className="sub">平均单次 {f.kcal} kcal</div>
                    </div>
                    <span className="food-count">{f.count} 次</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="section-title">
            本期解读
            <span className="hint">由 AI 根据上面的数据生成</span>
          </div>
          <div className="card">
            {insight ? (
              <>
                {insight.summary && <div className="insight-summary">{insight.summary}</div>}
                {insight.points.map((p, i) => (
                  <div className="insight-point" key={i}>
                    <span className="idx">{i + 1}</span>
                    <span>{p}</span>
                  </div>
                ))}
                <button className="btn-text" style={{ marginTop: 12 }} onClick={handleInsight} disabled={insightBusy}>
                  {insightBusy ? '重新生成中…' : '重新生成'}
                </button>
              </>
            ) : (
              <>
                <div className="helper" style={{ marginBottom: 12 }}>
                  会把你这段时间的统计结果交给模型，给出一段针对性点评。每次生成都会消耗一次模型额度。
                </div>
                {insightError && <div className="notice err">{insightError}</div>}
                <button className="btn" disabled={insightBusy} onClick={handleInsight}>
                  {insightBusy ? <span className="spinner" /> : <><IconPlus color="#4a3208" />生成解读</>}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
