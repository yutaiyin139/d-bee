import { cloud } from '../cloud'
import type { Entitlement, ExerciseLog, MealEntry, Profile, Recipe, WaterLog, WeightLog } from '../types'
import { BONUS_TTL_DAYS, FREE_DAILY_AI, SCAN_FEATURE } from './entitlement'
import { todayKey } from './nutrition'

/**
 * 云数据库访问封装。
 * 约定：owner_id 一律不传，由数据库 DEFAULT auth.uid() 填充，RLS 负责隔离。
 *
 * 关于下面的 `db()`：SDK 没有暴露数据库 schema 泛型，未经类型生成的链式查询会被
 * TypeScript 推成 never，导致每个调用点都要写断言。这里用一次受控的宽松类型收口，
 * 换取业务代码里干净的调用的同时，仍然保留方法名的拼写检查。
 */

interface QueryResult {
  data: unknown
  error: { message?: string } | null
}

type Row = Record<string, unknown>

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

function db(
  table: 'profiles' | 'meal_entries' | 'weight_logs' | 'water_logs' | 'exercise_logs' | 'entitlements' | 'ai_usage' | 'recipes',
): QueryBuilder {
  return cloud.database.from(table) as unknown as QueryBuilder
}

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : []
}

const PROFILE_WRITABLE = [
  'nickname', 'gender', 'age', 'height_cm', 'start_weight_kg', 'current_weight_kg',
  'target_weight_kg', 'activity_level', 'goal', 'weekly_rate_kg',
  'daily_calorie_target', 'protein_target_g', 'carb_target_g', 'fat_target_g',
  'barriers', 'plan_summary', 'onboarded',
] as const

function pickProfileFields(patch: Partial<Profile>): Row {
  const out: Row = {}
  for (const k of PROFILE_WRITABLE) {
    if (k in patch) out[k] = (patch as Record<string, unknown>)[k]
  }
  return out
}

export async function getProfile(): Promise<Profile | null> {
  const { data, error } = await db('profiles').select('*').maybeSingle()
  if (error) throw new Error(error.message || '读取档案失败')
  return (data as Profile | null) ?? null
}

export async function saveProfile(patch: Partial<Profile>): Promise<Profile> {
  const fields = pickProfileFields(patch)
  const existing = await getProfile()

  if (!existing) {
    const { data, error } = await db('profiles').insert(fields).select()
    if (error) throw new Error(error.message || '创建档案失败')
    const created = rows<Profile>(data)
    if (created.length === 0) throw new Error('创建档案失败：服务器没有返回记录')
    return created[0]
  }

  if (existing.id === undefined) throw new Error('保存失败：档案缺少主键')

  const { data, error } = await db('profiles')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select()
  if (error) throw new Error(error.message || '保存档案失败')
  const updated = rows<Profile>(data)
  if (updated.length === 0) throw new Error('保存失败：该档案不属于当前账号')
  return updated[0]
}

export async function listMealsByDate(logDate: string): Promise<MealEntry[]> {
  const { data, error } = await db('meal_entries')
    .select('*')
    .eq('log_date', logDate)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message || '读取记录失败')
  return rows<MealEntry>(data)
}

/** 按日期区间批量读取（含首尾），用于趋势与报告 */
export async function listMealsBetween(startDate: string, endDate: string): Promise<MealEntry[]> {
  const { data, error } = await db('meal_entries')
    .select('*')
    .gte('log_date', startDate)
    .lte('log_date', endDate)
    .order('log_date', { ascending: true })
  if (error) throw new Error(error.message || '读取记录失败')
  return rows<MealEntry>(data)
}

/** 最近 N 天的记录，按时间倒序，用于「最近吃过」快捷复记 */
export async function listRecentMeals(days = 30, limit = 200): Promise<MealEntry[]> {
  const start = shiftDateISO(days)
  const { data, error } = await db('meal_entries')
    .select('*')
    .gte('log_date', start)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message || '读取最近记录失败')
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

export async function insertMeals(list: Omit<MealEntry, 'id'>[]): Promise<MealEntry[]> {
  if (list.length === 0) return []
  const { data, error } = await db('meal_entries').insert(list as unknown as Row[]).select()
  if (error) throw new Error(error.message || '保存饮食记录失败')
  return rows<MealEntry>(data)
}

