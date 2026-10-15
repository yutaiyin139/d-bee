export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export type RecordSource = 'photo' | 'text' | 'barcode' | 'manual'

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
}

export const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack']

export interface Profile {
  id?: number
  nickname: string | null
  gender: 'male' | 'female' | null
  age: number | null
  height_cm: number | null
  start_weight_kg: number | null
  current_weight_kg: number | null
  target_weight_kg: number | null
  activity_level: string | null
  goal: 'lose' | 'keep' | 'gain' | null
  weekly_rate_kg: number | null
  daily_calorie_target: number | null
  protein_target_g: number | null
  carb_target_g: number | null
  fat_target_g: number | null
  barriers: string | null
  plan_summary: string | null
  onboarded: boolean
}

export interface MealEntry {
  id?: number
  log_date: string
  meal_type: MealType
  food_name: string
  quantity_text: string | null
  grams: number | null
  calories: number
  protein_g: number
  carb_g: number
  fat_g: number
  /** 钠（毫克） */
  sodium_mg?: number | null
  /** 膳食纤维（克） */
  fiber_g?: number | null
  /** 添加糖（克） */
  added_sugar_g?: number | null
  source: RecordSource
  image_url?: string | null
  ai_note?: string | null
  health_score?: number | null
  created_at?: string
}

/** AI 识别 / 解析出的单条食物结果（尚未落库） */
export interface DetectedFood {
  food_name: string
  quantity_text: string
  grams: number
  calories: number
  protein_g: number
  carb_g: number
  fat_g: number
  sodium_mg?: number
  fiber_g?: number
  added_sugar_g?: number
  note?: string
  health_score?: number
  /** 识别置信度 0–100（包装识别有，餐盘识别无） */
  confidence?: number
}

export interface WeightLog {
  id?: number
  log_date: string
  weight_kg: number
  note?: string | null
}

export interface WaterLog {
  id?: number
  log_date: string
  amount_ml: number
  created_at?: string
}

export interface ExerciseLog {
  id?: number
  log_date: string
  name: string
  minutes: number
  calories: number
  created_at?: string
}

/**
 * 会员三档：
 *  - free      免费（每日限次 AI）
 *  - pro       订阅制（pro_until 为过期时间，到期自动回落到 free）
 *  - lifetime  终身买断（pro_until 恒为 null，永久有效）
 */
export type UserPlan = 'free' | 'pro' | 'lifetime'

export interface Entitlement {
  id?: number
  plan: UserPlan
  pro_until: string | null
  redeemed_code: string | null
  /** 支付来源：redeem(兑换码) / wechat / alipay / apple / google；未接真实支付前为空或 redeem */
  source?: string | null
  updated_at?: string
}

/** 自定义食谱里的单条食物（营养按「实际摄入量」存，非每 100g） */
export interface RecipeItem {
  food_name: string
  quantity_text: string
  grams: number
  calories: number
  protein_g: number
  carb_g: number
  fat_g: number
  sodium_mg?: number | null
  fiber_g?: number | null
  added_sugar_g?: number | null
}

/** 用户自定义食谱模板（一餐 = 若干食物条目） */
export interface Recipe {
  id?: number
  name: string
  items: RecipeItem[]
  created_at?: string
  updated_at?: string
}
