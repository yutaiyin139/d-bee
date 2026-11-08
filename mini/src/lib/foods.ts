/**
 * 内置食物营养库（每 100g 可食部）—— 小程序端副本。
 *
 * 🔴 数据文件 foodsData*.ts 逐字复制自主工程 src/lib/，解析与检索逻辑亦与主端
 *    src/lib/foods.ts 同源。此前 mini 只有精简关键词版 foodInsight.ts，记一餐的
 *    「食物库」模式整体缺失，导致手动录入被移植成自由表单（与主端形态分叉）。
 *
 * 这里只保留「无环境依赖」的纯数据与纯函数：主端 foods.ts 的 foodInsight /
 * analyzeProfile / satiety 等画像能力 mini 已由 lib/foodInsight.ts 承担，不重复引入。
 * 三个数据源是紧凑分节文本，运行时解析，避免上千条对象字面量拖慢解析。
 */
import { CORE_ROWS } from './foodsDataCore'
import { FRESH_ROWS } from './foodsDataFresh'
import { DISH_ROWS } from './foodsDataDishes'

export interface FoodItem {
  name: string
  category: string
  kcal: number
  protein: number
  carb: number
  fat: number
  portionG: number
  portionLabel: string
  /** 钠 mg/100g（可选） */
  sodium?: number
  /** 膳食纤维 g/100g（可选） */
  fiber?: number
  /** 添加糖 g/100g（可选） */
  addedSugar?: number
}

/** 与主端 src/lib/foods.ts:33-72 逐字同源 */
function parse(raw: string): FoodItem[] {
  const out: FoodItem[] = []
  let category = '其他'

  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('#')) {
      category = t.slice(1).trim()
      continue
    }
    const p = t.split('|')
    if (p.length < 7) continue
    const kcal = Number(p[1])
    const protein = Number(p[2])
    const carb = Number(p[3])
    const fat = Number(p[4])
    const portionG = Number(p[5])
    if (!Number.isFinite(kcal) || !Number.isFinite(portionG) || portionG <= 0) continue
    const sodium = p.length > 7 ? Number(p[7]) : NaN
    const fiber = p.length > 8 ? Number(p[8]) : NaN
    const addedSugar = p.length > 9 ? Number(p[9]) : NaN
    out.push({
      name: p[0].trim(),
      category,
      kcal,
      protein: Number.isFinite(protein) ? protein : 0,
      carb: Number.isFinite(carb) ? carb : 0,
      fat: Number.isFinite(fat) ? fat : 0,
      portionG,
      portionLabel: p[6].trim(),
      sodium: Number.isFinite(sodium) ? sodium : undefined,
      fiber: Number.isFinite(fiber) ? fiber : undefined,
      addedSugar: Number.isFinite(addedSugar) ? addedSugar : undefined,
    })
  }
  return out
}

export const FOODS: FoodItem[] = [
  ...parse(CORE_ROWS),
  ...parse(FRESH_ROWS),
  ...parse(DISH_ROWS),
]

/** 按数据表中的出现顺序保留分类，浏览时更符合直觉 */
export const FOOD_CATEGORIES: string[] = Array.from(new Set(FOODS.map((f) => f.category)))

/** 检索食物：完全匹配 > 名称前缀 > 子串包含（与主端 searchFoods 同源） */
export function searchFoods(keyword: string, limit = 60): FoodItem[] {
  const q = keyword.trim().toLowerCase()
  if (!q) return []
  const exact: FoodItem[] = []
  const prefix: FoodItem[] = []
  const contains: FoodItem[] = []
  for (const f of FOODS) {
    const n = f.name.toLowerCase()
    if (n === q) exact.push(f)
    else if (n.startsWith(q)) prefix.push(f)
    else if (n.includes(q)) contains.push(f)
    if (exact.length > limit) break
  }
  return [...exact, ...prefix, ...contains].slice(0, limit)
}

/** 按分类浏览（与主端 listFoodsByCategory 同源） */
export function listFoodsByCategory(category: string, limit = 60): FoodItem[] {
  if (category === '全部') return FOODS.slice(0, limit)
  return FOODS.filter((f) => f.category === category).slice(0, limit)
}

/** 按食物名精确反查 */
export function lookupFood(name: string): FoodItem | null {
  const n = (name || '').trim()
  return FOODS.find((f) => f.name === n) ?? null
}