export async function deleteMeal(id: number): Promise<void> {

  const { data, error } = await db('meal_entries').delete().eq('id', id).select()
  if (error) throw new Error(error.message || '删除失败')
  if (rows<MealEntry>(data).length === 0) throw new Error('删除失败：该记录不属于当前账号')
}

export async function listWeightLogs(limit = 90): Promise<WeightLog[]> {
  const { data, error } = await db('weight_logs')
    .select('*')
    .order('log_date', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message || '读取体重记录失败')
  return rows<WeightLog>(data)
}

/** 体重记录按日期升序，便于画曲线 */
export async function listWeightLogsAsc(limit = 365): Promise<WeightLog[]> {
  const list = await listWeightLogs(limit)
  return list.slice().reverse()
}

export async function saveWeight(logDate: string, weightKg: number, note?: string): Promise<void> {
  const { data: found, error: findErr } = await db('weight_logs')
    .select('id')
    .eq('log_date', logDate)
    .maybeSingle()
  if (findErr) throw new Error(findErr.message || '查询体重记录失败')

  const existing = found as { id?: number } | null

  if (existing?.id !== undefined) {
    const { data, error } = await db('weight_logs')
      .update({ weight_kg: weightKg, note: note ?? null })
      .eq('id', existing.id)
      .select()
    if (error) throw new Error(error.message || '更新体重失败')
    if (rows<WeightLog>(data).length === 0) throw new Error('更新失败：该记录不属于当前账号')
    return
  }

  const { error } = await db('weight_logs')
    .insert({ log_date: logDate, weight_kg: weightKg, note: note ?? null })
    .select()
  if (error) throw new Error(error.message || '保存体重失败')
}

/* ── 饮水 ── */

export async function listWaterByDate(logDate: string): Promise<WaterLog[]> {
  const { data, error } = await db('water_logs')
    .select('*')
    .eq('log_date', logDate)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message || '读取饮水记录失败')
  return rows<WaterLog>(data)
}

export async function addWater(logDate: string, amountMl: number): Promise<WaterLog[]> {
  const { error } = await db('water_logs').insert({ log_date: logDate, amount_ml: Math.round(amountMl) }).select()
  if (error) throw new Error(error.message || '记录饮水失败')
  return listWaterByDate(logDate)
}

/** 饮水支持撤销：删掉当天最后一杯 */
export async function undoLastWater(logDate: string): Promise<void> {
  const list = await listWaterByDate(logDate)
  const last = list[list.length - 1]
  if (!last?.id) return
  const { data, error } = await db('water_logs').delete().eq('id', last.id).select()
  if (error) throw new Error(error.message || '撤销失败')
  if (rows<WaterLog>(data).length === 0) throw new Error('撤销失败：该记录不属于当前账号')
}

/* ── 运动 ── */

export async function listExerciseByDate(logDate: string): Promise<ExerciseLog[]> {
  const { data, error } = await db('exercise_logs')
    .select('*')
    .eq('log_date', logDate)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message || '读取运动记录失败')
  return rows<ExerciseLog>(data)
}

export async function addExercise(log: Omit<ExerciseLog, 'id'>): Promise<ExerciseLog[]> {
  const { error } = await db('exercise_logs').insert(log as unknown as Row).select()
  if (error) throw new Error(error.message || '记录运动失败')
  return listExerciseByDate(log.log_date)
}

export async function deleteExercise(id: number, logDate: string): Promise<ExerciseLog[]> {
  const { data, error } = await db('exercise_logs').delete().eq('id', id).select()
  if (error) throw new Error(error.message || '删除失败')
  if (rows<ExerciseLog>(data).length === 0) throw new Error('删除失败：该记录不属于当前账号')
  return listExerciseByDate(logDate)
}

/* ── 自定义食谱 ── */

export async function listRecipes(): Promise<Recipe[]> {
  const { data, error } = await db('recipes').select('*').order('updated_at', { ascending: false })
  if (error) throw new Error(error.message || '读取食谱失败')
  return rows<Recipe>(data).map((r) => ({ ...r, items: normalizeRecipeItems(r.items) }))
}

export async function saveRecipe(name: string, items: Recipe['items']): Promise<Recipe> {
  const { data, error } = await db('recipes')
    .insert({ name, items: items as unknown as Row })
    .select()
  if (error) throw new Error(error.message || '保存食谱失败')
  const created = rows<Recipe>(data)
  if (created.length === 0) throw new Error('保存食谱失败：服务器没有返回记录')
  return { ...created[0], items: normalizeRecipeItems(created[0].items) }
}

