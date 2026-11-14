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
  buildHealthPlanView,
} from '../lib/healthPlan'
import './HealthPlanSheet.scss'

/**
 * 健康管理方案 Sheet（mini 端）—— 单态渲染。
 *
 * 与主端 src/components/HealthPlanSheet.tsx 一一对应：一页三区、单枚目标徽标、
 * 2×2 统计网格、进度条、TransparencyNotes 折叠说明、intro/normal 两种按钮态。
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

  const progressA11y = {
    'aria-role': 'progressbar',
    'aria-valuenow': view.progressPct,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuetext': view.progressText,
  }

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

          <View className='hp-card'>
            <Text className='hp-chip' style={chipStyle}>{view.goalLabel}</Text>
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

            {view.hasProgress ? (
              <View style={{ marginTop: 14 }}>
                <Text className='hp-helper' style={{ marginBottom: 6 }}>{view.progressText}</Text>
                <View
                  {...progressA11y}
                  className='hp-track'
                  style={{ height: 8, borderRadius: 99, overflow: 'hidden' }}
                >
                  <View className='hp-fill' style={{ width: `${view.progressPct}%`, height: '100%' }} />
                </View>
              </View>
            ) : (
              <Text className='hp-helper' style={{ marginTop: 14 }}>{view.progressText}</Text>
            )}
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
