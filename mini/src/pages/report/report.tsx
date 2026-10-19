/**
 * 饮食报告页（对齐主工程 src/pages/ReportScreen.tsx）。
 *
 * 差异点（小程序端能力诚实降级）：
 *  - 图表：主工程用内联 SVG，小程序端经 Charts.tsx 序列化为 data URI 的 Image
 *  - 日历热力：用 View 网格实现（无需 SVG）
 *  - 会员门控：小程序端暂无支付，区间切换不做 Pro 门控（免费用户可看近 7 天，30 天给提示）
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { BarChart, LineChart, RatioBar, C_HONEY, C_BLUE, C_GREEN } from '../../components/Charts'
import { IconLock, IconWeight } from '../../components/Icons'
import { generateReportInsight } from '../../lib/ai'
import { getProfile, listMealsBetween, listWeightLogsAsc, saveWeight, type MealEntry, type Profile, type WeightLog } from '../../lib/api'
import { shiftDate, todayKey, monthGrid } from '../../lib/nutrition'
import {
  computeReport, forecastGoal, kcalByDate, monthCompareFromMeals, weightTrendTone,
  dayTone, type DayTone, type Forecast, type MonthCompare, type ReportData,
} from '../../lib/report'
import { WEIGHT_LIMIT, checkNumber, clampNumeric, rangeText, sanitizeNumeric } from '../../lib/validate'
import { FREE_REPORT_DAYS, PRO_REPORT_DAYS } from '@dbee/shared'
import './report.scss'

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
]

const STREAK_WINDOW_DAYS = 185

const WEEKS = ['一', '二', '三', '四', '五', '六', '日']

const TONE_BG: Record<DayTone, string> = {
  empty: '#f4efe4',
  under: '#fbe6c2',
  on: '#f2a93b',
  over: '#d05c4e',
}

function shortDate(key: string) {
  const [, m, d] = key.split('-').map(Number)
  return `${m}/${d}`
}

function fmtForecastDate(key: string) {
  const [y, m, d] = key.split('-').map(Number)
  return `${y} 年 ${m} 月 ${d} 日`
}

export default function ReportPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
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

  const [calCursor, setCalCursor] = useState(() => {
    const n = new Date()
    return { y: n.getFullYear(), m: n.getMonth() }
  })

  const today = todayKey()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [m, w, p] = await Promise.all([
        listMealsBetween(shiftDate(today, -STREAK_WINDOW_DAYS), today),
        listWeightLogsAsc(365),
        getProfile(),
      ])
      setRecentMeals(m)
      setWeights(w)
      if (p) setProfile(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载报告失败')
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setInsight(null)
    setInsightError('')
  }, [days])

  const report: ReportData = useMemo(
    () => computeReport(recentMeals, weights, profile, days),
    [recentMeals, weights, profile, days],
  )

  const kcalMap = useMemo(() => kcalByDate(recentMeals), [recentMeals])
  const monthCmp: MonthCompare = useMemo(() => monthCompareFromMeals(recentMeals, today), [recentMeals, today])

  const tone = weightTrendTone(report.weightChange, profile?.goal ?? 'keep')
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
    () => forecastGoal(report.weightSeries, profile?.goal ?? 'keep', profile?.target_weight_kg ?? null),
    [report.weightSeries, profile?.goal, profile?.target_weight_kg],
  )

  const calCells = useMemo(() => monthGrid(calCursor.y, calCursor.m), [calCursor])

  function pickRange(next: number) {
    if (next > FREE_REPORT_DAYS) {
      Taro.showToast({ title: `免费版可看近 ${FREE_REPORT_DAYS} 天，${PRO_REPORT_DAYS} 天是 Pro 功能`, icon: 'none' })
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
      setError(e instanceof Error ? e.message : '保存体重失败')
    } finally {
      setSavingWeight(false)
    }
  }

  async function handleInsight() {
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
        goal: profile?.goal ?? 'keep',
      })
      setInsight(res)
    } catch (e) {
      setInsightError(e instanceof Error ? e.message : '生成解读失败，请重试')
    } finally {
      setInsightBusy(false)
    }
  }

  function shiftCalMonth(delta: number) {
    setCalCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  return (
    <View className='page report'>
      <View className='hero'>
        <Text className='hero-title'>饮食报告</Text>
        <Text className='hero-sub'>
          {shortDate(report.rangeStart)} – {shortDate(report.rangeEnd)} · 共 {report.loggedDays} 天有记录
        </Text>
      </View>

      {/* 区间切换 */}
      <View className='segment'>
        {RANGES.map((r) => (
          <Button
            key={r.days}
            className={`seg-btn ${days === r.days ? 'active' : ''}`}
            onClick={() => pickRange(r.days)}
          >
            {r.label}
            {r.days > FREE_REPORT_DAYS ? <IconLock color='#a39c90' size={11} /> : null}
          </Button>
        ))}
      </View>

      {error ? <View className='notice err'><Text>{error}</Text></View> : null}

      {loading ? (
        <>
          <View className='skeleton' style={{ height: 180 }} />
          <View className='skeleton' style={{ height: 120 }} />
        </>
      ) : report.loggedDays === 0 ? (
        <View className='card'>
          <View className='empty-state'>
            <Text>这段时间还没有记录。</Text>
            <Text>去「今日」记上几餐，报告就有内容了。</Text>
          </View>
        </View>
      ) : (
        <>
          {/* 统计卡 */}
          <View className='stat-grid'>
            <View className='stat'>
              <Text className='stat-l'>日均摄入</Text>
              <Text className='stat-v'>{report.avgKcal}<Text className='stat-unit'>kcal</Text></Text>
              <Text className='stat-sub'>预算 {report.targetKcal} kcal</Text>
            </View>
            <View className='stat'>
              <Text className='stat-l'>达标 / 超标</Text>
              <Text className='stat-v'>
                {report.onTargetDays}<Text className='stat-unit'>天</Text>
                <Text className='stat-sep'>/</Text>
                {report.overDays}<Text className='stat-unit'>天</Text>
              </Text>
              <Text className='stat-sub'>共记录 {report.loggedDays} 天</Text>
            </View>
          </View>

          {/* 打卡日历 */}
          <View className='section-title'>
            <Text>打卡日历</Text>
            <Text className='hint'>按当日摄入相对预算着色</Text>
          </View>
          <View className='card'>
            <View className='cal-head'>
              <Button className='cal-nav' onClick={() => shiftCalMonth(-1)}>‹</Button>
              <Text className='cal-title'>{calCursor.y} 年 {calCursor.m + 1} 月</Text>
              <Button className='cal-nav' onClick={() => shiftCalMonth(1)}>›</Button>
            </View>
            <View className='cal-grid'>
              {WEEKS.map((w) => <Text key={w} className='cal-week'>{w}</Text>)}
              {calCells.map((date, i) => {
                if (date === null) return <View key={`e${i}`} className='cal-empty-cell' />
                const kcal = kcalMap.get(date)
                const logged = kcal !== undefined
                const t = dayTone(kcal ?? 0, logged, report.targetKcal)
                const isToday = date === today
                return (
                  <View
                    key={date}
                    className={`cal-day ${isToday ? 'cal-today' : ''}`}
                    style={{ background: TONE_BG[t] }}
                  >
                    <Text className='cal-day-num' style={{ color: t === 'empty' ? '#a39c90' : t === 'over' ? '#fff' : '#2a2723' }}>
                      {Number(date.slice(-2))}
                    </Text>
                  </View>
                )
              })}
            </View>
            <View className='cal-legend'>
              <View className='lg-item'><View className='lg-dot' style={{ background: TONE_BG.on }} /><Text>达标</Text></View>
              <View className='lg-item'><View className='lg-dot' style={{ background: TONE_BG.under }} /><Text>偏少</Text></View>
              <View className='lg-item'><View className='lg-dot' style={{ background: TONE_BG.over }} /><Text>超标</Text></View>
              <View className='lg-item'><View className='lg-dot' style={{ background: TONE_BG.empty }} /><Text>未记录</Text></View>
            </View>
          </View>

          {/* 本月 vs 上月 */}
          {monthCmp.thisMonthAvg != null && monthCmp.deltaPct != null ? (
            <View className='month-cmp'>
              <Text>
                {monthCmp.deltaPct === 0
                  ? '本月日均摄入与上月持平。'
                  : monthCmp.deltaPct > 0
                    ? `本月日均 ${monthCmp.thisMonthAvg} kcal，比上月多 ${monthCmp.deltaPct}%。`
                    : `本月日均 ${monthCmp.thisMonthAvg} kcal，比上月少 ${Math.abs(monthCmp.deltaPct)}%。`}
              </Text>
            </View>
          ) : null}

          {/* 每日热量 */}
          <View className='section-title'>
            <Text>每日热量</Text>
            <Text className='hint'>虚线为每日预算</Text>
          </View>
          <View className='card'>
            <BarChart bars={bars} target={report.targetKcal} />
          </View>

          {/* 营养素供能比 */}
          <View className='section-title'><Text>营养素供能比</Text></View>
          <View className='card'>
            <RatioBar
              segments={[
                { label: '蛋白质', value: report.proteinRatio, color: C_HONEY },
                { label: '碳水', value: report.carbRatio, color: C_BLUE },
                { label: '脂肪', value: report.fatRatio, color: C_GREEN },
              ]}
            />
            <Text className='helper'>
              日均 蛋 {report.avgProtein} g（目标 {report.proteinTarget} g）· 碳 {report.avgCarb} g · 脂 {report.avgFat} g
            </Text>
          </View>

          {/* 体重曲线 */}
          <View className='section-title'>
            <Text>体重曲线</Text>
            {report.weightChange !== null ? (
              <Text className={`hint trend-${tone}`}>
                {report.weightChange > 0 ? '+' : ''}{report.weightChange} kg
              </Text>
            ) : null}
          </View>
          <View className='card'>
            <LineChart
              points={weightPoints}
              target={profile?.target_weight_kg ?? null}
              unit='kg'
              color={C_HONEY}
              emptyText='这段时间还没记录体重'
            />
            <View className='weight-row'>
              <View className='weight-input-wrap'>
                <IconWeight color='#6b655c' size={18} />
                <Input
                  type='digit'
                  value={weightDraft}
                  onInput={(e) => setWeightDraft(sanitizeNumeric(e.detail.value, { decimals: WEIGHT_LIMIT.decimals }))}
                  onBlur={(e) => setWeightDraft(clampNumeric(e.detail.value, WEIGHT_LIMIT))}
                  className='weight-input'
                  placeholder={todayWeight ? String(todayWeight) : '今日体重'}
                />
                <Text className='unit'>kg</Text>
              </View>
              <Button className='btn btn-ghost' disabled={savingWeight || !weightDraft} onClick={() => void handleSaveWeight()}>
                {savingWeight ? '记录中…' : '记录'}
              </Button>
            </View>
            {profile?.target_weight_kg != null ? (
              <Text className='helper'>
                目标体重 {profile.target_weight_kg} kg
                {profile.current_weight_kg != null ? ` · 当前 ${profile.current_weight_kg} kg` : ''}
              </Text>
            ) : null}
          </View>

          {/* 进度预测 */}
          {profile?.goal !== 'keep' && profile?.target_weight_kg != null ? (
            <>
              <View className='section-title'><Text>进度预测</Text></View>
              <ForecastCard forecast={forecast} targetWeight={profile.target_weight_kg} />
            </>
          ) : null}

          {/* 常吃的食物 */}
          {report.topFoods.length > 0 ? (
            <>
              <View className='section-title'>
                <Text>常吃的食物</Text>
                <Text className='hint'>Top {report.topFoods.length}</Text>
              </View>
              <View className='card'>
                {report.topFoods.map((f) => (
                  <View className='food-row' key={f.name}>
                    <View className='food-main'>
                      <Text className='food-name'>{f.name}</Text>
                      <Text className='food-sub'>平均单次 {f.kcal} kcal</Text>
                    </View>
                    <Text className='food-count'>{f.count} 次</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {/* 本期解读 */}
          <View className='section-title'>
            <Text>本期解读</Text>
            <Text className='hint'>由 AI 根据上面的数据生成</Text>
          </View>
          <View className='card'>
            {insight ? (
              <>
                {insight.summary ? <Text className='insight-summary'>{insight.summary}</Text> : null}
                {insight.points.map((p, i) => (
                  <View className='insight-point' key={i}>
                    <Text className='idx'>{i + 1}</Text>
                    <Text className='point-text'>{p}</Text>
                  </View>
                ))}
                <Button className='btn-text' onClick={() => void handleInsight()} disabled={insightBusy}>
                  {insightBusy ? '重新生成中…' : '重新生成'}
                </Button>
              </>
            ) : (
              <>
                <Text className='helper'>
                  会把你这段时间的统计结果交给模型，给出一段针对性点评。每次生成都会消耗一次模型额度。
                </Text>
                {insightError ? <View className='notice err'><Text>{insightError}</Text></View> : null}
                <Button className='btn' disabled={insightBusy} onClick={() => void handleInsight()}>
                  {insightBusy ? '生成中…' : '生成解读'}
                </Button>
              </>
            )}
          </View>
        </>
      )}

      <View className='bottom-space' />
    </View>
  )
}

function ForecastCard({ forecast, targetWeight }: { forecast: Forecast; targetWeight: number | null }) {
  if (forecast.state === 'insufficient') {
    return (
      <View className='card'>
        <View className='empty-state'>
          <Text>体重记录还太少（至少 3 次、跨 5 天），暂时算不出趋势。</Text>
          <Text>每天称一称，记录越多预测越准。</Text>
        </View>
      </View>
    )
  }
  if (forecast.state === 'wrong_direction') {
    return (
      <View className='card'>
        <Text className='forecast-line warn'>
          按目前的体重趋势，方向和目标相反（每周约 {forecast.slopePerWeek! > 0 ? '+' : ''}
          {forecast.slopePerWeek} kg）。先回到热量缺口，再来看预测。
        </Text>
      </View>
    )
  }
  if (forecast.state === 'reached') {
    return (
      <View className='card'>
        <Text className='forecast-line good'>已经到达目标体重附近，接下来把保持当成新目标就好。</Text>
      </View>
    )
  }
  return (
    <View className='card'>
      <Text className='forecast-line'>
        按当前节奏（每周 {forecast.slopePerWeek! > 0 ? '+' : ''}
        {forecast.slopePerWeek} kg），预计 <Text className='strong'>{forecast.weeks}</Text> 周、
        约在 <Text className='strong'>{fmtForecastDate(forecast.date!)}</Text> 达到目标体重 {targetWeight} kg。
      </Text>
      <Text className='helper'>
        基于现有记录的线性推算，体重波动很正常，仅供参考，不是承诺。
      </Text>
    </View>
  )
}
