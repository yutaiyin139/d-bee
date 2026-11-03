/**
 * 定价单一真相源回归测试（2026-11-03）。
 *
 * 起因：用户要求「四个端的业务逻辑、收费用户及免费逻辑必须一致」。审计时发现
 * **价格数字在全仓存在三份互相独立的副本**，改价时必然漏改：
 *
 *   ① packages/shared/src/constants/index.ts  PRICE_PRO_MONTHLY = 18 / YEARLY = 128 / LIFETIME = 298
 *   ② packages/shared/src/rules/index.ts      PRODUCTS[].price = 18 / 128 / 298   ← 内联字面量，没引用 ①
 *   ③ src/pages/PaywallSheet.tsx              PRICE_TAG = { proMonthly: '¥18 / 月', ... } ← 又一份硬编码
 *
 * ③ 最危险：iOS 分支刻意「绝不回退硬编码价」（只用 App Store 拉到的真实价），
 * 而 Android/Web 分支却直接用 PRICE_TAG 这份硬编码。改价时只改 ①② 不改 ③，
 * 就会出现「商店价 ¥20、Web 展示 ¥18」的价格不符 —— 既误导用户也可能被认定价格欺诈。
 *
 * ② 同样违反项目既有纪律：constants/index.ts:84 对 FREE_HONEY_PRO_ITEM 明确写了
 * 「文案用模板字符串从 HONEY_PRICE 取值，不硬编码数字：调价时文案自动跟随」。
 * 价格本身反而硬编码，是本末倒置。
 *
 * 修法：
 *   · PRODUCTS[].price 改为引用 PRICE_* 常量（② 消失）
 *   · 新增 priceTag(p) 纯函数放在 @dbee/shared，主端 PaywallSheet 改为调用它（③ 消失）
 *   · priceTag 内部用 fmtNum（全站唯一权威数字格式化实现）而非自己写 toFixed
 *
 * 运行：npx vitest run tools/price-single-source.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  PRICE_LIFETIME,
  PRICE_PRO_MONTHLY,
  PRICE_PRO_YEARLY,
  PRODUCTS,
  priceTag,
} from '../src/lib/entitlement'

describe('PRODUCTS 价格必须引用 PRICE_* 常量（消灭副本 ②）', () => {
  it('三档价格与常量逐项一致', () => {
    const byId = Object.fromEntries(PRODUCTS.map((p) => [p.id, p.price]))
    expect(byId.proMonthly).toBe(PRICE_PRO_MONTHLY)
    expect(byId.proYearly).toBe(PRICE_PRO_YEARLY)
    expect(byId.lifetime).toBe(PRICE_LIFETIME)
  })

  it('PRODUCTS 覆盖全部三档且顺序即展示顺序', () => {
    expect(PRODUCTS.map((p) => p.id)).toEqual(['proMonthly', 'proYearly', 'lifetime'])
  })

  it('年订阅档位带 months=12（priceTag 均摊要用）', () => {
    const yearly = PRODUCTS.find((p) => p.id === 'proYearly')
    expect(yearly?.months).toBe(12)
  })

  it('终身买断不带 months（买断无订阅期）', () => {
    const lifetime = PRODUCTS.find((p) => p.id === 'lifetime')
    expect(lifetime?.months).toBeUndefined()
  })
})

describe('priceTag 价格文案生成（消灭副本 ③）', () => {
  it('三档线上文案与替换前的硬编码逐字一致（零 UI 变化护栏）', () => {
    // 这三个字符串是 2026-11-03 重构前 PaywallSheet 里 PRICE_TAG 的原值。
    // 钉住它们的目的：重构只应改变「价格的来源」，不应改变「用户看到的文案」。
    // 若将来真的要调价，改 PRICE_* 后这条会红 —— 那是**正确**的报警，
    // 届时同步更新本用例的期望值，并确认 iOS 商店价与 Android/Web 展示一致。
    const byId = Object.fromEntries(PRODUCTS.map((p) => [p.id, priceTag(p)]))
    expect(byId.proMonthly).toBe('¥18 / 月')
    expect(byId.proYearly).toBe('¥128 / 年（约 ¥10.7/月）')
    expect(byId.lifetime).toBe('¥298 永久')
  })

  it('月订阅：¥18 / 月', () => {
    expect(priceTag({ id: 'proMonthly', plan: 'pro', name: '月订阅', price: 18, months: 1 }))
      .toBe('¥18 / 月')
  })

  it('年订阅：带均摊月价，且与旧硬编码文案逐字一致', () => {
    // 旧硬编码是 '¥128 / 年（约 ¥10.7/月）'。128/12 = 10.666… → 1 位小数 = 10.7
    expect(priceTag({ id: 'proYearly', plan: 'pro', name: '年订阅', price: 128, months: 12, highlight: true }))
      .toBe('¥128 / 年（约 ¥10.7/月）')
  })

  it('终身买断：¥298 永久', () => {
    expect(priceTag({ id: 'lifetime', plan: 'lifetime', name: '终身买断', price: 298 }))
      .toBe('¥298 永久')
  })

  it('数字走 fmtNum 去尾随零（不出现 ¥18.00）', () => {
    const tag = priceTag({ id: 'proMonthly', plan: 'pro', name: '月订阅', price: 18, months: 1 })
    expect(tag).not.toContain('18.00')
    expect(tag).not.toContain('18.0 ')
  })

  it('均摊价出现小数时保留 1 位（¥127/年 → ¥10.6/月）', () => {
    expect(priceTag({ id: 'proYearly', plan: 'pro', name: '年订阅', price: 127, months: 12 }))
      .toBe('¥127 / 年（约 ¥10.6/月）')
  })

  it('均摊价为整数时不带小数点（¥120/年 → ¥10/月）', () => {
    expect(priceTag({ id: 'proYearly', plan: 'pro', name: '年订阅', price: 120, months: 12 }))
      .toBe('¥120 / 年（约 ¥10/月）')
  })

  it('lifetime 即使误带 months 也不显示均摊（买断无订阅期）', () => {
    expect(priceTag({ id: 'lifetime', plan: 'lifetime', name: '终身买断', price: 298, months: 12 }))
      .toBe('¥298 永久')
  })
})

describe('边界：异常输入不得产出 NaN/Infinity，也不得编造订阅周期', () => {
  it('months=0 时退化为只展示价格（避免除零 → Infinity）', () => {
    const tag = priceTag({ id: 'proYearly', plan: 'pro', name: '年订阅', price: 128, months: 0 })
    expect(tag).not.toContain('Infinity')
    expect(tag).not.toContain('NaN')
    // 周期未知就如实只写价格，不编一个「/ 年」出来
    expect(tag).toBe('¥128')
  })

  it('months 为负数时同样只展示价格', () => {
    const tag = priceTag({ id: 'proYearly', plan: 'pro', name: '年订阅', price: 128, months: -12 })
    expect(tag).not.toContain('NaN')
    expect(tag).toBe('¥128')
  })

  it('months 缺失时只展示价格', () => {
    expect(priceTag({ id: 'proMonthly', plan: 'pro', name: '月订阅', price: 18 }))
      .toBe('¥18')
  })

  it('price 为 0 时如实展示 ¥0（不吞成空串）', () => {
    expect(priceTag({ id: 'proMonthly', plan: 'pro', name: '限时免费', price: 0, months: 1 }))
      .toBe('¥0 / 月')
  })

  it('price 异常（NaN）时整体退化为占位符，而非 "¥NaN / 月"', () => {
    // 与 PaywallSheet 的 iOS 分支「拉不到商店价就显示 —」同一处置：
    // 宁可展示占位符，也不展示一个与真实扣款不符的数字。
    expect(priceTag({ id: 'proMonthly', plan: 'pro', name: '月订阅', price: NaN, months: 1 }))
      .toBe('—')
  })

  it('price 为 Infinity 时同样退化为占位符', () => {
    expect(priceTag({ id: 'proMonthly', plan: 'pro', name: '月订阅', price: Infinity, months: 1 }))
      .toBe('—')
  })
})
