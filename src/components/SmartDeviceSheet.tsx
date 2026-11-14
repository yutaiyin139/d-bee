import { useEffect, useState } from 'react'
import { Sheet } from './Sheet'
import {
  SMART_DEVICE_TITLE, SMART_DEVICE_SECTION_APPS, SMART_DEVICE_SECTION_STATUS,
  SMART_DEVICE_SECTION_FUTURE, SMART_DEVICE_WEB_HINT, SMART_DEVICE_NOT_CONNECTED,
  SMART_DEVICE_CONNECTED, SMART_DEVICE_LABEL_STEPS, SMART_DEVICE_LABEL_ACTIVITY,
  SMART_DEVICE_FUTURE_NOTE, DEVICE_STATUS_LABEL,
  HEALTH_APP_CATALOG, FUTURE_DEVICE_CATALOG,
  HEALTH_RECORD_LOAD_ERROR, HEALTH_RECORD_LABELS, HEALTH_RECORD_UNITS,
} from '@dbee/shared'
import { syncFromHealth, estimateActivityKcal } from '../lib/health'

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
    <Sheet title={SMART_DEVICE_TITLE} onClose={onClose}>
      <div className="section-title">{SMART_DEVICE_SECTION_STATUS}</div>
      <div className="card">
        <div className="list-line">
          <span>{HEALTH_RECORD_LABELS.healthStatus}</span>
          <span className="val">{connected ? `${SMART_DEVICE_CONNECTED} · ${vendorLabel}` : SMART_DEVICE_NOT_CONNECTED}</span>
        </div>
        <div className="list-line">
          <span>{SMART_DEVICE_LABEL_STEPS}</span>
          <span className="val">{connected ? `${shownSteps} ${HEALTH_RECORD_UNITS.step}` : '—'}</span>
        </div>
        <div className="list-line">
          <span>{SMART_DEVICE_LABEL_ACTIVITY}</span>
          <span className="val">{connected ? `${activeKcal} ${HEALTH_RECORD_UNITS.kcal}` : '—'}</span>
        </div>
        {connected && (
          <div className="list-line" onClick={onDisconnect} role="button" tabIndex={0}>
            <span>解除连接</span><span className="val">›</span>
          </div>
        )}
        {error && <div className="notice err">{HEALTH_RECORD_LOAD_ERROR}</div>}
      </div>

      <div className="section-title">{SMART_DEVICE_SECTION_APPS}</div>
      {!connectable && <div className="helper" style={{ marginBottom: 8 }}>{SMART_DEVICE_WEB_HINT}</div>}
      <div className="card">
        {HEALTH_APP_CATALOG.map((d) => (
          <div className="list-line" key={d.key}>
            <span>{d.label}</span>
            <span className="val">
              <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{DEVICE_STATUS_LABEL[d.status]} · {d.note}</span>
              {connectable && !connected && d.status === 'available' && (
                <button className="btn-text" style={{ marginLeft: 8 }} onClick={onConnect}>连接</button>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="section-title">{SMART_DEVICE_SECTION_FUTURE}</div>
      <div className="helper" style={{ marginBottom: 8 }}>{SMART_DEVICE_FUTURE_NOTE}</div>
      <div className="card">
        {FUTURE_DEVICE_CATALOG.map((d) => (
          <div className="list-line" key={d.key}>
            <span>{d.label}</span>
            <span className="val" style={{ color: 'var(--ink-3)', fontSize: 12 }}>{DEVICE_STATUS_LABEL[d.status]}</span>
          </div>
        ))}
      </div>
    </Sheet>
  )
}
