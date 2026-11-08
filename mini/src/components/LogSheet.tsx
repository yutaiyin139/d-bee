/**
 * 记录饮食弹层 · 小程序端（Taro）—— 逐项对齐主工程 src/pages/LogSheet.tsx。
 *
 * 🔴 2026-11-08 重构动因：此前 mini 把主端「单一 bottom sheet + 4 模式 + 统一草稿」
 *    拆成了三块：原生 showActionSheet 选模式、拍照跳独立 scan 页、手录内嵌首页 Sheet。
 *    这不是平台限制——mini/src/components/Sheet.tsx 早已实现自定义 fixed 弹层，
 *    coach.tsx 已用 ScrollView，index.tsx 旧弹层里已放 6 个 Input，
 *    mini/src/lib/ai.ts 也早有 parseFoodFromText。属于移植时走平台原生捷径造成的走样。
 *
 * 本组件把主端下列语义整体搬来（平台 API 只做适配，不放宽业务规则）：
 *  - 自定义 fixed bottom sheet（非路由、非原生菜单），点遮罩/× 关闭
 *  - 4 模式：拍照识别 / 文字描述 / 食物库 / 手动填写；共用同一个 items 草稿区
 *  - DraftItem 每克值模型、份量预设、改克数、删除某项、portionText、16 字段 buildRows
 *  - AI 同意 → 隐私授权 → 额度只读预检 → 原子预占 → 选图 → 压缩 → 识别(hint) → 判重
 *  - 判重命中退还额度；识别失败退还额度；保存失败不退（识别已成功）
 *  - settleDraft 同餐次冲突：内嵌横幅「覆盖 / 追加 / 取消」，取消保留草稿
 *  - 识别成功自动保存并关闭刷新；保存按钮兜底；关闭时有未保存草稿先 settleDraft
 *  - AI 标识、估算偏差提示、额度展示、积分兑换、存为食谱、升级引导
 *
 * 唯一刻意差异：主端 barcode 模式依赖 Open Food Facts 域名与 Scanner 组件，
 * 小程序 request 合法域名当前只配了 d-bee.cn，接了必然失败，故换成 mini 原有的
 * 「手动填写」自由表单（能力不减，且同样先入草稿再统一保存）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Button, Input, Image, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  insertMeals, listMealsByDate, deleteMeal, listRecentMeals, listRecipes, saveRecipe,
  getPhotoQuota, getHoneyBalance, redeemHoney, getEntitlement, getTodayPhotoCount,
  consumePhotoQuota, releasePhotoQuota, getProfile,
  type MealEntry, type MealType, type Profile, type RecipeItem, type RecordSource,
} from '../lib/api'
import { recognizeFoodFromImage, parseFoodFromText, type DetectedFood } from '../lib/ai'
import { AiConsent } from './AiConsent'
import { AiLabel } from './AiLabel'
import { grantAiConsent, hasAiConsent } from '../lib/aiConsent'
import { ensurePrivacyAuthorized, isPrivacyError, PRIVACY_DENIED_TEXT } from '../lib/privacy'
import { shouldShowUpsell, markUpsellShown, dismissUpsell } from '../lib/upsell'
import { checkStatBadges } from '../lib/badgeCheck'
import { GRAMS_LIMIT, KCAL_LIMIT, checkNumber } from '../lib/validate'
import { errText } from '../lib/errmsg'
import { FOOD_CATEGORIES, searchFoods, listFoodsByCategory, type FoodItem } from '../lib/foods'
import {
  isPro, roundTo, isDuplicatePhoto, summarizePhoto, photoLadderHint,
  quotaExhaustedReason, FREE_DAILY_AI, HONEY_PRICE, AI_REDEEM_DAILY_LIMIT,
  type PhotoSummary,
} from '@dbee/shared'
import './LogSheet.scss'

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack']
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
}
type Mode = 'photo' | 'text' | 'manual' | 'free'
const MODES: { key: Mode; label: string }[] = [
  { key: 'photo', label: '拍照识别' },
  { key: 'text', label: '文字描述' },
  { key: 'manual', label: '食物库' },
  { key: 'free', label: '手动填写' },
]

/** 与主工程 LogSheet.tsx:51-73 同源 */
interface DraftItem {
  key: string
  food_name: string
  quantity_text: string
  grams: number
  origGrams: number
  kcalPerG: number
  pPerG: number
  cPerG: number
  fPerG: number
  naPerG: number
  fbPerG: number
  asPerG: number
  source: RecordSource
  note?: string
  health_score?: number
  confidence?: number
}

interface RecentFood {
  name: string
  grams: number
  kcal: number
  protein_g: number
  carb_g: number
  fat_g: number
}

