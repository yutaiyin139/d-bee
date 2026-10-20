/**
 * 小程序端云端数据访问层（精简版，与主工程 src/lib/api.ts 对齐）。
 *
 * 与主工程共用同一云端（同一 resourceId / RPC 函数 / 表结构），
 * 差异仅在于 cloud 实例来自 createMiniProgramWorkBuddyCloud（见 ./cloud.ts）。
 *
 * 与主工程 src/lib/api.ts 功能对齐（档案 / 饮食 / 饮水 / 运动 / 体重 /
 * 食谱 / 会员权益与 AI 用量 / 拍照额度 / 邀请 / 蜜糖积分 / 徽章 /
 * 数据导出清理 / 统一支付），四端共用同一后端，任一端的读写都会同步。
 *
 * owner_id 一律不传，由数据库 DEFAULT auth.uid() 填充，RLS 负责隔离（与主工程一致）。
 */
import { cloud } from './cloud'
import { FREE_DAILY_AI, BONUS_TTL_DAYS, type Entitlement, type UserPlan } from '@dbee/shared'

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
  invited_by?: string | null
  invite_code?: string | null
  ai_consented?: boolean | null
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

export interface HoneyLedger {
  id: number
  reason: string
  amount: number
  ref_id: string | null
  expires_at: string | null
  created_at: string
}

export interface Badge {
  id: number
  badge_key: string
  unlocked_at: string
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

/** 会员权益（与主工程一致，UserPlan / Entitlement 由 @dbee/shared 提供） */
export type { UserPlan, Entitlement } from '@dbee/shared'

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
  | 'invite_links'
  | 'badges'
  | 'recipes'
  | 'entitlements'
  | 'ai_usage'

interface QueryBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): QueryBuilder
  insert(values: Row | Row[]): QueryBuilder
  update(values: Row): QueryBuilder
  delete(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  in(column: string, values: unknown[]): QueryBuilder
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
  'barriers', 'plan_summary', 'onboarded', 'health_connected', 'health_connected_at', 'step_goal', 'ai_consented',
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

export async function listMealsBetween(startDate: string, endDate: string): Promise<MealEntry[]> {
  const { data, error } = await db('meal_entries')
    .select('*')
    .gte('log_date', startDate)
    .lte('log_date', endDate)
    .order('log_date', { ascending: true })
  if (error) throw new Error(`读取记录失败：${error.message ?? ''}`)
  return rows<MealEntry>(data)
}

/** 返回 days 天前的 YYYY-MM-DD（本地时区） */
function shiftDateISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export async function listRecentMeals(days = 30, limit = 200): Promise<MealEntry[]> {
  const start = shiftDateISO(days)
  const { data, error } = await db('meal_entries')
    .select('*')
    .gte('log_date', start)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`读取最近记录失败：${error.message ?? ''}`)
  return rows<MealEntry>(data)
}

