import { useEffect, useState } from 'react'
import { Sheet } from './Sheet'
import {
  MY_FOOD_TITLE, MY_FOOD_HINT, MY_FOOD_EMPTY, MY_FOOD_UNIT_COUNT, MY_FOOD_UNIT_KCAL,
  MY_FOOD_ACTION_LOG, MY_FOOD_ACTION_DELETE, MY_FOOD_ACTION_DELETE_CONFIRM,
  MY_FOOD_ACTION_LOGGING, MY_FOOD_LOGGED, MY_FOOD_LOG_ERROR, MY_FOOD_DELETE_ERROR,
  HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  buildMyFoodViewCore, type MyFoodView,
} from '@dbee/shared'
import { listRecipes, deleteRecipe, insertMeals } from '../lib/api'
import { todayKey, guessMealType } from '../lib/nutrition'
import { checkStatBadges } from '../lib/badgeCheck'
import type { Recipe } from '../types'

/**
 * 「我的食物」：常吃的一餐模板，与主端/小程序食谱能力对齐。
 * 只读展示 recipes 表；每行可「记一餐」（直接落库当天）与「删除」（二次确认）。
 * 写入口径与 mini/src/pages/recipes 一致：营养为实际摄入量，source=manual。
 */
export function MyFoodSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [rows, setRows] = useState<MyFoodView[]>([])
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void listRecipes().then((r) => {
      if (!alive) return
      setRecipes(r)
      setRows(buildMyFoodViewCore(r))
      setState('ok')
    }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [])

  // 删除确认态 3 秒自动复位
  useEffect(() => {
    if (pendingDelete == null) return
    const t = setTimeout(() => setPendingDelete(null), 3000)
    return () => clearTimeout(t)
  }, [pendingDelete])

  /** 从食谱记一餐：食材按实际摄入量直接落库为当天饮食记录 */
  async function logMeal(r: Recipe) {
    if (r.id == null) return
    setMsg('')
    setBusyId(r.id)
    try {
      await insertMeals(r.items.map((it) => ({
        log_date: todayKey(),
        meal_type: guessMealType(),
        food_name: it.food_name,
        quantity_text: it.quantity_text || `${it.grams} 克`,
        grams: it.grams,
        calories: it.calories,
        protein_g: it.protein_g,
        carb_g: it.carb_g,
        fat_g: it.fat_g,
        sodium_mg: it.sodium_mg ?? null,
        fiber_g: it.fiber_g ?? null,
        added_sugar_g: it.added_sugar_g ?? null,
        source: 'manual',
      })))
      setMsg(MY_FOOD_LOGGED(r.name, r.items.length))
      void checkStatBadges()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : MY_FOOD_LOG_ERROR)
    } finally {
      setBusyId(null)
    }
  }

  /** 删除食谱（二次确认防误触） */
  async function handleDelete(r: Recipe) {
    const id = r.id
    if (id == null) return
    if (pendingDelete !== id) {
      setPendingDelete(id)
      return
    }
    setPendingDelete(null)
    setMsg('')
    try {
      await deleteRecipe(id)
      setRecipes((prev) => prev.filter((x) => x.id !== id))
      setRows((prev) => prev.filter((_, i) => recipes[i]?.id !== id))
      void checkStatBadges()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : MY_FOOD_DELETE_ERROR)
    }
  }

  return (
    <Sheet title={MY_FOOD_TITLE} onClose={onClose}>
      <div className="helper" style={{ marginBottom: 12 }}>{MY_FOOD_HINT}</div>
      {msg && <div className="notice ok">{msg}</div>}
      {state === 'loading' && <div className="helper">{HEALTH_RECORD_LOADING}</div>}
      {state === 'error' && <div className="notice err">{HEALTH_RECORD_LOAD_ERROR}</div>}
      {state === 'ok' && rows.length === 0 && <div className="helper">{MY_FOOD_EMPTY}</div>}
      {state === 'ok' && rows.length > 0 && (
        <div className="card">
          {rows.map((r, i) => {
            const recipe = recipes[i]
            return (
              <div className="recipe-row" key={`${r.name}-${i}`}>
                <div className="recipe-main">
                  <span className="recipe-name">{r.name}</span>
                  <span className="recipe-sub">{r.itemCount} {MY_FOOD_UNIT_COUNT} · {r.calories} {MY_FOOD_UNIT_KCAL}</span>
                </div>
                <button
                  className="btn-text"
                  disabled={busyId === recipe?.id}
                  onClick={() => void logMeal(recipe)}
                >{busyId === recipe?.id ? MY_FOOD_ACTION_LOGGING : MY_FOOD_ACTION_LOG}</button>
                <button
                  className={`btn-text ${pendingDelete === recipe?.id ? 'danger' : ''}`}
                  onClick={() => void handleDelete(recipe)}
                >{pendingDelete === recipe?.id ? MY_FOOD_ACTION_DELETE_CONFIRM : MY_FOOD_ACTION_DELETE}</button>
              </div>
            )
          })}
        </div>
      )}
    </Sheet>
  )
}