interface LogSheetProps {
  logDate: string
  initialMeal: MealType
  initialMode?: Mode
  onClose: () => void
  /** 保存成功：父级负责关闭弹层并刷新记录（对齐主端 onSaved → Dashboard.load()） */
  onSaved: () => void
}

let keySeq = 0
const nextKey = () => `d${++keySeq}`

/** 主端 :100-121 同源 */
function toDraft(d: DetectedFood, source: RecordSource): DraftItem {
  const g = Math.max(d.grams, 1)
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
    confidence: typeof d.confidence === 'number' && Number.isFinite(d.confidence)
      ? Math.round(d.confidence) : undefined,
  }
}

/** 主端 :123-140 同源：食物库按每 100g 换算 */
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

/** 主端 fromRecipeItem 同源：食谱存的是实际摄入量，回算每克值 */
function fromRecipeItem(it: RecipeItem): DraftItem {
  const g = Math.max(Number(it.grams) || 1, 1)
  return {
    key: nextKey(),
    food_name: it.food_name,
    quantity_text: it.quantity_text || `${g} 克`,
    grams: g,
    origGrams: g,
    kcalPerG: it.calories / g,
    pPerG: it.protein_g / g,
    cPerG: it.carb_g / g,
    fPerG: it.fat_g / g,
    naPerG: (it.sodium_mg ?? 0) / g,
    fbPerG: (it.fiber_g ?? 0) / g,
    asPerG: (it.added_sugar_g ?? 0) / g,
    source: 'manual',
  }
}

/** 手动填写：用户给的是「这一份」总量，回算每克值后进入同一草稿模型 */
function fromFree(name: string, kcal: number, grams: number, p: number, c: number, f: number): DraftItem {
  const g = Math.max(grams, 1)
  return {
    key: nextKey(),
    food_name: name,
    quantity_text: `${g} 克`,
    grams: g,
    origGrams: g,
    kcalPerG: kcal / g,
    pPerG: p / g,
    cPerG: c / g,
    fPerG: f / g,
    naPerG: 0,
    fbPerG: 0,
    asPerG: 0,
    source: 'manual',
  }
}

/** 主端 :169-177 同源 */
function portionPresets(it: DraftItem): { label: string; grams: number }[] {
  const base = it.origGrams || it.grams || 100
  return [
    { label: '半份', grams: Math.max(1, Math.round(base / 2)) },
    { label: '整份', grams: base },
    { label: '双份', grams: base * 2 },
  ]
}

/** 主端 :184-186 同源 */
function isAiDraft(it: DraftItem): boolean {
  return it.source === 'photo' || it.source === 'text' || (it.source === 'barcode' && it.confidence !== undefined)
}

/** 主端 :188-197 同源 */
function estimateHint(it: DraftItem): string {
  if (it.confidence !== undefined) {
    if (it.confidence >= 80) return '营养表识别较可靠'
    if (it.confidence >= 60) return '营养表可能不够清晰，请核对'
    return '营养表识别置信度低，建议手动核对'
  }
  return 'AI 估算，份量请按实际核对'
}

/** 主端 :283-291 同源：份量被改过后原描述失效 */
function portionText(it: DraftItem): string {
  const q = (it.quantity_text || '').trim()
  if (!q) return `${it.grams} 克`
  if (it.grams !== it.origGrams) return `${it.grams} 克`
  if (/克|ml|毫升|g\b/.test(q)) return q
  return `${q}（${it.grams} 克）`
}

/* 🔴 值会写库，属计算层：必须用 roundTo，禁止自写 Math.round(x*10)/10（数值口径唯一权威） */
const calc = (it: DraftItem) => ({
  kcal: roundTo(it.kcalPerG * it.grams, 0),
  p: roundTo(it.pPerG * it.grams, 2),
  c: roundTo(it.cPerG * it.grams, 2),
  f: roundTo(it.fPerG * it.grams, 2),
  na: roundTo(it.naPerG * it.grams, 0),
  fb: roundTo(it.fbPerG * it.grams, 2),
  as: roundTo(it.asPerG * it.grams, 2),
})