/** 原位编辑份量：按「每克营养值」等比缩放，保留原食物构成 */
export async function updateMealGrams(id: number, grams: number): Promise<MealEntry> {
  const { data: found, error: findErr } = await db('meal_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (findErr) throw new Error(`读取记录失败：${findErr.message ?? ''}`)
  const existing = found as MealEntry | null
  if (!existing) throw new Error('该记录不存在或不属于当前账号')

  const g = Math.max(1, Math.round(grams))
  const baseGrams = Number(existing.grams) || 1
  const scale = g / baseGrams
  const round1 = (n: number) => Math.round(n * 10) / 10

  const patch: Row = {
    grams: g,
    quantity_text: `${g} 克`,
    calories: Math.round((Number(existing.calories) || 0) * scale),
    protein_g: round1((Number(existing.protein_g) || 0) * scale),
    carb_g: round1((Number(existing.carb_g) || 0) * scale),
    fat_g: round1((Number(existing.fat_g) || 0) * scale),
    sodium_mg: existing.sodium_mg != null ? Math.round((Number(existing.sodium_mg) || 0) * scale) : null,
    fiber_g: existing.fiber_g != null ? round1((Number(existing.fiber_g) || 0) * scale) : null,
    added_sugar_g: existing.added_sugar_g != null ? round1((Number(existing.added_sugar_g) || 0) * scale) : null,
  }

  const { data, error } = await db('meal_entries').update(patch).eq('id', id).select()
  if (error) throw new Error(`修改失败：${error.message ?? ''}`)
  const list = rows<MealEntry>(data)
  if (list.length === 0) throw new Error('修改失败：该记录不属于当前账号')
  return list[0]
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

/** 撤销最近一杯水（删最后一条饮水记录） */
export async function undoLastWater(logDate: string): Promise<void> {
  const list = await listWaterByDate(logDate)
  const last = list[list.length - 1]
  if (!last?.id) return
  await db('water_logs').delete().eq('id', last.id).select()
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

export async function deleteExercise(id: number, logDate: string): Promise<ExerciseLog[]> {
  const { data, error } = await db('exercise_logs').delete().eq('id', id).select()
  if (error) throw new Error(`删除失败：${error.message ?? ''}`)
  if (rows<ExerciseLog>(data).length === 0) throw new Error('删除失败：该记录不属于当前账号')
  return listExerciseByDate(logDate)
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

/** 升序体重记录（报告页体重曲线用） */
export async function listWeightLogsAsc(limit = 365): Promise<WeightLog[]> {
  const list = await listWeightLogs(limit)
  return list.slice().reverse()
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

/* ── 自定义食谱 ─────────────────────────────────────────────── */

export async function listRecipes(): Promise<Recipe[]> {
  const { data, error } = await db('recipes').select('*').order('updated_at', { ascending: false })
  if (error) throw new Error(`读取食谱失败：${error.message ?? ''}`)
  return rows<Recipe>(data).map((r) => ({ ...r, items: normalizeRecipeItems(r.items) }))
}

export async function saveRecipe(name: string, items: Recipe['items']): Promise<Recipe> {
  const { data, error } = await db('recipes')
    .insert({ name, items: items as unknown as Row })
    .select()
  if (error) throw new Error(`保存食谱失败：${error.message ?? ''}`)
  const created = rows<Recipe>(data)
  if (created.length === 0) throw new Error('保存食谱失败：服务器没有返回记录')
  return { ...created[0], items: normalizeRecipeItems(created[0].items) }
}

export async function deleteRecipe(id: number): Promise<void> {
  const { data, error } = await db('recipes').delete().eq('id', id).select()
  if (error) throw new Error(`删除食谱失败：${error.message ?? ''}`)
  if (rows<Recipe>(data).length === 0) throw new Error('删除失败：该食谱不属于当前账号')
}

/** 食谱 items 在库里是 jsonb，读回时可能已是数组也可能还是字符串，这里归一化 */
function normalizeRecipeItems(items: unknown): Recipe['items'] {
  if (Array.isArray(items)) return items as Recipe['items']
  if (typeof items === 'string') {
    try {
      const parsed = JSON.parse(items)
      return Array.isArray(parsed) ? (parsed as Recipe['items']) : []
    } catch {
      return []
    }
  }
  return []
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

/* ── 会员权益与 AI 用量 ─────────────────────────────────────── */

export async function getEntitlement(): Promise<Entitlement | null> {
  const { data, error } = await db('entitlements').select('*').maybeSingle()
  if (error) throw new Error(`读取会员信息失败：${error.message ?? ''}`)
  return (data as Entitlement | null) ?? null
}

export interface UsageRow {
  usage_date: string
  feature: string
  count: number
}

export async function getUsage(usageDate: string, feature: string): Promise<number> {
  const { data, error } = await db('ai_usage')
    .select('count')
    .eq('usage_date', usageDate)
    .eq('feature', feature)
    .maybeSingle()
  if (error) throw new Error(`读取用量失败：${error.message ?? ''}`)
  const row = data as { count?: number } | null
  return row?.count ?? 0
}

/** 兜底路径：先读再写（并发下会覆盖，仅作 RPC 不可用时的降级） */
export async function bumpUsage(usageDate: string, feature: string, current: number): Promise<void> {
  if (current > 0) {
    const { data, error } = await db('ai_usage')
      .select('id')
      .eq('usage_date', usageDate)
      .eq('feature', feature)
      .maybeSingle()
    if (error) throw new Error(`读取用量失败：${error.message ?? ''}`)
    const found = data as { id?: number } | null
    if (found?.id !== undefined) {
      const { error: upErr } = await db('ai_usage').update({ count: current + 1 }).eq('id', found.id).select()
      if (upErr) throw new Error(`记录用量失败：${upErr.message ?? ''}`)
      return
    }
  }
  const { error } = await db('ai_usage').insert({ usage_date: usageDate, feature, count: 1 }).select()
  if (error) throw new Error(`记录用量失败：${error.message ?? ''}`)
}

/** 原子占用一次 AI 配额（走 consume_ai_quota RPC，多端并发不超发） */
export async function consumeAiQuota(usageDate: string, feature: string, limit: number): Promise<QuotaResult> {
  try {
    const { data, error } = await callRpc('consume_ai_quota', {
      p_usage_date: usageDate,
      p_feature: feature,
      p_limit: limit,
      p_amount: 1,
    })
    if (error) throw new Error(`配额函数调用失败：${error.message ?? ''}`)
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; used?: number; remaining?: number } | null
    if (!row || typeof row.allowed !== 'boolean') throw new Error('配额函数返回格式异常')
    const used = Number(row.used ?? 0)
    return {
      allowed: row.allowed,
      used,
      remaining: Number.isFinite(Number(row.remaining)) ? Number(row.remaining) : Math.max(0, limit - used),
    }
  } catch {
    const used = await getUsage(usageDate, feature)
    if (used >= limit) return { allowed: false, used, remaining: 0 }
    await bumpUsage(usageDate, feature, used)
    return { allowed: true, used: used + 1, remaining: Math.max(0, limit - used - 1) }
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
  /** 是否成功占用到一次额度 */
  allowed: boolean
  /** 占用后的当日累计用量 */
  used: number
  /** 本周期剩余次数 */
  remaining: number
  /** 预占 token（识别失败退还时凭它精确释放；仅拍照额度返回，可空） */
  token?: string | null
}

/** 查询「当日成功拍照次数」（云端唯一真相源，跨设备一致） */
export async function getTodayPhotoCount(): Promise<number> {
  try {
    const { data, error } = await callRpc('get_today_photo_count', {})
    if (error) return 0
    const n = Number(Array.isArray(data) ? data[0] : data)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

export async function consumePhotoQuota(): Promise<QuotaResult> {
  const { data, error } = await callRpc('consume_photo_quota', {
    p_usage_date: todayKey(),
    p_base_limit: FREE_DAILY_AI,
  })
  if (error) return { allowed: false, used: 0, remaining: 0 }
  const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; token?: string; used?: number; remaining?: number } | null
  if (!row || typeof row.allowed !== 'boolean') return { allowed: false, used: 0, remaining: 0 }
  const used = Number(row.used ?? 0)
  return {
    allowed: row.allowed === true,
    used,
    remaining: Number.isFinite(Number(row.remaining)) ? Number(row.remaining) : Math.max(0, FREE_DAILY_AI - used),
    token: row.token ?? null,
  }
}

export async function releasePhotoQuota(token: string | null | undefined): Promise<void> {
  if (!token) return
  await callRpc('release_photo_quota', { p_token: token })
}

/** 发放拍照奖励额度（新手/连续打卡/积分兑换），grant_key 防重复 */
export async function grantPhotoBonus(
  source: 'newbie' | 'streak7' | 'honey',
  grantKey: string,
  amount: number,
  ttlDays = BONUS_TTL_DAYS,
): Promise<boolean> {
  try {
    const { data, error } = await callRpc('grant_photo_bonus', {
      p_source: source,
      p_grant_key: grantKey,
      p_amount: amount,
      p_ttl_days: ttlDays,
    })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

/* ── 邀请 / 积分 / 徽章 ─────────────────────────────────────── */

/** 生成 6 位邀请码（排除易混淆字符） */
function randomCode(len = 6): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

export async function getMyInviteCode(): Promise<string> {
  const existing = await db('invite_links').select('code').maybeSingle()
  const found = existing.data as { code?: string } | null
  if (found?.code) return found.code

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode()
    const { data, error } = await db('invite_links').insert({ code }).select()
    if (!error) {
      const row = rows<{ code: string }>(data)[0]
      if (row?.code) return row.code
    }
  }
  throw new Error('生成邀请码失败，请重试')
}

export async function listInvitees(): Promise<{ code: string; invitees: number; settled: number }> {
  const code = await getMyInviteCode()
  try {
    const { data, error } = await callRpc('count_invitees', {})
    if (error) return { code, invitees: 0, settled: 0 }
    const stats = (Array.isArray(data) ? data[0] : data) as { invitees?: number; settled?: number } | null
    return {
      code,
      invitees: Number(stats?.invitees ?? 0) || 0,
      settled: Number(stats?.settled ?? 0) || 0,
    }
  } catch {
    return { code, invitees: 0, settled: 0 }
  }
}

/** 新用户注册后绑定邀请码（原子：绑定关系 + 双向发积分，见 bind_invite RPC） */
export async function bindInvite(code: string): Promise<'ok' | 'invalid' | 'self' | 'already' | 'throttled'> {
  const normalized = code.trim().toUpperCase()
  if (!normalized) return 'invalid'

  try {
    const { data, error } = await callRpc('bind_invite', { p_code: normalized })
    if (error) return 'invalid'
    const status = (Array.isArray(data) ? data[0] : data) as string | null
    if (status === 'ok' || status === 'already' || status === 'self' || status === 'invalid' || status === 'throttled') {
      return status
    }
    return 'invalid'
  } catch {
    return 'invalid'
  }
}

/** 受邀人 7 日打卡达标后结算双向奖励（走 settle_invite_checkin RPC，幂等） */
export async function settleInviteCheckin(): Promise<boolean> {
  try {
    const { data, error } = await callRpc('settle_invite_checkin', {})
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

export async function listHoneyLedger(limit = 200): Promise<HoneyLedger[]> {
  const { data, error } = await db('honey_ledger')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`读取积分流水失败：${error.message ?? ''}`)
  return rows<HoneyLedger>(data)
}

/** 发放积分（走 RPC 原子发放 + UNIQUE 防重复，返回是否实际发放） */
export async function grantHoney(reason: string, refId: string, amount: number, ttlDays = 365): Promise<boolean> {
  try {
    const { data, error } = await callRpc('grant_honey', {
      p_reason: reason,
      p_ref_id: refId,
      p_amount: amount,
      p_ttl_days: ttlDays,
    })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

/** 兑换码核销（SECURITY DEFINER，服务端校验，返回 ok/used/bad） */
export async function redeemByCode(code: string): Promise<'ok' | 'used' | 'bad'> {
  try {
    const { data, error } = await callRpc('redeem_by_code', { p_code: code })
    if (error) return 'bad'
    const r = (Array.isArray(data) ? data[0] : data) as string
    return r === 'ok' || r === 'used' ? r : 'bad'
  } catch {
    return 'bad'
  }
}

/** 解锁徽章（UNIQUE 防重复，返回是否实际解锁） */
export async function unlockBadge(badgeKey: string): Promise<boolean> {
  try {
    const { data, error } = await callRpc('unlock_badge', { p_badge_key: badgeKey })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

/** 删除当日最后一条饮食记录后收回打卡积分（防刷，幂等，SECURITY DEFINER） */
export async function refundCheckinHoney(logDate: string): Promise<boolean> {
  try {
    const { data, error } = await callRpc('refund_checkin_honey_by_date', { p_log_date: logDate })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

/** 撤销饮水后，若当日总量不再达标则收回 checkin_water 积分（防刷，幂等） */
export async function refundCheckinWater(logDate: string): Promise<boolean> {
  try {
    const { data, error } = await callRpc('refund_checkin_water_by_date', { p_log_date: logDate })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

/** 删除运动后，若当日已无运动记录则收回 checkin_exercise 积分（防刷，幂等） */
export async function refundCheckinExercise(logDate: string): Promise<boolean> {
  try {
    const { data, error } = await callRpc('refund_checkin_exercise_by_date', { p_log_date: logDate })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

export async function expireStaleHoney(): Promise<number> {
  try {
    const { data, error } = await callRpc('expire_stale_honey', {})
    if (error) return 0
    return Number(Array.isArray(data) ? data[0] : data) || 0
  } catch {
    return 0
  }
}

export async function listMyBadges(): Promise<Badge[]> {
  const { data, error } = await db('badges').select('*').order('unlocked_at', { ascending: false })
  if (error) throw new Error(`读取徽章失败：${error.message ?? ''}`)
  return rows<Badge>(data)
}

export interface BadgeStats {
  photo_count: number
  barcode_count: number
  recipe_count: number
  water_days: number
  exercise_count: number
  weight_lost: number
  invitees: number
  invite_settled: number
}

export async function getBadgeStats(): Promise<BadgeStats | null> {
  try {
    const { data, error } = await callRpc('badge_stats', {})
    if (error) return null
    const d = (Array.isArray(data) ? data[0] : data) as BadgeStats | null
    if (!d || typeof d !== 'object') return null
    return {
      photo_count: Number(d.photo_count) || 0,
      barcode_count: Number(d.barcode_count) || 0,
      recipe_count: Number(d.recipe_count) || 0,
      water_days: Number(d.water_days) || 0,
      exercise_count: Number(d.exercise_count) || 0,
      weight_lost: Number(d.weight_lost) || 0,
      invitees: Number(d.invitees) || 0,
      invite_settled: Number(d.invite_settled) || 0,
    }
  } catch {
    return null
  }
}

/* ── 数据导出与清理 ─────────────────────────────────────── */

export interface ExportBundle {
  app: string
  exported_at: string
  profile: Profile | null
  meal_entries: MealEntry[]
  weight_logs: WeightLog[]
  water_logs: unknown[]
  exercise_logs: unknown[]
  ai_usage: unknown[]
}

export async function exportAllData(): Promise<ExportBundle> {
  const [profile, meals, weights, waters, exercises, usage] = await Promise.all([
    getProfile(),
    listMealsBetween('1970-01-01', '2999-12-31'),
    listWeightLogsAsc(3650),
    db('water_logs').select('*').order('log_date', { ascending: false }).limit(5000).then((r: QueryResult) => rows<unknown>(r.data)),
    db('exercise_logs').select('*').order('log_date', { ascending: false }).limit(5000).then((r: QueryResult) => rows<unknown>(r.data)),
    db('ai_usage').select('*').order('usage_date', { ascending: false }).limit(5000).then((r: QueryResult) => rows<unknown>(r.data)),
  ])
  return {
    app: 'D-Bee 自律蜜蜂',
    exported_at: new Date().toISOString(),
    profile,
    meal_entries: meals,
    weight_logs: weights,
    water_logs: waters,
    exercise_logs: exercises,
    ai_usage: usage,
  }
}

/** 清空全部记录（保留账号与身体档案）。按 id 分批删 */
export async function clearAllRecords(): Promise<void> {
  for (const table of ['meal_entries', 'weight_logs', 'water_logs', 'exercise_logs'] as const) {
    for (let guard = 0; guard < 500; guard++) {
      const { data, error } = await db(table).select('id').limit(500)
      if (error) throw new Error(`清空记录失败：${error.message ?? ''}`)
      const ids = rows<{ id: number }>(data).map((r) => r.id)
      if (ids.length === 0) break
      const { error: delErr } = await db(table).delete().in('id', ids).select()
      if (delErr) throw new Error(`清空记录失败：${delErr.message ?? ''}`)
    }
  }
}

/** 把全部饮食记录拼成 CSV 文本（UTF-8 BOM，Excel 直接打开不乱码） */
export function buildMealsCsv(meals: MealEntry[]): string {
  const csvCell = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const headers = ['日期', '餐次', '食物', '份量', '克数', '热量(kcal)', '蛋白质(g)', '碳水(g)', '脂肪(g)', '钠(mg)', '膳食纤维(g)', '添加糖(g)', '来源']
  const mealCn: Record<string, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
  const lines: string[] = [headers.join(',')]
  for (const m of meals) {
    lines.push([
      m.log_date, mealCn[m.meal_type] ?? m.meal_type, m.food_name, m.quantity_text ?? '', m.grams ?? '',
      m.calories, m.protein_g, m.carb_g, m.fat_g, m.sodium_mg ?? '', m.fiber_g ?? '', m.added_sugar_g ?? '', m.source,
    ].map(csvCell).join(','))
  }
  return '\ufeff' + lines.join('\r\n')
}

/* ── 统一支付（订单 + 核销，走服务端 RPC）── */

/** 服务端下单返回的订单信息 */
export interface PaymentOrder {
  order_no: string
  product_id: string
  plan: 'pro' | 'lifetime'
  months: number | null
  amount_cents: number
  currency: string
}

/** 创建支付订单（服务端查价，客户端只传 product_id + provider） */
export async function createPaymentOrder(
  productId: string,
  provider: 'apple' | 'google' | 'wechat' | 'alipay',
): Promise<PaymentOrder> {
  const { data, error } = await callRpc('create_payment_order', {
    p_product_id: productId,
    p_provider: provider,
  })
  if (error) throw new Error(`创建订单失败：${error.message ?? ''}`)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row || row.error) throw new Error('创建订单失败')
  return {
    order_no: String(row.order_no),
    product_id: String(row.product_id),
    plan: row.plan as 'pro' | 'lifetime',
    months: row.months == null ? null : Number(row.months),
    amount_cents: Number(row.amount_cents),
    currency: String(row.currency),
  }
}

/** 核销订单（回传平台凭证，服务端幂等发权益） */
export async function verifyPaymentOrder(
  orderNo: string,
  providerTxnId: string,
  receipt: string,
): Promise<boolean> {
  try {
    const { data, error } = await callRpc('verify_payment_order', {
      p_order_no: orderNo,
      p_provider_txn_id: providerTxnId,
      p_receipt: receipt,
    })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}
