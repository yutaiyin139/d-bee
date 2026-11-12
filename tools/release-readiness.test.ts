/**
 * 护栏 19 · 发版就绪登记 + 阶段 0 一致性收口（2026-11-09 新增）。
 *
 * 补的是总纲 §1.4「零自动断言」里最易自动化的三类：
 *   ① 平台侧商品（ASC / 微信道具）的 ID、价格、发布状态
 *   ② 0046 是否应用到生产库
 *   ③ 网关 xpay.mjs / iap.mjs 是否部署、支付相关 env 是否配齐
 *
 * 🔴 边界（必须写清，否则会被误当成「已就绪」证明）：
 *   这三项无法从本地源码探测 —— 平台后台、生产库、服务器 env 都在仓库之外。
 *   本护栏的做法是「显式登记 + 与代码真源自动比对」：
 *     · tools/release-readiness.baseline.json 由发版人核对后更新（人工登记）；
 *     · 护栏保证登记的商品 ID/价格逐字等于 shared 真源、登记的 env key 确实
 *       被 config.mjs 读取、未就绪状态不被静默改成已就绪。
 *   护栏全绿 ≠ 生产就绪，只代表「登记没漂移、没人假装已配置」。
 *
 * 另钉死阶段 0 的两类刻意分叉（防顺手抹平）：
 *   · 第三方收银台门控常量及其实际生效点（当前为「未实装态」）；
 *   · 主端 / mini 权益清单的 2 条端能力差异。
 *
 * 🔴 11-09 用户已推翻 (B)「明确不收款」：Android 改判 (A) 实装、Web 改为
 *    「办妥 ICP 经营许可证后可收款」。19-C 在 (A) 实装同批须改写为
 *    「门控值 ↔ 法务口径 ↔ 实装登记」三者一致（而非钉死 false），
 *    并按项目铁律重新做红验证。详见
 *    `docs/四端收款堵点与政策依据详表-2026-11-09.md` §4.3 A13。
 *
 * 运行：npx vitest run tools/release-readiness.test.ts
 * 🔴 本护栏已按项目铁律做红验证（见当日日志「阶段 0 红验证」）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

type Lex = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

/** 字符级注释剥离：注释 → 等长空格，保留换行（行号不变，红了能直接定位）。 */
function stripComments(src: string): string {
  const out = src.split('')
  let s: Lex = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    switch (s) {
      case 'code':
        if (c === '/' && c2 === '/') {
          s = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c === '/' && c2 === '*') {
          s = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c === "'") { s = 'sq'; i++; continue }
        if (c === '"') { s = 'dq'; i++; continue }
        if (c === '`') { s = 'tpl'; i++; continue }
        i++; continue
      case 'line':
        if (c === '\n') { s = 'code'; i++; continue }
        out[i] = ' '; i++; continue
      case 'block':
        if (c === '*' && c2 === '/') {
          out[i] = ' '; out[i + 1] = ' '; s = 'code'; i += 2; continue
        }
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

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string) => stripComments(read(p))
const raw = (p: string) => read(p)

const BASELINE_PATH = 'tools/release-readiness.baseline.json'
const SHARED = 'packages/shared/src/constants/index.ts'
const PAYWALL = 'src/pages/PaywallSheet.tsx'
const MAIN_LEGAL = 'src/content/legal.ts'
const MINI_LEGAL = 'mini/src/content/legal.ts'
const MEMBERSHIP = 'src/content/membership.ts'
const MINI_PAYWALL = 'mini/src/pages/paywall/paywall.tsx'
const CONFIG = 'server/lib/config.mjs'
const MIG_0021 = 'db/migrations/0021-payment-orders.sql'
const MIG_0038 = 'db/migrations/0038-lifetime-price-298.sql'
const MIG_0046 = 'db/migrations/0046-wechat-xpay-settlement.sql'
const MIG_0047 = 'db/migrations/0047-app-payment-settlement.sql'

type Item = { key: string; productId: string; priceCny: number; amountCents: number; published: boolean }

const BASELINE = JSON.parse(raw(BASELINE_PATH)) as {
  production: { schemaMigrationLevel: string; migration0046Applied: boolean; migration0047Applied: boolean; gatewayXpayDeployed: boolean; gatewayAppPayDeployed: boolean; gatewayIapDeployed: boolean }
  env: { status: string; required: string[]; configured: string[] }
  platformProducts: { status: string; items: Item[] }
}

/** 抽 `const NAME = [ ... ]` 里的字符串字面量（含模板串原文，保留 ${} 便于两端逐字比对）。 */
function arrayItems(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name} = [`)
  if (start < 0) return []
  const end = src.indexOf(']', start)
  const body = src.slice(start, end)
  return [...body.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '')
}

function sharedProductIds(): string[] {
  const m = code(SHARED).match(/PRODUCT_IDS\s*=\s*\{([^}]*)\}/)
  if (!m) return []
  return [...m[1].matchAll(/\w+\s*:\s*'([^']+)'/g)].map((x) => x[1])
}

function sharedPrices(): number[] {
  const src = code(SHARED)
  return ['PRICE_PRO_MONTHLY', 'PRICE_PRO_YEARLY', 'PRICE_LIFETIME'].map((k) => {
    const m = src.match(new RegExp(`${k}\\s*=\\s*(\\d+)`))
    return m ? Number(m[1]) : Number.NaN
  })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('护栏 19-A · 平台侧三档商品基线（补 §1.4 零断言空白 #1）', () => {
  const items = BASELINE.platformProducts.items

  it('基线三档 productId 逐字等于 shared PRODUCT_IDS', () => {
    expect(items.map((i) => i.productId)).toEqual(sharedProductIds())
  })

  it('基线三档 priceCny 逐字等于 shared PRICE_*', () => {
    expect(items.map((i) => i.priceCny)).toEqual(sharedPrices())
  })

  it('基线 amountCents 恒等于 priceCny × 100（分单位，与 DB 种子同口径）', () => {
    expect(items.every((i) => i.amountCents === i.priceCny * 100)).toBe(true)
  })

  it('lifetime 基线金额取 0038 修正值（0021 的 32800 是历史值）', () => {
    const m = code(MIG_0038).match(/amount_cents\s*=\s*(\d+)/)
    expect(items.find((i) => i.key === 'lifetime')?.amountCents).toBe(Number(m?.[1]))
  })

  it('基线三档 productId 均出现在 0021 payment_products 种子中', () => {
    const seed = code(MIG_0021)
    expect(items.every((i) => seed.includes(i.productId))).toBe(true)
  })

  it('平台商品登记为未配置且三档均未发布（防把「计划」写成「已就绪」）', () => {
    expect(BASELINE.platformProducts.status === 'not_configured' && items.every((i) => !i.published)).toBe(true)
  })
})

describe('护栏 19-B · 生产水位与支付 env 登记（补 §1.4 零断言空白 #3 #4）', () => {
  // 🔴 2026-11-12 P0.4 刷新：0048（兑换码加固）已应用生产，0046/0047 仍未应用。
  //    原断言写死水位 '0045'，会与真实登记冲突。意图不变 —— 钉住「跳号空洞不得被静默抹平」：
  //    只要 0046/0047 还是未应用，就不许有人把它们改成 true 而不走迁移评审。
  it('0046/0047 登记为未应用且水位为 0048（跳号空洞不得被静默抹平）', () => {
    expect(
      BASELINE.production.migration0046Applied === false &&
        BASELINE.production.migration0047Applied === false &&
        BASELINE.production.schemaMigrationLevel === '0048',
    ).toBe(true)
  })

  it('0047（APP 支付结算底座）登记为未应用（未应用时严禁开 D_BEE_APPPAY_ENABLED）', () => {
    expect(BASELINE.production.migration0047Applied).toBe(false)
  })

  it('网关 xpay / apppay / iap 均登记为未部署', () => {
    expect(
      !BASELINE.production.gatewayXpayDeployed &&
        !BASELINE.production.gatewayAppPayDeployed &&
        !BASELINE.production.gatewayIapDeployed,
    ).toBe(true)
  })

  it('0046 迁移文件确实写入 schema_migrations（登记指向真迁移）', () => {
    expect(/schema_migrations/.test(code(MIG_0046))).toBe(true)
  })

  it('0047 迁移文件确实写入 schema_migrations 且提供 settle_app_payment', () => {
    const src = code(MIG_0047)
    expect(/schema_migrations/.test(src) && /FUNCTION public\.settle_app_payment/.test(src)).toBe(true)
  })

  it('0047 只把核销函数授给 dbee_app（definer 函数不对匿名/认证角色开放）', () => {
    expect(/GRANT EXECUTE ON FUNCTION public\.settle_app_payment[\s\S]{0,200}dbee_app/.test(code(MIG_0047))).toBe(true)
  })

  it('登记的每个 env key 都真的被 config.mjs 读取（防登记一个不存在的假 key）', () => {
    const cfg = code(CONFIG)
    expect(BASELINE.env.required.every((k) => cfg.includes(`env.${k}`))).toBe(true)
  })

  it('APP 支付 9 个 env key 全部登记且被 config.mjs 读取（微信 6 + 支付宝 3）', () => {
    const appKeys = [
      'WECHAT_PAY_APPID', 'WECHAT_PAY_MCHID', 'WECHAT_PAY_SERIAL_NO',
      'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_APIV3_KEY', 'WECHAT_PAY_PLATFORM_CERT',
      'ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY',
    ]
    expect(appKeys.every((k) => BASELINE.env.required.includes(k))).toBe(true)
  })

  it('支付 env 登记为未配置且零已配置 key', () => {
    expect(BASELINE.env.status === 'not_configured' && BASELINE.env.configured.length === 0).toBe(true)
  })

  it('基线文件禁止写入任何凭据值（只登记 key 名与有无）', () => {
    expect(
      !/"(XPAY_APP_KEY|XPAY_PUSH_AES_KEY|APPLE_SHARED_SECRET|APPLE_WEBHOOK_SECRET|WECHAT_PAY_PRIVATE_KEY|WECHAT_PAY_APIV3_KEY|ALIPAY_PRIVATE_KEY)"\s*:\s*"[^"]+"/.test(raw(BASELINE_PATH)),
    ).toBe(true)
  })
})

describe('护栏 19-C · 收银台门控 ↔ 法务口径 ↔ 实装登记 三者一致（(A) 已实装）', () => {
  it('Android 支付按钮受构建期开关 APPPAY_SALE_ENABLED 门控（不再是硬编码常量）', () => {
    expect(/setPayChannels\(APPPAY_SALE_ENABLED && isAndroid\(\)/.test(code(PAYWALL))).toBe(true)
  })

  it('APPPAY_SALE_ENABLED 从唯一真源 lib/miniOrderGuide 导入（付费墙不自定义开关）', () => {
    expect(/from '\.\.\/lib\/miniOrderGuide'/.test(code(PAYWALL)) && !/const APPPAY_SALE_ENABLED =/.test(code(PAYWALL))).toBe(true)
  })

  it('旧的第三方收银台硬编码常量已彻底移除（防两套门控并存漂移）', () => {
    expect(/THIRD_PARTY_CHECKOUT_ENABLED/.test(code(PAYWALL))).toBe(false)
  })

  it('legal §六 Android 条按 APPPAY_SALE_ENABLED 分支（开启态披露应用内购买，关闭态声明不提供）', () => {
    const src = code(MAIN_LEGAL)
    expect(/\.\.\.\(APPPAY_SALE_ENABLED\s*\?/.test(src)).toBe(true)
  })

  it('legal 两分支措辞互斥：开启态写「一次性购买」，关闭态写「当前版本不提供应用内购买」', () => {
    const src = code(MAIN_LEGAL)
    expect(src.includes('不构成自动续期订阅，不自动续费') && src.includes('当前版本不提供应用内购买')).toBe(true)
  })

  it('legal 三方 SDK 清单的微信条同样受开关门控（未开放态与已开放态不得混用）', () => {
    expect((code(MAIN_LEGAL).match(/APPPAY_SALE_ENABLED/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('legal 从 lib/miniOrderGuide 导入 APPPAY_SALE_ENABLED（法务与页面同一开关）', () => {
    expect(/APPPAY_SALE_ENABLED/.test(code(MAIN_LEGAL)) && /from '\.\.\/lib\/miniOrderGuide'/.test(code(MAIN_LEGAL))).toBe(true)
  })

  it('主端小程序条与 mini 退款专节都包在 XPAY_SALE_ENABLED 门控内（默认构建零收费条款）', () => {
    expect(
      /\.\.\.\(XPAY_SALE_ENABLED/.test(code(MAIN_LEGAL)) && /\.\.\.\(XPAY_SALE_ENABLED/.test(code(MINI_LEGAL)),
    ).toBe(true)
  })

  it('mini 使用条款含独立「九、退款与售后」专节', () => {
    expect(code(MINI_LEGAL).includes('九、退款与售后')).toBe(true)
  })
})

describe('护栏 19-D · 权益清单端能力差异快照（补 §1.3 L3 #8）', () => {
  it('主端 FREE_ITEMS 比 mini 恰好多「扫条码」一条', () => {
    const main = arrayItems(code(MEMBERSHIP), 'FREE_ITEMS')
    const mini = arrayItems(code(MINI_PAYWALL), 'FREE_ITEMS')
    expect(main.filter((x) => !mini.includes(x))).toEqual(['扫条码不限次数永久免费'])
  })

  it('主端 PRO_ITEMS 比 mini 恰好多「+ 数据导出」一条', () => {
    const main = arrayItems(code(MEMBERSHIP), 'PRO_ITEMS')
    const mini = arrayItems(code(MINI_PAYWALL), 'PRO_ITEMS')
    expect(main.filter((x) => !mini.includes(x))).toEqual(['饮食报告扩展到 ${PRO_REPORT_DAYS} 天 + 数据导出'])
  })

  it('mini PRO_ITEMS 的独有条目恰好是「无数据导出」变体（不得再冒出第三条差异）', () => {
    const main = arrayItems(code(MEMBERSHIP), 'PRO_ITEMS')
    const mini = arrayItems(code(MINI_PAYWALL), 'PRO_ITEMS')
    expect(mini.filter((x) => !main.includes(x))).toEqual(['饮食报告扩展到 ${PRO_REPORT_DAYS} 天'])
  })

  it('两端差异说明注释必须存在（防被当成 bug 顺手抹平）', () => {
    expect(
      /真实端能力差异|端能力差异/.test(raw(MEMBERSHIP)) && /端能力差异/.test(raw(MINI_PAYWALL)),
    ).toBe(true)
  })
})
