/**
 * AI 识别精度误差统计测试（P1-C）。
 *
 * 这些统计口径要直接支撑「改 prompt 还是换模型」「能不能做精度营销」两个决策，
 * 算错的代价是决策错 —— 所以口径本身必须有测试守护，不能等实测那天现写现信。
 *
 * 🔴 本文件最重要的用例是「MAPE 达标但 Bias 超标」那一组：它是开发这个工具时
 * **真实踩到并修掉的 bug**（初版 diagnose 在 MAPE≤15% 时直接返回 ok，
 * 跳过了系统性偏差检测，用模板样本一跑就发现热量 MAPE 12.76% 判达标、
 * 而 Bias 是 -17.29%）。对减脂产品，系统性低估比随机误差危险得多，
 * 这个用例防止未来重构时把该分支再丢掉。
 *
 * 运行：npx vitest run tools/ai-mape.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  METRICS,
  THRESHOLDS,
  computeAllStats,
  computeBandStats,
  computeMetricStats,
  diagnose,
  type Sample,
} from './ai-mape/mape'

/** 构造样本：默认五项指标都给全，按需覆盖 */
function s(truth: Partial<Sample['truth']>, pred: Partial<Sample['pred']>, food = ''): Sample {
  return { food, truth, pred }
}

describe('computeMetricStats · MAPE 口径', () => {
  it('基本 MAPE：|pred-truth|/truth 的均值 ×100', () => {
    // APE 分别 10%（110 vs 100）与 20%（120 vs 100）→ 均值 15%
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 110 }),
      s({ calories: 100 }, { calories: 120 }),
    ], 'calories')
    expect(stats.mape).toBe(15)
    expect(stats.n).toBe(2)
  })

  it('🔴 真值为 0 的样本被排除出 MAPE，且**显式计数**（不静默丢弃）', () => {
    const stats = computeMetricStats([
      s({ fat_g: 0 }, { fat_g: 3 }),   // 真值 0 → 除零无定义，须排除
      s({ fat_g: 10 }, { fat_g: 11 }), // APE 10%
    ], 'fat_g')
    expect(stats.n).toBe(2)          // MAE/Bias 仍算这两条
    expect(stats.excluded).toBe(1)   // 但 MAPE 只用了 1 条
    expect(stats.mape).toBe(10)      // 不是 Infinity、不是 NaN
    expect(Number.isFinite(stats.mape)).toBe(true)
  })

  it('🔴 真值 0 但 AI 报了值 → 仍计入 MAE/Bias（误差是实打实的，不因算不出百分比就消失）', () => {
    const stats = computeMetricStats([
      s({ fat_g: 0 }, { fat_g: 3 }),
    ], 'fat_g')
    expect(stats.mae).toBe(3)
    expect(stats.bias).toBe(3)
  })

  it('缺失值（null/undefined/空串）不计入 n，计入 excluded', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 110 }),
      s({ calories: null }, { calories: 110 }),
      s({}, { calories: 110 }),
      s({ calories: 100 }, {}),
    ], 'calories')
    expect(stats.n).toBe(1)
    expect(stats.excluded).toBe(3)
  })

  it('全部样本无效时不炸（返回全 0，n=0）', () => {
    const stats = computeMetricStats([], 'calories')
    expect(stats.n).toBe(0)
    expect(stats.mape).toBe(0)
    expect(stats.wmape).toBe(0)
    expect(stats.mae).toBe(0)
    expect(stats.worstFood).toBe('')
  })
})

describe('computeMetricStats · WMAPE 抗小真值放大', () => {
  it('🔴 小真值放大误差时 WMAPE 明显低于 MAPE（这是引入 WMAPE 的理由）', () => {
    // 项1：真值 5g 脂肪偏差 2g → APE 40%（对总量影响极小）
    // 项2：真值 200g 碳水偏差 2g → APE 1%
    const stats = computeMetricStats([
      s({ fat_g: 5 }, { fat_g: 7 }),
      s({ fat_g: 200 }, { fat_g: 202 }),
    ], 'fat_g')
    expect(stats.mape).toBe(20.5)                       // (40+1)/2，被小真值拉到 20%+
    expect(stats.wmape).toBeCloseTo(4 / 205 * 100, 2)   // Σ误差4 / Σ真值205 ≈ 1.95%
    expect(stats.wmape).toBeLessThan(stats.mape / 5)    // 量级差异显著
  })

  it('WMAPE = Σ|误差| / Σ真值 × 100（按量级加权）', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 90 }),  // 误差 10
      s({ calories: 300 }, { calories: 330 }), // 误差 30
    ], 'calories')
    expect(stats.wmape).toBeCloseTo(40 / 400 * 100, 2) // 10%
    expect(stats.mape).toBeCloseTo((10 + 10) / 2, 2)   // 两项 APE 都是 10% → 10%
  })
})

