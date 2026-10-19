/**
 * 小程序端饮食体检引擎（对齐主工程 src/lib/foodInsight.ts）。
 * 纯函数、离线、不消耗 AI 额度。这里移植 summarizeEntries / nextMealAdvice /
 * levelOfScore / LEVEL_LABELS，及 analyzeProfile 核心（分类反查用简化关键词版，
 * 不搬运完整 1175 条食物库，后续轮次评估是否引入共享食物库）。
 */
import type { MealEntry } from './api'

export type InsightTone = 'risk' | 'good'

export interface FoodTag {
  key: string
  label: string
  tone: InsightTone
  reason: string
  weight: 1 | 2 | 3
}

export type InsightLevel = 'great' | 'good' | 'ok' | 'caution' | 'limit'

export const LEVEL_LABELS: Record<InsightLevel, string> = {
  great: '很值得吃',
  good: '可以放心吃',
  ok: '适量就好',
  caution: '建议控制份量',
  limit: '尽量少吃',
}

/* ── 分类反查（简化关键词版，替代主工程完整食物库）── */

const CATEGORY_RULES: { cat: string; keys: string[] }[] = [
  { cat: '蔬菜', keys: ['菜', '青菜', '菠菜', '白菜', '生菜', '西兰花', '番茄', '黄瓜', '胡萝卜', '茄子', '豆角', '芹菜', '萝卜', '青椒', '蘑菇', '菌', '芦笋', '洋葱', '西葫芦'] },
  { cat: '水果', keys: ['苹果', '香蕉', '橙', '梨', '葡萄', '西瓜', '草莓', '桃', '莓', '柠檬', '芒果', '菠萝', '猕猴桃', '柚子', '樱桃'] },
  { cat: '水产', keys: ['鱼', '虾', '蟹', '贝', '蛤', '鱿', '海带', '紫菜', '三文鱼', '带鱼', '虾仁'] },
  { cat: '蛋奶', keys: ['蛋', '奶', '酸奶', '芝士', '奶酪', '牛奶', '奶粉', '酸奶'] },
  { cat: '豆制品', keys: ['豆腐', '豆浆', '豆干', '腐竹', '豆皮', '豆芽'] },
  { cat: '坚果种子', keys: ['坚果', '核桃', '杏仁', '腰果', '花生', '瓜子', '芝麻', '松子', '开心果'] },
  { cat: '主食', keys: ['米饭', '面条', '馒头', '面包', '粥', '米粉', '饺子', '包子', '饼', '饭', '米线', '意面', '燕麦', '红薯', '玉米', '土豆', '薯'] },
  { cat: '饮料酒水', keys: ['可乐', '奶茶', '咖啡', '果汁', '汽水', '饮料', '啤酒', '白酒', '酒', '茶'] },
  { cat: '快餐外卖', keys: ['汉堡', '薯条', '炸鸡', '披萨', '外卖', '麻辣烫', '烧烤', '烤串'] },
  { cat: '零食糕点', keys: ['薯片', '饼干', '蛋糕', '巧克力', '糖果', '冰淇淋', '雪糕', '蛋挞', '泡芙'] },
]

export function categoryOf(name: string): string {
  const n = (name || '').trim()
  if (!n) return '其他'
  for (const r of CATEGORY_RULES) {
    if (r.keys.some((k) => n.includes(k))) return r.cat
  }
  return '其他'
}

/* ── 规则词表（与主工程一致）── */

