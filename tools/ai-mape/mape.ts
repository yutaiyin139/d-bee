/**
 * AI 识别精度误差统计（P1-C 测量工具的计算内核）。
 *
 * ── 为什么需要这个文件 ─────────────────────────────────────────────
 * 审计计划把「AI 识别精度实测（MAPE）」列为竞品差评重灾区、专业性硬伤，
 * 并给了决策阈值：**MAPE > 15% 则优先调 prompt/模型，而不是做营销**。
 * 实测本身需要真机 + 称重样本（见 docs/AI识别精度MAPE实测方案-2026-11-03.md），
 * 但**统计口径不能等到实测那天现写** —— 口径错了，测出来的数字会误导决策。
 *
 * ── 🔴 单看 MAPE 会误导决策，必须四指标并报 ───────────────────────
 * MAPE = mean(|预测 − 真值| / 真值)，有两个已知陷阱，都会让「精度」看起来
 * 比实际更差或更好，而本项目要用它做「要不要改模型」的决策，故不能只用它：
 *
 *   ① **真值为 0 时无定义**。添加糖、膳食纤维这类字段真值常为 0
 *      （如清蒸鱼 added_sugar=0），除法直接炸或产生 Infinity。
 *      处理：跳过该项并**显式统计排除数**，绝不静默把 Infinity 混进均值。
 *
 *   ② **小真值放大误差**。真值 5g 的脂肪偏差 2g → 单项 APE 40%；
 *      真值 200g 的碳水偏差 2g → 1%。两者对用户的实际影响天差地别，
 *      但在 MAPE 里权重相同。极端情况：一餐里几项微量营养素真值很小，
 *      就能把整体 MAPE 拉到 30%+，而热量其实准得很。
 *      处理：同时给 **WMAPE**（按真值量级加权 = Σ|误差| / Σ真值），
 *      它才回答用户真正关心的问题：「这餐总热量差了多少」。
 *
 * 另外两个补充指标：
 *   · **MAE**（平均绝对误差，带单位）—— 「平均差 X kcal」比「差 X%」更可解释，
 *     也是营销侧唯一能诚实使用的表述（"平均误差 ±45 kcal"）。
 *   · **Bias（平均有符号误差）** —— 🔴 最关键但最容易被漏掉的一个。
 *     MAPE/MAE 取绝对值会**掩盖系统性偏差**：如果 AI 总是低估 20%，
 *     MAPE 显示 20% 看起来「一般」，但这其实是**可修的 prompt 问题**
 *     （加一句"不要低估油脂"就能救），而不是需要换模型的精度天花板。
 *     Bias 接近 0 但 MAPE 高 = 随机误差大（真的精度问题，需换模型/调参）；
 *     Bias 与 MAPE 同号且量级接近 = 系统性偏差（改 prompt 即可，性价比高）。
 *     这个区分直接决定「调 prompt 还是换模型」，是 P1-C 的核心产出。
 *
 * ── 分档报告 ───────────────────────────────────────────────────────
 * 误差往往集中在特定份量区间（小份量菜估不准、大碗主食反而准）。
 * 按真值热量分档统计，才能定位「哪类餐不准」，而不是得到一个笼统的总分。
 */

import { fmtNum, roundTo } from '@dbee/shared'

/** 参与精度评估的营养维度。克数类 2 位小数、kcal 取整（与全站口径一致） */
export const METRICS = ['calories', 'protein_g', 'carb_g', 'fat_g', 'grams'] as const
export type Metric = (typeof METRICS)[number]

/** 指标中文名（报告输出用） */
export const METRIC_LABEL: Record<Metric, string> = {
  calories: '热量 kcal',
  protein_g: '蛋白质 g',
  carb_g: '碳水 g',
  fat_g: '脂肪 g',
  grams: '克数 g',
}

