/**
 * Web 端「只展示定价、不收款、引导口径与小程序售卖同源」护栏（2026-11-08 新建，护栏 18）。
 *
 * ## 防的是什么
 *
 * Web 无 ICP 经营许可证 → 只能发布价格信息、不缔约、不收款（见
 * `docs/Web端定价展示与小程序下单-现状梳理与改造方案`）。同时 11-08 起小程序接入了
 * 微信虚拟支付售卖，由构建期开关 `D_BEE_XPAY_ENABLED` 驱动，**默认关闭**。
 *
 * 于是 Web 侧有两个必须被机器钉死的红线：
 *   1. **零收款**：公开定价页 / 付费墙的 Web 分支绝不能出现下单、创建订单、发起支付的路径；
 *   2. **引导同源**：Web「去小程序下单」的引导必须与 mini 的售卖开关**同一个变量**门控。
 *      只开一端 = 引导用户去一个买不到东西的小程序（虚假宣传），或小程序在卖而 Web 法务说没渠道
 *      （口径不一致）。两端同值时不可能出现任一情况。
 *
 * 这两条一旦被人「顺手」改回去（比如给定价页加个购买按钮、或把引导写成无条件展示），
 * 后果不是样式问题，是合规事故。故落成护栏。
 *
 * 🔴 与 four-end-consistency.test.ts 同款约束：剥离注释后再扫描（注释里的历史说明不算违规），
 *   一个 it() 一条断言，匹配「实际使用」而非「标识符出现」。
 *
 * 运行：npx vitest run tools/web-no-payment.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sanitizeMiniOrderLink } from '../src/lib/miniOrderGuide'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// 注释剥离（与 four-end-consistency.test.ts 同一实现，保留行号）
// ---------------------------------------------------------------------------
type Lex = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

function stripComments(src: string): string {
  const out = src.split('')
  let s: Lex = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    switch (s) {
      case 'code':
        if (c === '/' && c2 === '/') { s = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
        if (c === '/' && c2 === '*') { s = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
        if (c === "'") { s = 'sq'; i++; continue }
        if (c === '"') { s = 'dq'; i++; continue }
        if (c === '`') { s = 'tpl'; i++; continue }
        i++; continue
      case 'line':
        if (c === '\n') { s = 'code'; i++; continue }
        out[i] = ' '; i++; continue
      case 'block':
        if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; s = 'code'; i += 2; continue }
        if (c !== '\n') out[i] = ' '
        i++; continue
      case 'sq':
        if (c === '\\') { i += 2; continue }
        if (c === "'") s = 'code'
        i++; continue
      case 'dq':
        if (c === '\\') { i += 2; continue }
        if (c === '"') s = 'code'
        i++; continue
      case 'tpl':
        if (c === '\\') { i += 2; continue }
        if (c === '`') s = 'code'
        i++; continue
    }
  }
  return out.join('')
}

function load(p: string): { code: string; raw: string } {
  const raw = readFileSync(join(ROOT, p), 'utf8')
  return { raw, code: stripComments(raw) }
}

const pricing = load('src/pages/PricingSheet.tsx')
const paywall = load('src/pages/PaywallSheet.tsx')
const guide = load('src/components/MiniOrderGuide.tsx')
const guideLib = load('src/lib/miniOrderGuide.ts')
const membership = load('src/content/membership.ts')
const footer = load('src/components/SiteFooter.tsx')
const legal = load('src/content/legal.ts')
const viteConfig = load('vite.config.ts')
const miniXpayEnabled = load('mini/src/lib/xpayEnabled.ts')

// ---------------------------------------------------------------------------
// 护栏 W1 · 公开定价页零收款 / 零下单
// ---------------------------------------------------------------------------
describe('护栏 W1 · 公开定价页（PricingSheet）绝不引入任何收款 / 下单能力', () => {
  it('不 import 支付编排层 checkout（Web 唯一可能的下单入口）', () => {
    expect(/payment\/checkout|from '\.\.\/lib\/payment/.test(pricing.code)).toBe(false)
  })

  it('不调用 createPaymentOrder / verifyPaymentOrder / buyProduct', () => {
    expect(/createPaymentOrder|verifyPaymentOrder|buyProduct/.test(pricing.code)).toBe(false)
  })

  it('三档卡片用 div 展示，整页零 <button>（不给「点了能买」的暗示）', () => {
    expect(/<button/.test(pricing.code)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W2 · 公开定价页价格单一真相源
// ---------------------------------------------------------------------------
describe('护栏 W2 · 公开定价页价格走 shared PRODUCTS + priceTag，零副本', () => {
  it('用 priceTag(p) 生成价格文案（不是自己拼字符串）', () => {
    expect(/\bpriceTag\s*\(/.test(pricing.code)).toBe(true)
  })

  it('价格档位来自 shared 的 PRODUCTS', () => {
    expect(/\bPRODUCTS\b/.test(pricing.code)).toBe(true)
  })

  it('源码（剥离注释后）零硬编码 ¥ 数字', () => {
    expect(/[¥￥]\s*\d/.test(pricing.code)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W3 · 「去小程序下单」引导由售卖开关门控，且与 mini 同源
// ---------------------------------------------------------------------------
describe('护栏 W3 · Web 引导必须与 mini 售卖开关同源门控（默认关闭 = 零引导）', () => {
  it('MiniOrderGuide 的下单引导包在 canGuideToMiniSale() 门控内', () => {
    // 实际使用：先取 gate，再用 {gate && ...} 包住引导
    expect(/const guide = canGuideToMiniSale\(\)/.test(guide.code)).toBe(true)
  })

  it('canGuideToMiniSale() 直接返回 XPAY_SALE_ENABLED（引导与否 = 售卖与否）', () => {
    expect(/function canGuideToMiniSale\(\)[\s\S]*?return XPAY_SALE_ENABLED/.test(guideLib.code)).toBe(true)
  })

  it('「网页不收款」声明在门控之外（开关关也恒展示）——位置早于 {guide &&', () => {
    const atNoCharge = guide.code.indexOf('{WEB_NO_CHARGE_TEXT}')
    const atGate = guide.code.indexOf('{guide &&')
    expect(atNoCharge >= 0 && atGate >= 0 && atNoCharge < atGate).toBe(true)
  })

  it('Web 侧 XPAY_SALE_ENABLED 取自构建期常量 __XPAY_SALE_ENABLED__', () => {
    expect(/__XPAY_SALE_ENABLED__/.test(guideLib.code)).toBe(true)
  })

  it('vite.config.ts 从 D_BEE_XPAY_ENABLED 注入 __XPAY_SALE_ENABLED__（与 mini 同名变量）', () => {
    expect(/D_BEE_XPAY_ENABLED/.test(viteConfig.code) && /__XPAY_SALE_ENABLED__/.test(viteConfig.code)).toBe(true)
  })

  it('mini 端售卖开关读的也是 D_BEE_XPAY_ENABLED（两端同源，非各起一个变量名）', () => {
    expect(/D_BEE_XPAY_ENABLED/.test(miniXpayEnabled.code)).toBe(true)
  })

  it('vite.config.ts 对开关非法取值构建期 throw（防「以为开了其实没开」）', () => {
    expect(/!== 'true' && norm !== 'false'/.test(viteConfig.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W4 · 法务文案（legal §六）与页面展示同源
// ---------------------------------------------------------------------------
describe('护栏 W4 · legal.ts 网页版口径与售卖开关同源，且明示不收款', () => {
  it('legal.ts 从 lib/miniOrderGuide 导入 XPAY_SALE_ENABLED（法务与页面同一开关）', () => {
    expect(/from '\.\.\/lib\/miniOrderGuide'/.test(legal.code) && /XPAY_SALE_ENABLED/.test(legal.code)).toBe(true)
  })

  it('legal.ts §六 网页版按开关分支（导入 + 三元使用，至少两处引用）', () => {
    expect((legal.code.match(/XPAY_SALE_ENABLED/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('legal.ts 网页版两分支都明示「不提供在线支付」且「不会通过网页收取任何费用」', () => {
    expect(/不提供在线支付/.test(legal.code) && /不会通过网页收取任何费用/.test(legal.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W5 · 权益清单 / 引导区块单一真源（付费墙与定价页共用，零副本）
// ---------------------------------------------------------------------------
describe('护栏 W5 · 权益清单与引导区块单一真源，付费墙与公开定价页共用', () => {
  it('FREE_ITEMS / PRO_ITEMS 定义在 content/membership.ts', () => {
    expect(/export const FREE_ITEMS/.test(membership.code) && /export const PRO_ITEMS/.test(membership.code)).toBe(true)
  })

  it('PaywallSheet 从 membership 导入清单，且不再本地定义（防副本复活）', () => {
    expect(
      /from '\.\.\/content\/membership'/.test(paywall.code) &&
        !/const FREE_ITEMS =/.test(paywall.code) &&
        !/const PRO_ITEMS =/.test(paywall.code),
    ).toBe(true)
  })

  it('PricingSheet 也从 membership 导入同一份清单', () => {
    expect(/from '\.\.\/content\/membership'/.test(pricing.code)).toBe(true)
  })

  it('PaywallSheet 与 PricingSheet 都渲染共用组件 MiniOrderGuide（引导口径逐字相同）', () => {
    expect(
      /<MiniOrderGuide/.test(paywall.code) && /<MiniOrderGuide/.test(pricing.code),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W6 · 付费墙 Web 分支永不发起支付（运行时兜底）
// ---------------------------------------------------------------------------
describe('护栏 W6 · 付费墙 buyProduct 在 Web 无通道时直接拦截，绝不创建订单', () => {
  it('buyProduct 开头有 isWeb() && noPayChannel 的短路返回', () => {
    expect(/isWeb\(\) && noPayChannel/.test(paywall.code)).toBe(true)
  })

  it('Web 无通道时的拦截提示不再写「去小程序下单」（开关关时小程序不卖，避免误导）', () => {
    // 拦截分支的 setErr 文案只声明「仅展示价格 / 不收款」，不含「下单」
    const m = /if \(isWeb\(\) && noPayChannel\) \{[\s\S]*?setErr\(([^)]*)\)/.exec(paywall.code)
    expect(m !== null && !/下单/.test(m[1])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W7 · 公开定价入口仅 Web 渲染（iOS 只能用 App Store 真实价）
// ---------------------------------------------------------------------------
describe('护栏 W7 · 公开定价入口仅 Web 渲染，不在 iOS 展示本地生成价格', () => {
  it('SiteFooter 的会员定价入口由 isWeb() 门控', () => {
    expect(/const showPricingEntry = isWeb\(\)/.test(footer.code)).toBe(true)
  })

  it('入口按钮包在 showPricingEntry 条件内', () => {
    expect(/showPricingEntry &&/.test(footer.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 W8 · URL Link 协议白名单（运行时行为，纯函数单测）
// ---------------------------------------------------------------------------
describe('护栏 W8 · sanitizeMiniOrderLink 只放行 https，杜绝 javascript:/data: 注入', () => {
  // 🔴 为什么必须运行时单测而不是 grep 产物：VITE_MINI_ORDER_LINK 是 vite 构建期
  //   字符串替换，恶意字面量会原样留在 bundle 里，是否渲染取决于运行时求值。
  //   grep 命中 ≠ 会渲染；只有直接调函数才能证明过滤真实生效。
  it.each([
    ['javascript:alert(1)', ''],
    ['JaVaScRiPt:alert(1)', ''],
    ['data:text/html,<script>alert(1)</script>', ''],
    ['http://wxaurl.cn/abc', ''],
    ['/pages/paywall/paywall', ''],
    ['wxaurl.cn/abc', ''],
    ['', ''],
    ['   ', ''],
  ])('拒绝非 https 输入 %j → 空串', (input, expected) => {
    expect(sanitizeMiniOrderLink(input)).toBe(expected)
  })

  it('放行合法 https 链接（微信 URL Link 形态）', () => {
    expect(sanitizeMiniOrderLink('https://wxaurl.cn/AbCdEf')).toBe('https://wxaurl.cn/AbCdEf')
  })

  it('null / undefined 输入安全返回空串', () => {
    expect(sanitizeMiniOrderLink(undefined)).toBe('')
  })

  it('MiniOrderGuide 的 href 用的是过滤后的 MINI_ORDER_LINK（不是裸 env）', () => {
    expect(/href=\{MINI_ORDER_LINK\}/.test(guide.code)).toBe(true)
  })

  it('miniOrderGuide.ts 的 MINI_ORDER_LINK 确实经过 sanitizeMiniOrderLink（不得绕过）', () => {
    expect(/export const MINI_ORDER_LINK = sanitizeMiniOrderLink\(/.test(guideLib.code)).toBe(true)
  })
})