const OILY_KEYS = ['炸', '油条', '油饼', '酥', '脆皮', '锅包', '干锅', '爆炒', '红烧', '糖醋', '蜜汁', '拔丝', '回锅', '辣子', '烤串', '烤肉', '烧烤', '奶油', '黄油', '奶酪', '芝士', '沙拉酱', '薯条', '薯片', '肥牛', '五花', '猪蹄', '肘子', '起酥', '可颂', '派', '蛋挞', '泡芙']
const SALTY_KEYS = ['腌', '咸', '卤', '腐乳', '榨菜', '泡菜', '酸菜', '豆豉', '腊', '火腿', '培根', '香肠', '午餐肉', '肉松', '酱肉', '咸蛋', '皮蛋', '豆瓣酱', '辣酱', '沙茶']
const WHOLEGRAIN_KEYS = ['全麦', '糙', '燕麦', '藜麦', '荞麦', '青稞', '薏米', '高粱', '黑米', '紫米', '杂粮', '玉米', '红薯', '紫薯', '山药', '芋头', '南瓜', '莲藕']
const LIGHT_KEYS = ['蒸', '白灼', '清蒸', '凉拌', '水煮', '汆', '炖', '清炒', '汤']
const LIGHT_PRODUCT_KEYS = ['无糖', '零度', '零卡', '脱脂', '低脂', '低糖', '不加糖', '0糖']

const BENEFIT_CATEGORY: Record<string, { label: string; reason: string; weight: 1 | 2 | 3 }> = {
  蔬菜: { label: '蔬菜', reason: '膳食纤维与维生素的主要来源，热量通常很低', weight: 3 },
  菌菇: { label: '菌菇', reason: '热量低、有膳食纤维，适合用来填饱肚子', weight: 2 },
  水果: { label: '水果', reason: '维生素与钾的来源，比同甜度的加工甜食更值得吃', weight: 2 },
  水产: { label: '水产', reason: '优质蛋白，脂肪多为不饱和脂肪酸', weight: 3 },
  蛋奶: { label: '蛋奶', reason: '优质蛋白与钙的来源', weight: 2 },
  豆制品: { label: '豆制品', reason: '植物蛋白来源，饱和脂肪比肉类低', weight: 2 },
  坚果种子: { label: '坚果种子', reason: '不饱和脂肪与维生素 E 的来源', weight: 2 },
}

const RISK_CATEGORY: Record<string, { label: string; reason: string; weight: 1 | 2 | 3 }> = {
  快餐外卖: { label: '快餐外卖', reason: '这类食物油盐用量普遍偏高，且份量常被低估', weight: 2 },
  零食糕点: { label: '零食糕点', reason: '糖与油的组合最容易让热量悄悄超标', weight: 2 },
}

const STAPLE_REFINED: FoodTag = { key: 'refined_staple', label: '精制主食', tone: 'risk', reason: '升糖较快、饱腹感偏短，建议搭配蛋白质与蔬菜一起吃', weight: 2 }

const has = (name: string, keys: string[]) => keys.some((k) => name.includes(k))

function uniq(top: FoodTag[], cap: number): FoodTag[] {
  const best = new Map<string, FoodTag>()
  for (const t of top) {
    const prev = best.get(t.key)
    if (!prev || t.weight > prev.weight) best.set(t.key, t)
  }
  return Array.from(best.values()).sort((a, b) => b.weight - a.weight).slice(0, cap)
}

function levelOf(score: number): InsightLevel {
  if (score >= 80) return 'great'
  if (score >= 65) return 'good'
  if (score >= 50) return 'ok'
  if (score >= 35) return 'caution'
  return 'limit'
}

export function levelOfScore(score: number): InsightLevel {
  return levelOf(score)
}

/* ── 单条画像 ── */

export interface FoodInsight {
  score: number
  level: InsightLevel
  verdict: string
  risks: FoodTag[]
  benefits: FoodTag[]
  aiAssisted: boolean
}