/** 从历史记录聚合「最近吃过」（主端 :142-167 同源） */
function aggregateRecent(list: MealEntry[]): RecentFood[] {
  const map = new Map<string, RecentFood & { count: number; last: string }>()
  for (const m of list) {
    const name = (m.food_name || '').trim()
    if (!name) continue
    const prev = map.get(name)
    if (prev) {
      prev.count += 1
      if ((m.created_at ?? '') > prev.last) {
        prev.last = m.created_at ?? ''
        prev.grams = m.grams ?? prev.grams
        prev.kcal = m.calories
        prev.protein_g = m.protein_g
        prev.carb_g = m.carb_g
        prev.fat_g = m.fat_g
      }
    } else {
      map.set(name, {
        name, grams: m.grams ?? 100, kcal: m.calories,
        protein_g: m.protein_g, carb_g: m.carb_g, fat_g: m.fat_g,
        count: 1, last: m.created_at ?? '',
      })
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1))
    .slice(0, 12)
    .map(({ name, grams, kcal, protein_g, carb_g, fat_g }) => ({ name, grams, kcal, protein_g, carb_g, fat_g }))
}

/** 从 base64 头探测真实 MIME（上一轮已修，避免把 PNG/WebP 声明成 jpeg） */
function detectMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('UklG')) return 'image/webp'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  return 'image/jpeg'
}

