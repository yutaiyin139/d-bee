import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import {
  SMART_DEVICE_TITLE, SMART_DEVICE_SECTION_APPS, SMART_DEVICE_SECTION_STATUS,
  SMART_DEVICE_SECTION_FUTURE, SMART_DEVICE_WEB_HINT, SMART_DEVICE_NOT_CONNECTED,
  SMART_DEVICE_CONNECTED, SMART_DEVICE_LABEL_STEPS, SMART_DEVICE_LABEL_ACTIVITY,
  SMART_DEVICE_FUTURE_NOTE, DEVICE_STATUS_LABEL,
  HEALTH_APP_CATALOG, FUTURE_DEVICE_CATALOG,
  HEALTH_RECORD_LOAD_ERROR, HEALTH_RECORD_LABELS, HEALTH_RECORD_UNITS,
} from '@dbee/shared'
import { syncFromHealth, estimateActivityKcal } from '../lib/health'
import './MyPageSheets.scss'

interface SmartDeviceSheetProps {
  onClose: () => void
  connected: boolean
  connectable: boolean
  vendorLabel: string
  steps: number | null
  weightKg: number | null
  heightCm: number | null
  onConnect: () => void
  onDisconnect: () => void
}

/** 智能设备：只列真实可连接的健康应用，硬件目录全为「后续支持」，零假绑定按钮。 */
export function SmartDeviceSheet({
  onClose, connected, connectable, vendorLabel, steps, weightKg, heightCm, onConnect, onDisconnect,
}: SmartDeviceSheetProps) {
  const [liveSteps, setLiveSteps] = useState<number | null>(steps)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!connected || steps != null) return
    let alive = true
    void syncFromHealth().then((h) => { if (alive) setLiveSteps(h.steps) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [connected, steps])

  const shownSteps = liveSteps ?? steps ?? 0
  const activeKcal = estimateActivityKcal(shownSteps, weightKg, heightCm)

  return (
    <View className='mp-mask' onClick={onClose}>
      <View className='mp-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='mp-head'>
          <Text className='mp-title'>{SMART_DEVICE_TITLE}</Text>
          <View className='mp-close' onClick={onClose}><Text>×</Text></View>
        </View>
        <View className='mp-body'>
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
                {connectable && !connected && d.status === 'available' ? (
                  <Text className='mp-val' onClick={onConnect}>连接</Text>
                ) : null}
              </View>
            ))}
          </View>

          <Text className='mp-section'>{SMART_DEVICE_SECTION_FUTURE}</Text>
          <Text className='mp-helper'>{SMART_DEVICE_FUTURE_NOTE}</Text>
          <View className='mp-card'>
            {FUTURE_DEVICE_CATALOG.map((d) => (
              <View className='mp-line' key={d.key}>
                <Text>{d.label}</Text>
                <Text className='mp-muted'>{DEVICE_STATUS_LABEL[d.status]}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </View>
  )
}