export function analyzeEntry(
  entry: Pick<MealEntry, 'food_name' | 'grams' | 'calories' | 'protein_g' | 'carb_g' | 'fat_g' | 'health_score' | 'sodium_mg' | 'fiber_g' | 'added_sugar_g'>,
  resolve: (name: string) => string = categoryOf,
): FoodInsight {
  const name = entry.food_name || ''
  const grams = Number(entry.grams) || 0
  const usable = grams >= 10
  const r = usable ? 100 / grams : 1

  const kcal = (Number(entry.calories) || 0) * r
  const protein = (Number(entry.protein_g) || 0) * r
  const carb = (Number(entry.carb_g) || 0) * r
  const fat = (Number(entry.fat_g) || 0) * r
  const sodium = entry.sodium_mg != null ? (Number(entry.sodium_mg) || 0) * r : 0
  const fiber = entry.fiber_g != null ? (Number(entry.fiber_g) || 0) * r : 0
  const addedSugar = entry.added_sugar_g != null ? (Number(entry.added_sugar_g) || 0) * r : 0
  const cat = resolve(name)

  if (kcal <= 0 && protein <= 0 && carb <= 0 && fat <= 0) {
    return { score: 50, level: 'ok', verdict: '这个食物缺少营养数据，无法给出判断', risks: [], benefits: [], aiAssisted: false }
  }

  const risks: FoodTag[] = []
  const benefits: FoodTag[] = []

  const energy = protein * 4 + carb * 4 + fat * 9
  const pRatio = energy > 0 ? (protein * 4) / energy : 0
  const cRatio = energy > 0 ? (carb * 4) / energy : 0
  const fRatio = energy > 0 ? (fat * 9) / energy : 0

  if (kcal >= 400) risks.push({ key: 'dense', label: '热量密度高', tone: 'risk', reason: `${Math.round(kcal)} kcal/100g，吃同样的重量更容易吃掉大半天预算`, weight: 3 })
  else if (kcal <= 80 && kcal > 0) benefits.push({ key: 'low_density', label: '低热量密度', tone: 'good', reason: `${Math.round(kcal)} kcal/100g，可以吃较大份量而热量压力小`, weight: 2 })

  const fatExempt = cat === '水产' || cat === '坚果种子'
  if (!fatExempt && fRatio >= 0.5) risks.push({ key: 'high_fat', label: '高脂', tone: 'risk', reason: `脂肪提供了 ${Math.round(fRatio * 100)}% 的能量`, weight: 3 })
  else if (!fatExempt && fRatio >= 0.35) risks.push({ key: 'oily', label: '偏油', tone: 'risk', reason: `脂肪提供了 ${Math.round(fRatio * 100)}% 的能量`, weight: 2 })
  else if (fRatio <= 0.25 && pRatio >= 0.2) benefits.push({ key: 'lean_fat', label: '脂肪比例适中', tone: 'good', reason: `脂肪只占 ${Math.round(fRatio * 100)}% 的能量`, weight: 1 })

  if (protein >= 20) benefits.push({ key: 'protein_top', label: '蛋白质很高', tone: 'good', reason: `${Math.round(protein)} g/100g，减脂期最该保证的一类营养`, weight: 3 })
  else if (protein >= 10) benefits.push({ key: 'protein_good', label: '蛋白质较好', tone: 'good', reason: `${Math.round(protein)} g/100g`, weight: 2 })
  if (protein >= 15 && fRatio < 0.4) benefits.push({ key: 'high_p_low_f', label: '高蛋白低脂', tone: 'good', reason: `蛋白 ${Math.round(protein)} g 而脂肪仅占 ${Math.round(fRatio * 100)}% 能量`, weight: 3 })

  if (cat === '饮料酒水') {
    if (carb >= 8) risks.push({ key: 'sugary_drink', label: '含糖饮料', tone: 'risk', reason: `每 100ml 含碳水 ${Math.round(carb)} g，液体热量最不容易被记住`, weight: 3 })
    if (has(name, ['酒', '啤酒', '白酒', '红酒', '黄酒', '米酒', '清酒'])) risks.push({ key: 'alcohol', label: '含酒精', tone: 'risk', reason: '酒精几乎只提供热量，且会降低自控力', weight: 3 })
  } else if (kcal >= 200 && cRatio >= 0.6 && !has(name, WHOLEGRAIN_KEYS)) {
    risks.push({ key: 'carb_heavy', label: '碳水占比高', tone: 'risk', reason: `碳水提供了 ${Math.round(cRatio * 100)}% 的能量`, weight: 2 })
  }

  const bc = BENEFIT_CATEGORY[cat]
  if (bc) benefits.push({ key: `cat_${cat}`, label: bc.label, tone: 'good', reason: bc.reason, weight: bc.weight })
  const rc = RISK_CATEGORY[cat]
  if (rc) risks.push({ key: `cat_${cat}`, label: rc.label, tone: 'risk', reason: rc.reason, weight: rc.weight })
  if (cat === '主食' && !has(name, WHOLEGRAIN_KEYS)) risks.push(STAPLE_REFINED)
  if (cat === '坚果种子' && kcal >= 400) risks.push({ key: 'nut_portion', label: '注意份量', tone: 'risk', reason: '坚果营养好但热量集中，一天一小把（约 25g）就够', weight: 2 })

  if (has(name, OILY_KEYS)) risks.push({ key: 'oily_cook', label: '油糖用量偏高', tone: 'risk', reason: '这类做法通常会额外加入较多油或糖', weight: 2 })
  if (has(name, SALTY_KEYS)) risks.push({ key: 'salty', label: '钠可能偏高', tone: 'risk', reason: '腌渍或加工工艺会让钠明显升高', weight: 3 })
  if (has(name, WHOLEGRAIN_KEYS)) benefits.push({ key: 'wholegrain', label: '全谷杂粮', tone: 'good', reason: '膳食纤维更多，饱腹感更持久', weight: 2 })
  if (has(name, LIGHT_KEYS) && fRatio < 0.4 && !has(name, OILY_KEYS)) benefits.push({ key: 'light_cook', label: '做法清淡', tone: 'good', reason: '蒸煮凉拌类做法用油少', weight: 1 })
  if (has(name, LIGHT_PRODUCT_KEYS)) benefits.push({ key: 'light_product', label: '低糖低脂款', tone: 'good', reason: '配料上做过减糖或减脂处理', weight: 1 })

  if (sodium >= 600) risks.push({ key: 'high_sodium', label: '高钠', tone: 'risk', reason: `钠约 ${Math.round(sodium)} mg/100g`, weight: 3 })
  else if (sodium >= 300) risks.push({ key: 'moderate_sodium', label: '钠偏高', tone: 'risk', reason: `钠约 ${Math.round(sodium)} mg/100g`, weight: 2 })
  else if (sodium > 0 && sodium <= 60) benefits.push({ key: 'low_sodium', label: '低钠', tone: 'good', reason: `钠约 ${Math.round(sodium)} mg/100g`, weight: 1 })

  if (fiber >= 6) benefits.push({ key: 'high_fiber', label: '高膳食纤维', tone: 'good', reason: `膳食纤维约 ${fiber} g/100g`, weight: 2 })
  else if (fiber >= 3 && fiber > 0) benefits.push({ key: 'some_fiber', label: '含膳食纤维', tone: 'good', reason: `膳食纤维约 ${fiber} g/100g`, weight: 1 })

  if (addedSugar >= 10) risks.push({ key: 'high_added_sugar', label: '添加糖偏高', tone: 'risk', reason: `添加糖约 ${addedSugar} g/100g`, weight: 3 })
  else if (addedSugar >= 5 && addedSugar > 0) risks.push({ key: 'moderate_added_sugar', label: '含添加糖', tone: 'risk', reason: `添加糖约 ${addedSugar} g/100g`, weight: 2 })

  const riskList = uniq(risks, 3)
  const benefitList = uniq(benefits, 3)

  let score = 60
  for (const b of benefitList) score += b.weight * 7
  for (const r of riskList) score -= r.weight * 6

  const ai = typeof entry.health_score === 'number' && Number.isFinite(entry.health_score) && entry.health_score > 0 ? entry.health_score : null
  const finalScore = ai === null ? score : Math.round(score * 0.5 + ai * 0.5)
  score = Math.max(5, Math.min(98, Math.round(finalScore)))

  const level = levelOf(score)

  let verdict: string
  if (riskList.length === 0 && benefitList.length > 0) verdict = `${LEVEL_LABELS[level]} —— 目前没发现明显问题`
  else if (riskList.length > 0 && benefitList.length === 0) verdict = `${LEVEL_LABELS[level]} —— 主要问题是${riskList[0].label}`
  else if (riskList.length > 0) verdict = `${LEVEL_LABELS[level]} —— 好处是${benefitList[0].label}，但要留意${riskList[0].label}`
  else verdict = LEVEL_LABELS[level]

  const result: FoodInsight = { score, level, verdict, risks: riskList, benefits: benefitList, aiAssisted: ai !== null }

  if (!usable) {
    const drop = new Set(['dense', 'low_density'])
    result.risks = result.risks.filter((t) => !drop.has(t.key))
    result.benefits = result.benefits.filter((t) => !drop.has(t.key))
  }

  return result
}