export function LogSheet({ logDate, initialMeal, initialMode = 'photo', onClose, onSaved }: LogSheetProps) {
  const [meal, setMeal] = useState<MealType>(initialMeal)
  const [mode, setMode] = useState<Mode>(initialMode)
  const [items, setItems] = useState<DraftItem[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dupHint, setDupHint] = useState('')
  const [saveNudge, setSaveNudge] = useState('')
  const [overrideConfirm, setOverrideConfirm] = useState({ open: false, count: 0 })
  const [imageUrl, setImageUrl] = useState('')

  // 拍照补充说明（主端 MEAL_HINT_RULE.max = 60）
  const [hint, setHint] = useState('')
  const [textDesc, setTextDesc] = useState('')
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState('全部')
  const [freeName, setFreeName] = useState('')
  const [freeKcal, setFreeKcal] = useState('')
  const [freeGrams, setFreeGrams] = useState('')
  const [freeP, setFreeP] = useState('')
  const [freeC, setFreeC] = useState('')
  const [freeF, setFreeF] = useState('')
  const [recentFoods, setRecentFoods] = useState<RecentFood[]>([])
  const [recipes, setRecipes] = useState<{ name: string; items: RecipeItem[] }[]>([])
  const [recipesLoaded, setRecipesLoaded] = useState(false)
  const [recipeName, setRecipeName] = useState('')
  const [recipeInputOpen, setRecipeInputOpen] = useState(false)
  const [savingRecipe, setSavingRecipe] = useState(false)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [aiConsentOpen, setAiConsentOpen] = useState(false)
  const [honey, setHoney] = useState(0)
  const [quota, setQuota] = useState(0)
  const [quotaDegraded, setQuotaDegraded] = useState(false)
  const [pro, setPro] = useState(false)
  const [todayPhotoCount, setTodayPhotoCount] = useState(0)
  const [upsellVisible, setUpsellVisible] = useState(false)

  const settlingRef = useRef(false)
  const claimRef = useRef<{ token?: string | null; remaining?: number } | null>(null)
  const lastPhotoSummaryRef = useRef<PhotoSummary | null>(null)

  useEffect(() => {
    void refreshStats()
    void getProfile().then(setProfile).catch(() => { /* 同意状态拿不到就按未同意处理 */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (mode === 'manual' && recentFoods.length === 0) {
      void listRecentMeals(30, 200)
        .then((list) => setRecentFoods(aggregateRecent(list)))
        .catch(() => { /* 拉取失败不阻塞 */ })
    }
    if (mode === 'manual' && !recipesLoaded) {
      setRecipesLoaded(true)
      void listRecipes().then(setRecipes).catch(() => { /* 同上 */ })
    }
  }, [mode])

  async function refreshStats() {
    try {
      const [h, q, ent, n] = await Promise.all([
        getHoneyBalance(), getPhotoQuota(), getEntitlement(), getTodayPhotoCount(),
      ])
      setHoney(h.balance)
      setQuota(q.totalRemaining)
      setQuotaDegraded(q.degraded === true)
      setPro(isPro(ent))
      setTodayPhotoCount(n)
    } catch { /* 静默：额度展示失败不阻断录入 */ }
  }

  /**
   * 只读额度预检（主端 LogSheet:503-530 同源，fail-open）。
   * 真正 fail-closed 的闸门在 consumePhotoQuota 原子占用，放行不会超发。
   */
  async function checkPhotoQuota(): Promise<boolean> {
    if (pro) return true
    const q = await getPhotoQuota().catch(() => null)
    const totalRemaining = q && !q.degraded ? q.totalRemaining : FREE_DAILY_AI
    if (totalRemaining > 0) return true
    const bal = await getHoneyBalance().catch(() => null)
    const balance = bal ? bal.balance : 0
    const ladder = photoLadderHint(todayPhotoCount, balance)
    if (ladder.kind === 'redeem') {
      setError(`今日 ${FREE_DAILY_AI} 次免费识别已用完，可用 ${HONEY_PRICE.ai1Scan} 积分兑 1 次（每日最多兑 ${AI_REDEEM_DAILY_LIMIT} 次），你还有 ${balance} 积分。`)
    } else if (ladder.kind === 'inviteOrPro') {
      setError(`今日 ${FREE_DAILY_AI} 次免费识别已用完。邀请好友赚积分可兑换识别（每日最多 ${AI_REDEEM_DAILY_LIMIT} 次），或升级 Pro 无限次识别。`)
    } else {
      setError(quotaExhaustedReason())
    }
    return false
  }

  /** 临时路径 → 压缩后的 base64 dataUrl（Taro.compressImage 对齐主端 canvas 压缩职责） */
  async function toDataUrl(filePath: string): Promise<string> {
    let src = filePath
    try {
      const r = await Taro.compressImage({ src: filePath, quality: 80 })
      if (r?.tempFilePath) src = r.tempFilePath
    } catch { /* 压缩不可用则用原图 */ }
    const b64 = await new Promise<string>((resolve, reject) => {
      Taro.getFileSystemManager().readFile({
        filePath: src,
        encoding: 'base64',
        success: (res) => resolve(String(res.data ?? '')),
        fail: (err) => reject(new Error(err.errMsg || '读取图片失败')),
      })
    })
    return `data:${detectMime(b64)};base64,${b64}`
  }

  /** 主端 handleFile:559-598 同源顺序：预占 → 选图 → 压缩 → 识别(hint) → 判重 → 自动保存 */
  async function onTakePhoto() {
    if (!hasAiConsent(profile)) { setAiConsentOpen(true); return }
    setError(''); setDupHint('')
    // 隐私授权必须排在额度预占之前，否则用户拒绝授权会白扣一次
    const privacy = await ensurePrivacyAuthorized()
    if (!privacy.ok) { setError(PRIVACY_DENIED_TEXT); return }

    claimRef.current = null
    setBusy(true)
    try {
      if (!(await checkPhotoQuota())) { await refreshStats(); return }
      if (!pro) {
        const c = await consumePhotoQuota()
        if (!c.allowed) {
          setError(c.degraded
            ? '识别服务暂时不可用（额度扣减失败）。本次未消耗额度，请稍后重试；若持续如此请联系客服。'
            : quotaExhaustedReason())
          await refreshStats()
          return
        }
        claimRef.current = { token: c.token, remaining: c.remaining }
      }

      const chooseRes = await Taro.chooseImage({
        count: 1, sizeType: ['compressed'], sourceType: ['camera', 'album'],
      })
      const filePath = chooseRes.tempFilePaths[0]
      if (!filePath) {
        if (claimRef.current) await releasePhotoQuota(claimRef.current.token ?? null)
        return
      }
      setImageUrl(filePath)
      const dataUrl = await toDataUrl(filePath)
      // 🔴 hint 必须透传：上一轮 mini scan 只传 1 个参数，用户补充说明完全失效
      const detected = await recognizeFoodFromImage(dataUrl, hint.trim() || undefined)
      const drafts = detected.map((d) => toDraft(d, 'photo'))
      const summary = summarizePhoto(drafts)

      // 反复拍照判定（@dbee/shared 纯函数，与主端同源）
      if (lastPhotoSummaryRef.current && isDuplicatePhoto(lastPhotoSummaryRef.current, summary)) {
        if (claimRef.current) await releasePhotoQuota(claimRef.current.token ?? null)
        setDupHint('识别结果与上一次几乎一致，疑似重复拍照。本次额度已退还，如需保留请继续，否则请更换照片。')
        return
      }
      lastPhotoSummaryRef.current = summary
      void getTodayPhotoCount().then(setTodayPhotoCount).catch(() => {})
      void autoSaveRecognized(drafts)

      // 转化钩子：每周最多 1 次 + 可永久关闭（主端 handleFile:585-592 同源）
      void (async () => {
        const show = await shouldShowUpsell(pro, claimRef.current?.remaining ?? null)
        if (show) { await markUpsellShown(); setUpsellVisible(true) }
      })()
    } catch (e) {
      const reason = isPrivacyError(e) ? PRIVACY_DENIED_TEXT : errText(e, '识别失败，请重试')
      if (claimRef.current) {
        const released = await releasePhotoQuota(claimRef.current.token ?? null)
        setError(released
          ? `${reason}（本次未消耗识别次数）`
          : `${reason}（额度退还失败，本次识别次数可能未返还，请稍后联系客服）`)
      } else {
        setError(reason)
      }
    } finally {
      setBusy(false)
      await refreshStats()
    }
  }

  /** 文字描述：不占拍照额度，无「漏点保存白扣」风险，故进草稿由用户核对后保存 */
  async function onParseText() {
    const t = textDesc.trim()
    if (!t) { setError('请先描述这一餐吃了什么'); return }
    setBusy(true); setError('')
    try {
      const detected = await parseFoodFromText(t)
      if (!detected.length) { setError('没能识别出食物，请换一种描述'); return }
      setItems((prev) => [...prev, ...detected.map((d) => toDraft(d, 'text'))])
      setTextDesc('')
    } catch (e) {
      setError(errText(e, '识别失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  function addFreeform() {
    const name = freeName.trim()
    if (!name) { setError('请输入食物名称'); return }
    const kcalCheck = checkNumber(freeKcal, KCAL_LIMIT)
    if (!kcalCheck.ok || kcalCheck.value == null) { setError(kcalCheck.error); return }
    let grams = 100
    if (freeGrams.trim() !== '') {
      const g = checkNumber(freeGrams, GRAMS_LIMIT)
      if (!g.ok || g.value == null) { setError(g.error); return }
      grams = g.value
    }
    const num = (s: string) => {
      const v = Number(s) || 0
      return v > 0 ? roundTo(Math.min(v, GRAMS_LIMIT.max), 2) : 0
    }
    setItems((prev) => [...prev, fromFree(name, kcalCheck.value!, grams, num(freeP), num(freeC), num(freeF))])
    setFreeName(''); setFreeKcal(''); setFreeGrams(''); setFreeP(''); setFreeC(''); setFreeF('')
    setError('')
  }

  function updateGrams(key: string, grams: number) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, grams } : it)))
  }
  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key))
  }

  /** 主端 buildRows:708-730 同源：16 字段，手录/食物库/AI 全部走同一落库形状 */
  function buildRows(list: DraftItem[], targetMeal: MealType): Omit<MealEntry, 'id'>[] {
    return list.map((it) => {
      const v = calc(it)
      return {
        log_date: logDate,
        meal_type: targetMeal,
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
  }

  function handleSave() {
    if (items.length === 0) return
    if (overrideConfirm.open) {
      setSaveNudge('请先选择「覆盖」或「追加」，再保存')
      return
    }
    void settleDraft(items, 'manual')
  }

  /** 主端 settleDraft:753-790 同源 */
  async function settleDraft(list: DraftItem[], source: 'auto' | 'manual' | 'close' = 'auto') {
    if (settlingRef.current) return
    settlingRef.current = true
    setOverrideConfirm({ open: false, count: 0 })
    try {
      let sameMealCount = 0
      try {
        const existing = await listMealsByDate(logDate)
        sameMealCount = existing.filter((m) => m.meal_type === meal).length
      } catch { /* 查不到按无记录处理 */ }
      if (sameMealCount === 0) {
        await doSave(list, false)
        return
      }
      setOverrideConfirm({ open: true, count: sameMealCount })
      if (source === 'manual') setSaveNudge('该餐已有记录，请选择「覆盖」或「追加」后再保存')
    } finally {
      settlingRef.current = false
    }
  }

  /** 保存失败只 setError、不退还额度（识别已成功，额度理应消耗；主端同口径） */
  async function doSave(list: DraftItem[], override: boolean) {
    setSaving(true); setError('')
    try {
      if (override) {
        const existing = await listMealsByDate(logDate)
        const sameMeal = existing.filter((m) => m.meal_type === meal)
        for (const m of sameMeal) if (m.id != null) await deleteMeal(m.id)
      }
      await insertMeals(buildRows(list, meal))
      setItems([])
      setOverrideConfirm({ open: false, count: 0 })
      setSaveNudge('')
      Taro.showToast({ title: `已记录 ${list.length} 项`, icon: 'success' })
      void checkStatBadges()
      setSaving(false)
      onSaved()
    } catch (e) {
      setError(errText(e, '保存失败，请重试'))
      setSaving(false)
    }
  }

  async function confirmOverride() { await doSave(items, true) }
  async function confirmAppend() { await doSave(items, false) }
  /** 主端 cancelOverride:853-856 同源：保留草稿，用户可编辑后再点保存 */
  function cancelOverride() {
    setOverrideConfirm({ open: false, count: 0 })
    setSaveNudge('')
  }

  /** 主端 handleClose:859-865 同源：有未保存草稿先 settleDraft，不静默丢弃 */
  function handleClose() {
    if (items.length === 0 || overrideConfirm.open || settlingRef.current) { onClose(); return }
    void settleDraft(items, 'close')
  }

  /** 识别成功自动保存（主端 autoSaveRecognized:812-815 同源） */
  function autoSaveRecognized(drafts: DraftItem[]) {
    setItems(drafts)
    void settleDraft(drafts)
  }

  async function onRedeem() {
    setError('')
    if (honey < HONEY_PRICE.ai1Scan) { setError('积分不足，先去打卡攒积分'); return }
    try {
      const r = await redeemHoney('ai1Scan')
      setError(r.ok ? '兑换成功，已增加 1 次拍照识别额度' : r.message)
      await refreshStats()
    } catch (e) { setError(e instanceof Error ? e.message : '兑换失败') }
  }

  async function onSaveRecipe() {
    const name = recipeName.trim()
    if (!name) return
    setSavingRecipe(true); setError('')
    try {
      await saveRecipe(name, items.map((it) => {
        const v = calc(it)
        return {
          food_name: it.food_name, quantity_text: portionText(it), grams: it.grams,
          calories: v.kcal, protein_g: v.p, carb_g: v.c, fat_g: v.f,
          sodium_mg: v.na || null, fiber_g: v.fb || null, added_sugar_g: v.as || null,
        }
      }))
      setError(`已存为食谱「${name}」`)
      setRecipeName(''); setRecipeInputOpen(false)
      setRecipesLoaded(false)
      void checkStatBadges()
    } catch (e) { setError(e instanceof Error ? e.message : '保存食谱失败，请重试') }
    finally { setSavingRecipe(false) }
  }

  const totals = useMemo(() => items.reduce((acc, it) => {
    const v = calc(it)
    return { kcal: acc.kcal + v.kcal, p: acc.p + v.p, c: acc.c + v.c, f: acc.f + v.f }
  }, { kcal: 0, p: 0, c: 0, f: 0 }), [items])

  const foodList = useMemo(() => {
    const k = keyword.trim()
    return (k ? searchFoods(k, 40) : listFoodsByCategory(category, 40))
  }, [keyword, category])

  return (
    <View className='ls-mask' onClick={handleClose}>
      <View className='ls-sheet' catchMove onClick={(e) => e.stopPropagation()}>
        <View className='ls-head'>
          <View className='ls-head-left'>
            <Text className='ls-title'>记录饮食</Text>
            <Text className='ls-sub'>{logDate} · 记入{MEAL_LABELS[meal]}</Text>
          </View>
          <View className='ls-close' onClick={handleClose}>×</View>
        </View>

        <ScrollView className='ls-body' scrollY>
          {/* 餐次 chip：主端 LogSheet:932-941 同源，日期只读（props.logDate 单一来源） */}
          <View className='ls-chips'>
            {MEAL_TYPES.map((m) => (
              <Button key={m} size='mini' className={`ls-chip ${m === meal ? 'active' : ''}`} onClick={() => setMeal(m)}>
                {MEAL_LABELS[m]}
              </Button>
            ))}
          </View>

          <View className='ls-stat'>
            <Text>今日识别剩余：{quotaDegraded ? '—' : pro ? '不限' : `${quota} 次`}</Text>
            <Text>积分：{honey}</Text>
          </View>

          {/* 模式 segment：主端 :1047-1060 同源，4 模式共用下方同一个草稿区 */}
          <View className='ls-seg'>
            {MODES.map((m) => (
              <View key={m.key} className={`ls-seg-item ${mode === m.key ? 'active' : ''}`} onClick={() => setMode(m.key)}>
                <Text>{m.label}</Text>
              </View>
            ))}
          </View>

          {mode === 'photo' && (
            <View className='ls-block'>
              <Input
                className='ls-input' maxlength={60} value={hint} placeholder='补充说明（可选）：半份、少油、加了两个蛋'
                onInput={(e) => setHint(e.detail.value)}
              />
              <Button className='ls-btn' loading={busy} disabled={busy} onClick={() => void onTakePhoto()}>
                {busy ? '正在识别食物，大约需要几秒…' : '拍照 / 选图识别'}
              </Button>
              {imageUrl ? <Image className='ls-photo' src={imageUrl} mode='aspectFit' /> : null}
              <Text className='ls-helper'>识别结果由 AI 生成，可能存在误差，请核对份量后再保存。</Text>
            </View>
          )}

          {mode === 'text' && (
            <View className='ls-block'>
              <Input
                className='ls-input' value={textDesc} placeholder='例如：一碗米饭、番茄炒蛋、一杯豆浆'
                onInput={(e) => setTextDesc(e.detail.value)}
              />
              <Button className='ls-btn' loading={busy} disabled={busy} onClick={() => void onParseText()}>
                {busy ? '识别中…' : '识别并加入待记录'}
              </Button>
              <Text className='ls-helper'>文字描述不消耗拍照次数，结果会先进下方草稿区供你核对。</Text>
            </View>
          )}

          {mode === 'manual' && (
            <View className='ls-block'>
              <Input
                className='ls-input' value={keyword} placeholder='搜索食物名称（内置食物库）'
                onInput={(e) => setKeyword(e.detail.value)}
              />
              <ScrollView className='ls-cats' scrollX>
                {['全部', ...FOOD_CATEGORIES].slice(0, 12).map((c) => (
                  <View key={c} className={`ls-cat ${c === category ? 'active' : ''}`} onClick={() => { setCategory(c); setKeyword('') }}>
                    <Text>{c}</Text>
                  </View>
                ))}
              </ScrollView>
              {foodList.slice(0, 20).map((f) => (
                <View key={f.name} className='ls-food' onClick={() => setItems((prev) => [...prev, fromFood(f)])}>
                  <Text className='ls-food-name'>{f.name}</Text>
                  <Text className='ls-food-meta'>{f.kcal} kcal/100g · {f.portionLabel}</Text>
                  <Text className='ls-food-add'>+</Text>
                </View>
              ))}
              {recentFoods.length > 0 && (
                <View className='ls-recent'>
                  <Text className='ls-block-title'>最近吃过</Text>
                  <View className='ls-recent-list'>
                    {recentFoods.slice(0, 8).map((r) => (
                      <Button key={r.name} size='mini' className='ls-recent-item'
                        onClick={() => setItems((prev) => [...prev,
                          fromFree(r.name, r.kcal, r.grams, r.protein_g, r.carb_g, r.fat_g)])}>
                        {r.name}
                      </Button>
                    ))}
                  </View>
                </View>
              )}
              {recipes.length > 0 && (
                <View className='ls-recent'>
                  <Text className='ls-block-title'>我的食谱</Text>
                  <View className='ls-recent-list'>
                    {recipes.map((r) => (
                      <Button key={r.name} size='mini' className='ls-recent-item'
                        onClick={() => setItems((prev) => [...prev, ...r.items.map(fromRecipeItem)])}>
                        {r.name}
                      </Button>
                    ))}
                  </View>
                </View>
              )}
              <Text className='ls-helper'>内置食物库数值为参考值，不构成医疗或营养建议。</Text>
            </View>
          )}

          {mode === 'free' && (
            <View className='ls-block'>
              <Input className='ls-input' value={freeName} placeholder='食物名称，如：燕麦粥'
                onInput={(e) => setFreeName(e.detail.value)} />
              <View className='ls-row'>
                <Input className='ls-input flex1' type='number' value={freeKcal} placeholder='热量 kcal *'
                  onInput={(e) => setFreeKcal(e.detail.value)} />
                <Input className='ls-input flex1' type='number' value={freeGrams} placeholder='份量克数'
                  onInput={(e) => setFreeGrams(e.detail.value)} />
              </View>
              <View className='ls-row'>
                <Input className='ls-input flex1' type='digit' value={freeP} placeholder='蛋白质 g'
                  onInput={(e) => setFreeP(e.detail.value)} />
                <Input className='ls-input flex1' type='digit' value={freeC} placeholder='碳水 g'
                  onInput={(e) => setFreeC(e.detail.value)} />
                <Input className='ls-input flex1' type='digit' value={freeF} placeholder='脂肪 g'
                  onInput={(e) => setFreeF(e.detail.value)} />
              </View>
              <Button className='ls-btn ghost' onClick={addFreeform}>加入待记录</Button>
              <Text className='ls-helper'>手动录入永久免费，不消耗识别次数。</Text>
            </View>
          )}

          {error ? <View className='ls-notice err'><Text>{error}</Text></View> : null}
          {dupHint ? <View className='ls-notice'><Text>{dupHint}</Text></View> : null}
          {saveNudge ? <View className='ls-notice'><Text>{saveNudge}</Text></View> : null}

          {/* 冲突三选一：内嵌横幅，替代此前 Taro.showActionSheet（主端 :954-976 同源） */}
          {overrideConfirm.open && (
            <View className='ls-notice conflict'>
              <Text className='ls-conflict-title'>这一餐已有 {overrideConfirm.count} 条记录</Text>
              <View className='ls-conflict-actions'>
                <Button size='mini' onClick={() => void confirmOverride()}>覆盖这一餐</Button>
                <Button size='mini' onClick={() => void confirmAppend()}>追加到这一餐</Button>
                <Button size='mini' onClick={cancelOverride}>取消本次保存</Button>
              </View>
            </View>
          )}

          {/* 统一草稿区：主端 :1292-1407 同源（克数缩放 / 份量预设 / 删除 / AI 标识 / 偏差提示） */}
          {items.length > 0 && (
            <View className='ls-drafts'>
              <View className='ls-drafts-head'>
                <Text className='ls-block-title'>待记录 {items.length} 项</Text>
                <AiLabel />
              </View>
              {items.map((it) => {
                const v = calc(it)
                return (
                  <View key={it.key} className='ls-draft'>
                    <View className='ls-draft-top'>
                      <Text className='ls-draft-name'>{it.food_name}</Text>
                      {isAiDraft(it) ? <AiLabel /> : null}
                      <Text className='ls-draft-del' onClick={() => removeItem(it.key)}>×</Text>
                    </View>
                    <Text className='ls-draft-meta'>{portionText(it)} · {v.kcal} kcal · 蛋白 {v.p}g</Text>
                    {it.source === 'photo' || it.source === 'text'
                      ? <Text className='ls-helper'>{estimateHint(it)}</Text> : null}
                    <View className='ls-draft-actions'>
                      {portionPresets(it).map((p) => (
                        <Button key={p.label} size='mini' className={`ls-chip ${it.grams === p.grams ? 'active' : ''}`}
                          onClick={() => updateGrams(it.key, p.grams)}>{p.label}</Button>
                      ))}
                      <Input className='ls-grams' type='number' value={String(it.grams)}
                        onInput={(e) => {
                          const n = Number(e.detail.value)
                          if (Number.isFinite(n) && n >= GRAMS_LIMIT.min && n <= GRAMS_LIMIT.max) updateGrams(it.key, Math.round(n))
                        }} />
                      <Text className='ls-unit'>克</Text>
                    </View>
                  </View>
                )
              })}
              <View className='ls-total'>
                <Text>合计 {roundTo(totals.kcal, 0)} kcal · 蛋白 {roundTo(totals.p, 1)}g / 碳水 {roundTo(totals.c, 1)}g / 脂肪 {roundTo(totals.f, 1)}g</Text>
              </View>
            </View>
          )}

          <Button className='ls-btn save' loading={saving} disabled={saving || items.length === 0}
            onClick={handleSave}>
            {saving ? '保存中…' : `保存到${MEAL_LABELS[meal]}`}
          </Button>
          <AiLabel inline text='识别结果由 AI 生成，可能存在误差，不构成医疗或营养建议，请核对后再保存。' />

          {items.length > 0 && (
            <View className='ls-block'>
              {recipeInputOpen ? (
                <View className='ls-row'>
                  <Input className='ls-input flex1' value={recipeName} placeholder='给食谱起个名字'
                    onInput={(e) => setRecipeName(e.detail.value)} />
                  <Button size='mini' disabled={savingRecipe || !recipeName.trim()} onClick={() => void onSaveRecipe()}>
                    {savingRecipe ? '保存中…' : '确认'}
                  </Button>
                  <Button size='mini' onClick={() => { setRecipeInputOpen(false); setRecipeName('') }}>取消</Button>
                </View>
              ) : (
                <Button className='ls-btn ghost' onClick={() => setRecipeInputOpen(true)}>存为食谱</Button>
              )}
            </View>
          )}

          <View className='ls-redeem'>
            <Text className='ls-block-title'>积分兑换拍照额度</Text>
            <Text className='ls-helper'>{HONEY_PRICE.ai1Scan} 积分兑换 1 次 AI 拍照识别（每日最多 {AI_REDEEM_DAILY_LIMIT} 次）</Text>
            <Button className='ls-btn ghost' onClick={() => void onRedeem()}>兑换 1 次（{HONEY_PRICE.ai1Scan} 积分）</Button>
          </View>

          {upsellVisible && (
            <View className='ls-notice'>
              <Text>升级 Pro 可无限次拍照识别、解锁完整报告。</Text>
              <View className='ls-conflict-actions'>
                <Button size='mini' onClick={() => { setUpsellVisible(false); Taro.navigateTo({ url: '/pages/paywall/paywall' }) }}>去看看</Button>
                <Button size='mini' onClick={() => { setUpsellVisible(false); void dismissUpsell() }}>不再提醒</Button>
              </View>
            </View>
          )}
        </ScrollView>
      </View>

      {aiConsentOpen && (
        <AiConsent
          kind='photo'
          onAgree={async () => {
            await grantAiConsent(profile)
            setProfile((p) => (p ? { ...p, ai_consented: true } : p))
            setAiConsentOpen(false)
          }}
          onDecline={() => setAiConsentOpen(false)}
        />
      )}
    </View>
  )
}

export default LogSheet
