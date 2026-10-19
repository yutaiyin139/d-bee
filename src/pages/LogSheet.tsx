import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteRecipe, getHoneyBalance, insertMeals, listRecentMeals, listRecipes, saveRecipe } from '../lib/api'
import { compressImage, identifyPackagedFood, parseFoodFromText, recognizeFoodFromImage } from '../lib/ai'
import { lookupBarcode } from '../lib/off'
import {
  categoryOf,
  FOOD_CATEGORIES,
  FOOD_SORTS,
  foodInsight,
  listFoods,
  lookupFood,
  satiety,
  searchFoods,
  type FoodItem,
  type FoodSort,
} from '../lib/foods'
import { analyzeProfile, LEVEL_LABELS, levelOfScore, summarizeEntries } from '../lib/foodInsight'
import { quotaExhaustedReason, AI_REDEEM_DAILY_LIMIT } from '../lib/entitlement'
import { HONEY_PRICE } from '../lib/invite'
import {
  photoLadderHint,
  isDuplicatePhoto,
  summarizePhoto,
  FREE_DAILY_AI,
  type PhotoSummary,
} from '../lib/photoGuard'
import { getTodayPhotoCount, getPhotoQuota } from '../lib/api'
import { dismissUpsell, markUpsellShown, shouldShowUpsell } from '../lib/upsell'
import { takePhoto } from '../lib/capture'
import {
  FOOD_KEYWORD_RULE,
  GRAMS_LIMIT,
  MEAL_HINT_RULE,
  MEAL_TEXT_RULE,
  RECIPE_NAME_RULE,
  sanitizeNumeric,
} from '../lib/validate'
import { FoodTagList } from '../components/FoodTags'
import { Scanner } from '../components/Scanner'
import { usePlan } from '../state/plan'
import { MEAL_LABELS, MEAL_ORDER } from '../types'
import type { DetectedFood, MealEntry, MealType, Recipe, RecordSource } from '../types'
import { errText } from '../lib/errmsg'

interface DraftItem {
  key: string
  food_name: string
  quantity_text: string
  grams: number
  /** 创建时的份量，用于判断用户是否改过（改过则原份量描述失效） */
  origGrams: number
  kcalPerG: number
  pPerG: number
  cPerG: number
  fPerG: number
  /** 钠 mg/100g */
  naPerG: number
  /** 膳食纤维 g/100g */
  fbPerG: number
  /** 添加糖 g/100g */
  asPerG: number
  source: RecordSource
  note?: string
  health_score?: number
  /** AI 识别给的置信度 0–100（包装识别有，餐盘识别无） */
  confidence?: number
}

/** 最近吃过：从历史记录聚合出的「一键复记」项 */
interface RecentFood {
  name: string
  grams: number
  count: number
  lastEaten: string
}

type Mode = 'photo' | 'text' | 'barcode' | 'manual'

interface LogSheetProps {
  logDate: string
  initialMeal: MealType
  onClose: () => void
  onSaved: () => void
  /** 今日剩余热量下这一餐的建议额度，仅作提示 */
  budget?: number | null
  budgetText?: string
  /** 打开蜜糖积分中心（额度用尽、有积分时的兑换引导入口） */
  onOpenInviteCenter?: () => void
}

let keySeq = 0
const nextKey = () => `d${++keySeq}`

function toDraft(d: DetectedFood, source: RecordSource): DraftItem {
  const g = Math.max(d.grams, 1)
  const conf = (d as DetectedFood & { confidence?: number }).confidence
  return {
    key: nextKey(),
    food_name: d.food_name,
    quantity_text: d.quantity_text,
    grams: g,
    origGrams: g,
    kcalPerG: d.calories / g,
    pPerG: d.protein_g / g,
    cPerG: d.carb_g / g,
    fPerG: d.fat_g / g,
    naPerG: (d.sodium_mg ?? 0) / g,
    fbPerG: (d.fiber_g ?? 0) / g,
    asPerG: (d.added_sugar_g ?? 0) / g,
    source,
    note: d.note,
    health_score: d.health_score,
    confidence: typeof conf === 'number' && Number.isFinite(conf) ? Math.round(conf) : undefined,
  }
}

function fromFood(f: FoodItem, grams?: number): DraftItem {
  const g = grams ?? f.portionG
  return {
    key: nextKey(),
    food_name: f.name,
    quantity_text: `${g} 克`,
    grams: g,
    origGrams: g,
    kcalPerG: f.kcal / 100,
    pPerG: f.protein / 100,
    cPerG: f.carb / 100,
    fPerG: f.fat / 100,
    naPerG: (f.sodium ?? 0) / 100,
    fbPerG: (f.fiber ?? 0) / 100,
    asPerG: (f.addedSugar ?? 0) / 100,
    source: 'manual',
  }
}

