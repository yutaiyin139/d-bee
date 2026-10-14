import type { MealEntry } from '../types'

/**
 * 食物画像引擎：风险发现 + 益处探索。
 *
 * 设计约束（重要）：
 * 1. **纯函数、完全离线、不调用任何模型** —— 因此不消耗用户的 AI 配额，断网可用，
 *    结果可复现、可解释。这是刻意的：AI 额度只用在「识别」这种真正需要模型的环节，
 *    而「这食物有什么问题」是可以用规则算清楚的。
 * 2. **每条结论都带数字依据**（如「脂肪提供 52% 的能量」），不是空泛的健康标语。
 * 3. **数据边界**：成分表只有能量与三大营养素，没有钠 / 膳食纤维 / 添加糖字段，
 *    所以钠、添加糖一类判断只能靠分类与名称关键词给出**倾向性提示**，
 *    界面上必须带上「仅供参考、不构成医疗建议」的说明。
 */

export type InsightTone = 'risk' | 'good'

export interface FoodTag {
  key: string
  label: string
  tone: InsightTone
  /** 一句话依据，含具体数字 */
  reason: string
  /** 强度 1–3，用于排序与着色 */
  weight: 1 | 2 | 3
}

/** 每 100g（毫升）的营养画像 */
export interface FoodProfile {
  name: string
  category: string
  kcal: number
  protein: number
  carb: number
  fat: number
}

export interface FoodInsight {
  /** 健康友好度 0–100 */
  score: number
  level: 'great' | 'good' | 'ok' | 'caution' | 'limit'
  verdict: string
  risks: FoodTag[]
  benefits: FoodTag[]
  tags: FoodTag[]
  /** 是否由 AI 评分参与（识别记录携带 health_score 时为真） */
  aiAssisted: boolean
}

export const LEVEL_LABELS: Record<FoodInsight['level'], string> = {
  great: '很值得吃',
  good: '可以放心吃',
  ok: '适量就好',
  caution: '建议控制份量',
  limit: '尽量少吃',
}

/* ────────────────────────── 规则词表 ────────────────────────── */

/** 高油 / 高糖的烹饪方式与食材 */
const OILY_KEYS = [
  '炸', '油条', '油饼', '油面筋', '酥', '脆皮', '锅包', '干锅', '爆炒', '红烧', '糖醋',
  '蜜汁', '拔丝', '回锅', '辣子', '烤串', '烤肉', '烧烤', '奶油', '黄油', '奶酪', '芝士',
  '沙拉酱', '千岛', '蛋黄酱', '薯条', '薯片', '肥牛', '五花', '猪蹄', '肘子', '雪花',
  '起酥', '可颂', '派', '蛋挞', '泡芙',
]

/** 钠含量通常偏高的腌渍 / 加工品 */
const SALTY_KEYS = [
  '腌', '咸', '卤', '腐乳', '榨菜', '泡菜', '酸菜', '梅干菜', '豆豉', '腊', '火腿',
  '培根', '香肠', '午餐肉', '肉松', '酱肉', '咸蛋', '皮蛋', '豆瓣酱', '辣酱', '沙茶',
]

/** 全谷杂粮 / 薯类，纤维与饱腹感通常更好 */
const WHOLEGRAIN_KEYS = [
  '全麦', '糙', '燕麦', '藜麦', '荞麦', '青稞', '薏米', '高粱', '黑米', '紫米', '杂粮',
  '玉米', '红薯', '紫薯', '山药', '芋头', '南瓜', '莲藕',
]

/** 清淡的烹饪方式 */
const LIGHT_KEYS = ['蒸', '白灼', '清蒸', '凉拌', '水煮', '汆', '炖', '清炒', '汤']

/** 明确做了减糖 / 减脂处理的产品 */
const LIGHT_PRODUCT_KEYS = ['无糖', '零度', '零卡', '脱脂', '低脂', '低糖', '不加糖', '0 糖', '0糖']

const BENEFIT_CATEGORY: Record<string, { label: string; reason: string; weight: 1 | 2 | 3 }> = {
  蔬菜: {
    label: '蔬菜',
    reason: '膳食纤维与维生素的主要来源，热量通常很低',
    weight: 3,
  },
  菌菇: {
    label: '菌菇',
    reason: '热量低、有膳食纤维，适合用来填饱肚子',
    weight: 2,
  },
  水果: {
    label: '水果',
    reason: '维生素与钾的来源，比同甜度的加工甜食更值得吃',
    weight: 2,
  },
  水产: {
    label: '水产',
    reason: '优质蛋白，脂肪多为不饱和脂肪酸',
    weight: 3,
  },
  蛋奶: {
    label: '蛋奶',
    reason: '优质蛋白与钙的来源',
    weight: 2,
  },
  豆制品: {
    label: '豆制品',
    reason: '植物蛋白来源，饱和脂肪比肉类低',
    weight: 2,
  },
  坚果种子: {
    label: '坚果种子',
    reason: '不饱和脂肪与维生素 E 的来源',
    weight: 2,
  },
}

