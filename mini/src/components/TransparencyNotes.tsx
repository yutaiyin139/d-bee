import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import type { TransparencyNote } from '@dbee/shared'

/**
 * 透明化文案的展示组件（P1.4 / P1.5 / P1.6，mini 端；2026-11-12 改为默认收起）。
 *
 * 文案真源在 `@dbee/shared` 的 `content/transparency.ts`，与主端
 * `src/components/TransparencyNotes.tsx` 共用同一份数据，本文件不持有文案副本。
 * 行内样式：不改动任何页面级 scss，可单独回滚。
 *
 * 交互与主端同款：默认收起，点标题行展开（药丸「展开 / 收起」+ 箭头翻转 +
 * 详情区折叠），对应主端首页「饮食体检」的手势。刻意不记忆展开偏好。
 *
 * 🔴 额度文案必须传入按 `MINI_RECORDING_CAPS` 生成的结果 —— mini 没有扫码/
 * 包装识别能力，直接渲染全能力端口文案会构成宣传与功能不符（护栏 19）。
 * 收起只改变「是否展示」，展开后仍逐条渲染 notes 真源，不改任何文案。
 */
export function TransparencyNotes({
  notes,
  title,
}: {
  notes: readonly TransparencyNote[]
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const label = title ?? '说明'

  return (
    <View style={{ marginTop: 20 }}>
      <View
        className='section-title'
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 0,
          marginBottom: 12,
        }}
      >
        <Text>{label}</Text>
        <View style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <Text className='hint' style={{ fontSize: '12px', marginRight: 6 }}>共 {notes.length} 条</Text>
          <View
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              padding: '5px 12px',
              border: '1px solid rgba(42,39,35,0.16)',
              borderRadius: '99px',
              backgroundColor: '#ffffff',
            }}
          >
            <Text
              style={{
                fontSize: '11px',
                lineHeight: 1,
                transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.25s ease',
              }}
            >▾</Text>
            <Text style={{ fontSize: '12px', color: '#6b655c', marginLeft: 3 }}>{open ? '收起' : '展开'}</Text>
          </View>
        </View>
      </View>

      <View
        style={{
          overflow: 'hidden',
          maxHeight: open ? `${notes.length * 200 + 60}px` : '0px',
          opacity: open ? 1 : 0,
          transition: 'max-height 0.32s ease, opacity 0.24s ease',
        }}
      >
        <View className='card' style={{ padding: '6px 14px' }}>
          {notes.map((n, i) => (
            <View
              key={n.label}
              style={{
                padding: '9px 0',
                borderTop: i === 0 ? 'none' : '1px solid rgba(42,39,35,0.08)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <Text style={{ fontSize: '13px', fontWeight: '600', marginBottom: 2 }}>{n.label}</Text>
              <Text className='hint' style={{ lineHeight: 1.65 }}>{n.text}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}
