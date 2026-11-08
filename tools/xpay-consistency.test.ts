/**
 * 微信虚拟支付（xpay）跨端一致性护栏（2026-11-08 新增，任务 #27）。
 *
 * 背景：用户指令「微信小程序端要展示三档价格并售卖订阅，走微信支付」。
 * 实装链路横跨 4 个真相源，任何一处漂移都是**资损级**事故：
 *   · mini/src/lib/xpay.ts + xpayEnabled.ts + paywall.tsx + content/legal.ts（前端）
 *   · server/lib/xpay.mjs + app.mjs（网关）
 *   · db/migrations/0046（核销 RPC 的 provider 分支）
 *   · packages/shared（PRODUCT_IDS / PRICE_* 单一真相源）
 *
 * 本护栏钉死的每条都对应一个真实翻车面（详见各 it 的失败信息）：
 *   端点路径、provider 取值、notify_provide_goods 资金结算闸门、
 *   signData 原样透传、settling 语义、措辞纪律（道具直购 ≠ 自动续费订阅）、
 *   构建期开关的校验与注入、三档 productId/价格与迁移种子一致。
 *
 * 🔴 断言纪律（护栏三铁律）：一个 it 一条断言；匹配「实际使用」而非「标识符出现」；
 *   生效代码断言一律在 stripComments() 之后做（注释里的历史说明不算数，
 *   例如 paywall 注释里的「取消订阅」是纪律说明，绝不能被当成正文违规）。
 *
 * 运行：npx vitest run tools/xpay-consistency.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// 注释剥离（与 four-end-consistency.test.ts 同款：注释 → 等长空格，行号保留）
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
          s = 'code'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c !== '\n') out[i] = ' '
        i++; continue
      case 'sq':
        if (c === '\\') { i += 2; continue }
        if (c === "'" || c === '\n') s = 'code'
        i++; continue
      case 'dq':
        if (c === '\\') { i += 2; continue }
        if (c === '"' || c === '\n') s = 'code'
        i++; continue
      case 'tpl':
        if (c === '\\') { i += 2; continue }
        if (c === '`') s = 'code'
        i++; continue
    }
  }
  return out.join('')
}

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string): string => stripComments(read(p))

const MINI_XPAY = 'mini/src/lib/xpay.ts'
const MINI_PAYWALL = 'mini/src/pages/paywall/paywall.tsx'
const MINI_LEGAL = 'mini/src/content/legal.ts'
const MINI_ENABLED = 'mini/src/lib/xpayEnabled.ts'
const MINI_CONFIG = 'mini/config/index.ts'
const SERVER_XPAY = 'server/lib/xpay.mjs'
const SERVER_APP = 'server/lib/app.mjs'
const MIG_0046 = 'db/migrations/0046-wechat-xpay-settlement.sql'
const MIG_0030 = 'db/migrations/0030-full-selfhost-mirror.sql'
const SHARED_CONST = 'packages/shared/src/constants/index.ts'

/* ── 1. 端点路径：前端 XPAY_BASE 与网关 W 必须逐字一致 ─────────────── */

describe('xpay 护栏 1 · 端点路径两端逐字一致', () => {
  it('mini 的 XPAY_BASE === 网关的 W（/.cloud/payment/wechat）', () => {
    const miniBase = code(MINI_XPAY).match(/XPAY_BASE\s*=\s*'([^']+)'/)?.[1] ?? ''
    const serverW = code(SERVER_APP).match(/const W = '([^']+)'/)?.[1] ?? ''
    expect(
      miniBase !== '' && miniBase === serverW,
      `前端 XPAY_BASE='${miniBase}' 与网关 W='${serverW}' 不一致 —— ` +
        '查单/取参会 404，支付成功但权益永远不到账',
    ).toBe(true)
  })

  it('网关注册了全部 4 条路由（params/query/notify-GET/notify-POST）', () => {
    const c = code(SERVER_APP)
    expect(
      c.includes('`${W}/params`') && c.includes('`${W}/query`') &&
        /router\.on\('GET', `\$\{W\}\/notify`/.test(c) &&
        /router\.on\('POST', `\$\{W\}\/notify`/.test(c),
      '缺任一支付路由 → 对应链路（取签名/查单/推送握手/发货推送）静默断掉',
    ).toBe(true)
  })

  it('🔴 notify POST 不得走 wrap()（wrap 会先消费请求流 → 推送验签读到空 body 必失败）', () => {
    const c = code(SERVER_APP)
    expect(
      !c.includes('wrap(xpay.notify)') && c.includes('=> xpay.notify(req, res, ctx))'),
      'notify 被塞进 wrap() → readJson 把流吃掉，微信发货推送全部验签失败 = 权益不发放',
    ).toBe(true)
  })
})

