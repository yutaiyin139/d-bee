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
  note?: string
  health_score?: number
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

export type UserPlan = 'free' | 'pro'

export interface Entitlement {
  id?: number
  plan: UserPlan
  pro_until: string | null
  redeemed_code: string | null
  updated_at?: string
}
