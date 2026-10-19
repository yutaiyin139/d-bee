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
  /** 邀请人 owner_id（绑定后不可改，仅由绑定逻辑写入） */
  invited_by?: string | null
  /** 注册时填写的邀请码（审计用） */
  invite_code?: string | null
  /** 是否已连接 Apple 健康（云端唯一真相源，跨设备一致） */
  health_connected?: boolean | null
  /** Apple 健康连接时间 */
  health_connected_at?: string | null
  /** 每日步数目标（运动卡片进度条；默认 6000，可在「我的」里设置） */
  step_goal?: number | null
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
 *  - free      免费（每日 3 次拍照识别 + 积分兑换每日最多 2 次）
 *  - pro       订阅制（pro_until 为过期时间，到期自动回落到 free）
 *  - lifetime  终身买断（pro_until 恒为 null，永久有效）
 */
// 会员权益类型（UserPlan / Entitlement）统一由 @dbee/shared 提供单一真相源，
// 这里 re-export 以兼容既有 `import { ... } from '../types'` 调用点。
export type { UserPlan, Entitlement } from '@dbee/shared'

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

/* ── 邀约拉新 + 蜜糖积分 + 成就徽章 ── */

/** 邀请码（一人一码） */
export interface InviteLink {
  id?: number
  code: string
  created_at?: string
}

/** 蜜糖积分账本流水（正负记账） */
export interface HoneyLedger {
  id?: number
  amount: number
  reason: string
  ref_id: string | null
  expires_at: string | null
  created_at?: string
}

/** 积分余额（含即将过期） */
export interface HoneyBalance {
  /** 当前可用余额（未过期入账 − 未过期消耗） */
  balance: number
  /** 累计获得 */
  totalEarned: number
  /** 累计消耗 */
  totalSpent: number
}

/** 受邀好友状态（邀请记录面板用） */
export interface InviteeStatus {
  /** 好友昵称快照（可能为空） */
  nickname: string | null
  /** 注册时间 */
  invited_at: string | null
  /** 7 日内是否完成 ≥5 天打卡 */
  checkinDone: boolean
  /** 是否已订阅（占位，真实支付后填充） */
  subscribed: boolean
}

/** 成就徽章 */
export interface Badge {
  id?: number
  badge_key: string
  unlocked_at?: string
}

/** 徽章定义（前端静态清单，key 与 badges 表 badge_key 对应） */
export interface BadgeDef {
  key: string
  name: string
  desc: string
  /** 分类：checkin 打卡 / record 记录 / health 健康 / social 社群 */
  category: 'checkin' | 'record' | 'health' | 'social'
}
