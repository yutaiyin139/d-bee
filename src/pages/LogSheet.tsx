import { useMemo, useState } from 'react'
import { insertMeals } from '../lib/api'
import { compressImage, identifyPackagedFood, parseFoodFromText, recognizeFoodFromImage } from '../lib/ai'
import { lookupBarcode } from '../lib/off'
import {
  categoryOf,
  FOOD_CATEGORIES,
  FOOD_SORTS,
  foodInsight,
  listFoods,
  satiety,
  searchFoods,
  type FoodItem,
  type FoodSort,
} from '../lib/foods'
import { analyzeProfile } from '../lib/foodInsight'
import { quotaExhaustedReason } from '../lib/entitlement'
import { pickFileFromInput, PHOTO_INPUT_PROPS } from '../lib/capture'
import { FoodTagList } from '../components/FoodTags'
import { Scanner } from '../components/Scanner'
import { usePlan } from '../state/plan'
import { MEAL_LABELS, MEAL_ORDER } from '../types'
import type { DetectedFood, MealEntry, MealType, RecordSource } from '../types'

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
  source: RecordSource
  note?: string
  health_score?: number
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
}

let keySeq = 0
const nextKey = () => `d${++keySeq}`

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
    source,
    note: d.note,
    health_score: d.health_score,
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
    source: 'manual',
  }
}

/** 由 Open Food Facts 的「每 100g」数据构造待记录项 */
function fromPackaged(
  name: string,
  grams: number,
  per100g: { kcal: number; protein: number; carb: number; fat: number },
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
    source: 'barcode',
    note,
  }
}

const calc = (it: DraftItem) => ({
  kcal: Math.round(it.kcalPerG * it.grams),
  p: Math.round(it.pPerG * it.grams * 10) / 10,
  c: Math.round(it.cPerG * it.grams * 10) / 10,
  f: Math.round(it.fPerG * it.grams * 10) / 10,
})

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

