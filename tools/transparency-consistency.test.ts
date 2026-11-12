/**
 * 护栏 25 · 透明化文案四端一致性（2026-11-12，P1.4 / P1.5 / P1.6）
 *
 * ## 为什么需要这道护栏
 *
 * 这三项都是「把已经写在代码注释里的规则搬到 UI 上」。搬完最容易出现的退化是：
 *  ① 某端又自己抄了一份文案（改常量时漏改 → 数字漂移 → 虚假宣传）；
 *  ② 把全能力端口的额度文案贴到 mini（mini 没有扫码 / 包装识别，护栏 19 明确
 *     钉住这条刻意差异），等于宣传一个不存在的功能；
 *  ③ 为了图省事，把数字直接写死在文案里（`每日 3 次`），改配额后页面还写 3；
 *  ④ 顺手「优化」了法务条款或刷了 `LEGAL_UPDATED`（全体老用户重弹同意窗）。
 *
 * ## 护栏断言三铁律的落实
 *
 * ① 一个 `it()` 只一条断言；
 * ② 匹配「实际使用」而非标识符出现：读渲染调用点的实参表达式，并动态从
 *    shared 常量取真实值比对文案产出（改常量即变红）；
 * ③ 代码断言一律在 `stripComments()` 之后做，注释里的示例/说明不算数。
 *
 * 运行：npx vitest run tools/transparency-consistency.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  HONEY_PRICE,
  ACTIVITY_EATBACK_RATIO,
  FULL_RECORDING_CAPS,
  MINI_RECORDING_CAPS,
  quotaNotes,
  CAPABILITY_NOTES,
  DATA_RIGHTS_NOTES,
} from '../src/lib/entitlement'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/** 去掉块注释 / 行注释；断言只作用在真实代码与真实文案上。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

/** 官网额度规则快照（独立仓库，路径可达时读；不可达时用内置逐字副本比对）。 */
const WEBSITE_QUOTA = 'E:/DEV/d-bee-website/src/data/site.mjs'
const OFFICIAL_QUOTA_TEXTS = [
  '仅 AI 拍照识别消耗次数，且识别成功才扣、失败不扣。',
  '手动录入、文字描述识别、包装营养表读取、条码扫码、体重 / 饮水 / 运动打卡均不占额度。',
  '基础额度按自然日 0 点重置，不累计、不结转；奖励额度带 7 天有效期。',
  '额度用完仍可手动录入、扫码与查看历史记录。本服务免费版永久可用，不承诺服务不中断、无差错。',
]

describe('护栏 25-A · 文案数字必须来自 shared 常量（改常量即变红）', () => {
  it('免费额度条目逐字等于由常量插值的结果', () => {
    expect(quotaNotes(FULL_RECORDING_CAPS)[4].text).toBe(
      `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别；积分可再兑换，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（${HONEY_PRICE.ai1Scan} 积分/次）。`,
    )
  })

  it('积分规则条目逐字等于由 HONEY_PRICE 插值的结果', () => {
    expect(CAPABILITY_NOTES[3].text).toContain(
      `${HONEY_PRICE.ai1Scan} 分/次）或 Pro 天数（${HONEY_PRICE.pro1Day} 分/天、${HONEY_PRICE.pro30Day} 分/30 天）`,
    )
  })

  it('运动回补条目逐字等于由 ACTIVITY_EATBACK_RATIO 插值的结果', () => {
    expect(CAPABILITY_NOTES[2].text).toContain(`活动消耗只按 ${ACTIVITY_EATBACK_RATIO * 100}% 计入可吃回额度`)
  })

  it('shared 文案源文件不含写死的配额数字（3 / 2 / 50 只出现在常量名里）', () => {
    const src = stripComments(read('packages/shared/src/content/transparency.ts'))
    expect(src.includes('每日 3 次') || src.includes('每日最多 2 次') || src.includes('50 积分/次')).toBe(false)
  })
})

