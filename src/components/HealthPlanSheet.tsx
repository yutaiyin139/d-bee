import type { CSSProperties } from 'react'
import { Sheet } from './Sheet'
import { TransparencyNotes } from './TransparencyNotes'
import type { Profile } from '../types'
import { roundTo } from '../lib/numfmt'
import {
  HEALTH_PLAN_TITLE,
  HEALTH_PLAN_INTRO_TITLE,
  HEALTH_PLAN_INTRO_HINT,
  HEALTH_PLAN_NOTES_TITLE,
  HEALTH_PLAN_NOT_READY,
  HEALTH_PLAN_GO_FILL,
  HEALTH_PLAN_LABEL_DAILY,
  HEALTH_PLAN_UNIT_KCAL,
  HEALTH_PLAN_LABEL_PROTEIN,
  HEALTH_PLAN_LABEL_CARB,
  HEALTH_PLAN_LABEL_FAT,
  HEALTH_PLAN_LABEL_WEEKLY,
  HEALTH_PLAN_LABEL_START,
  HEALTH_PLAN_LABEL_CHANGE,
  HEALTH_PLAN_SECTION_BASIC,
  HEALTH_PLAN_SECTION_GOAL,
  HEALTH_PLAN_SECTION_DAILY,
  HEALTH_PLAN_LABEL_HEIGHT,
  HEALTH_PLAN_LABEL_WEIGHT,
  HEALTH_PLAN_LABEL_BMR,
  HEALTH_PLAN_LABEL_BMI,
  HEALTH_PLAN_UNIT_CM,
  HEALTH_PLAN_UNIT_KG,
  HEALTH_PLAN_BMI_PREFIX,
  HEALTH_PLAN_BMI_DISCLAIMER,
  HEALTH_PLAN_LABEL_PROGRESS,
  HEALTH_PLAN_LABEL_START_W,
  HEALTH_PLAN_LABEL_TARGET_W,
  HEALTH_PLAN_BAND_HINT,
  buildHealthPlanView,
} from '../lib/healthPlan'

/**
 * 体重管理方案 Sheet —— 单态渲染（Web / iOS / Android 共用主端组件）。
 *
 * 三段卡片：基本信息 → 体重目标 → 每日方案。只读 profile.goal 对应的【一态】，
 * 不渲染 segment、不遍历 GOAL_LABELS、不持有本地目标态。改目标确认写库后，
 * 父级 profile 变化会让本组件自动重渲染成新目标态（时间行同步回到第 1 天）。
 *
 * 全部可见文案与展示数值来自 @dbee/shared 真源，mini 端组件消费同一组常量与
 * buildHealthPlanViewCore()，因此四端逐字一致。BMI 四段色带只承担氛围，
 * 信息同时由档位文字、指示器位置、BMI 数值与 aria-label 四重非色彩编码承载。
 */
interface HealthPlanSheetProps {
  profile: Profile
  mode: 'intro' | 'normal'
  onClose: () => void
  onChangeGoal?: () => void
  updatedLabel?: string
}

const chipStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 13,
  padding: '5px 12px',
  borderRadius: 99,
  background: 'rgba(242,169,59,0.18)',
  border: '1px solid rgba(242,169,59,0.45)',
  color: 'var(--ink)',
}

const sectionTitleStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 13,
  padding: '5px 12px',
  borderRadius: 99,
  background: 'var(--honey-soft)',
  color: 'var(--honey-dark)',
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
  marginTop: 12,
}

const cellStyle: CSSProperties = {
  background: 'var(--bg-2)',
  borderRadius: 12,
  padding: 10,
}

const smallLabelStyle: CSSProperties = { fontSize: 12, color: 'var(--ink-3)', margin: 0 }
const cellValueStyle: CSSProperties = { fontSize: 18, fontWeight: 500, color: 'var(--ink)' }

const dash = (n: number | null | undefined): string => (n == null ? '—' : String(n))