export function LogSheet({ logDate, initialMeal, onClose, onSaved, budget, budgetText }: LogSheetProps) {
  const { claimAiQuota, refundAiQuota, aiRemaining, openPaywall } = usePlan()
  const [mode, setMode] = useState<Mode>('photo')
  const [meal, setMeal] = useState<MealType>(initialMeal)
  const [items, setItems] = useState<DraftItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

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
   * AI 调用前的统一闸门：原子占用一次免费额度。
   * 额度在服务端一条语句内「判断 + 自增」，多端并发也不会超发；
   * 占用发生但后续 AI 调用失败时，由各 handler 的 catch 退还。
   */
  async function guardAiQuota(): Promise<boolean> {
    const q = await claimAiQuota()
    if (!q.allowed) {
      openPaywall(quotaExhaustedReason())
      return false
    }
    return true
  }

  async function handleFile(file: File) {
    setError('')
    setBusy(true)
    let claimed = false
    try {
      if (!(await guardAiQuota())) return
      claimed = true
      const dataUrl = await compressImage(file)
      setPreview(dataUrl)
      const res = await recognizeFoodFromImage(dataUrl, hint.trim() || undefined)
      setItems((prev) => [...prev, ...res.map((d) => toDraft(d, 'photo'))])
    } catch (e) {
      if (claimed) await refundAiQuota()
      setError(e instanceof Error ? e.message : '识别失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function handleTextParse() {
    if (!text.trim()) return
    setError('')
    setBusy(true)
    let claimed = false
    try {
      if (!(await guardAiQuota())) return
      claimed = true
      const res = await parseFoodFromText(text.trim())
      setItems((prev) => [...prev, ...res.map((d) => toDraft(d, 'text'))])
      setText('')
    } catch (e) {
      if (claimed) await refundAiQuota()
      setError(e instanceof Error ? e.message : '解析失败，请重试')
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
      setError(e instanceof Error ? e.message : '查询商品库失败')
    } finally {
      setBusy(false)
    }
  }

  /** 兜底：拍包装正面照片，交给视觉模型读营养表 */
  async function handlePackagePhoto(file: File) {
    setError('')
    setBusy(true)
    let claimed = false
    try {
      if (!(await guardAiQuota())) return
      claimed = true
      const dataUrl = await compressImage(file)
      const res = await identifyPackagedFood(dataUrl, missCode || undefined)
      setItems((prev) => [...prev, ...res.map((d) => toDraft(d, 'barcode'))])
      setScanMsg({ kind: 'ok', text: '已按包装上的营养表识别，请核对份量是否与实物一致。' })
      setMissCode('')
    } catch (e) {
      if (claimed) await refundAiQuota()
      setError(e instanceof Error ? e.message : '识别包装失败，请重试')
    } finally {
      setBusy(false)
    }
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
          source: it.source,
          image_url: null,
          ai_note: it.note ?? null,
          health_score: it.health_score ?? null,
        }
      })
      await insertMeals(rows)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="sheet-mask" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="记录饮食">
        <div className="sheet-head">
          <h2>记录饮食</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {mode !== 'manual' && aiRemaining !== null && (
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>今日剩 {aiRemaining} 次 AI</span>
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
                <label className="dropzone" style={{ display: 'block' }}>
                  <strong>拍一张这一餐的照片</strong>
                  AI 会自动识别食物并估算热量
                  <input
                    {...PHOTO_INPUT_PROPS}
                    onChange={(e) => {
                      const f = pickFileFromInput(e)
                      if (f) void handleFile(f)
                    }}
                  />
                </label>
              )}

              {busy && (
                <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="spinner" style={{ borderColor: 'rgba(107,74,8,.3)', borderTopColor: '#6b4a08' }} />
                  正在识别食物，大约需要几秒…
                </div>
              )}

              {preview && !busy && (
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                  <label className="btn btn-ghost" style={{ flex: 1 }}>
                    换一张照片
                    <input
                      {...PHOTO_INPUT_PROPS}
                      onChange={(e) => {
                        const f = pickFileFromInput(e)
                        if (f) void handleFile(f)
                      }}
                    />
                  </label>
                </div>
              )}

              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="hint">补充说明（可选）</label>
                <input
                  id="hint"
                  placeholder="例如：半份、少油、加了两个蛋"
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
                <label className="btn btn-ghost" style={{ marginTop: 12, display: 'block', textAlign: 'center' }}>
                  {busy ? '正在识别包装…' : '拍包装正面，读营养表'}
                  <input
                    {...PHOTO_INPUT_PROPS}
                    onChange={(e) => {
                      const f = pickFileFromInput(e)
                      if (f) void handlePackagePhoto(f)
                    }}
                  />
                </label>
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
              <div className="field">
                <input
                  placeholder="搜索食物，如「米饭」「鸡胸肉」"
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
                <span className="hint">共 {totals.kcal} kcal</span>
              </div>
              <div className="card card-tight">
                {items.map((it) => {
                  const v = calc(it)
                  return (
                    <div key={it.key} className="food-row">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="nm">{it.food_name}</div>
                        <div className="sub">
                          {v.kcal} kcal · 蛋 {v.p}g · 碳 {v.c}g · 脂 {v.f}g
                        </div>
                        {it.note && (
                          <div className="sub" style={{ color: 'var(--honey-dark)' }}>{it.note}</div>
                        )}
                        <FoodTagList tags={draftInsight(it).tags.slice(0, 2)} />
                      </div>
                      <div className="stepper">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={Math.round(it.grams)}
                          onChange={(e) => updateGrams(it.key, Math.max(1, Number(e.target.value) || 1))}
                        />
                        <span className="unit">g</span>
                        <button className="entry-del" onClick={() => removeItem(it.key)} aria-label="移除">
                          ×
                        </button>
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
        </div>
      </div>
    </div>
  )
}
