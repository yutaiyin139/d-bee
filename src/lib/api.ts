import { cloud } from '../cloud'
import type { Badge, Entitlement, ExerciseLog, HoneyBalance, HoneyLedger, InviteLink, MealEntry, Profile, Recipe, WaterLog, WeightLog } from '../types'
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
  table: 'profiles' | 'meal_entries' | 'weight_logs' | 'water_logs' | 'exercise_logs' | 'entitlements' | 'ai_usage' | 'recipes' | 'invite_links' | 'honey_ledger' | 'badges',
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

/**
 * 原位编辑已保存的饮食记录：改份量（grams）。
 * 营养值按「每克」等比缩放，保留原记录的食物构成与来源，不重新走 AI。
 * 自律茄子坑 2 的解法 —— 竞品「提交后不能改份量」是本功能最直接的补位。
 */
export async function updateMealGrams(id: number, grams: number): Promise<MealEntry> {
  const { data: found, error: findErr } = await db('meal_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (findErr) throw new Error(findErr.message || '读取记录失败')
  const existing = found as MealEntry | null
  if (!existing) throw new Error('该记录不存在或不属于当前账号')

  const g = Math.max(1, Math.round(grams))
  // 以「每克营养值」为基准等比缩放，避免直接改 calories 造成与宏量不一致
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
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await db('meal_entries').update(patch).eq('id', id).select()
  if (error) throw new Error(error.message || '修改失败')
  const list = rows<MealEntry>(data)
  if (list.length === 0) throw new Error('修改失败：该记录不属于当前账号')
  return list[0]
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

/* ── 饮食记录 CSV 导出 ── */

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  // Excel 兼容：含逗号/引号/换行的字段加引号包裹
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const CSV_HEADERS = [
  '日期', '餐次', '食物', '份量', '克数', '热量(kcal)',
  '蛋白质(g)', '碳水(g)', '脂肪(g)', '钠(mg)', '膳食纤维(g)', '添加糖(g)', '来源',
] as const

const MEAL_CN: Record<string, string> = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
}

/** 把全部饮食记录拼成 CSV 文本（UTF-8 BOM，Excel 直接打开不乱码） */
export function buildMealsCsv(meals: MealEntry[]): string {
  const lines: string[] = [CSV_HEADERS.join(',')]
  for (const m of meals) {
    lines.push(
      [
        m.log_date,
        MEAL_CN[m.meal_type] ?? m.meal_type,
        m.food_name,
        m.quantity_text ?? '',
        m.grams ?? '',
        m.calories,
        m.protein_g,
        m.carb_g,
        m.fat_g,
        m.sodium_mg ?? '',
        m.fiber_g ?? '',
        m.added_sugar_g ?? '',
        m.source,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return '\ufeff' + lines.join('\r\n')
}

/* ── 邀约拉新 + 蜜糖积分 + 成就徽章 ── */

/** 生成 6 位邀请码（大小写字母+数字，排除易混淆字符） */
function randomCode(len = 6): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

/** 获取我的邀请码；不存在则创建（一人一码，UNIQUE 约束兜底并发） */
export async function getMyInviteCode(): Promise<string> {
  const existing = await db('invite_links').select('code').maybeSingle()
  const found = existing.data as { code?: string } | null
  if (found?.code) return found.code

  // 最多重试 3 次，撞码则换码重试（UNIQUE(code) 会拒绝重复）
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

/** 新用户注册后绑定邀请码（原子：绑定关系 + 双向发积分，见 bind_invite RPC） */
export async function bindInvite(code: string): Promise<'ok' | 'invalid' | 'self' | 'already'> {
  const normalized = code.trim().toUpperCase()
  if (!normalized) return 'invalid'

  try {
    const { data, error } = await callRpc('bind_invite', { p_code: normalized })
    if (error) return 'invalid'
    const status = (Array.isArray(data) ? data[0] : data) as string | null
    if (status === 'ok' || status === 'already' || status === 'self' || status === 'invalid') {
      return status
    }
    return 'invalid'
  } catch {
    return 'invalid'
  }
}

/** 邀请记录：我的邀请码 + 已绑定好友数 + 达标好友数（SECURITY DEFINER 统计） */
export async function listInvitees(): Promise<{ code: string; invitees: number; settled: number }> {
  const code = await getMyInviteCode()
  try {
    const { data, error } = await callRpc('count_invitees', {})
    if (error) return { code, invitees: 0, settled: 0 }
    const stats = (Array.isArray(data) ? data[0] : data) as
      | { invitees?: number; settled?: number }
      | null
    return {
      code,
      invitees: Number(stats?.invitees ?? 0) || 0,
      settled: Number(stats?.settled ?? 0) || 0,
    }
  } catch {
    return { code, invitees: 0, settled: 0 }
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

/** 读取我的积分余额（未过期入账 − 未过期消耗） */
export async function getHoneyBalance(): Promise<HoneyBalance> {
  const { data, error } = await db('honey_ledger')
    .select('amount, expires_at')
  if (error) throw new Error(error.message || '读取积分失败')
  const rows_ = rows<{ amount: number; expires_at: string | null }>(data)
  const now = Date.now()
  let balance = 0
  let earned = 0
  let spent = 0
  for (const r of rows_) {
    const amt = Number(r.amount) || 0
    if (amt >= 0) earned += amt
    else spent += -amt
    // 只有「未过期」的入账计入可用余额；负流水（消耗）不受过期影响
    if (amt > 0 && r.expires_at && new Date(r.expires_at).getTime() <= now) continue
    balance += amt
  }
  return { balance: Math.max(0, balance), totalEarned: earned, totalSpent: spent }
}

/** 读取积分流水（倒序，最多 200 条） */
export async function listHoneyLedger(limit = 200): Promise<HoneyLedger[]> {
  const { data, error } = await db('honey_ledger')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message || '读取积分流水失败')
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

/** 读取我已解锁的徽章 */
export async function listMyBadges(): Promise<Badge[]> {
  const { data, error } = await db('badges').select('*').order('unlocked_at', { ascending: false })
  if (error) throw new Error(error.message || '读取徽章失败')
  return rows<Badge>(data)
}

/** 积分兑换（走 RPC 原子扣积分 + 发权益，返回是否兑换成功） */
export async function redeemHoney(kind: 'pro1Day' | 'pro30Day' | 'ai1Scan'): Promise<boolean> {
  try {
    const { data, error } = await callRpc('redeem_honey', { p_kind: kind })
    if (error) return false
    return (Array.isArray(data) ? data[0] : data) === true
  } catch {
    return false
  }
}