/** 从历史记录聚合「最近吃过」：按食物名去重，取最近一次份量，按频次排序 */
function aggregateRecent(list: { food_name: string; grams: number | null; created_at?: string }[]): RecentFood[] {
  const map = new Map<string, RecentFood>()
  for (const m of list) {
    const name = (m.food_name || '').trim()
    if (!name) continue
    const prev = map.get(name)
    if (prev) {
      prev.count += 1
      if ((m.created_at ?? '') > prev.lastEaten) {
        prev.lastEaten = m.created_at ?? ''
        if (m.grams) prev.grams = m.grams
      }
    } else {
      map.set(name, {
        name,
        grams: m.grams ?? 100,
        count: 1,
        lastEaten: m.created_at ?? '',
      })
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || (b.lastEaten > a.lastEaten ? 1 : -1))
    .slice(0, 12)
}

/** 份量快捷档：按当前克数给出「半份 / 整份 / 双份」三个常见档位 */
function portionPresets(it: DraftItem): { label: string; grams: number }[] {
  const base = it.origGrams || it.grams || 100
  return [
    { label: '半份', grams: Math.max(1, Math.round(base / 2)) },
    { label: '整份', grams: base },
    { label: '双份', grams: base * 2 },
  ]
}

/** AI 估算的偏差提示：让用户知道这数字是「约数」，可一键修正 */
function estimateHint(it: DraftItem): string {
  // 有置信度的（包装识别）优先用置信度，没有的（餐盘识别）给统一口径
  if (it.confidence !== undefined) {
    if (it.confidence >= 80) return '营养表识别较可靠'
    if (it.confidence >= 60) return '营养表可能不够清晰，请核对'
    return '营养表识别置信度低，建议手动核对'
  }
  return 'AI 估算，份量请按实际核对'
}

/** 由 Open Food Facts 的「每 100g」数据构造待记录项 */
function fromPackaged(
  name: string,
  grams: number,
  per100g: { kcal: number; protein: number; carb: number; fat: number; sodium?: number; fiber?: number; sugar?: number },
  quantityText: string,
  note: string,
): DraftItem {
  const g = Math.max(grams, 1)
  return {
    key: nextKey(),
    food_name: name,
    quantity_text: quantityText,
    grams: g,
    origGrams: g,
    kcalPerG: per100g.kcal / 100,
    pPerG: per100g.protein / 100,
    cPerG: per100g.carb / 100,
    fPerG: per100g.fat / 100,
    naPerG: (per100g.sodium ?? 0) / 100,
    fbPerG: (per100g.fiber ?? 0) / 100,
    asPerG: (per100g.sugar ?? 0) / 100,
    source: 'barcode',
    note,
  }
}

const calc = (it: DraftItem) => ({
  kcal: Math.round(it.kcalPerG * it.grams),
  p: Math.round(it.pPerG * it.grams * 10) / 10,
  c: Math.round(it.cPerG * it.grams * 10) / 10,
  f: Math.round(it.fPerG * it.grams * 10) / 10,
  na: Math.round(it.naPerG * it.grams),
  fb: Math.round(it.fbPerG * it.grams * 10) / 10,
  as: Math.round(it.asPerG * it.grams * 10) / 10,
})

/** 从自定义食谱的一餐构造待记录项（营养已是实际摄入量，回算每克值） */
function fromRecipeItem(it: Recipe['items'][number]): DraftItem {
  const g = Math.max(Number(it.grams) || 1, 1)
  return {
    key: nextKey(),
    food_name: it.food_name,
    quantity_text: it.quantity_text || `${g} 克`,
    grams: g,
    origGrams: g,
    kcalPerG: (Number(it.calories) || 0) / g,
    pPerG: (Number(it.protein_g) || 0) / g,
    cPerG: (Number(it.carb_g) || 0) / g,
    fPerG: (Number(it.fat_g) || 0) / g,
    naPerG: (Number(it.sodium_mg) || 0) / g,
    fbPerG: (Number(it.fiber_g) || 0) / g,
    asPerG: (Number(it.added_sugar_g) || 0) / g,
    source: 'manual',
  }
}

/** 待记录项的风险 / 益处画像（每克值换算回每 100g 后交给规则引擎） */
const draftInsight = (it: DraftItem) =>
  analyzeProfile(
    {
      name: it.food_name,
      category: categoryOf(it.food_name),
      kcal: it.kcalPerG * 100,
      protein: it.pPerG * 100,
      carb: it.cPerG * 100,
      fat: it.fPerG * 100,
      sodium: it.naPerG * 100,
      fiber: it.fbPerG * 100,
      addedSugar: it.asPerG * 100,
    },
    it.health_score ?? null,
  )

/**
 * 落库时的份量文字。
 * 优先保留「1 碗」「1 包（50 克）」这类可读描述 —— 此前这里被硬写成「N 克」，
 * 把 AI 与商品库给出的份量描述整段丢掉了，记录列表里只剩一个干巴巴的克数。
 */
function portionText(it: DraftItem): string {
  const q = (it.quantity_text || '').trim()
  if (!q) return `${it.grams} 克`
  // 用户手动改过份量，原描述已经不对，改用克数避免误导
  if (it.grams !== it.origGrams) return `${it.grams} 克`
  if (/克|ml|毫升|g\b/.test(q)) return q
  return `${q}（${it.grams} 克）`
}

/**
 * 保存前的「这一餐体检」即时反馈。
 * 复用与首页「饮食体检」同一套规则引擎（summarizeEntries），纯本地、不消耗 AI。
 * 自律茄子与 Cal AI 都只在「识别」层面给数字，不给即时健康判断——这里补上。
 */
function MealCheckup({ items }: { items: DraftItem[] }) {
  const insight = useMemo(() => {
    const pseudo = items.map((it) => ({
      log_date: '',
      quantity_text: it.quantity_text ?? null,
      food_name: it.food_name,
      grams: it.grams,
      calories: calc(it).kcal,
      protein_g: calc(it).p,
      carb_g: calc(it).c,
      fat_g: calc(it).f,
      sodium_mg: calc(it).na,
      fiber_g: calc(it).fb,
      added_sugar_g: calc(it).as,
      health_score: it.health_score,
      meal_type: 'snack' as const,
      source: it.source,
    }))
    return summarizeEntries(pseudo as MealEntry[], categoryOf)
  }, [items])

  if (insight.scanned === 0) return null
  const level = insight.avgScore === null ? null : levelOfScore(insight.avgScore)
  const tone = level === 'great' || level === 'good' ? 'is-good' : level === 'ok' ? 'is-ok' : 'is-warn'

  return (
    <div className="card checkup" style={{ marginBottom: 14, padding: '14px 16px' }}>
      <div className="checkup-verdict">
        {level && insight.avgScore !== null && (
          <span className={`cu-score ${tone}`}>{insight.avgScore}</span>
        )}
        <span className="cu-main">
          {level && <span className={`cu-level ${tone}`}>{LEVEL_LABELS[level]}</span>}
          <span className="cu-text">{insight.verdict || '这一餐看起来挺均衡。'}</span>
        </span>
      </div>
      {insight.risks.length > 0 && (
        <div className="checkup-group" style={{ marginTop: 10 }}>
          <div className="cg-title risk">建议留意</div>
          {insight.risks.slice(0, 2).map((t) => (
            <div className="cg-row" key={t.key}>
              <span className="cg-label">{t.label}</span>
              <span className="cg-items">{t.items.join('、')}</span>
            </div>
          ))}
        </div>
      )}
      {insight.benefits.length > 0 && (
        <div className="checkup-group" style={{ marginTop: 8 }}>
          <div className="cg-title good">值得肯定</div>
          {insight.benefits.slice(0, 2).map((t) => (
            <div className="cg-row" key={t.key}>
              <span className="cg-label">{t.label}</span>
              <span className="cg-items">{t.items.join('、')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LogSheet({ logDate, initialMeal, onClose, onSaved, budget, budgetText, onOpenInviteCenter }: LogSheetProps) {
  const { claimAiQuota, refundAiQuota, aiRemaining, openPaywall, pro } = usePlan()
  const [mode, setMode] = useState<Mode>('photo')
  const [meal, setMeal] = useState<MealType>(initialMeal)
  const [items, setItems] = useState<DraftItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // 拍照分流提示：redeem=积分兑换 / inviteOrPro=拉人+Pro / pro=直接Pro
  const [quotaHint, setQuotaHint] = useState<{ kind: 'redeem' | 'inviteOrPro' | 'pro'; text: string } | null>(null)
  // 当日已成功拍照次数（本地计数，驱动阶梯提示）
  const [todayPhotoCount, setTodayPhotoCount] = useState(0)
  // 上一次成功识别的结果摘要（用于反复拍照判定）
  const lastPhotoSummaryRef = useRef<PhotoSummary | null>(null)
  // 反复拍照提示
  const [dupHint, setDupHint] = useState<string | null>(null)

  const [text, setText] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [hint, setHint] = useState('')
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<string>('全部')
  const [sort, setSort] = useState<FoodSort>('default')

  // 扫码相关：scanKey 变化会重建取景组件，用于「重新扫码」
  const [scanKey, setScanKey] = useState(0)
  const [scanMsg, setScanMsg] = useState<{ kind: 'ok' | 'info' | 'err'; text: string } | null>(null)
  const [missCode, setMissCode] = useState('')

  // 转化钩子：免费用户用完第 3 次拍照后轻提示升级（每周最多 1 次、可永久关闭）
  const [upsellVisible, setUpsellVisible] = useState(false)

  // 最近吃过：进入「食物库」页时拉一次历史，聚合出「一键复记」项
  const [recentFoods, setRecentFoods] = useState<RecentFood[]>([])
  const [recentLoaded, setRecentLoaded] = useState(false)

  // 我的食谱：进入「食物库」页时拉一次，展示自定义食谱模板
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipesLoaded, setRecipesLoaded] = useState(false)
  const [saveRecipeOpen, setSaveRecipeOpen] = useState(false)
  const [recipeName, setRecipeName] = useState('')
  const [savingRecipe, setSavingRecipe] = useState(false)

  // 挂载时读「当日已成功拍照次数」（云端唯一真相源），驱动阶梯提示
  useEffect(() => {
    let alive = true
    void (async () => {
      const n = await getTodayPhotoCount()
      if (alive) setTodayPhotoCount(n)
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (mode !== 'manual' || recentLoaded) return
    let alive = true
    void (async () => {
      try {
        const list = await listRecentMeals(30, 200)
        if (!alive) return
        setRecentFoods(aggregateRecent(list))
      } catch {
        // 拉不到历史不阻塞，静默降级为无「最近吃过」条
      } finally {
        if (alive) setRecentLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [mode, recentLoaded])

  useEffect(() => {
    if (mode !== 'manual' || recipesLoaded) return
    let alive = true
    void (async () => {
      try {
        const list = await listRecipes()
        if (!alive) return
        setRecipes(list)
      } catch {
        // 拉不到食谱不阻塞，静默降级
      } finally {
        if (alive) setRecipesLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [mode, recipesLoaded])

  const totals = useMemo(
    () =>
      items.reduce(
        (acc, it) => {
          const v = calc(it)
          acc.kcal += v.kcal
          acc.p += v.p
          acc.c += v.c
          acc.f += v.f
          return acc
        },
        { kcal: 0, p: 0, c: 0, f: 0 },
      ),
    [items],
  )

  const manualList = useMemo(() => {
    if (keyword.trim()) return searchFoods(keyword, 60)
    return listFoods(category, sort, 60)
  }, [keyword, category, sort])

  /**
   * 「AI 拍照识别」专用闸门：占用的是「识别」额度，不是「拍照」额度。
   * 计次口径：识别成功（照片里识别出食物并展示结果）才算一次；识别失败（模糊/非食物/报错）
   * 由 handleFile 的 catch 退还，拍照但没识别不算。文字解析、包装识别、条码、手动录入不计。
   */

  /**
   * 只读额度预检（点击「拍照」按钮时先调）：额度用完 → 提示兑换/Pro 并返回 false，
   * 调用方应直接中止（不调相机/选图），避免用户拍完照才被拦（白拍一次）。
   */
  async function checkPhotoQuota(): Promise<boolean> {
    if (pro) return true
    setQuotaHint(null)
    setDupHint(null)

    const quota = await getPhotoQuota().catch(() => null)
    const totalRemaining = quota ? quota.totalRemaining : (aiRemaining ?? FREE_DAILY_AI)
    if (totalRemaining > 0) return true

    // 确实没有额度了，才按阶梯引导「兑换」或「升级 Pro」
    const bal = await getHoneyBalance().catch(() => null)
    const balance = bal ? bal.balance : 0
    const ladder = photoLadderHint(todayPhotoCount, balance)
    if (ladder.kind === 'redeem') {
      setQuotaHint({
        kind: 'redeem',
        text: `今日 3 次免费识别已用完，可用 ${HONEY_PRICE.ai1Scan} 积分兑 1 次（每日最多兑 ${AI_REDEEM_DAILY_LIMIT} 次），你还有 ${balance} 积分。`,
      })
    } else if (ladder.kind === 'inviteOrPro') {
      setQuotaHint({
        kind: 'inviteOrPro',
        text: `今日 3 次免费识别已用完。邀请好友赚积分可兑换识别（每日最多 ${AI_REDEEM_DAILY_LIMIT} 次），或升级 Pro 无限次识别。`,
      })
    } else {
      setQuotaHint({ kind: 'pro', text: quotaExhaustedReason() })
    }
    return false
  }

  /**
   * 原子占用一次识别额度（consume_photo_quota 会优先扣奖励额度）。
   * 额度已由 checkPhotoQuota 预检，这里只做占用；仍兜底处理并发下额度被抢空的情况。
   */
  async function guardAiQuota(): Promise<{ ok: boolean; remaining: number | null }> {
    const q = await claimAiQuota()
    if (!q.allowed) {
      setQuotaHint({ kind: 'pro', text: quotaExhaustedReason() })
      openPaywall(quotaExhaustedReason())
      return { ok: false, remaining: null }
    }
    return { ok: true, remaining: q.remaining }
  }

  async function handleFile(file: File) {
    setError('')
    setBusy(true)
    let claimed = false
    try {
      const guard = await guardAiQuota()
      if (!guard.ok) return
      claimed = true
      const dataUrl = await compressImage(file)
      setPreview(dataUrl)
      const res = await recognizeFoodFromImage(dataUrl, hint.trim() || undefined)
      const drafts = res.map((d) => toDraft(d, 'photo'))
      const summary = summarizePhoto(drafts)

      // 反复拍照判定：与上一次成功识别结果比对，基本一致则提示并退还本次额度
      if (lastPhotoSummaryRef.current && isDuplicatePhoto(lastPhotoSummaryRef.current, summary)) {
        await refundAiQuota()
        setDupHint('识别结果与上一次几乎一致，疑似重复拍照。本次额度已退还，如需保留请继续，否则请更换照片。')
        return
      }

      lastPhotoSummaryRef.current = summary
      setItems((prev) => [...prev, ...drafts])
      // 当日成功拍照次数由云端 claim 承载；重读一次同步 state（识别成功不 release，claim 计数已 +1）
      void getTodayPhotoCount().then((n) => setTodayPhotoCount(n))

      // 转化钩子：免费用户本次拍照后用尽额度 → 轻提示升级（克制：每周 1 次 + 可永久关闭）
      void (async () => {
        const show = await shouldShowUpsell(pro, guard.remaining)
        if (show) {
          await markUpsellShown()
          setUpsellVisible(true)
        }
      })()
    } catch (e) {
      if (claimed) await refundAiQuota()
      setError(errText(e, '识别失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  // 拍餐盘照片：先预检识别额度（用完直接提示兑换/Pro，不调相机），有额度才调相机/选图。
  // 原生走 @capacitor/camera（绕开华为 WebView 对 <input capture> 的兼容问题），web 走 pickWithInput。
  async function handlePickMealPhoto() {
    if (!(await checkPhotoQuota())) return
    const f = await takePhoto({ preferCamera: true })
    if (f) void handleFile(f)
  }

  async function handleTextParse() {
    if (!text.trim()) return
    setError('')
    setBusy(true)
    try {
      // 文字描述解析不计入拍照额度（只有 AI 拍照识别才消耗次数）
      const res = await parseFoodFromText(text.trim())
      setItems((prev) => [...prev, ...res.map((d) => toDraft(d, 'text'))])
      setText('')
    } catch (e) {
      setError(errText(e, '解析失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  /** 扫到条码 → 查 Open Food Facts；查不到就把条码留住，引导走拍包装的兜底 */
  async function handleBarcode(code: string) {
    setError('')
    setScanMsg(null)
    setMissCode('')
    setBusy(true)
    try {
      const res = await lookupBarcode(code)
      if (res.status === 'found') {
        const p = res.product
        const label = p.brand ? `${p.brand} ${p.name}` : p.name
        setItems((prev) => [
          ...prev,
          fromPackaged(
            label,
            p.servingG,
            p.per100g,
            p.servingLabel,
            `条码识别 · 每 100g ${p.per100g.kcal} kcal`,
          ),
        ])
        setScanMsg({
          kind: 'ok',
          text: `已加入「${label}」，按每 100g ${p.per100g.kcal} kcal 折算，可在下方调整份量。`,
        })
      } else if (res.status === 'not_found') {
        setMissCode(code)
        setScanMsg({
          kind: 'info',
          text: `商品库里没有条码 ${code}（国产食品覆盖较少，属正常）。可以拍一张包装正面，我读营养表。`,
        })
      } else {
        setMissCode(code)
        setScanMsg({ kind: 'err', text: `${res.message}。可以拍包装照片让我直接读营养表。` })
      }
    } catch (e) {
      setError(errText(e, '查询商品库失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 兜底：拍包装正面照片，交给视觉模型读营养表 */
  async function handlePackagePhoto(file: File) {
    setError('')
    setBusy(true)
    try {
      // 包装识别是条码兜底，不计入拍照额度（只有「拍餐盘照片」才消耗次数）
      const dataUrl = await compressImage(file)
      const res = await identifyPackagedFood(dataUrl, missCode || undefined)
      setItems((prev) => [...prev, ...res.map((d) => toDraft(d, 'barcode'))])
      setScanMsg({ kind: 'ok', text: '已按包装上的营养表识别，请核对份量是否与实物一致。' })
      setMissCode('')
    } catch (e) {
      setError(errText(e, '识别包装失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  // 原生端拍包装正面：走 @capacitor/camera（同 handlePickMealPhoto）
  async function handlePickPackagePhoto() {
    const f = await takePhoto({ preferCamera: true })
    if (f) void handlePackagePhoto(f)
  }

  function updateGrams(key: string, grams: number) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, grams } : it)))
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key))
  }

  async function handleSave() {
    if (items.length === 0) return
    setSaving(true)
    setError('')
    try {
      const rows: Omit<MealEntry, 'id'>[] = items.map((it) => {
        const v = calc(it)
        return {
          log_date: logDate,
          meal_type: meal,
          food_name: it.food_name,
          quantity_text: portionText(it),
          grams: it.grams,
          calories: v.kcal,
          protein_g: v.p,
          carb_g: v.c,
          fat_g: v.f,
          sodium_mg: v.na || null,
          fiber_g: v.fb || null,
          added_sugar_g: v.as || null,
          source: it.source,
          image_url: null,
          ai_note: it.note ?? null,
          health_score: it.health_score ?? null,
        }
      })
      await insertMeals(rows)
      onSaved()
    } catch (e) {
      setError(errText(e, '保存失败，请重试'))
    } finally {
      setSaving(false)
    }
  }

  /** 把当前待记录项存成自定义食谱模板 */
  async function handleSaveRecipe() {
    const name = recipeName.trim()
    if (!name) return
    setSavingRecipe(true)
    setError('')
    try {
      const recipeItems = items.map((it) => {
        const v = calc(it)
        return {
          food_name: it.food_name,
          quantity_text: portionText(it),
          grams: it.grams,
          calories: v.kcal,
          protein_g: v.p,
          carb_g: v.c,
          fat_g: v.f,
          sodium_mg: v.na || null,
          fiber_g: v.fb || null,
          added_sugar_g: v.as || null,
        }
      })
      const saved = await saveRecipe(name, recipeItems)
      setRecipes((prev) => [saved, ...prev])
      setRecipeName('')
      setSaveRecipeOpen(false)
    } catch (e) {
      setError(errText(e, '保存食谱失败，请重试'))
    } finally {
      setSavingRecipe(false)
    }
  }

  async function handleDeleteRecipe(id?: number) {
    if (!id) return
    setError('')
    try {
      await deleteRecipe(id)
      setRecipes((prev) => prev.filter((r) => r.id !== id))
    } catch (e) {
      setError(errText(e, '删除食谱失败'))
    }
  }

  return (
    <div className="sheet-mask" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="记录饮食">
        <div className="sheet-head">
          <h2>记录饮食</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {mode !== 'manual' && aiRemaining !== null && (
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>今日免费识别还剩 {aiRemaining} 次</span>
            )}
            <button className="sheet-close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </div>

        <div className="sheet-body">
          <div className="field" style={{ marginBottom: 14 }}>
            <label>计入哪一餐</label>
            <div className="chips">
              {MEAL_ORDER.map((m) => (
                <button key={m} className={`chip ${meal === m ? 'active' : ''}`} onClick={() => setMeal(m)}>
                  {MEAL_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="notice err">{error}</div>}

          {dupHint && (
            <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{ flex: 1 }}>{dupHint}</span>
              <button className="btn-text" style={{ fontSize: 13, flexShrink: 0 }} onClick={() => setDupHint(null)}>
                知道了
              </button>
            </div>
          )}

          {quotaHint && (
            <div
              className="notice info"
              style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}
            >
              <span style={{ flex: 1 }}>{quotaHint.text}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {quotaHint.kind === 'redeem' && (
                  <button
                    className="btn-text"
                    style={{ fontSize: 13 }}
                    onClick={() => {
                      setQuotaHint(null)
                      if (onOpenInviteCenter) onOpenInviteCenter()
                    }}
                  >
                    去兑换
                  </button>
                )}
                {quotaHint.kind === 'inviteOrPro' && (
                  <button
                    className="btn-text"
                    style={{ fontSize: 13 }}
                    onClick={() => {
                      setQuotaHint(null)
                      if (onOpenInviteCenter) onOpenInviteCenter()
                    }}
                  >
                    去邀请
                  </button>
                )}
                <button className="btn-text" style={{ fontSize: 13 }} onClick={() => { setQuotaHint(null); openPaywall() }}>
                  升级 Pro
                </button>
              </span>
            </div>
          )}

          {upsellVisible && (
            <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{ flex: 1 }}>今天拍得顺手吗？升级 Pro 可无限次拍照识别、解锁完整报告。</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <button className="btn-text" style={{ fontSize: 13 }} onClick={() => { setUpsellVisible(false); openPaywall() }}>
                  去看看
                </button>
                <button
                  className="btn-text"
                  style={{ fontSize: 13, color: 'var(--ink-3)' }}
                  onClick={() => { setUpsellVisible(false); void dismissUpsell() }}
                >
                  不再提醒
                </button>
              </span>
            </div>
          )}

          {budgetText && (
            <div className={`budget-hint ${budget === null ? 'is-over' : ''}`}>
              <span className="bh-label">卡路里追踪</span>
              <span>{budgetText}</span>
            </div>
          )}

          <div className="segment">
            <button className={mode === 'photo' ? 'active' : ''} onClick={() => setMode('photo')}>
              拍照识别
            </button>
            <button className={mode === 'barcode' ? 'active' : ''} onClick={() => setMode('barcode')}>
              扫条码
            </button>
            <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>
              文字描述
            </button>
            <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>
              食物库
            </button>
          </div>

          {mode === 'photo' && (
            <>
              {preview ? (
                <img src={preview} alt="这一餐的照片" className="preview-img" />
              ) : (
                <button
                  className="dropzone"
                  style={{ display: 'block', width: '100%', cursor: 'pointer', font: 'inherit' }}
                  onClick={() => void handlePickMealPhoto()}
                >
                  <strong>拍一张这一餐的照片</strong>
                  AI 会自动识别食物并估算热量
                </button>
              )}

              {busy && (
                <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="spinner" style={{ borderColor: 'rgba(107,74,8,.3)', borderTopColor: '#6b4a08' }} />
                  正在识别食物，大约需要几秒…
                </div>
              )}

              {preview && !busy && (
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => void handlePickMealPhoto()}>
                    换一张照片
                  </button>
                </div>
              )}

              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="hint">补充说明（可选）</label>
                <input
                  id="hint"
                  placeholder="例如：半份、少油、加了两个蛋"
                  maxLength={MEAL_HINT_RULE.max}
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                />
              </div>
            </>
          )}

          {mode === 'barcode' && (
            <>
              <Scanner key={scanKey} onDetected={handleBarcode} busy={busy} />

              {scanMsg && (
                <div className={`notice ${scanMsg.kind === 'ok' ? 'ok' : scanMsg.kind === 'err' ? 'err' : 'info'}`} style={{ marginTop: 12 }}>
                  {scanMsg.text}
                </div>
              )}

              {missCode && (
                <button
                  className="btn btn-ghost"
                  style={{ marginTop: 12, display: 'block', width: '100%', textAlign: 'center' }}
                  onClick={() => void handlePickPackagePhoto()}
                >
                  {busy ? '正在识别包装…' : '拍包装正面，读营养表'}
                </button>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => {
                    setScanMsg(null)
                    setMissCode('')
                    setScanKey((k) => k + 1)
                  }}
                >
                  重新扫码
                </button>
              </div>

              <div className="helper" style={{ marginTop: 12, lineHeight: 1.7 }}>
                中国包装食品在公开商品库里覆盖较少，扫不到时会自动改为读包装上的营养成分表。
                AI 估算与商品库数据都可能有偏差，请以包装标注为准。
              </div>
            </>
          )}

          {mode === 'text' && (
            <>
              <div className="field">
                <label htmlFor="meal-text">描述你吃了什么</label>
                <textarea
                  id="meal-text"
                  placeholder="例如：一碗牛肉面，加了两个鸡蛋，还有一杯无糖豆浆"
                  maxLength={MEAL_TEXT_RULE.max}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              <button className="btn" disabled={busy || !text.trim()} onClick={handleTextParse}>
                {busy ? <span className="spinner" /> : '分析这一餐'}
              </button>
            </>
          )}

          {mode === 'manual' && (
            <>
              {recentFoods.length > 0 && !keyword.trim() && (
                <div style={{ marginBottom: 14 }}>
                  <div className="section-title" style={{ marginBottom: 8 }}>
                    最近吃过
                    <span className="hint">点一下就记上</span>
                  </div>
                  <div className="chips chips-scroll">
                    {recentFoods.map((r) => (
                      <button
                        key={r.name}
                        className="chip recent-chip"
                        onClick={() => {
                          const f = lookupFood(r.name)
                          setItems((prev) => [
                            ...prev,
                            fromFood(
                              f ?? {
                                name: r.name,
                                category: '其他',
                                kcal: 0,
                                protein: 0,
                                carb: 0,
                                fat: 0,
                                portionG: r.grams,
                                portionLabel: `${r.grams} 克`,
                              },
                              r.grams,
                            ),
                          ])
                        }}
                      >
                        {r.name}
                        {r.count > 1 && <span className="rc-count">{r.count}次</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {recipes.length > 0 && !keyword.trim() && (
                <div style={{ marginBottom: 14 }}>
                  <div className="section-title" style={{ marginBottom: 8 }}>
                    我的食谱
                    <span className="hint">一键记一餐</span>
                  </div>
                  <div className="recipe-list">
                    {recipes.map((r) => {
                      const totalKcal = r.items.reduce((s, it) => s + (Number(it.calories) || 0), 0)
                      return (
                        <div key={r.id ?? r.name} className="recipe-row">
                          <button
                            className="recipe-main"
                            onClick={() => setItems((prev) => [...prev, ...r.items.map(fromRecipeItem)])}
                          >
                            <span className="recipe-name">{r.name}</span>
                            <span className="recipe-sub">
                              {r.items.length} 项 · 约 {Math.round(totalKcal)} kcal
                            </span>
                          </button>
                          <button className="entry-del" onClick={() => void handleDeleteRecipe(r.id)} aria-label="删除食谱">
                            ×
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="field">
                <input
                  placeholder="搜索食物，如「米饭」「鸡胸肉」"
                  maxLength={FOOD_KEYWORD_RULE.max}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
              {!keyword.trim() && (
                <>
                  <div className="chips" style={{ marginBottom: 10 }}>
                    {['全部', ...FOOD_CATEGORIES].map((c) => (
                      <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
                        {c}
                      </button>
                    ))}
                  </div>
                  <div className="chips" style={{ marginBottom: 14 }}>
                    {FOOD_SORTS.map((s) => (
                      <button
                        key={s.key}
                        className={`chip ${sort === s.key ? 'active' : ''}`}
                        style={{ fontSize: 12, padding: '6px 11px' }}
                        onClick={() => setSort(s.key)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="card card-tight" style={{ padding: '4px 16px' }}>
                {manualList.length === 0 && <div className="empty-state">没有找到这个食物，试试用文字描述记录</div>}
                {manualList.map((f, idx) => (
                  <div key={`${f.category}-${f.name}-${idx}`} className="food-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="nm">{f.name}</div>
                      <div className="sub">
                        {f.kcal} kcal / 100g · 蛋白 {f.protein}g · {f.portionLabel}
                        {sort === 'satiety_desc' && ` · 饱腹感 ${satiety(f)}`}
                        {sort === 'healthy_desc' && ` · 友好度 ${foodInsight(f).score}`}
                      </div>
                      <FoodTagList tags={foodInsight(f).tags.slice(0, 2)} />
                    </div>
                    <button className="btn-text" onClick={() => setItems((prev) => [...prev, fromFood(f)])}>
                      添加
                    </button>
                  </div>
                ))}
              </div>
              <div className="helper" style={{ marginTop: 10, lineHeight: 1.7 }}>
                风险与益处标签由营养成分与烹调方式推算，不消耗 AI 次数、断网也能用，仅供参考。
              </div>
            </>
          )}

          {items.length > 0 && (
            <>
              <div className="section-title">
                本次将记录 {items.length} 项
                <span className="hint">
                  共 {totals.kcal} kcal
                  {items.length >= 2 && (
                    <button className="btn-text" style={{ marginLeft: 10, color: 'var(--honey-dark)' }} onClick={() => setSaveRecipeOpen(true)}>
                      存为食谱
                    </button>
                  )}
                </span>
              </div>
              <MealCheckup items={items} />
              <div className="card card-tight">
                {items.map((it) => {
                  const v = calc(it)
                  const ins = draftInsight(it)
                  const presets = portionPresets(it)
                  return (
                    <div key={it.key} className="food-row" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '12px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="nm">{it.food_name}</div>
                          <div className="sub">
                            {v.kcal} kcal · 蛋 {v.p}g · 碳 {v.c}g · 脂 {v.f}g
                          </div>
                          {(v.na > 0 || v.fb > 0 || v.as > 0) && (
                            <div className="sub" style={{ color: 'var(--ink-3)' }}>
                              {v.na > 0 && `钠 ${v.na}mg`}
                              {v.fb > 0 && ` · 纤维 ${v.fb}g`}
                              {v.as > 0 && ` · 添加糖 ${v.as}g`}
                            </div>
                          )}
                          {it.note && (
                            <div className="sub" style={{ color: 'var(--honey-dark)' }}>{it.note}</div>
                          )}
                          <FoodTagList tags={ins.tags.slice(0, 2)} />
                        </div>
                        <button className="entry-del" onClick={() => removeItem(it.key)} aria-label="移除">
                          ×
                        </button>
                      </div>

                      <div className="sub" style={{ marginTop: 6, color: 'var(--ink-3)' }}>
                        {estimateHint(it)}
                      </div>

                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                        {presets.map((p) => (
                          <button
                            key={p.label}
                            className={`chip ${Math.round(it.grams) === p.grams ? 'active' : ''}`}
                            style={{ fontSize: 12, padding: '5px 11px' }}
                            onClick={() => updateGrams(it.key, p.grams)}
                          >
                            {p.label}
                          </button>
                        ))}
                        <div className="stepper" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={GRAMS_LIMIT.min}
                            max={GRAMS_LIMIT.max}
                            value={Math.round(it.grams)}
                            onChange={(e) => {
                              const s = sanitizeNumeric(e.target.value, { int: true })
                              if (s === '') return
                              const n = Math.min(GRAMS_LIMIT.max, Math.max(GRAMS_LIMIT.min, Number(s)))
                              updateGrams(it.key, Number.isFinite(n) ? n : GRAMS_LIMIT.min)
                            }}
                          />
                          <span className="unit">g</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="stat-grid" style={{ marginBottom: 16 }}>
                <div className="stat">
                  <div className="l">蛋白质</div>
                  <div className="v">{Math.round(totals.p)}<small>g</small></div>
                </div>
                <div className="stat">
                  <div className="l">碳水 / 脂肪</div>
                  <div className="v">
                    {Math.round(totals.c)}<small>g</small> / {Math.round(totals.f)}<small>g</small>
                  </div>
                </div>
              </div>

              <button className="btn" disabled={saving} onClick={handleSave}>
                {saving ? <span className="spinner" /> : `保存到${MEAL_LABELS[meal]}`}
              </button>
            </>
          )}

          {/* 存为食谱：给这顿饭起个名字，下次一键记入 */}
          {saveRecipeOpen && (
            <div className="recipe-save" style={{ marginTop: 16 }}>
              <div className="section-title" style={{ marginBottom: 8 }}>存为食谱</div>
              <div className="field">
                <input
                  autoFocus
                  placeholder="例如：我的减脂午餐"
                  maxLength={RECIPE_NAME_RULE.max}
                  value={recipeName}
                  onChange={(e) => setRecipeName(e.target.value)}
                />
              </div>
              <div className="helper" style={{ marginBottom: 10, lineHeight: 1.6 }}>
                会把当前 {items.length} 项食物一起存成模板，下次在「食物库 → 我的食谱」一键记入。
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn" style={{ flex: 1 }} disabled={savingRecipe || !recipeName.trim()} onClick={handleSaveRecipe}>
                  {savingRecipe ? <span className="spinner" /> : '保存食谱'}
                </button>
                <button className="btn btn-ghost" onClick={() => { setSaveRecipeOpen(false); setRecipeName('') }}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