/* ── 2. provider 取值：前端下单与 0046 核销分支必须同值 ────────────── */

describe('xpay 护栏 2 · provider = wechat_xpay 前后端同值', () => {
  it('mini 下单用 wechat_xpay，且 0046 verify_payment_order 按同值走查单语义分支', () => {
    expect(
      code(MINI_XPAY).includes("createPaymentOrder(realProductId, 'wechat_xpay')") &&
        code(MIG_0046).includes("v_order.provider = 'wechat_xpay'"),
      "任一处写成 'wechat' → 0046 落入未实现的 V3 验签分支（恒 false）→ " +
        '用户已扣款但 verify 永远失败，前端只能一直 settling',
    ).toBe(true)
  })
})

/* ── 3. 资金结算闸门：查单兜底补发权益后必须调 notify_provide_goods ── */

describe('xpay 护栏 3 · notify_provide_goods 资金结算闸门', () => {
  it('query 路径在 paid/settled（st=2/3）且非 Apple 单时调用 notify_provide_goods', () => {
    const c = code(SERVER_XPAY)
    expect(
      c.includes("callXpayApi('/xpay/notify_provide_goods'") &&
        /const isApple = Number\(o\.order_type\) === 7/.test(c) &&
        /\(st === 2 \|\| st === 3\) && !isApple/.test(c),
      '推送丢失时查单兜底只发了本地权益、没通知平台「已发货」→ 订单停在' +
        '「已支付待发货」→ 资金不结算（用户拿到会员、我方收不到钱，资损级）',
    ).toBe(true)
  })

  it('闸门调用失败只留痕不抛出（权益已落库，不能把成功支付报成失败）', () => {
    const c = code(SERVER_XPAY)
    expect(
      /catch \(err\) \{[\s\S]{0,200}notify_provide_goods 异常/.test(c),
      'notify_provide_goods 异常若向上抛 → query 接口 500 → 前端把「已到账」误报成失败',
    ).toBe(true)
  })
})

/* ── 4. signData 原样透传（官方明文：parse+stringify → -15005/-15006）── */

describe('xpay 护栏 4 · signData 原样透传', () => {
  it('requestVirtualPayment 生效代码里 signData 直取 params.signData，且全文件无 parse 痕迹', () => {
    const c = code(MINI_XPAY)
    expect(
      c.includes('signData: params.signData') &&
        !c.includes('JSON.parse(params.signData)'),
      'signData 被 parse+stringify → 字段顺序/空格变化 → 双签名逐字节失配 → ' +
        '-15005/-15006，收银台拉不起来（官方文档明文要求 string 原样传递）',
    ).toBe(true)
  })

  it('服务端签名公式锚点：paySig = hmac(appKey, uri&signData)，接口 pay_sig = hmac(appKey, uri&body)', () => {
    const c = code(SERVER_XPAY)
    expect(
      /export function calcPaySig\(appKey, signData, uri = 'requestVirtualPayment'\)/.test(c) &&
        c.includes('hmacSha256Hex(appKey, `${uri}&${signData}`)'),
      '签名公式被改动（uri 带 query / 连接符不是 & / 默认 uri 变了）→ 全量 -15005/-15006',
    ).toBe(true)
  })
})

/* ── 5. settling 语义：已扣款未到账绝不报 error ─────────────────────── */

describe('xpay 护栏 5 · 推模式 settling 语义（对齐主端 CheckoutResult）', () => {
  it('buyProduct 先落盘 pending 再轮询（顺序反了 → iOS 杀进程后订单号丢失）', () => {
    const c = code(MINI_XPAY)
    const fn = c.match(/export async function buyProduct[\s\S]*?\n\}/)?.[0] ?? ''
    const save = fn.indexOf('await savePending(')
    const poll = fn.indexOf('await pollUntilSettled(')
    expect(
      save >= 0 && poll >= 0 && save < poll,
      '先轮询后落盘 → 轮询期间小程序被杀（iOS 支付回来常被回收）→ ' +
        '本地无订单号，重启无法自愈，只能人工客服',
    ).toBe(true)
  })

  it('轮询窗口用尽 → settling（含「正在到账」），生效代码不得把该分支写成 error', () => {
    const c = code(MINI_XPAY)
    expect(
      /status: 'settling',\s*\n\s*message: '支付已完成，会员权益正在到账/.test(c),
      'settling 分支被改成 error → 用户已扣款却看到「支付失败」→ 重复购买 + 投诉 + 退款',
    ).toBe(true)
  })

  it('轮询节奏 = 1.5s × 4（P1-D §二-A 口径，与主端 checkout 一致）', () => {
    const c = code(MINI_XPAY)
    expect(
      /POLL_INTERVAL_MS = 1500/.test(c) && /POLL_ATTEMPTS = 4/.test(c),
      '轮询节奏漂移 → 到账确认窗口与主端不一致，settling 概率与文案（约 1 分钟）失配',
    ).toBe(true)
  })
})

