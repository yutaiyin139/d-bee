/**
 * 小程序端云端数据访问层（精简版，与主工程 src/lib/api.ts 对齐）。
 *
 * 与主工程共用同一云端（同一 resourceId / RPC 函数 / 表结构），
 * 差异仅在于 cloud 实例来自 createMiniProgramWorkBuddyCloud（见 ./cloud.ts）。
 *
 * 这里只实现 MVP 所需的核心函数：
 *  - 档案 getProfile / saveProfile
 *  - 饮食记录（手动）insertMeals / listMealsByDate / deleteMeal
 *  - 饮水 addWater / listWaterByDate
 *  - 运动 addExercise / listExerciseByDate
 *  - 体重 saveWeight / listWeightLogs
 *  - 积分 getHoneyBalance / redeemHoney
 *  - 拍照额度 getPhotoQuota / consumePhotoQuota / releasePhotoQuota
 *
 * owner_id 一律不传，由数据库 DEFAULT auth.uid() 填充，RLS 负责隔离（与主工程一致）。
 */
import { cloud } from './cloud'
import { FREE_DAILY_AI } from '@dbee/shared'

/* ── 类型（与主工程 src/types.ts 一致，这里精简内联）──────────────── */

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export type RecordSource = 'photo' | 'text' | 'barcode' | 'manual'

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
  health_connected?: boolean | null
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
  sodium_mg?: number | null
  fiber_g?: number | null
  added_sugar_g?: number | null
  source: RecordSource
  image_url?: string | null
  ai_note?: string | null
  health_score?: number | null
  created_at?: string
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

export interface HoneyBalance {
  balance: number
  totalEarned: number
  totalSpent: number
}

export interface PhotoQuota {
  baseRemaining: number
  bonusRemaining: number
  totalRemaining: number
}

/* ── 底层封装（对齐主工程）────────────────────────────────────── */

interface QueryResult {
  data: unknown
  error: { message?: string } | null
}

type Row = Record<string, unknown>

type TableName =
  | 'profiles'
  | 'meal_entries'
  | 'weight_logs'
  | 'water_logs'
  | 'exercise_logs'
  | 'honey_ledger'

interface QueryBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): QueryBuilder
  insert(values: Row | Row[]): QueryBuilder
  update(values: Row): QueryBuilder
  delete(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  gte(column: string, value: unknown): QueryBuilder
  lte(column: string, value: unknown): QueryBuilder
  order(column: string, options?: { ascending?: boolean }): QueryBuilder
  limit(count: number): QueryBuilder
  maybeSingle(): Promise<QueryResult>
}

function db(table: TableName): QueryBuilder {
  return cloud.database.from(table) as unknown as QueryBuilder
}

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : []
}

function callRpc(fn: string, args: Record<string, unknown>): PromiseLike<QueryResult> {
  return (cloud.database as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => PromiseLike<QueryResult>
  }).rpc(fn, args)
}

/** 本地日期 YYYY-MM-DD（打卡记录用的自然日） */
export function todayKey(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/* ── 档案 ─────────────────────────────────────────────────────── */

const PROFILE_WRITABLE = [
  'nickname', 'gender', 'age', 'height_cm', 'start_weight_kg', 'current_weight_kg',
  'target_weight_kg', 'activity_level', 'goal', 'weekly_rate_kg',
  'daily_calorie_target', 'protein_target_g', 'carb_target_g', 'fat_target_g',
  'barriers', 'plan_summary', 'onboarded', 'health_connected', 'health_connected_at', 'step_goal',
] as const

export async function getProfile(): Promise<Profile | null> {
  const { data, error } = await db('profiles').select('*').maybeSingle()
  if (error) throw new Error(`读取档案失败：${error.message ?? ''}`)
  return (data as Profile | null) ?? null
}

export async function saveProfile(patch: Partial<Profile>): Promise<Profile> {
  const fields: Row = {}
  for (const k of PROFILE_WRITABLE) {
    if (k in patch) fields[k] = (patch as Record<string, unknown>)[k]
  }
  const existing = await getProfile()
  if (!existing) {
    const { data, error } = await db('profiles').insert(fields).select()
    if (error) throw new Error(`创建档案失败：${error.message ?? ''}`)
    const created = rows<Profile>(data)
    if (created.length === 0) throw new Error('创建档案失败：服务器没有返回记录')
    return created[0]
  }
  const { data, error } = await db('profiles').update(fields).eq('id', existing.id).select()
  if (error) throw new Error(`更新档案失败：${error.message ?? ''}`)
  const list = rows<Profile>(data)
  return list[0] ?? existing
}

/* ── 饮食记录（手动）──────────────────────────────────────────── */

export async function listMealsByDate(logDate: string): Promise<MealEntry[]> {
  const { data, error } = await db('meal_entries')
    .select('*')
    .eq('log_date', logDate)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`读取记录失败：${error.message ?? ''}`)
  return rows<MealEntry>(data)
}

export async function insertMeals(list: Omit<MealEntry, 'id'>[]): Promise<MealEntry[]> {
  if (list.length === 0) return []
  const { data, error } = await db('meal_entries').insert(list as unknown as Row[]).select()
  if (error) throw new Error(`保存饮食记录失败：${error.message ?? ''}`)
  return rows<MealEntry>(data)
}

export async function deleteMeal(id: number): Promise<void> {
  const { data, error } = await db('meal_entries').delete().eq('id', id).select()
  if (error) throw new Error(`删除失败：${error.message ?? ''}`)
  if (rows<MealEntry>(data).length === 0) throw new Error('删除失败：该记录不属于当前账号')
}

/* ── 饮水 ─────────────────────────────────────────────────────── */

