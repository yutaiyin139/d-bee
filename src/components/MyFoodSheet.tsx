import { useEffect, useState } from 'react'
import { Sheet } from './Sheet'
import {
  MY_FOOD_TITLE, MY_FOOD_HINT, MY_FOOD_EMPTY, MY_FOOD_UNIT_COUNT, MY_FOOD_UNIT_KCAL,
  HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  buildMyFoodViewCore, type MyFoodView,
} from '@dbee/shared'
import { listRecipes } from '../lib/api'

/** 「我的食物」：只读 recipes 表，无推荐内容库、无编辑入口。 */
export function MyFoodSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [rows, setRows] = useState<MyFoodView[]>([])

  useEffect(() => {
    let alive = true
    void listRecipes().then((r) => {
      if (!alive) return
      setRows(buildMyFoodViewCore(r))
      setState('ok')
    }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [])

  return (
    <Sheet title={MY_FOOD_TITLE} onClose={onClose}>
      <div className="helper" style={{ marginBottom: 12 }}>{MY_FOOD_HINT}</div>
      {state === 'loading' && <div className="helper">{HEALTH_RECORD_LOADING}</div>}
      {state === 'error' && <div className="notice err">{HEALTH_RECORD_LOAD_ERROR}</div>}
      {state === 'ok' && rows.length === 0 && <div className="helper">{MY_FOOD_EMPTY}</div>}
      {state === 'ok' && rows.length > 0 && (
        <div className="card">
          {rows.map((r, i) => (
            <div className="list-line" key={`${r.name}-${i}`}>
              <span>{r.name}</span>
              <span className="val">{r.itemCount} {MY_FOOD_UNIT_COUNT} · {r.calories} {MY_FOOD_UNIT_KCAL}</span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}