/* ── 6. 措辞纪律：道具直购 ≠ 自动续费订阅（写错 = 虚假宣传）─────────── */

describe('xpay 护栏 6 · 措辞纪律（预付费时长，不得出现订阅式披露）', () => {
  it('paywall 生效文案零处「取消订阅 / 连续包月 / 到期前 24 小时」（注释里的纪律说明不算）', () => {
    const c = code(MINI_PAYWALL)
    expect(
      !/取消订阅|连续包月|到期前 ?24 ?小时/.test(c),
      '出现 StoreKit 订阅式披露 → 道具直购本无自动扣款，写上即虚假宣传' +
        '（用户以为不取消会一直被扣钱）→ 微信审核驳回 + 消费者投诉双重风险',
    ).toBe(true)
  })

  it('paywall 与 legal 生效文案都必须明写「不自动续费」（正面披露义务）', () => {
    expect(
      code(MINI_PAYWALL).includes('不自动续费') && code(MINI_LEGAL).includes('不自动续费'),
      '只写「一次性购买」不够 —— 「不自动续费、不自动扣款」是用户最关心的承诺，必须明示',
    ).toBe(true)
  })

  it('legal 生效文案零处订阅式披露（与 paywall 同口径）', () => {
    expect(
      !/取消订阅|连续包月|到期前 ?24 ?小时/.test(code(MINI_LEGAL)),
      'legal.ts 出现自动续订披露 → 与付费墙「一次性购买」展示矛盾，审核核「展示与协议一致」必挂',
    ).toBe(true)
  })

  it('兑换码保持「免费获得」属性（P1-E 合规红线：付费买码 = 小米/华为下架级风险）', () => {
    expect(
      code(MINI_PAYWALL).includes('免费获得'),
      '兑换码文案丢失「免费获得」→ 若演变成「付费买码/加客服开通」，' +
        '触发小米「引导异常交易」与华为「切支付」条款，属下架级风险',
    ).toBe(true)
  })
})

/* ── 7. 构建期开关：校验、注入与同源 ────────────────────────────────── */

