import type { CSSProperties } from 'react'
import { View, Text } from '@tarojs/components'
import { roundTo } from '@dbee/shared'
import { TransparencyNotes } from './TransparencyNotes'
import type { Profile } from '../lib/api'
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
import './HealthPlanSheet.scss'

/**
 * 体重管理方案 Sheet（mini 端）—— 单态渲染。
 *
 * 与主端 src/components/HealthPlanSheet.tsx 一一对应：三段卡片、单枚目标徽标、
 * 2×2 统计网格、红黄绿 BMI 参考带、第 N 天/达成日、进度条、TransparencyNotes。
 * 只读 profile.goal 的【唯一一态】，不渲染 segment、不遍历 GOAL_LABELS、
 * 不持有本地目标态；改目标确认写库后由父级 profile 变化自动重渲染成新目标态。
 *
 * 全部可见文案来自 @dbee/shared 真源；尺寸/字重走行内样式且数值与主端逐字一致，
 * 颜色走 HealthPlanSheet.scss 的 token（scss 内 2× 换算），两端真机视觉一致。
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
}

const sectionTitleStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 13,
  padding: '5px 12px',
  borderRadius: 99,
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
  marginTop: 12,
}

const cellStyle: CSSProperties = {
  borderRadius: 12,
  padding: 10,
}

const smallLabelStyle: CSSProperties = { fontSize: 12, margin: 0 }
const cellValueStyle: CSSProperties = { fontSize: 18, fontWeight: 500 }

const dash = (n: number | null | undefined): string => (n == null ? '—' : String(n))

export function HealthPlanSheet({ profile, mode, onClose, onChangeGoal, updatedLabel }: HealthPlanSheetProps) {
  const view = buildHealthPlanView(profile)
  const isIntro = mode === 'intro'

  if (!view.ready) {
    return (
      <View className='hp-mask' onClick={onClose}>
        <View className='hp-sheet' onClick={(e) => e.stopPropagation()}>
          <View className='hp-head'>
            <Text className='hp-title'>{HEALTH_PLAN_TITLE}</Text>
            <View className='hp-close' onClick={onClose}><Text>×</Text></View>
          </View>
          <View className='hp-body'>
            <View className='hp-card'>
              <Text className='hp-helper'>{HEALTH_PLAN_NOT_READY}</Text>
            </View>
            <View className='hp-btn' onClick={onChangeGoal ?? onClose}><Text>{HEALTH_PLAN_GO_FILL}</Text></View>
          </View>
        </View>
      </View>
    )
  }

  const { basic, timeline, goals } = view
  const progressA11y = {
    'aria-role': 'progressbar',
    'aria-valuenow': view.progressPct,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuetext': view.progressText,
  }
  const bandA11y = { 'aria-role': 'img', 'aria-label': basic.ariaLabel }

  return (
    <View className='hp-mask' onClick={onClose}>
      <View className='hp-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='hp-head'>
          <Text className='hp-title'>{isIntro ? HEALTH_PLAN_INTRO_TITLE : HEALTH_PLAN_TITLE}</Text>
          <View className='hp-close' onClick={onClose}><Text>×</Text></View>
        </View>
        <View className='hp-body'>
          {updatedLabel ? (
            <View className='hp-notice' style={{ marginBottom: 12 }}><Text>{updatedLabel}</Text></View>
          ) : null}

          {/* 卡片 1 · 基本信息 */}
          <View className='hp-card'>
            <Text className='hp-section-chip' style={sectionTitleStyle}>{HEALTH_PLAN_SECTION_BASIC}</Text>
            <View className='hp-basic-grid' style={gridStyle}>
              <View className='hp-basic-stat' style={cellStyle}>
                <Text className='hp-helper' style={smallLabelStyle}>{HEALTH_PLAN_LABEL_HEIGHT}</Text>
                <Text className='hp-stat-v' style={cellValueStyle}>{dash(basic.heightCm)} <Text style={{ fontSize: 12, fontWeight: 400 }}>{HEALTH_PLAN_UNIT_CM}</Text></Text>
              </View>
              <View className='hp-basic-stat' style={cellStyle}>
                <Text className='hp-helper' style={smallLabelStyle}>{HEALTH_PLAN_LABEL_WEIGHT}</Text>
                <Text className='hp-stat-v' style={cellValueStyle}>{dash(basic.weightKg)} <Text style={{ fontSize: 12, fontWeight: 400 }}>{HEALTH_PLAN_UNIT_KG}</Text></Text>
              </View>
              <View className='hp-basic-stat' style={cellStyle}>
                <Text className='hp-helper' style={smallLabelStyle}>{HEALTH_PLAN_LABEL_BMR}</Text>
                <Text className='hp-stat-v' style={cellValueStyle}>{dash(basic.bmrKcal)} <Text style={{ fontSize: 12, fontWeight: 400 }}>{HEALTH_PLAN_UNIT_KCAL}</Text></Text>
              </View>
              <View className='hp-basic-stat' style={cellStyle}>
                <Text className='hp-helper' style={smallLabelStyle}>{HEALTH_PLAN_LABEL_BMI}</Text>
                <Text className='hp-stat-v' style={cellValueStyle}>{dash(basic.bmi)}</Text>
              </View>
            </View>

            {basic.bmi != null ? (
              <View style={{ marginTop: 12 }}>
                <View style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Text style={{ fontSize: 13 }}>{HEALTH_PLAN_BMI_PREFIX}{basic.bmi}</Text>
                  {basic.band ? (
                    <Text style={{ fontSize: 12, padding: '3px 10px', borderRadius: 99, background: basic.band.color, color: '#2a2723' }}>
                      {basic.band.label}
                    </Text>
                  ) : null}
                </View>
                <View {...bandA11y} className='hp-band' style={{ position: 'relative', marginBottom: 6 }}>
                  <View style={{ display: 'flex', height: 8, borderRadius: 99, overflow: 'hidden' }}>
                    {basic.bands.map((b) => <View key={b.key} style={{ flex: 1, background: b.color }} />)}
                  </View>
                  {basic.bandPositionPct != null ? (
                    <View style={{
                      position: 'absolute', left: `${basic.bandPositionPct}%`, top: -7, width: 0, height: 0,
                      borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                      borderTop: '7px solid #96600a',
                    }} />
                  ) : null}
                </View>
                <View style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  {basic.bands.map((b) => <Text key={b.key} className='hp-helper' style={{ fontSize: 12 }}>{b.label}</Text>)}
                </View>
                <Text className='hp-helper' style={{ fontSize: 12, marginTop: 8 }}>{HEALTH_PLAN_BMI_DISCLAIMER}</Text>
              </View>
            ) : null}
          </View>

          {/* 卡片 2 · 体重目标 */}
          <View className='hp-card'>
            <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text className='hp-section-chip' style={sectionTitleStyle}>{HEALTH_PLAN_SECTION_GOAL}</Text>
              <Text className='hp-chip' style={chipStyle}>{view.goalLabel}</Text>
            </View>

            {view.hasProgress ? (
              <View>
                <Text className='hp-helper' style={{ marginBottom: 6 }}>{view.progressPct}% · {HEALTH_PLAN_LABEL_PROGRESS}</Text>
                <View
                  {...progressA11y}
                  className='hp-track'
                  style={{ height: 8, borderRadius: 99, overflow: 'hidden' }}
                >
                  <View className='hp-fill' style={{ width: `${view.progressPct}%`, height: '100%' }} />
                </View>
                <View style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 6 }}>
                  <Text className='hp-helper' style={{ fontSize: 12 }}>{HEALTH_PLAN_LABEL_START_W} {dash(goals.startWeight)} kg</Text>
                  <Text className='hp-helper' style={{ fontSize: 12 }}>{HEALTH_PLAN_LABEL_TARGET_W} {dash(goals.targetWeight)} kg</Text>
                </View>
              </View>
            ) : (
              <Text className='hp-helper' style={{ marginBottom: 8 }}>{HEALTH_PLAN_BAND_HINT}</Text>
            )}

            <View className='hp-timeline' style={{ borderRadius: 12, padding: '10px 12px', marginTop: 10 }}>
              <View style={{ fontSize: 13, fontWeight: 500 }}>
                {timeline.dayLabel ? (
                  <Text style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 99, marginRight: 6, fontSize: 13 }}>
                    {timeline.dayLabel}
                  </Text>
                ) : null}
                <Text>{timeline.timelineText}</Text>
              </View>
              <Text className='hp-helper' style={{ fontSize: 12, marginTop: 6 }}>{timeline.timeNote}</Text>
            </View>

            <View className='hp-dual' style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
              <View className='hp-dual-a' style={{ borderRadius: 12, padding: 10 }}>
                <Text className='hp-helper' style={{ fontSize: 12, margin: 0 }}>{goals.expectLabel}</Text>
                <Text style={{ fontSize: 18, fontWeight: 500 }}>{goals.expectValue}</Text>
              </View>
              <View className='hp-dual-b' style={{ borderRadius: 12, padding: 10 }}>
                <Text className='hp-helper' style={{ fontSize: 12, margin: 0 }}>{goals.remainLabel}</Text>
                <Text style={{ fontSize: 18, fontWeight: 500 }}>{goals.remainValue}</Text>
              </View>
            </View>
          </View>

          {/* 卡片 3 · 每日方案 */}
          <View className='hp-card'>
            <Text className='hp-section-chip' style={sectionTitleStyle}>{HEALTH_PLAN_SECTION_DAILY}</Text>
            <Text className='hp-helper' style={{ margin: '12px 0 2px' }}>{HEALTH_PLAN_LABEL_DAILY}</Text>
            <View className='hp-num' style={{ fontSize: 28, fontWeight: 500 }}>
              <Text>{roundTo(view.calories, 0)}</Text>
              <Text style={{ fontSize: 14, fontWeight: 400 }}> {HEALTH_PLAN_UNIT_KCAL}</Text>
            </View>

            <View className='hp-stat-grid' style={{ marginTop: 14 }}>
              <View className='hp-stat'>
                <Text className='hp-helper' style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_PROTEIN}</Text>
                <Text className='hp-stat-v' style={{ fontSize: 18, fontWeight: 500 }}>{roundTo(view.protein, 0)} g</Text>
              </View>
              <View className='hp-stat'>
                <Text className='hp-helper' style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_CARB}</Text>
                <Text className='hp-stat-v' style={{ fontSize: 18, fontWeight: 500 }}>{roundTo(view.carb, 0)} g</Text>
              </View>
              <View className='hp-stat'>
                <Text className='hp-helper' style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_FAT}</Text>
                <Text className='hp-stat-v' style={{ fontSize: 18, fontWeight: 500 }}>{roundTo(view.fat, 0)} g</Text>
              </View>
              <View className='hp-stat'>
                <Text className='hp-helper' style={{ margin: 0 }}>{HEALTH_PLAN_LABEL_WEEKLY}</Text>
                <Text className='hp-stat-v' style={{ fontSize: 18, fontWeight: 500 }}>{view.weeklyLabel}</Text>
              </View>
            </View>
          </View>

          <TransparencyNotes title={HEALTH_PLAN_NOTES_TITLE} notes={view.notes} />

          {isIntro ? (
            <View>
              <Text className='hp-helper' style={{ margin: '14px 0 12px' }}>{HEALTH_PLAN_INTRO_HINT}</Text>
              <View className='hp-btn' onClick={onClose}><Text>{HEALTH_PLAN_LABEL_START}</Text></View>
            </View>
          ) : (
            <View className='hp-btn' style={{ marginTop: 14 }} onClick={onChangeGoal}><Text>{HEALTH_PLAN_LABEL_CHANGE}</Text></View>
          )}
        </View>
      </View>
    </View>
  )
}