const RISK_CATEGORY: Record<string, { label: string; reason: string; weight: 1 | 2 | 3 }> = {
  快餐外卖: {
    label: '快餐外卖',
    reason: '这类食物油盐用量普遍偏高，且份量常被低估',
    weight: 2,
  },
  零食糕点: {
    label: '零食糕点',
    reason: '糖与油的组合最容易让热量悄悄超标',
    weight: 2,
  },
  调味品: {
    label: '调味品',
    reason: '少量使用即可，钠与油容易在不知不觉间累积',
    weight: 2,
  },
}

/** 主食里若不含全谷杂粮关键词，视为精制主食 */
const STAPLE_REFINED: FoodTag = {
  key: 'refined_staple',
  label: '精制主食',
  tone: 'risk',
  reason: '升糖较快、饱腹感偏短，建议搭配蛋白质与蔬菜一起吃',
  weight: 2,
}

/* ────────────────────────── 工具 ────────────────────────── */

const has = (name: string, keys: string[]) => keys.some((k) => name.includes(k))

function uniq(top: FoodTag[], cap: number): FoodTag[] {
  const best = new Map<string, FoodTag>()
  for (const t of top) {
    const prev = best.get(t.key)
    if (!prev || t.weight > prev.weight) best.set(t.key, t)
  }
  return Array.from(best.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, cap)
}

function levelOf(score: number): FoodInsight['level'] {
  if (score >= 80) return 'great'
  if (score >= 65) return 'good'
  if (score >= 50) return 'ok'
  if (score >= 35) return 'caution'
  return 'limit'
}

/** 友好度分数 → 档位（供汇总卡片复用同一套阈值） */
export function levelOfScore(score: number): FoodInsight['level'] {
  return levelOf(score)
}

/* ────────────────────────── 核心：单条画像 ────────────────────────── */

/**
 * 依据每 100g 营养画像判定风险与益处。
 * 若四项营养值全为 0，说明数据缺失，返回中性结论而不是硬判。
 */
