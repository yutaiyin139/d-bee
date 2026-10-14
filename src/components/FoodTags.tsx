import type { FoodTag, TagSummary } from '../lib/foodInsight'

/**
 * 食物标签药丸。红系=需要留意的风险，绿系=值得肯定的益处。
 * 颜色只在 tone 上区分，不做更细的强弱分级 —— 强弱已经由排序和文案体现，
 * 再上更多颜色只会让列表噪杂。
 */
export function FoodTagPill({ tag, count }: { tag: FoodTag | TagSummary; count?: number }) {
  const risk = tag.tone === 'risk'
  return (
    <span className={`ftag ${risk ? 'ftag-risk' : 'ftag-good'}`} title={`${tag.reason}${count ? `（${count} 项）` : ''}`}>
      <span className="ftag-mark">{risk ? '!' : '✓'}</span>
      {tag.label}
      {count !== undefined && count > 1 && <span className="ftag-count">×{count}</span>}
    </span>
  )
}

/** 一串标签；为空时给出中性提示，避免出现空白区块 */
export function FoodTagList({ tags, empty }: { tags: FoodTag[]; empty?: string }) {
  if (tags.length === 0) return empty ? <span className="ftag-none">{empty}</span> : null
  return (
    <span className="ftag-row">
      {tags.map((t) => (
        <FoodTagPill key={t.key} tag={t} />
      ))}
    </span>
  )
}
