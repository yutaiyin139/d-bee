import { useEffect, useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import {
  SMART_DEVICE_TITLE, SMART_DEVICE_SECTION_APPS, SMART_DEVICE_SECTION_STATUS,
  SMART_DEVICE_SECTION_FUTURE, SMART_DEVICE_WEB_HINT, SMART_DEVICE_NOT_CONNECTED,
  SMART_DEVICE_CONNECTED, SMART_DEVICE_LABEL_STEPS, SMART_DEVICE_LABEL_ACTIVITY,
  SMART_DEVICE_FUTURE_NOTE, DEVICE_STATUS_LABEL,
  HEALTH_APP_CATALOG, FUTURE_DEVICE_CATALOG, healthCatalogKeyForVendor,
  HEALTH_RECORD_LOAD_ERROR, HEALTH_RECORD_LABELS, HEALTH_RECORD_UNITS,
  WATCH_CATALOG, WATCH_SECTION_OTHER, WATCH_BIND_ENTRY, WATCH_BIND_TITLE,
  WATCH_BIND_HINT, WATCH_BIND_NOT_BOUND, WATCH_BIND_BOUND,
  WATCH_BIND_ACTION_CONNECT, WATCH_BIND_ACTION_PROGRESS, WATCH_BIND_HC_NOTE,
  WATCH_BIND_BACK, WATCH_BIND_PROGRESS_NOTE,
  smartDeviceLine,
} from '@dbee/shared'
import { syncFromHealth, estimateActivityKcal } from '../lib/health'
import './MyPageSheets.scss'

interface SmartDeviceSheetProps {
  onClose: () => void
  connected: boolean
  connectable: boolean
  vendorLabel: string
  /** 当前机型 vendor；连接按钮只对目录中对应当前机型的那一行渲染 */
  vendorKey: string
  steps: number | null
  weightKg: number | null
  heightCm: number | null
  onConnect: () => void
  onDisconnect: () => void
}

/** 智能设备：只列真实可连接的健康应用，硬件目录全为「后续支持」，零假绑定按钮。 */
export function SmartDeviceSheet({
  onClose, connected, connectable, vendorLabel, vendorKey, steps, weightKg, heightCm, onConnect, onDisconnect,
}: SmartDeviceSheetProps) {
  const [liveSteps, setLiveSteps] = useState<number | null>(steps)
  const [liveActive, setLiveActive] = useState<number | null>(null)
  const [error, setError] = useState(false)
  const [watchView, setWatchView] = useState(false)

  // 🔴 2026-11-18 修复「连接成功后今日步数不刷新」的另一半：
  //   liveSteps 原本只在 useState 初始化时读一次 props.steps，父组件连接成功后
  //   传进来的新步数**不会**同步进来；而 shownSteps = liveSteps ?? steps，
  //   旧的 liveSteps（非 null）会把新值盖住 → 用户看到的仍是连接前的数字。
  useEffect(() => {
    if (steps != null) setLiveSteps(steps)
  }, [steps])

  useEffect(() => {
    if (!connected || steps != null) return
    let alive = true
    // live 实时同步：弹层打开就是「用户主动查看」，此时取微信运动当时的步数（零弹框）
    void syncFromHealth({ live: true }).then((h) => {
      if (!alive) return
      setLiveSteps(h.steps)
      setLiveActive(h.activeKcal)
    }).catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [connected, steps])

  const deviceSteps = liveSteps ?? steps
  const shownSteps = deviceSteps ?? 0
  const estimated = estimateActivityKcal(shownSteps, weightKg, heightCm)
  const activeKcal = liveActive != null && liveActive > 0 ? Math.round(liveActive) : estimated

  // 手表品牌状态复用健康应用目录（单一真源），不另造状态机
  const healthFor = (key: string) => HEALTH_APP_CATALOG.find((d) => d.key === key)

  return (
    <View className='mp-mask' onClick={onClose}>
      <View className='mp-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='mp-head'>
          <Text className='mp-title'>{watchView ? WATCH_BIND_TITLE : SMART_DEVICE_TITLE}</Text>
          <View className='mp-close' onClick={onClose}><Text>×</Text></View>
        </View>
        <View className='mp-body'>
          {watchView ? (
            <>
              <View className='mp-line' onClick={() => setWatchView(false)}><Text className='mp-val'>‹ {WATCH_BIND_BACK}</Text></View>
              <Text className='mp-helper'>{WATCH_BIND_HINT}</Text>
              <View className='mp-card'>
                {WATCH_CATALOG.map((w) => {
                  const app = healthFor(w.key)
                  const status = app?.status ?? 'planned'
                  const isApple = w.key === 'apple'
                  const canBindApple = isApple && connectable && !connected && healthCatalogKeyForVendor(vendorKey) === 'apple'
                  const boundApple = isApple && connected
                  return (
                    <View className='mp-food-row' key={w.key}>
                      <View className='mp-food-main'>
                        <Text>{w.label}</Text>
                        <Text className='mp-muted'>{app ? DEVICE_STATUS_LABEL[status] : WATCH_BIND_NOT_BOUND} · {w.statusNote}</Text>
                      </View>
                      {canBindApple ? (
                        <Button className='btn-text' onClick={onConnect}>{WATCH_BIND_ACTION_CONNECT}</Button>
                      ) : boundApple ? (
                        <Text className='mp-val'>{WATCH_BIND_BOUND}</Text>
                      ) : (
                        <Text className='mp-muted'>{WATCH_BIND_ACTION_PROGRESS}</Text>
                      )}
                    </View>
                  )
                })}
              </View>
              <Text className='mp-helper'>{WATCH_BIND_HC_NOTE}</Text>
              <Text className='mp-helper'>{WATCH_BIND_PROGRESS_NOTE}</Text>
            </>
          ) : (
            <>
              <Text className='mp-section'>{SMART_DEVICE_SECTION_STATUS}</Text>
              <View className='mp-card'>
                <View className='mp-line'><Text>{HEALTH_RECORD_LABELS.healthStatus}</Text><Text className='mp-val'>{connected ? `${SMART_DEVICE_CONNECTED} · ${vendorLabel}` : SMART_DEVICE_NOT_CONNECTED}</Text></View>
                <View className='mp-line'><Text>{SMART_DEVICE_LABEL_STEPS}</Text><Text className='mp-val'>{connected ? `${shownSteps} ${HEALTH_RECORD_UNITS.step}` : '—'}</Text></View>
                <View className='mp-line'><Text>{SMART_DEVICE_LABEL_ACTIVITY}</Text><Text className='mp-val'>{connected ? `${activeKcal} ${HEALTH_RECORD_UNITS.kcal}` : '—'}</Text></View>
                {connected ? (
                  <View className='mp-line' onClick={onDisconnect}><Text>解除连接</Text><Text className='mp-val'>›</Text></View>
                ) : null}
                {error ? <Text className='mp-helper'>{HEALTH_RECORD_LOAD_ERROR}</Text> : null}
              </View>

              <Text className='mp-section'>{SMART_DEVICE_SECTION_APPS}</Text>
              {!connectable ? <Text className='mp-helper'>{SMART_DEVICE_WEB_HINT}</Text> : null}
              <View className='mp-card'>
                {HEALTH_APP_CATALOG.map((d) => (
                  <View className='mp-line' key={d.key}>
                    <Text>{d.label}</Text>
                    <Text className='mp-muted'>{DEVICE_STATUS_LABEL[d.status]} · {d.note}</Text>
                    {connectable && !connected && d.status === 'available' && d.key === healthCatalogKeyForVendor(vendorKey) ? (
                      <Text className='mp-val' onClick={onConnect}>连接</Text>
                    ) : null}
                  </View>
                ))}
              </View>

              <Text className='mp-section'>{SMART_DEVICE_SECTION_FUTURE}</Text>
              <Text className='mp-helper'>{SMART_DEVICE_FUTURE_NOTE}</Text>
              <View className='mp-card'>
                {FUTURE_DEVICE_CATALOG.map((d) => {
                  const line = smartDeviceLine(d.key, null, deviceSteps, 'mini')
                  return (
                    <View className='mp-line' key={d.key}>
                      <Text>{d.label}</Text>
                      <Text className='mp-muted'>{line.value || d.note}</Text>
                    </View>
                  )
                })}
              </View>

              <Text className='mp-section'>{WATCH_SECTION_OTHER}</Text>
              <View className='mp-card'>
                <View className='mp-line' onClick={() => setWatchView(true)}><Text>{WATCH_BIND_ENTRY}</Text><Text className='mp-val'>›</Text></View>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  )
}
