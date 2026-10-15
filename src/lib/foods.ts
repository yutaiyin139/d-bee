import { CORE_ROWS } from './foodsDataCore'
import { FRESH_ROWS } from './foodsDataFresh'
import { DISH_ROWS } from './foodsDataDishes'
import { analyzeProfile, type FoodInsight } from './foodInsight'

/**
 * 内置食物营养库（每 100g 可食部）。
 *
 * 数据参考《中国食物成分表（第 6 版）》常见条目，熟食与菜品按常见烹饪方式估算，
 * 为参考值而非精确检测值，不构成医疗建议。条目无法覆盖到的食物由 AI 兜底估算。
 *
 * 数据以紧凑的分节文本存放（见 foodsData*.ts），运行时解析，避免上千条对象字面量
 * 拖慢解析与增大打包体积。
 */

export interface FoodItem {
  name: string
  category: string
  kcal: number
  protein: number
  carb: number
  fat: number
  portionG: number
  portionLabel: string
  /** 钠 mg/100g（可选，内置库暂无此数据，AI 识别与自定义食谱会带） */
  sodium?: number
  /** 膳食纤维 g/100g（可选） */
  fiber?: number
  /** 添加糖 g/100g（可选） */
  addedSugar?: number
}

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
    // 第 8/9/10 列为可选微营养素（钠 mg/100g、膳食纤维 g/100g、添加糖 g/100g），
    // 兼容旧 7 列格式（缺失时读作 undefined，规则引擎回落关键词判断）。
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

/* 反查索引：饮食记录表里不存分类，做食物画像时按名字补回语境。
   别名（如「番茄（西红柿）」）按括号前的主名建索引，O(1) 命中。 */
const BY_NAME = new Map<string, FoodItem>()
const BY_PREFIX = new Map<string, string>()
for (const f of FOODS) {
  BY_NAME.set(f.name, f)
  const base = f.name.split('（')[0].trim()
  if (base && !BY_PREFIX.has(base)) BY_PREFIX.set(base, f.category)
}

/**
 * 按食物名反查分类，查不到返回「其他」。
 * 用途：给历史记录补上分类语境，让「蔬菜 / 水产 / 蛋奶」这类分类级益处与
 * 「快餐外卖 / 零食糕点」这类分类级风险也能作用在已记录的条目上。
 */
export function categoryOf(name: string): string {
  const n = (name || '').trim()
  if (!n) return '其他'
  const exact = BY_NAME.get(n)
  if (exact) return exact.category
  const base = n.split('（')[0].trim()
  return BY_PREFIX.get(base) ?? '其他'
}

/**
 * 检索食物：完全匹配 > 名称前缀 > 子串包含。
 * 名称里用全角括号写了别名（如「番茄（西红柿）」），因此用别名也能命中。
 */
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

/** 按分类浏览 */
export function listFoodsByCategory(category: string, limit = 60): FoodItem[] {
  if (category === '全部') return FOODS.slice(0, limit)
  return FOODS.filter((f) => f.category === category).slice(0, limit)
}

/**
 * 饱腹感（估算，0–100）：蛋白质与碳水的供能占比越高、热量密度越低，越抗饿。
 * 这是对「高蛋白低热量更顶饱」的直观量化，不是实测饱腹指数，仅用于排序参考。
 */
export function satiety(f: FoodItem): number {
  if (f.kcal <= 0) return 0
  const score = ((f.protein * 4 + f.carb * 2) / f.kcal) * 100
  return Math.max(0, Math.min(100, Math.round(score)))
}

export type FoodSort = 'default' | 'kcal_asc' | 'protein_desc' | 'satiety_desc' | 'healthy_desc'

export const FOOD_SORTS: { key: FoodSort; label: string }[] = [
  { key: 'default', label: '默认' },
  { key: 'kcal_asc', label: '热量低 → 高' },
  { key: 'protein_desc', label: '蛋白质高 → 低' },
  { key: 'satiety_desc', label: '更抗饿' },
  { key: 'healthy_desc', label: '更健康' },
]

/** 食物画像（风险 / 益处 / 友好度），按需现算，不常驻内存 */
export function foodInsight(f: FoodItem): FoodInsight {
  return analyzeProfile({
    name: f.name,
    category: f.category,
    kcal: f.kcal,
    protein: f.protein,
    carb: f.carb,
    fat: f.fat,
  })
}

/** 按分类浏览 + 排序（饱腹感、健康度会在需要时现算，不常驻内存） */
export function listFoods(category: string, sort: FoodSort, limit = 60): FoodItem[] {
  const src = category === '全部' ? FOODS : FOODS.filter((f) => f.category === category)
  let list = src
  if (sort === 'kcal_asc') list = [...src].sort((a, b) => a.kcal - b.kcal)
  if (sort === 'protein_desc') list = [...src].sort((a, b) => b.protein - a.protein || a.kcal - b.kcal)
  if (sort === 'satiety_desc') list = [...src].sort((a, b) => satiety(b) - satiety(a) || a.kcal - b.kcal)
  if (sort === 'healthy_desc') {
    list = [...src]
      .map((f) => ({ f, s: foodInsight(f).score }))
      .sort((a, b) => b.s - a.s || a.f.kcal - b.f.kcal)
      .map((x) => x.f)
  }
  return list.slice(0, limit)
}

/** 把每 100g 营养换算成指定克重 */
export function scaleFood(f: FoodItem, grams: number) {
  const r = grams / 100
  return {
    kcal: Math.round(f.kcal * r),
    protein: Math.round(f.protein * r * 10) / 10,
    carb: Math.round(f.carb * r * 10) / 10,
    fat: Math.round(f.fat * r * 10) / 10,
    sodium: f.sodium != null ? Math.round(f.sodium * r) : undefined,
    fiber: f.fiber != null ? Math.round(f.fiber * r * 10) / 10 : undefined,
    addedSugar: f.addedSugar != null ? Math.round(f.addedSugar * r * 10) / 10 : undefined,
  }
}

/**
 * 从「食物名」反查库里的营养数据，返回 null 表示库里没有（应走 AI 估算）。
 * 与 categoryOf 共用同一套别名反查，但这里要拿到完整 FoodItem。
 */
export function lookupFood(name: string): FoodItem | null {
  const n = (name || '').trim()
  if (!n) return null
  return BY_NAME.get(n) ?? null
}