export function analyzeProfile(p: FoodProfile, aiScore?: number | null): FoodInsight {
  const name = p.name || ''
  const kcal = Number(p.kcal) || 0
  const protein = Number(p.protein) || 0
  const carb = Number(p.carb) || 0
  const fat = Number(p.fat) || 0
  const cat = p.category || '其他'

  if (kcal <= 0 && protein <= 0 && carb <= 0 && fat <= 0) {
    return {
      score: 50,
      level: 'ok',
      verdict: '这个食物缺少营养数据，无法给出判断',
      risks: [],
      benefits: [],
      tags: [],
      aiAssisted: false,
    }
  }

  const risks: FoodTag[] = []
  const benefits: FoodTag[] = []

  // 供能比（用营养素本身算出的能量，避免与 kcal 字段口径不一致）
  const energy = protein * 4 + carb * 4 + fat * 9
  const pRatio = energy > 0 ? (protein * 4) / energy : 0
  const cRatio = energy > 0 ? (carb * 4) / energy : 0
  const fRatio = energy > 0 ? (fat * 9) / energy : 0

  /* ① 能量密度 */
  if (kcal >= 400) {
    risks.push({
      key: 'dense',
      label: '热量密度高',
      tone: 'risk',
      reason: `${Math.round(kcal)} kcal/100g，吃同样的重量更容易吃掉大半天预算`,
      weight: 3,
    })
  } else if (kcal <= 80 && kcal > 0) {
    benefits.push({
      key: 'low_density',
      label: '低热量密度',
      tone: 'good',
      reason: `${Math.round(kcal)} kcal/100g，可以吃较大份量而热量压力小`,
      weight: 2,
    })
  }

  /* ② 脂肪
     水产与坚果种子的脂肪以不饱和脂肪酸为主，用「脂肪供能比」判它们偏高会误导，
     这两类的份量问题另有专门规则，因此豁免通用高脂判定。 */
  const fatExempt = cat === '水产' || cat === '坚果种子'
  if (!fatExempt && fRatio >= 0.5) {
    risks.push({
      key: 'high_fat',
      label: '高脂',
      tone: 'risk',
      reason: `脂肪提供了 ${Math.round(fRatio * 100)}% 的能量`,
      weight: 3,
    })
  } else if (!fatExempt && fRatio >= 0.35) {
    risks.push({
      key: 'oily',
      label: '偏油',
      tone: 'risk',
      reason: `脂肪提供了 ${Math.round(fRatio * 100)}% 的能量`,
      weight: 2,
    })
  } else if (fRatio <= 0.25 && pRatio >= 0.2) {
    benefits.push({
      key: 'lean_fat',
      label: '脂肪比例适中',
      tone: 'good',
      reason: `脂肪只占 ${Math.round(fRatio * 100)}% 的能量`,
      weight: 1,
    })
  }

  /* ③ 蛋白质 */
  if (protein >= 20) {
    benefits.push({
      key: 'protein_top',
      label: '蛋白质很高',
      tone: 'good',
      reason: `${protein} g/100g，减脂期最该保证的一类营养`,
      weight: 3,
    })
  } else if (protein >= 10) {
    benefits.push({
      key: 'protein_good',
      label: '蛋白质较好',
      tone: 'good',
      reason: `${protein} g/100g`,
      weight: 2,
    })
  }
  if (protein >= 15 && fRatio < 0.4) {
    benefits.push({
      key: 'high_p_low_f',
      label: '高蛋白低脂',
      tone: 'good',
      reason: `蛋白 ${protein} g 而脂肪仅占 ${Math.round(fRatio * 100)}% 能量`,
      weight: 3,
    })
  }

  /* ④ 碳水（按分类差异化判定，避免把水果蔬菜误判成高碳水） */
  if (cat === '饮料酒水') {
    if (carb >= 8) {
      risks.push({
        key: 'sugary_drink',
        label: '含糖饮料',
        tone: 'risk',
        reason: `每 100ml 含碳水 ${carb} g，液体热量最不容易被记住`,
        weight: 3,
      })
    }
    if (has(name, ['酒', '啤酒', '白酒', '红酒', '黄酒', '米酒', '清酒'])) {
      risks.push({
        key: 'alcohol',
        label: '含酒精',
        tone: 'risk',
        reason: '酒精几乎只提供热量，且会降低自控力',
        weight: 3,
      })
    }
  } else if (kcal >= 200 && cRatio >= 0.6 && !has(name, WHOLEGRAIN_KEYS)) {
    risks.push({
      key: 'carb_heavy',
      label: '碳水占比高',
      tone: 'risk',
      reason: `碳水提供了 ${Math.round(cRatio * 100)}% 的能量`,
      weight: 2,
    })
  }

  /* ⑤ 分类规则 */
  const bc = BENEFIT_CATEGORY[cat]
  if (bc) benefits.push({ key: `cat_${cat}`, label: bc.label, tone: 'good', reason: bc.reason, weight: bc.weight })

  const rc = RISK_CATEGORY[cat]
  if (rc) risks.push({ key: `cat_${cat}`, label: rc.label, tone: 'risk', reason: rc.reason, weight: rc.weight })

  if (cat === '主食' && !has(name, WHOLEGRAIN_KEYS)) risks.push(STAPLE_REFINED)

  if (cat === '坚果种子' && kcal >= 400) {
    risks.push({
      key: 'nut_portion',
      label: '注意份量',
      tone: 'risk',
      reason: '坚果营养好但热量集中，一天一小把（约 25g）就够',
      weight: 2,
    })
  }

  if (cat === '水产' && fRatio >= 0.35) {
    benefits.push({
      key: 'good_fat_fish',
      label: '脂肪来自水产',
      tone: 'good',
      reason: '这类脂肪以不饱和脂肪酸为主，不必当作「油多」来回避',
      weight: 1,
    })
  }

  /* ⑥ 名称关键词 */
  if (has(name, OILY_KEYS)) {
    risks.push({
      key: 'oily_cook',
      label: '油糖用量偏高',
      tone: 'risk',
      reason: '这类做法通常会额外加入较多油或糖',
      weight: 2,
    })
  }
  if (has(name, SALTY_KEYS)) {
    risks.push({
      key: 'salty',
      label: '钠可能偏高',
      tone: 'risk',
      reason: '腌渍或加工工艺会让钠明显升高',
      weight: 3,
    })
  }
  if (has(name, WHOLEGRAIN_KEYS)) {
    benefits.push({
      key: 'wholegrain',
      label: '全谷杂粮',
      tone: 'good',
      reason: '膳食纤维更多，饱腹感更持久',
      weight: 2,
    })
  }
  if (has(name, LIGHT_KEYS) && fRatio < 0.4 && !has(name, OILY_KEYS)) {
    benefits.push({
      key: 'light_cook',
      label: '做法清淡',
      tone: 'good',
      reason: '蒸煮凉拌类做法用油少',
      weight: 1,
    })
  }
  if (has(name, LIGHT_PRODUCT_KEYS)) {
    benefits.push({
      key: 'light_product',
      label: '低糖低脂款',
      tone: 'good',
      reason: '配料上做过减糖或减脂处理',
      weight: 1,
    })
  }

  /* ⑦ 汇总打分 */
  const riskList = uniq(risks, 3)
  const benefitList = uniq(benefits, 3)

  let score = 60
  for (const b of benefitList) score += b.weight * 7
  for (const r of riskList) score -= r.weight * 6

  // AI 识别时给出的 health_score 作为另一半判断依据：规则可解释，模型看整体
  const ai = typeof aiScore === 'number' && Number.isFinite(aiScore) && aiScore > 0 ? aiScore : null
  const finalScore = ai === null ? score : Math.round(score * 0.5 + ai * 0.5)
  score = Math.max(5, Math.min(98, Math.round(finalScore)))

  const level = levelOf(score)

  let verdict: string
  if (riskList.length === 0 && benefitList.length > 0) {
    verdict = `${LEVEL_LABELS[level]} —— 目前没发现明显问题`
  } else if (riskList.length > 0 && benefitList.length === 0) {
    verdict = `${LEVEL_LABELS[level]} —— 主要问题是${riskList[0].label}`
  } else if (riskList.length > 0) {
    verdict = `${LEVEL_LABELS[level]} —— 好处是${benefitList[0].label}，但要留意${riskList[0].label}`
  } else {
    verdict = LEVEL_LABELS[level]
  }

  return {
    score,
    level,
    verdict,
    risks: riskList,
    benefits: benefitList,
    tags: [...riskList, ...benefitList],
    aiAssisted: ai !== null,
  }
}

