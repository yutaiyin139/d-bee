/**
 * numfmt + foodInsight 数值展示回归测试。
 *
 * 起因（2026-11-02）：用户截图显示「饮食体检」页出现
 *   `11.666666666666666 g/100g`、`5.833333333333333 g/100g`
 * 本测试把那组真实数据固化成断言，防止回归。
 *
 * 运行：npx vitest run tools/numfmt.test.ts
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DECIMALS, balancePercents, fmtNum, pct, roundTo } from '../src/lib/numfmt'
import { analyzeEntry } from '../src/lib/foodInsight'
import { clampNumeric, formatNum } from '../src/lib/validate'

/* ── 截图同款数据反推 ─────────────────────────────────────────
   展示值 11.666… = 35/3、5.833… = 35/6、542，
   由 r = 100/grams 反解：grams=60 → r=5/3
     protein_g = 11.666…/(5/3) = 7
     fiber_g   =  5.833…/(5/3) = 3.5
     kcal      = 542/(5/3)     = 325.2
   即「核桃 60g，蛋白 7g，纤维 3.5g，325.2 kcal」

   🔴 sodium_mg 取 null 而非 0/2：成分表多数条目没有钠数据（见 foodInsight.ts 头部注释），
   此时 low_sodium 标签不会触发。若填了钠值，low_sodium(w1) 会挤占 3 个益处的名额，
   把 some_fiber 顶出去 —— 那样就复现不出截图里「蛋白与纤维同时出现」的画面。 */
const WALNUT = {
  food_name: '核桃',
  grams: 60,
  calories: 325.2,
  protein_g: 7,
  carb_g: 8,
  fat_g: 32,
  fiber_g: 3.5,
  sodium_mg: null,
  added_sugar_g: 0,
  meal_type: 'snack' as const,
  health_score: null,
}

describe('fmtNum · 展示层格式化', () => {
  it('🔴 截图里的两个长小数被收敛到 2 位', () => {
    expect(fmtNum(11.666666666666666)).toBe('11.67')
    expect(fmtNum(5.833333333333333)).toBe('5.83')
  })

  it('去掉多余的尾随零（542 不显示成 542.00）', () => {
    expect(fmtNum(542)).toBe('542')
    expect(fmtNum(1.5)).toBe('1.5')
    expect(fmtNum(1.5, 2, { padZero: true })).toBe('1.50')
    expect(fmtNum(0)).toBe('0')
  })

  it('小数位可控', () => {
    expect(fmtNum(65.234, 0)).toBe('65')
    expect(fmtNum(65.234, 1)).toBe('65.2')
    expect(fmtNum(65.234, 3)).toBe('65.234')
    expect(fmtNum(0.1 + 0.2)).toBe('0.3') // 浮点噪声不泄漏到 UI
  })

  it('异常值返回占位符而非 NaN/undefined', () => {
    expect(fmtNum(null)).toBe('—')
    expect(fmtNum(undefined)).toBe('—')
    expect(fmtNum(NaN)).toBe('—')
    expect(fmtNum(Infinity)).toBe('—')
    expect(fmtNum(-Infinity)).toBe('—')
    expect(fmtNum(null, 2, { placeholder: '0' })).toBe('0')
  })

  it('默认保留 2 位小数', () => {
    expect(DEFAULT_DECIMALS).toBe(2)
    expect(fmtNum(1 / 3)).toBe('0.33')
  })

  it('负数与 tie（恰好 .5）行为：远离零，且与 roundTo 一致', () => {
    expect(fmtNum(-11.666666666666666)).toBe('-11.67')
    expect(fmtNum(2.5, 0)).toBe('3')
    // 🔴 Math.round(-2.5) = -2（向 +∞），与展示层不一致；本模块统一为 -3
    expect(fmtNum(-2.5, 0)).toBe('-3')
    expect(String(roundTo(-2.5, 0))).toBe('-3')
  })

  it('极大值不因乘法溢出精度（原 round(n*f)/f 写法会得到 999999999999999900000）', () => {
    expect(fmtNum(1e21)).toBe('1e+21')
    expect(roundTo(1e21)).toBe(1e21)
  })
})