describe('xpay 护栏 7 · D_BEE_XPAY_ENABLED 构建期开关', () => {
  it('config 对非法开关值构建期 throw（防「=1/=yes」被静默当成关或开）', () => {
    const c = code(MINI_CONFIG)
    expect(
      /D_BEE_XPAY_ENABLED 只接受 'true' \/ 'false'/.test(c) && c.includes('throw new Error'),
      '开关值不校验 → `D_BEE_XPAY_ENABLED=1` 这类常见写法被静默忽略，' +
        '构建者以为开了其实没开（与 backend.ts 的 READY 门同病）',
    ).toBe(true)
  })

  it('defineConstants 注入归一化后的字面量（运行时读到的是 true/false 字符串）', () => {
    expect(
      /'process\.env\.D_BEE_XPAY_ENABLED': JSON\.stringify\(xpayNorm\)/.test(code(MINI_CONFIG)),
      '注入缺失或注入原始值 → isXpaySaleEnabled 在小程序运行时读到 undefined，开关永远关',
    ).toBe(true)
  })

  it('xpayEnabled.ts 顶层导出构建期常量（付费墙与 legal 共用同一判定）', () => {
    expect(
      /export const XPAY_SALE_ENABLED: boolean = isXpaySaleEnabled\(\)/.test(code(MINI_ENABLED)),
      '两处各自调 isXpaySaleEnabled 或改成运行时判定 → 法务文本随网络结果漂移，' +
        '用户已同意的协议不再是构建时确定的字符串',
    ).toBe(true)
  })
})

/* ── 8. 三档商品：productId 与价格四端同源 ──────────────────────────── */

/** 三档权威定价（分）与其在迁移里的出处：0030 种子写 monthly/yearly；0038 把 lifetime 32800→29800。 */
const PRICE_CENTS: Array<{ key: string; cents: number; mig: string }> = [
  { key: 'PRICE_PRO_MONTHLY', cents: 1800, mig: MIG_0030 },
  { key: 'PRICE_PRO_YEARLY', cents: 12800, mig: MIG_0030 },
  { key: 'PRICE_LIFETIME', cents: 29800, mig: 'db/migrations/0038-lifetime-price-298.sql' },
]

const sharedPriceYuan = (key: string): number =>
  Number(code(SHARED_CONST).match(new RegExp(`export const ${key} = ([\\d.]+)`))?.[1] ?? NaN)

describe('xpay 护栏 8 · 三档 productId/价格与迁移种子一致', () => {
  it.each(['proMonthly', 'proYearly', 'lifetime'])(
    'PRODUCT_IDS.%s 的值必须出现在 0030 payment_products 种子里',
    (k) => {
      const id = code(SHARED_CONST).match(new RegExp(`${k}: '([^']+)'`))?.[1] ?? ''
      expect(
        id !== '' && read(MIG_0030).includes(`"product_id":"${id}"`),
        `PRODUCT_IDS.${k}='${id}' 与库内种子不一致 → 下单查价失败或买错档位` +
          '（平台道具 productId 也须与此逐字一致，否则 -15010）',
      ).toBe(true)
    },
  )

  it.each(PRICE_CENTS)('shared $key（元）× 100 === $cents（分）', ({ key, cents }) => {
    expect(
      Math.round(sharedPriceYuan(key) * 100),
      `${key} 展示价换算后 ≠ ${cents} 分 —— 展示价与实际扣款不符 = 价格欺诈` +
        '（微信侧也会 -15013 拦截：道具价格须与 payment_products 一致）',
    ).toBe(cents)
  })

  it.each(PRICE_CENTS)('$cents 分必须真实出现在 $mig（防「shared 对、库里是旧价」）', ({ cents, mig }) => {
    expect(
      read(mig).includes(String(cents)),
      `${mig} 里找不到 ${cents} —— 库内定价可能停在旧值（如 lifetime 仍是 32800）`,
    ).toBe(true)
  })
})