/* ────────────────────────── 记录条目 → 画像 ────────────────────────── */

/** 把食物名映射回分类。记录表里不存分类，由调用方注入内置食物库的反查结果 */
export type CategoryResolver = (name: string) => string

const NO_CATEGORY: CategoryResolver = () => '其他'

/**
 * 把一条饮食记录折算成每 100g 画像。
 * grams 缺失或明显不合理时（AI 偶尔给出 1g），退化为「按整份判断」，
 * 此时跳过能量密度规则，只保留与重量无关的判定。
 */
export function analyzeEntry(
  entry: Pick<MealEntry, 'food_name' | 'grams' | 'calories' | 'protein_g' | 'carb_g' | 'fat_g' | 'health_score' | 'meal_type'>,
  resolve: CategoryResolver = NO_CATEGORY,
): FoodInsight {
  const grams = Number(entry.grams) || 0
  const usable = grams >= 10

  const r = usable ? 100 / grams : 1
  const profile: FoodProfile = {
    name: entry.food_name || '',
    category: resolve(entry.food_name || ''),
    kcal: (Number(entry.calories) || 0) * r,
    protein: (Number(entry.protein_g) || 0) * r,
    carb: (Number(entry.carb_g) || 0) * r,
    fat: (Number(entry.fat_g) || 0) * r,
  }

  const insight = analyzeProfile(profile, entry.health_score ?? null)

  if (!usable) {
    // 重量不可信：去掉依赖「每 100g」的结论，避免误报
    const drop = new Set(['dense', 'low_density'])
    insight.risks = insight.risks.filter((t) => !drop.has(t.key))
    insight.benefits = insight.benefits.filter((t) => !drop.has(t.key))
    insight.tags = [...insight.risks, ...insight.benefits]
  }

  return insight
}

/* ────────────────────────── 当日汇总 ────────────────────────── */

export interface TagSummary {
  key: string
  label: string
  reason: string
  tone: InsightTone
  weight: 1 | 2 | 3
  count: number
  /** 触发该标签的食物名（去重，最多 3 个） */
  items: string[]
  /** 这些食物合计贡献的热量 */
  kcal: number
}

