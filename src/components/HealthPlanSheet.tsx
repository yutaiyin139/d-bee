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
  buildHealthPlanView,
} from '../lib/healthPlan'

/**
 * 健康管理方案 Sheet —— 单态渲染（Web / iOS / Android 共用主端组件）。
 *
 * 只读 profile.goal 对应的【一态】，不渲染 segment、不遍历 GOAL_LABELS、
 * 不持有本地目标态。改目标确认写库后，父级 profile 变化会让本组件自动重渲染成新目标态。
 * 复用既有 Sheet / TransparencyNotes / .stat-grid，零新建设计 token、零新建底部 tab。
 * 全部可见文案来自 @dbee/shared 真源；mini 端 HealthPlanSheet 消费同一组常量。
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

  return (
    <Sheet title={isIntro ? HEALTH_PLAN_INTRO_TITLE : HEALTH_PLAN_TITLE} onClose={onClose}>
      {updatedLabel && <div className="notice ok" style={{ marginBottom: 12 }}>{updatedLabel}</div>}

      <div className="card">
        <span style={chipStyle}>{view.goalLabel}</span>
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

        {view.hasProgress ? (
          <div style={{ marginTop: 14 }}>
            <div className="helper" style={{ marginBottom: 6 }}>{view.progressText}</div>
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
          </div>
        ) : (
          <div className="helper" style={{ marginTop: 14 }}>{view.progressText}</div>
        )}
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
