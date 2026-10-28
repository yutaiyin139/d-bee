import type { MealEntry, Profile } from './types'

/**
 * 演示数据与数据库 mock —— 供本地预览页与商店截图页共用。
 *
 * 抽自原 `src/preview-main.tsx`，避免两处各维护一份 demo 数据导致截图与预览不一致。
 * 只被 `preview.html` / `store-preview.html` 两个本地入口引用，
 * **不进正式构建**（`vite build` 只打包 `index.html`）。
 *
 * mock 会真正执行 eq('log_date', ...) 过滤，这样「当日餐次 / 饮食体检」只统计
 * 当天，而 gte/lte 区间查询（打卡与近 7 天趋势）能拿到整周数据。
 */

type Row = Record<string, unknown>

const now = new Date()
const dayKey = (offset: number) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const T = dayKey(0)

export const DEMO: Record<string, Row[]> = {
  meal_entries: [
    // 今天：一份高油早餐 + 全麦主食 + 优质蛋白午餐 + 加餐
    { id: 101, log_date: T, meal_type: 'breakfast', food_name: '油条', quantity_text: '1 根', grams: 60, calories: 232, protein_g: 4.2, carb_g: 25, fat_g: 13.2, health_score: 28 },
    { id: 102, log_date: T, meal_type: 'breakfast', food_name: '全麦面包', quantity_text: '2 片', grams: 80, calories: 200, protein_g: 7, carb_g: 36, fat_g: 3, health_score: 78 },
    { id: 103, log_date: T, meal_type: 'lunch', food_name: '鸡胸肉（熟）', quantity_text: '1 份', grams: 150, calories: 200, protein_g: 30, carb_g: 0, fat_g: 7.5, health_score: 92 },
    { id: 104, log_date: T, meal_type: 'lunch', food_name: '藜麦饭（熟）', quantity_text: '1 碗', grams: 200, calories: 240, protein_g: 8.8, carb_g: 42.6, fat_g: 3.8, health_score: 80 },
    { id: 105, log_date: T, meal_type: 'snack', food_name: '薯片', quantity_text: '1 小包', grams: 45, calories: 248, protein_g: 1.6, carb_g: 24, fat_g: 15.5, health_score: 22 },
    // 前 6 天：供打卡与近 7 天趋势使用
    ...[-6, -5, -4, -3, -2, -1].flatMap((off, i) => {
      const d = dayKey(off)
      const base = 1450 + i * 90
      return [
        { id: 200 + off * 10 + 1, log_date: d, meal_type: 'breakfast', food_name: '燕麦粥', quantity_text: '1 碗', grams: 250, calories: 320, protein_g: 12, carb_g: 54, fat_g: 6 },
        {
          id: 200 + off * 10 + 2,
          log_date: d,
          meal_type: 'lunch',
          food_name: '清蒸鲈鱼配米饭',
          quantity_text: '1 份',
          grams: 400,
          calories: base - 620,
          protein_g: 38,
          carb_g: 62,
          fat_g: 12,
        },
        { id: 200 + off * 10 + 3, log_date: d, meal_type: 'dinner', food_name: '番茄鸡蛋面', quantity_text: '1 碗', grams: 420, calories: 300, protein_g: 16, carb_g: 44, fat_g: 8 },
      ]
    }),
  ],
  water_logs: [{ id: 1, log_date: T, amount_ml: 750 }],
  exercise_logs: [{ id: 1, log_date: T, name: '慢跑', minutes: 30, calories: 264 }],
}

export interface Chain extends PromiseLike<{ data: Row[]; error: null }> {
  select(): Chain
  insert(v: Row | Row[]): Chain
  update(v: Row): Chain
  delete(): Chain
  eq(c: string, v: unknown): Chain
  in(c: string, v: unknown[]): Chain
  gte(c: string, v: unknown): Chain
  lte(c: string, v: unknown): Chain
  order(c: string, o?: { ascending?: boolean }): Chain
  limit(n: number): Chain
  maybeSingle(): Promise<{ data: Row | null; error: null }>
}

export function mockFrom(table: string): Chain {
  let data = (DEMO[table] ?? []).slice()
  const chain = {} as Chain
  const self = () => chain
  Object.assign(chain, {
    select: self,
    insert: self,
    update: self,
    delete: self,
    // 只实现 log_date 的等值过滤：够 Dashboard 区分「当日」与「整周」
    eq: (c: string, v: unknown) => {
      if (c === 'log_date') data = data.filter((r) => r.log_date === v)
      return chain
    },
    in: self,
    gte: self,
    lte: self,
    order: self,
    limit: self,
    maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
    then: (
      res: (r: { data: Row[]; error: null }) => void,
      rej: (e: unknown) => void,
    ) => Promise.resolve({ data, error: null }).then(res, rej),
  })
  return chain
}

export const DEMO_PROFILE = {
  nickname: '小蜜蜂',
  gender: 'female',
  age: 28,
  height_cm: 165,
  start_weight_kg: 58,
  current_weight_kg: 55.2,
  target_weight_kg: 50,
  activity_level: 'light',
  goal: 'lose',
  weekly_rate_kg: 0.5,
  daily_calorie_target: 1520,
  protein_target_g: 99,
  carb_target_g: 152,
  fat_target_g: 42,
  barriers: null,
  plan_summary: null,
  onboarded: true,
} as unknown as Profile

// 编译期护栏：确认 meal_type 字面量与真实类型一致，避免 DEMO 数据悄悄失效
const _guard: MealEntry['meal_type'][] = ['breakfast', 'lunch', 'dinner', 'snack']
void _guard