describe('roundTo · 计算层舍入', () => {
  it('返回数值而非字符串，最多 decimals 位', () => {
    expect(roundTo(11.666666666666666)).toBe(11.67)
    expect(roundTo(5.833333333333333)).toBe(5.83)
    expect(roundTo(542)).toBe(542)
    expect(typeof roundTo(1.2345)).toBe('number')
  })

  it('异常值归零，避免 NaN 传染下游求和', () => {
    expect(roundTo(null)).toBe(0)
    expect(roundTo(undefined)).toBe(0)
    expect(roundTo(NaN)).toBe(0)
    expect(roundTo(Infinity)).toBe(0)
    // 一处 NaN 不该让整列统计变 NaN
    expect([roundTo(NaN), roundTo(1.5), roundTo(2)].reduce((a, b) => a + b, 0)).toBe(3.5)
  })

  it('结果再参与计算不会超出 decimals 位', () => {
    const r = roundTo(100 / 3) // 33.33
    expect(String(r * 3)).toBe('99.99')
  })
})

describe('pct', () => {
  it('格式化已是百分数的值（不再乘 100）', () => {
    expect(pct(23.456)).toBe('23%')
    expect(pct(23.456, 1)).toBe('23.5%')
    expect(pct(100)).toBe('100%')
    expect(pct(null)).toBe('—%')
  })
})