export function HealthPlanSheet({ profile, mode, onClose, onChangeGoal, updatedLabel }: HealthPlanSheetProps) {
  const view = buildHealthPlanView(profile)
  const isIntro = mode === 'intro'

  if (!view.ready) {
    return (
      <Sheet title={HEALTH_PLAN_TITLE} onClose={onClose}>
        <div className="card">
          <div className="helper" style={{ margin: 0 }}>{HEALTH_PLAN_NOT_READY}</div>
        </div>
        <button className="btn" onClick={onChangeGoal ?? onClose}>{HEALTH_PLAN_GO_FILL}</button>
      </Sheet>
    )
  }

  const { basic, timeline, goals } = view

  return (
    <Sheet title={isIntro ? HEALTH_PLAN_INTRO_TITLE : HEALTH_PLAN_TITLE} onClose={onClose}>
      {updatedLabel && <div className="notice ok" style={{ marginBottom: 12 }}>{updatedLabel}</div>}

      {/* 卡片 1 · 基本信息 */}
      <div className="card">
        <span style={sectionTitleStyle}>{HEALTH_PLAN_SECTION_BASIC}</span>
        <div className="plan-basic-grid" style={gridStyle}>
          <div className="plan-basic-stat" style={cellStyle}>
            <div className="helper" style={smallLabelStyle}>{HEALTH_PLAN_LABEL_HEIGHT}</div>
            <div style={cellValueStyle}>{dash(basic.heightCm)} <span style={{ fontSize: 12, fontWeight: 400 }}>{HEALTH_PLAN_UNIT_CM}</span></div>
          </div>
          <div className="plan-basic-stat" style={cellStyle}>
            <div className="helper" style={smallLabelStyle}>{HEALTH_PLAN_LABEL_WEIGHT}</div>
            <div style={cellValueStyle}>{dash(basic.weightKg)} <span style={{ fontSize: 12, fontWeight: 400 }}>{HEALTH_PLAN_UNIT_KG}</span></div>
          </div>
          <div className="plan-basic-stat" style={cellStyle}>
            <div className="helper" style={smallLabelStyle}>{HEALTH_PLAN_LABEL_BMR}</div>
            <div style={cellValueStyle}>{dash(basic.bmrKcal)} <span style={{ fontSize: 12, fontWeight: 400 }}>{HEALTH_PLAN_UNIT_KCAL}</span></div>
          </div>
          <div className="plan-basic-stat" style={cellStyle}>
            <div className="helper" style={smallLabelStyle}>{HEALTH_PLAN_LABEL_BMI}</div>
            <div style={cellValueStyle}>{dash(basic.bmi)}</div>
          </div>
        </div>

        {basic.bmi != null ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 13 }}>{HEALTH_PLAN_BMI_PREFIX}{basic.bmi}</span>
              {basic.band && (
                <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 99, background: basic.band.color, color: 'var(--ink)' }}>
                  {basic.band.label}
                </span>
              )}
            </div>
            <div role="img" aria-label={basic.ariaLabel} style={{ position: 'relative', marginBottom: 6 }}>
              <div style={{ display: 'flex', height: 8, borderRadius: 99, overflow: 'hidden' }}>
                {basic.bands.map((b) => <div key={b.key} style={{ flex: 1, background: b.color }} />)}
              </div>
              {basic.bandPositionPct != null && (
                <div style={{
                  position: 'absolute', left: `${basic.bandPositionPct}%`, top: -7, width: 0, height: 0,
                  borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                  borderTop: '7px solid var(--honey-dark)',
                }} />
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
              {basic.bands.map((b) => <span key={b.key}>{b.label}</span>)}
            </div>
            <div className="helper" style={{ fontSize: 12, margin: 0 }}>{HEALTH_PLAN_BMI_DISCLAIMER}</div>
          </div>
        ) : null}
      </div>

      {/* 卡片 2 · 体重目标 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={sectionTitleStyle}>{HEALTH_PLAN_SECTION_GOAL}</span>
          <span style={chipStyle}>{view.goalLabel}</span>
        </div>

        {view.hasProgress ? (
          <div>
            <div className="helper" style={{ marginBottom: 6 }}>{view.progressPct}% · {HEALTH_PLAN_LABEL_PROGRESS}</div>
            <div
              role="progressbar"
              aria-valuenow={view.progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={view.progressText}
              style={{ height: 8, borderRadius: 99, background: 'var(--bg-2)', overflow: 'hidden' }}
            >
              <div style={{ width: `${view.progressPct}%`, height: '100%', background: 'var(--honey)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-2)', marginTop: 6 }}>
              <span>{HEALTH_PLAN_LABEL_START_W} {dash(goals.startWeight)} kg</span>
              <span>{HEALTH_PLAN_LABEL_TARGET_W} {dash(goals.targetWeight)} kg</span>
            </div>
          </div>
        ) : (
          <div className="helper" style={{ marginBottom: 8 }}>{HEALTH_PLAN_BAND_HINT}</div>
        )}

        <div className="plan-timeline" style={{ background: 'var(--honey-soft)', borderRadius: 12, padding: '10px 12px', marginTop: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>
            {timeline.dayLabel ? (
              <span style={{ display: 'inline-block', background: 'var(--surface)', color: 'var(--honey-dark)', padding: '2px 8px', borderRadius: 99, marginRight: 6, fontSize: 13 }}>
                {timeline.dayLabel}
              </span>
            ) : null}
            <span>{timeline.timelineText}</span>
          </div>
          <div className="helper" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>{timeline.timeNote}</div>
        </div>

        <div className="plan-dual" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
          <div style={{ background: 'var(--honey-soft)', borderRadius: 12, padding: 10 }}>
            <div className="helper" style={{ fontSize: 12, color: 'var(--honey-dark)', margin: 0 }}>{goals.expectLabel}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--honey-dark)' }}>{goals.expectValue}</div>
          </div>
          <div style={{ background: 'var(--green-soft)', borderRadius: 12, padding: 10 }}>
            <div className="helper" style={{ fontSize: 12, color: 'var(--ok-ink)', margin: 0 }}>{goals.remainLabel}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--ok-ink)' }}>{goals.remainValue}</div>
          </div>
        </div>
      </div>

      {/* 卡片 3 · 每日方案 */}
      <div className="card">
        <span style={sectionTitleStyle}>{HEALTH_PLAN_SECTION_DAILY}</span>
        <div className="helper" style={{ margin: '12px 0 2px' }}>{HEALTH_PLAN_LABEL_DAILY}</div>
        <div style={{ fontSize: 28, fontWeight: 500, color: 'var(--ink)' }}>
          {roundTo(view.calories, 0)}<span style={{ fontSize: 14, fontWeight: 400 }}> {HEALTH_PLAN_UNIT_KCAL}</span>
        </div>

        <div className="stat-grid" style={{ marginTop: 14 }}>
          <div className="stat">
            <div className="helper" style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_PROTEIN}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>{roundTo(view.protein, 0)} g</div>
          </div>
          <div className="stat">
            <div className="helper" style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_CARB}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>{roundTo(view.carb, 0)} g</div>
          </div>
          <div className="stat">
            <div className="helper" style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_FAT}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>{roundTo(view.fat, 0)} g</div>
          </div>
          <div className="stat">
            <div className="helper" style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_WEEKLY}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>{view.weeklyLabel}</div>
          </div>
        </div>
      </div>

      <TransparencyNotes title={HEALTH_PLAN_NOTES_TITLE} notes={view.notes} />

      {isIntro ? (
        <>
          <div className="helper" style={{ margin: '14px 0 12px' }}>{HEALTH_PLAN_INTRO_HINT}</div>
          <button className="btn" onClick={onClose}>{HEALTH_PLAN_LABEL_START}</button>
        </>
      ) : (
        <button className="btn" style={{ marginTop: 14 }} onClick={onChangeGoal}>{HEALTH_PLAN_LABEL_CHANGE}</button>
      )}
    </Sheet>
  )
}