/* ── 当日汇总 ── */

export interface TagSummary {
  key: string
  label: string
  reason: string
  tone: InsightTone
  weight: 1 | 2 | 3
  count: number
  items: string[]
  kcal: number
}

export interface DayInsight {
  scanned: number
  aiAssisted: number
  risks: TagSummary[]
  benefits: TagSummary[]
  avgScore: number | null
  verdict: string
}

export function summarizeEntries(entries: MealEntry[], resolve: (name: string) => string = categoryOf): DayInsight {
  const valid = entries.filter((e) => (Number(e.calories) || 0) > 0 || (Number(e.protein_g) || 0) > 0)
  if (valid.length === 0) return { scanned: 0, aiAssisted: 0, risks: [], benefits: [], avgScore: null, verdict: '' }

  const collect = (pick: (i: FoodInsight) => FoodTag[]) => {
    const map = new Map<string, TagSummary>()
    for (const e of valid) {
      const insight = analyzeEntry(e, resolve)
      const kcal = Number(e.calories) || 0
      for (const t of pick(insight)) {
        const prev = map.get(t.key)
        if (prev) {
          prev.count += 1
          if (!prev.items.includes(e.food_name) && prev.items.length < 3) prev.items.push(e.food_name)
          prev.kcal += kcal
        } else {
          map.set(t.key, { key: t.key, label: t.label, reason: t.reason, tone: t.tone, weight: t.weight, count: 1, items: [e.food_name], kcal })
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.weight * 100 + b.count - (a.weight * 100 + a.count) || b.kcal - a.kcal)
  }

  const risks = collect((i) => i.risks).slice(0, 4)
  const benefits = collect((i) => i.benefits).slice(0, 4)
  const scores = valid.map((e) => analyzeEntry(e, resolve).score)
  const avgScore = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
  const aiAssisted = valid.filter((e) => analyzeEntry(e, resolve).aiAssisted).length

  let verdict: string
  if (risks.length === 0 && benefits.length === 0) verdict = '这几餐没发现明显问题，也没识别到突出优点。'
  else if (risks.length === 0) verdict = `这一天的选择都挺稳，最突出的是${benefits[0].label}。`
  else if (benefits.length === 0) verdict = `需要留意${risks[0].label}，共 ${risks[0].count} 项。`
  else verdict = `亮点是${benefits[0].label}，同时要留意${risks[0].label}（${risks[0].count} 项）。`

  return { scanned: valid.length, aiAssisted, risks, benefits, avgScore, verdict }
}

/* ── 下一餐建议额度 ── */

export interface NextMealAdvice {
  budget: number | null
  over: boolean
  remainingMeals: number
  text: string
}

export function nextMealAdvice(remainKcal: number, eatenMeals: Set<string>, now: Date = new Date()): NextMealAdvice {
  const order = ['breakfast', 'lunch', 'dinner', 'snack'] as const
  const hour = now.getHours()
  const deadline: Record<(typeof order)[number], number> = { breakfast: 10, lunch: 15, dinner: 21, snack: 24 }
  const pending = order.filter((m) => !eatenMeals.has(m) && hour < deadline[m])
  const remainingMeals = Math.max(pending.length, 1)

  if (remainKcal <= 0) {
    return { budget: null, over: true, remainingMeals, text: `今天已超出 ${Math.abs(Math.round(remainKcal))} kcal，接下来建议只喝水或无糖茶饮，下一餐以蔬菜和蛋白质为主。` }
  }
  const budget = Math.round(remainKcal / remainingMeals / 10) * 10
  return { budget, over: false, remainingMeals, text: `今天还能吃 ${Math.round(remainKcal)} kcal，还剩 ${remainingMeals} 餐，下一餐建议控制在 ${budget} kcal 以内。` }
}