/** 单条样本：一个食物项的「真值 vs AI 识别值」 */
export interface Sample {
  /** 样本编号/餐次标识，便于回查原始记录 */
  id?: string
  /** 食物名（真值侧的菜名，用于分档与定位问题菜式） */
  food?: string
  /** 真值（电子秤称重 + 成分表折算） */
  truth: Partial<Record<Metric, number>>
  /** AI 识别值（小程序 scan 页返回的 normalizeItems 结果） */
  pred: Partial<Record<Metric, number>>
}

/** 单个指标的误差统计结果 */
export interface MetricStats {
  metric: Metric
  /** 参与统计的有效样本数（真值 > 0 的） */
  n: number
  /** 因真值为 0/缺失而被排除的样本数（🔴 必须显式报告，不能静默丢弃） */
  excluded: number
  /** MAPE %：mean(|pred-truth|/truth)*100，真值为 0 的项已排除 */
  mape: number
  /** WMAPE %：Σ|pred-truth| / Σtruth * 100，按真值量级加权，抗小真值放大 */
  wmape: number
  /** MAE：平均绝对误差，单位同该指标 */
  mae: number
  /** Bias：平均**有符号**误差（pred - truth）。正=AI 偏高，负=AI 偏低 */
  bias: number
  /** 有符号偏差占比 %：Bias / mean(truth) * 100，用于判断系统性偏差强度 */
  biasPct: number
  /** 误差中位数（绝对值），抗离群点，与 MAE 差距大说明有极端个案 */
  medianAe: number
  /** 最大单项绝对百分比误差，定位最差个案 */
  maxApe: number
  /** 最差个案的食物名（便于回去看那张照片） */
  worstFood: string
}

/** 诊断结论：区分「系统性偏差（改 prompt）」与「随机误差（换模型）」 */
export interface Diagnosis {
  metric: Metric
  /** systematic = 系统性偏差为主（改 prompt 性价比高）；
   *  random = 随机误差为主（需换模型/调参）；
   *  ok = 精度达标；insufficient = 样本不足无法判断 */
  kind: 'systematic' | 'random' | 'ok' | 'insufficient'
  /** 人类可读的诊断说明 */
  reason: string
}

/** 判定阈值（审计计划给的决策线 + 工程惯例） */
export const THRESHOLDS = {
  /** MAPE ≤ 15% 视为达标（审计计划 P1-C 的决策阈值） */
  mapeOk: 15,
  /** |Bias| 占 MAPE 的比例 ≥ 60% 判为「系统性偏差为主」 */
  systematicRatio: 0.6,
  /**
   * |Bias%| 超过此值即判「存在系统性偏差」，**即使 MAPE 达标也要报**。
   *
   * 🔴 这条不能省。MAPE 达标只说明「误差不大」，不说明「误差无方向」。
   * 对减脂产品，热量**系统性低估**比随机误差危险得多：用户按记录值控制饮食，
   * 每天少记 15% 热量 → 长期累积 → 减脂失败且归因不到工具上（会怪自己意志力）。
   * 而随机误差只是「今天不准明天准」，长期会抵消。
   * 所以「MAPE 12%、Bias -17%」是**必须修 prompt** 的状态，不是达标状态。
   * 取 10%：低于此值的偏移对减脂结论影响可忽略（约 1800kcal 日摄入差 180kcal）。
   */
  biasAlertPct: 10,
  /** 有效样本 < 5 条不足以做统计判断 */
  minSamples: 5,
} as const

/** 安全转数字：非有限值一律归 null（区分「0」与「缺失」，二者统计含义不同） */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 中位数（不改变入参数组） */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 计算单个指标的误差统计。
 *
 * 口径说明：
 *   · 只统计「真值与预测值都存在」的样本；缺失视为该项未测，计入 excluded；
 *   · 真值为 0 的样本**排除出 MAPE/WMAPE/Bias%**（除零无定义），但**保留在 MAE/Bias**
 *     里 —— 因为「AI 报了 3g 脂肪而真值是 0」是实打实的误差，不该因为算不出百分比就消失；
 *   · 克数类保留 2 位小数、kcal 取整，与全站数值口径一致（P1-A 下沉的 numfmt）。
 */
