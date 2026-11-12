import { Text, View } from '@tarojs/components'
import type { TransparencyNote } from '@dbee/shared'

/**
 * 透明化文案的纯展示组件（P1.4 / P1.5 / P1.6，mini 端）。
 *
 * 文案真源在 `@dbee/shared` 的 `content/transparency.ts`，与主端
 * `src/components/TransparencyNotes.tsx` 共用同一份数据，本文件不持有文案副本。
 * 行内样式：不改动任何页面级 scss，可单独回滚。
 *
 * 🔴 额度文案必须传入按 `MINI_RECORDING_CAPS` 生成的结果 —— mini 没有扫码/
 * 包装识别能力，直接渲染全能力端口文案会构成宣传与功能不符（护栏 19）。
 */
export function TransparencyNotes({
  notes,
  title,
}: {
  notes: readonly TransparencyNote[]
  title?: string
}) {
  return (
    <View style={{ marginTop: 20 }}>
      {title ? <View className='section-title'><Text>{title}</Text></View> : null}
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
  )
}