export interface DayInsight {
  /** 参与的记录条数 */
  scanned: number
  /** 有 AI 评分参与的条数 */
  aiAssisted: number
  risks: TagSummary[]
  benefits: TagSummary[]
  /** 所有条目的加权平均友好度，无数据为 null */
  avgScore: number | null
  /** 一句话总结 */
  verdict: string
}

function collectTags(
  entries: MealEntry[],
  pick: (i: FoodInsight) => FoodTag[],
  resolve: CategoryResolver,
): TagSummary[] {
  const map = new Map<string, TagSummary>()
  for (const e of entries) {
    const insight = analyzeEntry(e, resolve)
    const kcal = Number(e.calories) || 0
    for (const t of pick(insight)) {
      const prev = map.get(t.key)
      if (prev) {
        prev.count += 1
        if (!prev.items.includes(e.food_name) && prev.items.length < 3) prev.items.push(e.food_name)
        prev.kcal += kcal
      } else {
        map.set(t.key, {
          key: t.key,
          label: t.label,
          reason: t.reason,
          tone: t.tone,
          weight: t.weight,
          count: 1,
          items: [e.food_name],
          kcal,
        })
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.weight * 100 + b.count - (a.weight * 100 + a.count) || b.kcal - a.kcal,
  )
}

/** 汇总某一餐 / 某一天的记录，产出「饮食体检」结果 */
export function summarizeEntries(entries: MealEntry[], resolve: CategoryResolver = NO_CATEGORY): DayInsight {
  const valid = entries.filter((e) => (Number(e.calories) || 0) > 0 || (Number(e.protein_g) || 0) > 0)

  if (valid.length === 0) {
    return { scanned: 0, aiAssisted: 0, risks: [], benefits: [], avgScore: null, verdict: '' }
  }

  const risks = collectTags(valid, (i) => i.risks, resolve).slice(0, 4)
  const benefits = collectTags(valid, (i) => i.benefits, resolve).slice(0, 4)

  const scores = valid.map((e) => analyzeEntry(e, resolve).score)
  const avgScore = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
  const aiAssisted = valid.filter((e) => analyzeEntry(e, resolve).aiAssisted).length

  let verdict: string
  if (risks.length === 0 && benefits.length === 0) {
    verdict = '这几餐没发现明显问题，也没识别到突出优点。'
  } else if (risks.length === 0) {
    verdict = `这一天的选择都挺稳，最突出的是${benefits[0].label}。`
  } else if (benefits.length === 0) {
    verdict = `需要留意${risks[0].label}，共 ${risks[0].count} 项。`
  } else {
    verdict = `亮点是${benefits[0].label}，同时要留意${risks[0].label}（${risks[0].count} 项）。`
  }

  return { scanned: valid.length, aiAssisted, risks, benefits, avgScore, verdict }
}

/* ────────────────────────── 下一餐建议额度 ────────────────────────── */

export interface NextMealAdvice {
  /** 建议这一餐不超过多少 kcal */
  budget: number | null
  /** 是否已经超出今天的预算 */
  over: boolean
  /** 还有几餐没吃（含当前这餐） */
  remainingMeals: number
  text: string
}

/**
 * 把剩余热量按「还没吃且时间还没过」的餐次平均分配，给出下一餐的参考额度。
 * 这是纯建议，不写库、不做任何拦截。
 */
export function nextMealAdvice(
  remainKcal: number,
  eatenMeals: Set<string>,
  now: Date = new Date(),
): NextMealAdvice {
  const order = ['breakfast', 'lunch', 'dinner', 'snack'] as const
  const hour = now.getHours()
  // 各餐次的「该吃时间」上限，过了就不再计入
  const deadline: Record<(typeof order)[number], number> = { breakfast: 10, lunch: 15, dinner: 21, snack: 24 }

  const pending = order.filter((m) => !eatenMeals.has(m) && hour < deadline[m])
  const remainingMeals = Math.max(pending.length, 1)

  if (remainKcal <= 0) {
    return {
      budget: null,
      over: true,
      remainingMeals,
      text: `今天已超出 ${Math.abs(Math.round(remainKcal))} kcal，接下来建议只喝水或无糖茶饮，下一餐以蔬菜和蛋白质为主。`,
    }
  }

  const budget = Math.round(remainKcal / remainingMeals / 10) * 10
  return {
    budget,
    over: false,
    remainingMeals,
    text: `今天还能吃 ${Math.round(remainKcal)} kcal，还剩 ${remainingMeals} 餐，下一餐建议控制在 ${budget} kcal 以内。`,
  }
}