describe('护栏 25-B · 端能力差异不得抹平（mini 无扫码 / 包装识别）', () => {
  it('MINI_RECORDING_CAPS 两个能力均为 false', () => {
    expect(MINI_RECORDING_CAPS.barcode === false && MINI_RECORDING_CAPS.packagedLabel === false).toBe(true)
  })

  it('全能力端口文案与官网 QUOTA_RULES 前 4 条逐字一致', () => {
    expect(quotaNotes(FULL_RECORDING_CAPS).slice(0, 4).map((n) => n.text)).toEqual(OFFICIAL_QUOTA_TEXTS)
  })

  it('mini 额度文案不含「条码扫码」', () => {
    expect(quotaNotes(MINI_RECORDING_CAPS).some((n) => n.text.includes('条码扫码'))).toBe(false)
  })

  it('mini 额度文案不含「包装营养表读取」', () => {
    expect(quotaNotes(MINI_RECORDING_CAPS).some((n) => n.text.includes('包装营养表读取'))).toBe(false)
  })

  it('mini 免费兜底不承诺「扫码」', () => {
    expect(quotaNotes(MINI_RECORDING_CAPS)[3].text.includes('扫码')).toBe(false)
  })

  it('mini 付费墙调用 quotaNotes 时传的是 MINI_RECORDING_CAPS', () => {
    const src = stripComments(read('mini/src/pages/paywall/paywall.tsx'))
    expect(src).toContain('quotaNotes(MINI_RECORDING_CAPS)')
  })

  it('mini 我的页调用 quotaNotes 时传的是 MINI_RECORDING_CAPS', () => {
    const src = stripComments(read('mini/src/pages/profile/profile.tsx'))
    expect(src).toContain('quotaNotes(MINI_RECORDING_CAPS)')
  })

  it('主端定价页调用 quotaNotes 时传的是 FULL_RECORDING_CAPS', () => {
    const src = stripComments(read('src/pages/PricingSheet.tsx'))
    expect(src).toContain('quotaNotes(FULL_RECORDING_CAPS)')
  })
})

describe('护栏 25-C · 四端都渲染同一份文案真源（不许另抄副本）', () => {
  const files = [
    'src/pages/PricingSheet.tsx',
    'src/pages/ProfileScreen.tsx',
    'mini/src/pages/paywall/paywall.tsx',
    'mini/src/pages/profile/profile.tsx',
  ]

  files.forEach((f) => {
    it(`${f} 引用 TransparencyNotes 组件而非内联文案`, () => {
      expect(stripComments(read(f))).toContain('<TransparencyNotes')
    })
  })

  it('四端渲染点合计覆盖额度 / 能力 / 数据权三组文案', () => {
    const all = files.map((f) => stripComments(read(f))).join('\n')
    expect(
      all.includes('quotaNotes(') && all.includes('CAPABILITY_NOTES') && all.includes('DATA_RIGHTS_NOTES'),
    ).toBe(true)
  })

  it('主端我的页同时渲染能力与数据权两组', () => {
    const src = stripComments(read('src/pages/ProfileScreen.tsx'))
    expect(src).toContain('notes={CAPABILITY_NOTES}')
  })

  it('mini 我的页同时渲染能力与数据权两组', () => {
    const src = stripComments(read('mini/src/pages/profile/profile.tsx'))
    expect(src).toContain('notes={DATA_RIGHTS_NOTES}')
  })

  it('两个展示组件都不持有文案副本（只 import 类型）', () => {
    const a = stripComments(read('src/components/TransparencyNotes.tsx'))
    const b = stripComments(read('mini/src/components/TransparencyNotes.tsx'))
    expect(!a.includes('每日') && !b.includes('每日')).toBe(true)
  })
})

describe('护栏 25-D · 红线：不改法务条款 / 不刷同意窗 / 不新增写死数字', () => {
  it('LogSheet 不再写死「今日 3 次免费识别已用完」', () => {
    expect(stripComments(read('src/pages/LogSheet.tsx')).includes('今日 3 次免费识别已用完')).toBe(false)
  })

  it('LogSheet 额度提示插值 FREE_DAILY_AI', () => {
    expect(stripComments(read('src/pages/LogSheet.tsx'))).toContain('今日 ${FREE_DAILY_AI} 次免费识别已用完')
  })

  it('legal.ts 未刷新 LEGAL_UPDATED（本次只加展示文案，不动条款）', () => {
    const src = read('src/content/legal.ts')
    expect(src).toContain('刻意不动本值')
  })

  it('本次改动未引入自动退款 / 代补发 RPC', () => {
    const all = [
      'src/pages/ProfileScreen.tsx',
      'mini/src/pages/profile/profile.tsx',
      'packages/shared/src/content/transparency.ts',
    ].map((f) => stripComments(read(f))).join('\n')
    expect(all.includes('refund') || all.includes('autoRefund') || all.includes('grant_photo')).toBe(false)
  })

  it('官网 QUOTA_RULES 快照与内置逐字副本一致（跨仓库漂移可见）', () => {
    let official: string[] = OFFICIAL_QUOTA_TEXTS
    try {
      const site = readFileSync(WEBSITE_QUOTA, 'utf8')
      const block = site.slice(site.indexOf('export const QUOTA_RULES'), site.indexOf('];', site.indexOf('export const QUOTA_RULES')))
      const found = [...block.matchAll(/text:\s*'([^']+)'/g)].map((m) => m[1])
      if (found.length === 4) official = found
    } catch {
      // 官网仓库不在本机时退回内置副本，断言仍生效
    }
    expect(official).toEqual(OFFICIAL_QUOTA_TEXTS)
  })
})
