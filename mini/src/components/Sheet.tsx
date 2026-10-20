/**
 * 底部弹层（对齐主工程 src/components/Sheet.tsx）。
 * 小程序用 View 实现遮罩 + 面板，点遮罩关闭、面板内点击不冒泡。
 */
import type { ReactNode } from 'react'
import { View, Text } from '@tarojs/components'

interface SheetProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Sheet({ title, onClose, children }: SheetProps) {
  return (
    <View className='sheet-mask' onClick={onClose}>
      <View className='sheet' onClick={(e) => e.stopPropagation()}>
        <View className='sheet-head'>
          <Text className='sheet-title'>{title}</Text>
          <View className='sheet-close' onClick={onClose}>×</View>
        </View>
        <View className='sheet-body'>{children}</View>
      </View>
    </View>
  )
}