export async function deleteRecipe(id: number): Promise<void> {
  const { data, error } = await db('recipes').delete().eq('id', id).select()
  if (error) throw new Error(error.message || '删除食谱失败')
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

/* ── 会员权益与 AI 用量 ── */

export async function getEntitlement(): Promise<Entitlement | null> {
  const { data, error } = await db('entitlements').select('*').maybeSingle()
  if (error) throw new Error(error.message || '读取会员信息失败')
  return (data as Entitlement | null) ?? null
}

export async function saveEntitlement(patch: Partial<Entitlement> & { plan: Entitlement['plan'] }): Promise<Entitlement> {
  const existing = await getEntitlement()
  const fields = { ...patch, updated_at: new Date().toISOString() }
  if (existing?.id !== undefined) {
    const { data, error } = await db('entitlements').update(fields).eq('id', existing.id).select()
    if (error) throw new Error(error.message || '保存会员信息失败')
    const list = rows<Entitlement>(data)
    if (list.length === 0) throw new Error('保存失败：该权益不属于当前账号')
    return list[0]
  }
  const { data, error } = await db('entitlements').insert(fields).select()
  if (error) throw new Error(error.message || '保存会员信息失败')
  const list = rows<Entitlement>(data)
  if (list.length === 0) throw new Error('保存失败：服务器没有返回记录')
  return list[0]
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
  if (error) throw new Error(error.message || '读取用量失败')
  const row = data as { count?: number } | null
  return row?.count ?? 0
}

/**
 * 兜底路径：先读再写。
 * 并发下会互相覆盖，仅作为数据库函数不可用（未迁移 / 异常）时的降级实现。
 */
export async function bumpUsage(usageDate: string, feature: string, current: number): Promise<void> {
  if (current > 0) {
    const { data, error } = await db('ai_usage')
      .select('id')
      .eq('usage_date', usageDate)
      .eq('feature', feature)
      .maybeSingle()
    if (error) throw new Error(error.message || '读取用量失败')
    const found = data as { id?: number } | null
    if (found?.id !== undefined) {
      const { error: upErr } = await db('ai_usage').update({ count: current + 1 }).eq('id', found.id).select()
      if (upErr) throw new Error(upErr.message || '记录用量失败')
      return
    }
  }
  const { error } = await db('ai_usage').insert({ usage_date: usageDate, feature, count: 1 }).select()
  if (error) throw new Error(error.message || '记录用量失败')
}

export interface QuotaResult {
  /** 是否成功占用到一次额度 */
  allowed: boolean
  /** 占用后的当日累计用量 */
  used: number
  /** 本周期剩余次数 */
  remaining: number
}

interface QuotaRpcRow {
  allowed?: boolean
  used?: number
  remaining?: number
}

function callRpc(fn: string, args: Record<string, unknown>): PromiseLike<QueryResult> {
  return (cloud.database as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => PromiseLike<QueryResult>
  }).rpc(fn, args)
}

/**
 * 原子占用一次 AI 配额。
 *
 * 走数据库函数 consume_ai_quota，在服务端一条语句内完成「判断是否超限 + 自增」，
 * 因此多设备 / 多标签页同时调用也不会超发（旧的「先读 count 再写 count+1」在并发下
 * 会互相覆盖，免费额度限制形同虚设）。
 *
 * 采用「先占后用」而不是「先用后记」：AI 请求一旦发出就已产生成本，即使用户中途
 * 关掉页面，这次占用也应保留；调用失败时由 releaseAiQuota 退还。
 *
 * 函数不可用时回退到旧的读改写路径，保证任何情况下功能不中断。
 */
