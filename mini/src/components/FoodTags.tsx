/**
 * 食物标签药丸（对齐主工程 src/components/FoodTags.tsx）。
 * 红系=需要留意的风险，绿系=值得肯定的益处。
 * 小程序用 View/Text 替代 span，颜色直接传具体色值（无 CSS 变量运行时）。
 */
import { View, Text } from '@tarojs/components'
import type { FoodTag, TagSummary } from '../lib/foodInsight'

export function FoodTagPill({ tag, count }: { tag: FoodTag | TagSummary; count?: number }) {
  const risk = tag.tone === 'risk'
  return (
    <View className={`ftag ${risk ? 'ftag-risk' : 'ftag-good'}`}>
      <Text className='ftag-mark'>{risk ? '!' : '✓'}</Text>
      <Text>{tag.label}</Text>
      {count !== undefined && count > 1 && <Text className='ftag-count'>×{count}</Text>}
    </View>
  )
}

/** 一串标签；为空时给出中性提示，避免出现空白区块 */
export function FoodTagList({ tags, empty }: { tags: FoodTag[]; empty?: string }) {
  if (tags.length === 0) return empty ? <Text className='ftag-none'>{empty}</Text> : null
  return (
    <View className='ftag-row'>
      {tags.map((t) => (
        <FoodTagPill key={t.key} tag={t} />
      ))}
    </View>
  )
}
