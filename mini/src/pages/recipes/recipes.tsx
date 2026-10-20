/**
 * 我的食谱（P2-2，小程序端，对齐主工程 LogSheet 的食谱能力）。
 *
 * 功能：
 *   - 查看我的自定义食谱列表（含每餐热量合计）
 *   - 从食谱「记一餐」：把食谱里的食材按实际摄入量落库为当日饮食记录
 *   - 删除食谱
 *
 * 保存食谱入口在 scan 页（识别结果卡片「存为食谱」）。
 * 数据层复用 mini/src/lib/api.ts 的 listRecipes / deleteRecipe / insertMeals。
 */
import { useEffect, useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import Taro, { useShareAppMessage } from '@tarojs/taro'
import {
  listRecipes, deleteRecipe, insertMeals,
  type Recipe,
} from '../../lib/api'
import { checkStatBadges } from '../../lib/badgeCheck'
import { todayKey, guessMealType } from '../../lib/nutrition'
import './recipes.scss'

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  // 删除确认：记录待删除 id，二次点击确认
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  // 「记一餐」后跳回首页的引导
  const [loggedMsg, setLoggedMsg] = useState('')

  useEffect(() => {
    let alive = true
    void listRecipes()
      .then((r) => { if (alive) setRecipes(r) })
      .catch(() => { if (alive) setMsg('读取食谱失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // 删除确认态 3 秒自动复位
  useEffect(() => {
    if (pendingDelete == null) return
    const t = setTimeout(() => setPendingDelete(null), 3000)
    return () => clearTimeout(t)
  }, [pendingDelete])

  useShareAppMessage(() => ({
    title: '我在「自律蜜蜂」收藏了自己的常吃食谱，记录饮食超方便',
    path: '/pages/index/index',
  }))

  /** 从食谱记一餐：展开食材落库为当日记录 */
  async function logFromRecipe(r: Recipe) {
    setMsg('')
    setBusyId(r.id ?? null)
    try {
      const mealType = guessMealType()
      await insertMeals(r.items.map((it) => ({
        log_date: todayKey(),
        meal_type: mealType,
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
      setLoggedMsg(`已把「${r.name}」记入今天（${r.items.length} 项）`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '记录失败，请重试')
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
      // 删除后重算统计类徽章（recipe_3 等，幂等）
      void checkStatBadges()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <View className='page recipes'>
      <View className='hero'>
        <Text className='hero-title'>我的食谱</Text>
      </View>

      <View className='helper'>
        <Text>把常吃的一餐存成食谱，下次一键复记，不用再走 AI 识别</Text>
      </View>

      {msg ? <View className='notice'><Text>{msg}</Text></View> : null}
      {loggedMsg ? <View className='notice is-good'><Text>{loggedMsg}</Text></View> : null}

      {loading ? (
        <View className='skeleton' style={{ height: 160 }} />
      ) : recipes.length === 0 ? (
        <View className='empty'>
          <Text className='empty-emoji'>🍱</Text>
          <Text className='empty-text'>还没有食谱</Text>
          <Text className='empty-sub'>拍照识别后，在识别结果里点「存为食谱」即可创建</Text>
        </View>
      ) : (
        <View className='recipe-list'>
          {recipes.map((r) => {
            const kcal = Math.round(r.items.reduce((s, it) => s + (Number(it.calories) || 0), 0))
            return (
              <View className='recipe-card' key={r.id}>
                <View className='rc-head'>
                  <View className='rc-title'>
                    <Text className='rc-name'>{r.name}</Text>
                    <Text className='rc-meta'>{r.items.length} 项 · {kcal} kcal</Text>
                  </View>
                  <View className='rc-actions'>
                    <Button
                      className='btn-text'
                      disabled={busyId === r.id}
                      onClick={() => void logFromRecipe(r)}
                    >
                      {busyId === r.id ? '记录中…' : '记一餐'}
                    </Button>
                    <Button
                      className={`btn-text ${pendingDelete === r.id ? 'confirming' : ''}`}
                      onClick={() => void handleDelete(r)}
                    >
                      {pendingDelete === r.id ? '确认删除?' : '删除'}
                    </Button>
                  </View>
                </View>
                <View className='rc-items'>
                  {r.items.map((it, i) => (
                    <View className='rc-item' key={i}>
                      <Text className='ri-name'>{it.food_name}</Text>
                      <Text className='ri-meta'>{it.quantity_text || `${it.grams} 克`} · {Math.round(Number(it.calories))} kcal</Text>
                    </View>
                  ))}
                </View>
              </View>
            )
          })}
        </View>
      )}

      <View className='bottom-space' />
    </View>
  )
}