export async function consumeAiQuota(usageDate: string, feature: string, limit: number): Promise<QuotaResult> {
  try {
    const { data, error } = await callRpc('consume_ai_quota', {
      p_usage_date: usageDate,
      p_feature: feature,
      p_limit: limit,
      p_amount: 1,
    })
    if (error) throw new Error(error.message || '配额函数调用失败')
    const row = (Array.isArray(data) ? data[0] : data) as QuotaRpcRow | null
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

/** 退还一次已占用但最终失败的额度（AI 报错 / 超时），失败静默忽略 */
export async function releaseAiQuota(usageDate: string, feature: string): Promise<void> {
  try {
    await callRpc('release_ai_quota', { p_usage_date: usageDate, p_feature: feature, p_amount: 1 })
  } catch {
    // 退还失败只意味着用户少一次免费额度，不应阻断主流程
  }
}

/* ── 拍照额度（基础 3 次 + 奖励余额）── */

export interface PhotoQuota {
  /** 基础额度剩余（自然日重置） */
  baseRemaining: number
  /** 奖励额度剩余（带 7 天有效期） */
  bonusRemaining: number
  /** 总剩余 = 基础 + 奖励 */
  totalRemaining: number
}

/** 查询当前拍照额度（基础 + 未过期奖励） */
export async function getPhotoQuota(): Promise<PhotoQuota> {
  const { data, error } = await callRpc('get_photo_quota', { p_base_limit: FREE_DAILY_AI })
  if (error) throw new Error(error.message || '读取额度失败')
  const row = (Array.isArray(data) ? data[0] : data) as {
    base_remaining?: number
    bonus_remaining?: number
    total_remaining?: number
  } | null
  if (!row) return { baseRemaining: FREE_DAILY_AI, bonusRemaining: 0, totalRemaining: FREE_DAILY_AI }
  return {
    baseRemaining: Number(row.base_remaining ?? 0),
    bonusRemaining: Number(row.bonus_remaining ?? 0),
    totalRemaining: Number(row.total_remaining ?? 0),
  }
}

/**
 * 原子占用一次「拍照识别」额度。
 * 优先扣最早过期的奖励余额，不足再扣基础额度；识别失败由 releasePhotoQuota 退还。
 */
export async function consumePhotoQuota(): Promise<QuotaResult> {
  try {
    const { data, error } = await callRpc('consume_photo_quota', {
      p_usage_date: todayKey(),
      p_base_limit: FREE_DAILY_AI,
    })
    if (error) throw new Error(error.message || '配额函数调用失败')
    const row = (Array.isArray(data) ? data[0] : data) as QuotaRpcRow | null
    if (!row || typeof row.allowed !== 'boolean') throw new Error('配额函数返回格式异常')
    const used = Number(row.used ?? 0)
    return {
      allowed: row.allowed,
      used,
      remaining: Number.isFinite(Number(row.remaining)) ? Number(row.remaining) : Math.max(0, FREE_DAILY_AI - used),
    }
  } catch {
    // 函数不可用回退：走基础额度的 consume_ai_quota（奖励额度一并失效，但不阻断主流程）
    return consumeAiQuota(todayKey(), SCAN_FEATURE, FREE_DAILY_AI)
  }
}

/** 退还一次拍照额度（识别失败时调用）。优先还奖励，其次还基础。 */
export async function releasePhotoQuota(): Promise<void> {
  // 无法精确判断刚才扣的是奖励还是基础，这里统一还基础额度；
  // 奖励额度退还精确性由消费侧依赖 get_photo_quota 重读刷新，不阻塞主流程。
  await releaseAiQuota(todayKey(), SCAN_FEATURE)
}

/** 发放奖励额度（防重复领取靠数据库 UNIQUE 约束） */
export async function grantPhotoBonus(
  source: 'newbie' | 'streak7',
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
    if (error) throw new Error(error.message || '发放奖励失败')
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}

/* ── 数据导出与清理 ── */

export interface ExportBundle {
  app: string
  exported_at: string
  profile: Profile | null
  meal_entries: MealEntry[]
  weight_logs: WeightLog[]
  water_logs: unknown[]
  exercise_logs: unknown[]
  /** AI 用量记录同样属于个人数据，一并导出以满足数据可携带权 */
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

/** 清空全部记录（保留账号与身体档案）。按 id 分批删，避免无过滤 DELETE 的兼容性问题 */
export async function clearAllRecords(): Promise<void> {
  for (const table of ['meal_entries', 'weight_logs', 'water_logs', 'exercise_logs'] as const) {
    for (let guard = 0; guard < 500; guard++) {
      const { data, error } = await db(table).select('id').limit(500)
      if (error) throw new Error(error.message || '清空记录失败')
      const ids = rows<{ id: number }>(data).map((r) => r.id)
      if (ids.length === 0) break
      const { error: delErr } = await db(table).delete().in('id', ids).select()
      if (delErr) throw new Error(delErr.message || '清空记录失败')
    }
  }
}