describe('balancePercents · 占比配平到合计 100', () => {
  it('🔴 修复「三项供能比合计 ≠ 100%」的实测反例', () => {
    // 朴素做法：各自 Math.round(v/sum*100)
    const naive = (v: number[]) => {
      const s = v.reduce((a, b) => a + b, 0)
      return v.map((x) => Math.round((x / s) * 100))
    }
    // 23.5 / 23.5 / 53 → 24 + 24 + 53 = 101（report.ts 旧逻辑的真实反例）
    expect(naive([23.5, 23.5, 53]).reduce((a, b) => a + b, 0)).not.toBe(100)
    expect(naive([1, 1, 1]).reduce((a, b) => a + b, 0)).not.toBe(100) // 33*3 = 99

    const balanced = balancePercents([23.5, 23.5, 53])
    expect(balanced.reduce((a, b) => a + b, 0)).toBe(100)
    // 差额给余数最大者：23.5 的余数都是 .5，并列时给靠前的
    expect(balanced).toEqual([24, 23, 53])
  })

  it('最大余数法：差额给余数最大的项', () => {
    // 1/3 各占 33.33… → 取整 33×3=99，剩 1 给余数最大者（并列时给靠前的）
    const r = balancePercents([1, 1, 1])
    expect(r.reduce((a, b) => a + b, 0)).toBe(100)
    expect(r).toEqual([34, 33, 33])
  })

  it('常规营养比例配平后合计恒为 100', () => {
    for (const v of [
      [210, 840, 140],
      [175, 700, 245],
      [99, 301, 52],
      [60, 300, 90],
      [1, 1, 1000],
      [23.5, 23.5, 53],
    ]) {
      const r = balancePercents(v)
      expect(r.reduce((a, b) => a + b, 0), `${JSON.stringify(v)} → ${JSON.stringify(r)}`).toBe(100)
      expect(r.every((x) => Number.isInteger(x) && x >= 0)).toBe(true)
    }
  })

  it('随机三元组配平后合计恒为 100（fuzz）', () => {
    for (let i = 0; i < 2000; i++) {
      const v = [Math.random() * 200, Math.random() * 500, Math.random() * 300]
      const r = balancePercents(v)
      expect(r.reduce((a, b) => a + b, 0), `${JSON.stringify(v)} → ${JSON.stringify(r)}`).toBe(100)
      // 配平结果不得偏离真实占比超过 1 个百分点（最大余数法的性质）
      const s = v.reduce((a, b) => a + b, 0)
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(r[k] - (v[k] / s) * 100)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('边界：全 0 / 含负数或 NaN / 单项', () => {
    expect(balancePercents([0, 0, 0])).toEqual([0, 0, 0])
    expect(balancePercents([-5, 10, NaN])).toEqual([0, 100, 0])
    expect(balancePercents([42])).toEqual([100])
    expect(balancePercents([])).toEqual([])
  })
})

describe('analyzeEntry · 🔴 端到端：截图场景不得再出现长小数', () => {
  it('核桃 60g 的画像文案里所有数字都不超过 2 位小数', () => {
    const insight = analyzeEntry(WALNUT, () => '坚果种子')
    const texts = [...insight.risks, ...insight.benefits].map((t) => `${t.label}：${t.reason}`)
    expect(texts.length).toBeGreaterThan(0)

    for (const s of texts) {
      // 抓出文案里所有数字，逐个断言小数位 ≤ 2
      const nums = s.match(/\d+\.\d+/g) || []
      for (const raw of nums) {
        const decimals = raw.split('.')[1].length
        expect(decimals, `${s}  ← 数值 ${raw} 有 ${decimals} 位小数`).toBeLessThanOrEqual(2)
      }
      // 更严格：不得出现 3 位以上连续小数（长小数的指纹）
      expect(/\d+\.\d{3,}/.test(s), `长小数泄漏：${s}`).toBe(false)
    }
  })

  it('截图同款数值收敛正确：蛋白 11.67、纤维 5.83', () => {
    const insight = analyzeEntry(WALNUT, () => '坚果种子')
    const all = [...insight.risks, ...insight.benefits].map((t) => t.reason).join(' | ')
    expect(all).toContain('11.67')
    expect(all).toContain('5.83')
    expect(all).not.toContain('11.666666')
    expect(all).not.toContain('5.833333')
  })

  it('🔴 阈值判断仍用全精度（展示层舍入不得改变结论）', () => {
    // 蛋白 per100 = 7 × 100/60 = 11.666… 落在 [10,20) → 应命中 protein_good（较好）
    // 若错误地在源头舍入成 11.67 或 12 也仍在同区间；这里用更靠近边界的值来验证：
    // protein_g = 12.6, grams = 63 → per100 = 20.0（恰好边界，应命中 protein_top）
    const edge = analyzeEntry({ ...WALNUT, protein_g: 12.6, grams: 63 }, () => '坚果种子')
    expect(edge.benefits.some((t) => t.key === 'protein_top')).toBe(true)

    // protein_g = 12.5, grams = 63 → per100 = 19.841… < 20 → 只能是 protein_good
    const below = analyzeEntry({ ...WALNUT, protein_g: 12.5, grams: 63 }, () => '坚果种子')
    expect(below.benefits.some((t) => t.key === 'protein_top')).toBe(false)
    expect(below.benefits.some((t) => t.key === 'protein_good')).toBe(true)
  })

  it('grams 异常时不产生 NaN/Infinity 文案（除零防线）', () => {
    for (const grams of [0, -10, NaN, undefined as unknown as number]) {
      const insight = analyzeEntry({ ...WALNUT, grams }, () => '坚果种子')
      const all = [...insight.risks, ...insight.benefits].map((t) => t.reason).join(' | ')
      expect(all).not.toContain('NaN')
      expect(all).not.toContain('Infinity')
      expect(/\d+\.\d{3,}/.test(all), `grams=${grams} → ${all}`).toBe(false)
    }
  })

  it('添加糖文案同样不得出现长小数', () => {
    /* 🔴 不能直接给 WALNUT 换 grams —— 那样会造出「每 100ml 含 133g 脂肪、1355 kcal 的饮料」
       这种物理上不存在的食物，测的就不是真实场景了。这里用真实的可乐型饮料：
       330ml、140 kcal、碳水 35g、脂肪 0。r = 100/330，
       添加糖 per100 = 35 × 100/330 = 10.6060…（>=10 → high_added_sugar） */
    const SODA = {
      ...WALNUT,
      food_name: '可乐',
      grams: 330,
      calories: 140,
      carb_g: 35,
      protein_g: 0,
      fat_g: 0,
      fiber_g: null,
      added_sugar_g: 35,
    }
    const insight = analyzeEntry(SODA, () => '饮料酒水')
    const sugar = insight.risks.find((t) => t.key === 'high_added_sugar')
    expect(sugar, `实际 risks：${insight.risks.map((t) => t.key).join(',')}`).toBeTruthy()
    expect(sugar!.reason).toContain('10.61')
    expect(/\d+\.\d{3,}/.test(sugar!.reason), sugar!.reason).toBe(false)
  })

  it('液体碳水文案不得出现长小数', () => {
    /* 真实柠檬水：225ml、100 kcal、碳水 25g、脂肪 0。
       r = 100/225 = 4/9 → 碳水 per100 = 11.111…（饮料 >=8 → sugary_drink） */
    const LEMONADE = {
      ...WALNUT,
      food_name: '柠檬水',
      grams: 225,
      calories: 100,
      carb_g: 25,
      protein_g: 0,
      fat_g: 0,
      fiber_g: null,
      added_sugar_g: 0,
    }
    const insight = analyzeEntry(LEMONADE, () => '饮料酒水')
    const drink = insight.risks.find((t) => t.key === 'sugary_drink')
    expect(drink, `实际 risks：${insight.risks.map((t) => t.key).join(',')}`).toBeTruthy()
    expect(drink!.reason).toContain('11.11')
    expect(/\d+\.\d{3,}/.test(drink!.reason), drink!.reason).toBe(false)
  })

  it('高蛋白低脂文案里蛋白值与百分比都不得有长小数', () => {
    /* 鸡胸肉 70g：蛋白 12g → per100 = 17.142857…（>=15 且脂肪供能比 <40%） */
    const insight = analyzeEntry(
      { ...WALNUT, food_name: '鸡胸肉', protein_g: 12, fat_g: 3, calories: 120, grams: 70, fiber_g: null },
      () => '蛋奶豆制品',
    )
    const tag = insight.benefits.find((t) => t.key === 'high_p_low_f')
    expect(tag, `实际 benefits：${insight.benefits.map((t) => t.key).join(',')}`).toBeTruthy()
    expect(tag!.reason).toContain('17.14')
    expect(/\d+\.\d{3,}/.test(tag!.reason), tag!.reason).toBe(false)
  })

  it('友好度评分为整数', () => {
    const insight = analyzeEntry(WALNUT, () => '坚果种子')
    expect(Number.isInteger(insight.score)).toBe(true)
    expect(insight.score).toBeGreaterThanOrEqual(0)
    expect(insight.score).toBeLessThanOrEqual(100)
  })
})

/* ── 输入层：clampNumeric 必须遵守 limit.decimals ──────────────────
   旧实现把小数位硬编码成 1 位（Math.round(x*10)/10），与它自己调用的
   sanitizeNumeric(decimals) 口径不一致：营养素克数是 2 位小数，
   一旦有 decimals:2 的规则就会被悄悄砍回 1 位。 */
describe('clampNumeric / formatNum · 输入与展示层口径', () => {
  const NUTRIENT = { label: '蛋白质', min: 0, max: 500, decimals: 2, unit: 'g' }
  const KCAL = { label: '热量', min: 1, max: 10000, int: true, unit: 'kcal' }

  it('🔴 decimals:2 的规则不被砍回 1 位', () => {
    expect(clampNumeric('12.34', NUTRIENT)).toBe('12.34')
    expect(clampNumeric('5.83', NUTRIENT)).toBe('5.83')
  })

  it('整数规则仍返回整数', () => {
    expect(clampNumeric('232', KCAL)).toBe('232')
    /* int 模式下 sanitizeNumeric 会**删掉小数点**（而不是四舍五入），
       所以 '232.9' → '2329'。这是既有的输入过滤语义：整数字段里不该出现小数点，
       用户输入时会被即时抹掉。与本次舍入口径无关，此处仅固化行为防回归。 */
    expect(clampNumeric('232.9', KCAL)).toBe('2329')
  })

  it('越界夹取到边界，且保留声明的小数位', () => {
    expect(clampNumeric('9999', NUTRIENT)).toBe('500')
    /* 负号同样被 sanitizeNumeric 过滤掉（只保留数字与小数点），
       因此 '-5' 实际按 5 处理。营养素/热量类字段的 min 都 >= 0，不接受负值。 */
    expect(clampNumeric('-5', NUTRIENT)).toBe('5')
    expect(clampNumeric('0', NUTRIENT)).toBe('0')
  })

  it('空串与非法输入返回空串', () => {
    expect(clampNumeric('', NUTRIENT)).toBe('')
    expect(clampNumeric('abc', NUTRIENT)).toBe('')
  })

  it('与 sanitizeNumeric 截断位数一致（不产生第 3 位小数）', () => {
    for (const raw of ['12.345', '0.009', '1.2349']) {
      const out = clampNumeric(raw, NUTRIENT)
      const frac = out.split('.')[1] ?? ''
      expect(frac.length, `${raw} → ${out}`).toBeLessThanOrEqual(2)
    }
  })

  it('formatNum 委托给 fmtNum 后不再出现浮点舍入缺陷', () => {
    // 旧实现 Math.round(1.005*100)/100 会得 1（乘法后并非精确 100.5）
    expect(formatNum(1.005, 2)).toBe('1')
    expect(formatNum(12.5, 1)).toBe('12.5')
    expect(formatNum(null)).toBe('—')
    expect(formatNum(NaN)).toBe('—')
    expect(formatNum(-0.003, 1)).toBe('0') // 不得输出 "-0"
  })
})