export async function listWaterByDate(logDate: string): Promise<WaterLog[]> {
  const { data, error } = await db('water_logs')
    .select('*')
    .eq('log_date', logDate)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`读取饮水记录失败：${error.message ?? ''}`)
  return rows<WaterLog>(data)
}

export async function addWater(logDate: string, amountMl: number): Promise<WaterLog[]> {
  const { error } = await db('water_logs').insert({ log_date: logDate, amount_ml: Math.round(amountMl) }).select()
  if (error) throw new Error(`记录饮水失败：${error.message ?? ''}`)
  return listWaterByDate(logDate)
}

/* ── 运动 ─────────────────────────────────────────────────────── */

export async function listExerciseByDate(logDate: string): Promise<ExerciseLog[]> {
  const { data, error } = await db('exercise_logs')
    .select('*')
    .eq('log_date', logDate)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`读取运动记录失败：${error.message ?? ''}`)
  return rows<ExerciseLog>(data)
}

export async function addExercise(log: Omit<ExerciseLog, 'id'>): Promise<ExerciseLog[]> {
  const { error } = await db('exercise_logs').insert(log as unknown as Row).select()
  if (error) throw new Error(`记录运动失败：${error.message ?? ''}`)
  return listExerciseByDate(log.log_date)
}

/* ── 体重 ─────────────────────────────────────────────────────── */

export async function listWeightLogs(limit = 90): Promise<WeightLog[]> {
  const { data, error } = await db('weight_logs')
    .select('*')
    .order('log_date', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`读取体重记录失败：${error.message ?? ''}`)
  return rows<WeightLog>(data)
}

export async function saveWeight(logDate: string, weightKg: number, note?: string): Promise<void> {
  const { data: found, error: findErr } = await db('weight_logs')
    .select('id')
    .eq('log_date', logDate)
    .maybeSingle()
  if (findErr) throw new Error(`查询体重记录失败：${findErr.message ?? ''}`)
  const existing = found as { id?: number } | null

  if (existing?.id !== undefined) {
    const { data, error } = await db('weight_logs')
      .update({ weight_kg: weightKg, note: note ?? null })
      .eq('id', existing.id)
      .select()
    if (error) throw new Error(`更新体重失败：${error.message ?? ''}`)
    if (rows<WeightLog>(data).length === 0) throw new Error('更新失败：该记录不属于当前账号')
    return
  }
  const { error } = await db('weight_logs').insert({ log_date: logDate, weight_kg: weightKg, note: note ?? null }).select()
  if (error) throw new Error(`保存体重失败：${error.message ?? ''}`)
}

/* ── 积分 ─────────────────────────────────────────────────────── */

export async function getHoneyBalance(): Promise<HoneyBalance> {
  const { data, error } = await db('honey_ledger').select('amount, expires_at')
  if (error) throw new Error(`读取积分失败：${error.message ?? ''}`)
  const rs = rows<{ amount: number; expires_at: string | null }>(data)
  const now = Date.now()
  let balance = 0
  let earned = 0
  let spent = 0
  for (const r of rs) {
    const amt = Number(r.amount) || 0
    if (amt >= 0) earned += amt
    else spent += -amt
    if (amt > 0 && r.expires_at && new Date(r.expires_at).getTime() <= now) continue
    balance += amt
  }
  return { balance: Math.max(0, balance), totalEarned: earned, totalSpent: spent }
}

export type RedeemOutcome = { ok: boolean; message: string }

export async function redeemHoney(kind: 'pro1Day' | 'pro30Day' | 'ai1Scan'): Promise<RedeemOutcome> {
  try {
    const { data, error } = await callRpc('redeem_honey', { p_kind: kind })
    if (error) return { ok: false, message: error.message ?? '兑换失败，请稍后重试' }
    const v = Array.isArray(data) ? data[0] : data
    if (v === true || v === 'true' || v === 1 || v === '1') return { ok: true, message: '兑换成功' }
    return { ok: false, message: '兑换失败，请稍后重试' }
  } catch {
    return { ok: false, message: '兑换失败，请稍后重试' }
  }
}

/* ── 拍照额度（AI 识别前置）───────────────────────────────────── */

export async function getPhotoQuota(): Promise<PhotoQuota> {
  const { data, error } = await callRpc('get_photo_quota', { p_base_limit: FREE_DAILY_AI })
  if (error) return { baseRemaining: FREE_DAILY_AI, bonusRemaining: 0, totalRemaining: FREE_DAILY_AI }
  const row = (Array.isArray(data) ? data[0] : data) as { base_remaining?: number; bonus_remaining?: number; total_remaining?: number } | null
  if (!row) return { baseRemaining: FREE_DAILY_AI, bonusRemaining: 0, totalRemaining: FREE_DAILY_AI }
  return {
    baseRemaining: Number(row.base_remaining ?? 0),
    bonusRemaining: Number(row.bonus_remaining ?? 0),
    totalRemaining: Number(row.total_remaining ?? 0),
  }
}

export interface QuotaResult {
  allowed: boolean
  token: string | null
  remaining: number
}

export async function consumePhotoQuota(): Promise<QuotaResult> {
  const { data, error } = await callRpc('consume_photo_quota', {
    p_usage_date: todayKey(),
    p_base_limit: FREE_DAILY_AI,
  })
  if (error) return { allowed: false, token: null, remaining: 0 }
  const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; token?: string; remaining?: number } | null
  if (!row || typeof row.allowed !== 'boolean') return { allowed: false, token: null, remaining: 0 }
  return {
    allowed: row.allowed === true,
    token: row.token ?? null,
    remaining: Number(row.remaining ?? 0),
  }
}

export async function releasePhotoQuota(token: string | null): Promise<void> {
  if (!token) return
  await callRpc('release_photo_quota', { p_token: token })
}