export function computeMetricStats(samples: Sample[], metric: Metric): MetricStats {
  const pairs: { truth: number; pred: number; food: string }[] = []
  let excluded = 0

  for (const s of samples) {
    const t = toNum(s.truth?.[metric])
    const p = toNum(s.pred?.[metric])
    if (t === null || p === null) {
      excluded += 1
      continue
    }
    pairs.push({ truth: t, pred: p, food: s.food ?? s.id ?? '' })
  }

  if (pairs.length === 0) {
    return {
      metric, n: 0, excluded, mape: 0, wmape: 0, mae: 0, bias: 0,
      biasPct: 0, medianAe: 0, maxApe: 0, worstFood: '',
    }
  }

  // MAE / Bias 用全部有效配对（含真值 0）
  const absErrs = pairs.map((x) => Math.abs(x.pred - x.truth))
  const signedErrs = pairs.map((x) => x.pred - x.truth)
  const mae = absErrs.reduce((a, b) => a + b, 0) / absErrs.length
  const bias = signedErrs.reduce((a, b) => a + b, 0) / signedErrs.length

  // MAPE / WMAPE / Bias% 只用真值 > 0 的（除零无定义）
  const nonzero = pairs.filter((x) => Math.abs(x.truth) > 1e-9)
  const n2 = nonzero.length
  const mape = n2 > 0
    ? nonzero.reduce((a, x) => a + Math.abs(x.pred - x.truth) / Math.abs(x.truth), 0) / n2 * 100
    : 0
  const sumTruth = nonzero.reduce((a, x) => a + Math.abs(x.truth), 0)
  const sumAbsErr = nonzero.reduce((a, x) => a + Math.abs(x.pred - x.truth), 0)
  const wmape = sumTruth > 0 ? (sumAbsErr / sumTruth) * 100 : 0
  const meanTruth = n2 > 0 ? nonzero.reduce((a, x) => a + x.truth, 0) / n2 : 0
  const biasPct = Math.abs(meanTruth) > 1e-9
    ? nonzero.reduce((a, x) => a + (x.pred - x.truth), 0) / n2 / meanTruth * 100
    : 0

  // 最差个案（按绝对百分比误差）
  let maxApe = 0
  let worstFood = ''
  for (const x of nonzero) {
    const ape = Math.abs(x.pred - x.truth) / Math.abs(x.truth) * 100
    if (ape > maxApe) {
      maxApe = ape
      worstFood = x.food
    }
  }

  // 精度：克数类 2 位、kcal 取整（与全站口径一致）
  const decimals = metric === 'calories' ? 0 : 2
  return {
    metric,
    n: pairs.length,
    excluded: excluded + (pairs.length - n2),
    mape: roundTo(mape, 2),
    wmape: roundTo(wmape, 2),
    mae: roundTo(mae, decimals),
    bias: roundTo(bias, decimals),
    biasPct: roundTo(biasPct, 2),
    medianAe: roundTo(median(absErrs), decimals),
    maxApe: roundTo(maxApe, 2),
    worstFood,
  }
}

/**
 * 诊断误差性质：系统性偏差（改 prompt）还是随机误差（换模型）。
 *
 * 判据：比较 |Bias%| 与 MAPE 的量级。
 *   · |Bias%| / MAPE ≥ 0.6 → 误差主要来自**同一方向的偏移**，
 *     说明 prompt 有可修的系统性问题（如"倾向低估油脂"），性价比高；
 *   · 否则 → 误差方向随机分散，属真实精度天花板，需换模型/调参。
 *
 * 🔴 MAPE 达标**不等于**无需处理：还要单独查 |Bias%| 是否超阈值。
 * 反例（本工具开发时用模板样本实测出来的）：热量 MAPE 12.76% ≤ 15% 判达标，
 * 但 Bias = -17.29%，即 AI 系统性低估热量近两成 —— 对减脂产品这比随机误差
 * 危险得多（用户长期少记，减脂失败且归因不到工具）。这种情况必须报 systematic。
 */