describe('computeMetricStats · Bias（有符号，识别系统性偏差）', () => {
  it('🔴 全部偏低 → Bias 为负；MAPE 只有绝对值，看不出方向', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 80 }),
      s({ calories: 200 }, { calories: 160 }),
    ], 'calories')
    expect(stats.bias).toBe(-30)          // (−20 + −40)/2
    expect(stats.mape).toBe(20)           // 绝对值掩盖了方向
    expect(stats.biasPct).toBe(-20)       // −30 / 150(均值真值) = −20%
  })

  it('随机误差（有正有负）→ Bias 接近 0，但 MAPE 不小', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 120 }), // +20
      s({ calories: 100 }, { calories: 80 }),  // −20
    ], 'calories')
    expect(stats.bias).toBe(0)
    expect(stats.mape).toBe(20)
  })

  it('Bias% 的分母是真值均值（不是误差均值）', () => {
    const stats = computeMetricStats([
      s({ calories: 500 }, { calories: 600 }), // 真值 500，误差 +100
    ], 'calories')
    expect(stats.biasPct).toBe(20) // 100/500
  })
})

describe('computeMetricStats · 精度与鲁棒性', () => {
  it('kcal 取整、克数类保留 2 位（与全站数值口径一致）', () => {
    const kcal = computeMetricStats([s({ calories: 100 }, { calories: 100.678 })], 'calories')
    expect(Number.isInteger(kcal.mae)).toBe(true)

    const protein = computeMetricStats([s({ protein_g: 10 }, { protein_g: 10.6789 })], 'protein_g')
    expect(protein.mae).toBe(0.68)
  })

  it('中位绝对误差抗离群点（与 MAE 差距大 = 有极端个案）', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 101 }),
      s({ calories: 100 }, { calories: 102 }),
      s({ calories: 100 }, { calories: 300 }), // 离群
    ], 'calories')
    expect(stats.medianAe).toBe(2)   // 中位数不受离群影响
    expect(stats.mae).toBeGreaterThan(60) // 均值被拉高
  })

  it('maxApe 定位最差个案并带出菜名（便于回去看那张照片）', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: 110 }, '米饭'),
      s({ calories: 100 }, { calories: 150 }, '红烧肉'),
    ], 'calories')
    expect(stats.maxApe).toBe(50)
    expect(stats.worstFood).toBe('红烧肉')
  })

  it('字符串数字与带单位串也能解析（AI 偶尔返回 "232 kcal"）', () => {
    const stats = computeMetricStats([
      s({ calories: 100 }, { calories: '110 kcal' as unknown as number }),
    ], 'calories')
    expect(stats.mape).toBe(10)
  })

  it('不产生 NaN/Infinity（喂极端值）', () => {
    const stats = computeMetricStats([
      s({ calories: 0 }, { calories: 0 }),
      s({ calories: 1e-12 }, { calories: 5 }),
    ], 'calories')
    for (const v of [stats.mape, stats.wmape, stats.mae, stats.bias, stats.biasPct, stats.medianAe, stats.maxApe]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('diagnose · 改 prompt 还是换模型', () => {
  const base = { n: 20, excluded: 0, wmape: 0, mae: 0, medianAe: 0, maxApe: 0, worstFood: '' }

  it('样本不足 → insufficient（不硬下结论）', () => {
    const d = diagnose({ ...base, metric: 'calories', n: 3, mape: 5, bias: 0, biasPct: 0 })
    expect(d.kind).toBe('insufficient')
  })

  it('MAPE 达标且 Bias 小 → ok', () => {
    const d = diagnose({ ...base, metric: 'calories', n: 20, mape: 8, bias: -2, biasPct: -3 })
    expect(d.kind).toBe('ok')
  })

  it('🔴 MAPE 达标但 Bias 超警戒线 → systematic（本次修掉的真 bug，必须守住）', () => {
    // 模板样本实测出的情形：热量 MAPE 12.76% ≤ 15% 看似达标，Bias 却是 -17.29%。
    // 初版 diagnose 在这里直接返回 ok，把「系统性低估」当成达标放过了。
    const d = diagnose({ ...base, metric: 'calories', n: 20, mape: 12.76, bias: -59, biasPct: -17.29 })
    expect(d.kind).toBe('systematic')
    expect(d.reason).toContain('看似达标')
    expect(d.reason).toContain('偏低')
  })

  it('Bias 恰在警戒线上 → systematic（闭区间，不放过边界）', () => {
    const d = diagnose({
      ...base, metric: 'calories', n: 20,
      mape: 10, bias: -10, biasPct: -THRESHOLDS.biasAlertPct,
    })
    expect(d.kind).toBe('systematic')
  })

  it('Bias 略低于警戒线 → ok（不误报）', () => {
    const d = diagnose({
      ...base, metric: 'calories', n: 20,
      mape: 10, bias: -9, biasPct: -(THRESHOLDS.biasAlertPct - 0.5),
    })
    expect(d.kind).toBe('ok')
  })

  it('🔴 偏高方向也要报（不只盯低估）', () => {
    const d = diagnose({ ...base, metric: 'fat_g', n: 20, mape: 12, bias: 5, biasPct: 15 })
    expect(d.kind).toBe('systematic')
    expect(d.reason).toContain('偏高')
  })

  it('MAPE 超标 + Bias 占比高 → systematic（改 prompt 性价比高的典型）', () => {
    const d = diagnose({ ...base, metric: 'fat_g', n: 20, mape: 20.21, bias: -4.1, biasPct: -19.88 })
    expect(d.kind).toBe('systematic')
    expect(d.reason).toContain('先别换模型')
  })

  it('MAPE 超标 + Bias 占比低 → random（需换模型，改 prompt 收益有限）', () => {
    const d = diagnose({ ...base, metric: 'calories', n: 20, mape: 30, bias: 1, biasPct: 2 })
    expect(d.kind).toBe('random')
    expect(d.reason).toContain('换模型')
  })

  it('MAPE=0 时不除零（Bias 也为 0 → ok）', () => {
    const d = diagnose({ ...base, metric: 'calories', n: 20, mape: 0, bias: 0, biasPct: 0 })
    expect(d.kind).toBe('ok')
  })
})

describe('computeAllStats / computeBandStats', () => {
  it('computeAllStats 覆盖全部五个指标', () => {
    const all = computeAllStats([
      s({ grams: 100, calories: 200, protein_g: 10, carb_g: 20, fat_g: 5 },
        { grams: 90, calories: 180, protein_g: 9, carb_g: 18, fat_g: 4 }),
    ])
    expect(all.map((x) => x.metric)).toEqual([...METRICS])
    expect(all).toHaveLength(5)
  })

  it('分档统计按真值热量归档', () => {
    const bands = computeBandStats([
      s({ calories: 50 }, { calories: 55 }),   // <100
      s({ calories: 200 }, { calories: 210 }), // 100-300
      s({ calories: 400 }, { calories: 420 }), // 300-600
      s({ calories: 900 }, { calories: 950 }), // >600
    ])
    expect(bands).toHaveLength(4)
    expect(bands.map((b) => b.n)).toEqual([1, 1, 1, 1])
  })

  it('边界值归入下一档（左闭右开：300 属 300-600 档）', () => {
    const bands = computeBandStats([s({ calories: 300 }, { calories: 310 })])
    expect(bands[1].n).toBe(0) // 100-300 是右开，300 不在内
    expect(bands[2].n).toBe(1) // 300-600
  })

  it('空档 mape=0 且 n=0（不误报精度）', () => {
    const bands = computeBandStats([s({ calories: 900 }, { calories: 950 })])
    expect(bands[0]).toMatchObject({ n: 0, mape: 0 })
  })
})