export function diagnose(stats: MetricStats): Diagnosis {
  if (stats.n < THRESHOLDS.minSamples) {
    return {
      metric: stats.metric,
      kind: 'insufficient',
      reason: `有效样本仅 ${stats.n} 条（< ${THRESHOLDS.minSamples}），不足以判断误差性质，请补样本`,
    }
  }

  const ratio = stats.mape > 0 ? Math.abs(stats.biasPct) / stats.mape : 0
  const dir = stats.biasPct > 0 ? '偏高' : '偏低'

  // MAPE 达标，但存在不可忽略的系统性偏移 → 仍要修 prompt
  if (stats.mape <= THRESHOLDS.mapeOk) {
    if (Math.abs(stats.biasPct) >= THRESHOLDS.biasAlertPct) {
      return {
        metric: stats.metric,
        kind: 'systematic',
        reason:
          `MAPE ${fmtNum(stats.mape)}% ≤ ${THRESHOLDS.mapeOk}% 看似达标，但 Bias ${fmtNum(stats.biasPct)}% ` +
          `已超 ${THRESHOLDS.biasAlertPct}% 警戒线 —— AI 系统性${dir}。` +
          `随机误差不大但方向一致，长期会累积（减脂场景尤其危险），应改 prompt 纠正${dir}倾向`,
      }
    }
    return {
      metric: stats.metric,
      kind: 'ok',
      reason:
        `MAPE ${fmtNum(stats.mape)}% ≤ ${THRESHOLDS.mapeOk}%，且 Bias ${fmtNum(stats.biasPct)}% ` +
        `未超 ${THRESHOLDS.biasAlertPct}% 警戒线，精度达标，可用于营销表述`,
    }
  }

  if (ratio >= THRESHOLDS.systematicRatio) {
    return {
      metric: stats.metric,
      kind: 'systematic',
      reason:
        `MAPE ${fmtNum(stats.mape)}% 超标，但 Bias ${fmtNum(stats.biasPct)}% 占了 ${fmtNum(ratio * 100, 0)}% —— ` +
        `AI 系统性${dir}。优先改 prompt（明确纠正${dir}倾向），性价比高，先别换模型`,
    }
  }
  return {
    metric: stats.metric,
    kind: 'random',
    reason:
      `MAPE ${fmtNum(stats.mape)}% 超标，Bias 仅 ${fmtNum(stats.biasPct)}%（占 ${fmtNum(ratio * 100, 0)}%）—— ` +
      `误差方向随机，属真实精度问题，需换模型/调参，改 prompt 收益有限`,
  }
}

/** 全部指标一次性统计 */
export function computeAllStats(samples: Sample[]): MetricStats[] {
  return METRICS.map((m) => computeMetricStats(samples, m))
}

/** 按真值热量分档，定位「哪类餐不准」 */
export const KCAL_BANDS = [
  { label: '< 100 kcal（小份/配菜）', min: 0, max: 100 },
  { label: '100–300 kcal（单人小菜）', min: 100, max: 300 },
  { label: '300–600 kcal（正餐主菜）', min: 300, max: 600 },
  { label: '> 600 kcal（大份/主食）', min: 600, max: Number.POSITIVE_INFINITY },
] as const

/** 分档统计：每档的热量 MAPE，用于定位误差集中区间 */
export function computeBandStats(samples: Sample[]): { label: string; n: number; mape: number }[] {
  return KCAL_BANDS.map((band) => {
    const inBand = samples.filter((s) => {
      const t = toNum(s.truth?.calories)
      return t !== null && t >= band.min && t < band.max
    })
    const stats = computeMetricStats(inBand, 'calories')
    return { label: band.label, n: inBand.length, mape: stats.mape }
  })
}
