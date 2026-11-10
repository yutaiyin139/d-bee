/**
 * 护栏 20 · Android APP 支付（微信 V3 / 支付宝 RSA2）跨端一致性与资损防线
 * （2026-11-09 新增，0047 / apppay.mjs / apppayClient.ts 同批）。
 *
 * ## 防的是什么
 *
 * 用户定案：**Android 必须能收款；Web 暂不收费只做引导；四端业务逻辑不变**。
 * 这条链路上任何一个环节被「顺手优化」，后果都不是样式问题：
 *
 *   · 客户端自己算价 / 自建订单号 → 金额可被篡改，或产生孤儿单（钱收了没订单）；
 *   · Web 分支也渲染支付按钮 → Web 无 ICP 经营许可证，出现收款入口即合规事故；
 *   · Web 引导与 Android 按钮不同源 → 引导到买不到东西的端（《广告法》第 4 条）；
 *   · 回调少了金额校验 → 1 分钱买走终身会员；
 *   · 回调验签被放宽 → 任何人可伪造「支付成功」白拿会员；
 *   · 查单失败报 error → 用户已扣款却看到「支付失败」，客服资损 + 投诉；
 *   · 支付宝 8000（处理中）当失败 → 同上；
 *   · 网关半配凭据仍放行 → 下单成功但回调永远验签不过，钱收了权益发不出。
 *
 * 这些红线分散在 6 个文件（vite.config / PaywallSheet / MiniOrderGuide / checkout /
 * api.ts / apppay.mjs / 0047），人工 review 极易漏。故落成机器断言。
 *
 * 🔴 与 four-end-consistency / web-no-payment 同款约束：剥离注释后再扫描
 *   （注释里的历史说明不算违规），一个 it() 一条断言，匹配「实际使用」而非
 *   「标识符出现」，断言写在 stripComments() 之后的代码上。
 *
 * 运行：npx vitest run tools/apppay-consistency.test.ts
 * 🔴 本护栏已按项目铁律做红验证（见当日日志「护栏 20 红验证」）。
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

const VITE = load('vite.config.ts')
const PAYWALL = load('src/pages/PaywallSheet.tsx')
const GUIDE = load('src/components/MiniOrderGuide.tsx')
const GUIDE_LIB = load('src/lib/miniOrderGuide.ts')
const CHECKOUT = load('src/lib/payment/checkout.ts')
const TYPES = load('src/lib/payment/types.ts')
const WECHAT_PAY = load('src/lib/payment/wechatPay.ts')
const ALIPAY = load('src/lib/payment/alipay.ts')
const APPPAY_CLIENT = load('src/lib/payment/apppayClient.ts')
const API = load('src/lib/api.ts')
const APP_MJS = load('server/lib/app.mjs')
const APPPAY_MJS = load('server/lib/apppay.mjs')
const CONFIG_MJS = load('server/lib/config.mjs')
const MIG_0047 = load('db/migrations/0047-app-payment-settlement.sql')
const MIG_0021 = load('db/migrations/0021-payment-orders.sql')

// ---------------------------------------------------------------------------
// 护栏 20-A · 四端业务逻辑不变：checkout 主流程零改动，适配器只补渠道缺口
// ---------------------------------------------------------------------------
describe('护栏 20-A · 收款流程仍是 checkout 那一条（下单→支付→核销），四端共用', () => {
  it('checkout 仍按「createPaymentOrder → purchase → settlePurchase」顺序编排', () => {
    const src = CHECKOUT.code
    const atCreate = src.indexOf('await createPaymentOrder(')
    const atPurchase = src.indexOf('await adapter.purchase(')
    const atSettle = src.indexOf('await settlePurchase(')
    expect(atCreate >= 0 && atPurchase > atCreate && atSettle > atPurchase).toBe(true)
  })

  it('下单时把 order_no 传给适配器（第三方收银台必须复用同一笔单号）', () => {
    expect(/adapter\.purchase\(productId, order\.order_no\)/.test(CHECKOUT.code)).toBe(true)
  })

  it('适配器接口的 purchase 第二参是可选 orderNo（iOS IAP 忽略，不分叉类型）', () => {
    expect(/purchase\(productId: ProductId, orderNo\?: string\)/.test(TYPES.code)).toBe(true)
  })

  it('核销仍走 verifyPaymentOrder（客户端不自建「支付成功」判定）', () => {
    expect(/await verifyPaymentOrder\(orderNo, purchase\.providerTxnId, purchase\.receipt\)/.test(CHECKOUT.code)).toBe(true)
  })

  it('微信适配器的预下单调用网关客户端（不自己拼签名、不自己算价）', () => {
    expect(/await requestAppPrepay\(\{/.test(WECHAT_PAY.code)).toBe(true)
  })

  it('支付宝适配器的预下单同样只调网关客户端', () => {
    expect(/await requestAppPrepay\(\{/.test(ALIPAY.code)).toBe(true)
  })

  it('两个适配器都强制要求 orderNo 存在（缺单号即抛错，绝不生成孤儿单）', () => {
    expect(
      /if \(!orderNo\) throw new Error/.test(WECHAT_PAY.code) && /if \(!orderNo\) throw new Error/.test(ALIPAY.code),
    ).toBe(true)
  })

  it('两个适配器都校验网关返回的 provider 与请求渠道一致', () => {
    expect(
      /prepay\.provider !== 'wechat'/.test(WECHAT_PAY.code) && /prepay\.provider !== 'alipay'/.test(ALIPAY.code),
    ).toBe(true)
  })

  it('apppayClient 不含任何价格 / 档位 / 权益规则（业务逻辑仍只在 checkout + 服务端）', () => {
    expect(/PRICE_|PRODUCT_IDS|amount_cents|pro_until|entitlement/i.test(APPPAY_CLIENT.code)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-B · 构建期开关同源：Android 支付按钮 ↔ Web「去 App 购买」引导
// ---------------------------------------------------------------------------
describe('护栏 20-B · D_BEE_APPPAY_ENABLED 一个变量同决定 Android 按钮与 Web 引导', () => {
  it('vite.config.ts 从 D_BEE_APPPAY_ENABLED 解析开关', () => {
    expect(/process\.env\.D_BEE_APPPAY_ENABLED/.test(VITE.code)).toBe(true)
  })

  it('非法取值构建期 throw（防「以为开了其实没开」）', () => {
    expect(/function resolveApppaySaleFlag[\s\S]*?throw new Error/.test(VITE.code)).toBe(true)
  })

  it('注入的是**布尔字面量** __APPPAY_SALE_ENABLED__（可被 terser 死代码折叠）', () => {
    expect(/__APPPAY_SALE_ENABLED__: resolveApppaySaleFlag\(\) === 'true' \? 'true' : 'false'/.test(VITE.code)).toBe(true)
  })

  it('lib 侧 APPPAY_SALE_ENABLED 取自该构建期常量且 typeof 兜底为 false', () => {
    expect(
      /typeof __APPPAY_SALE_ENABLED__ !== 'undefined' && __APPPAY_SALE_ENABLED__ === true/.test(GUIDE_LIB.code),
    ).toBe(true)
  })

  it('canGuideToAppSale() 直接返回 APPPAY_SALE_ENABLED（引导与否 = 售卖与否）', () => {
    expect(/function canGuideToAppSale\(\)[\s\S]*?return APPPAY_SALE_ENABLED/.test(GUIDE_LIB.code)).toBe(true)
  })

  it('MiniOrderGuide 的 App 引导块包在 canGuideToAppSale() 门控内', () => {
    expect(/const guideApp = canGuideToAppSale\(\)/.test(GUIDE.code) && /\{guideApp &&/.test(GUIDE.code)).toBe(true)
  })

  it('Android 付费墙的渠道门用的是同一个 APPPAY_SALE_ENABLED（不是另起一个常量）', () => {
    expect(/setPayChannels\(APPPAY_SALE_ENABLED && isAndroid\(\)/.test(PAYWALL.code)).toBe(true)
  })

  it('付费墙不自定义该开关（只从唯一真源 import）', () => {
    expect(/from '\.\.\/lib\/miniOrderGuide'/.test(PAYWALL.code) && !/const APPPAY_SALE_ENABLED =/.test(PAYWALL.code)).toBe(true)
  })

  it('App 引导无凭证时退化为纯文字，绝不渲染点了没反应的死链接', () => {
    expect(/!APP_DOWNLOAD_QR && !APP_DOWNLOAD_LINK &&/.test(GUIDE.code)).toBe(true)
  })

  it('App 下载链接经 sanitizeMiniOrderLink 过滤（与小程序链接同一纯函数）', () => {
    expect(/export const APP_DOWNLOAD_LINK = sanitizeMiniOrderLink\(/.test(GUIDE_LIB.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-C · Web 暂不收费：支付按钮对 Web 恒关（11-09 用户定案）
// ---------------------------------------------------------------------------
describe('护栏 20-C · Web 端永不出现支付按钮（仅 Android）', () => {
  it('渠道门含 isAndroid() 判定（Web 即便带 VITE_WECHAT_APPID 也进不来）', () => {
    expect(/APPPAY_SALE_ENABLED && isAndroid\(\)/.test(PAYWALL.code)).toBe(true)
  })

  it('开关关或非 Android 时渠道显式置 false（不是留 undefined 靠默认）', () => {
    expect(/: \{ wechat: false, alipay: false \}\)/.test(PAYWALL.code)).toBe(true)
  })

  it('apppayClient 的网关查询只在 android 平台启用', () => {
    expect(/if \(platformName\(\) === 'android'\) \{[\s\S]*?verifyViaApppayGateway\(orderNo\)/.test(API.code)).toBe(true)
  })

  it('网关通道不可用（null）时回退 RPC，绝不谎报成功', () => {
    expect(/const gw = await verifyViaApppayGateway\(orderNo\)\s*\n\s*if \(gw !== null\) return gw/.test(API.code)).toBe(true)
  })

  it('「网页不收款」声明恒展示，与两个售卖开关无关', () => {
    expect(GUIDE.code.includes('{WEB_NO_CHARGE_TEXT}')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-D · 资损防线：金额校验 / 验签 / 幂等 / owner 权威
// ---------------------------------------------------------------------------
describe('护栏 20-D · 服务端资损防线（金额、验签、幂等、归属）', () => {
  it('微信回调有金额校验：回调金额 < 订单金额即拒发权益', () => {
    expect(/amountCents != null && amountCents < Number\(order\.amount_cents\)/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('金额校验在三条路径上都存在（微信回调 + 支付宝回调 + 主动查单）', () => {
    expect((APPPAY_MJS.code.match(/amountCents < Number\(order\.amount_cents\)|remote\.amountCents < Number\(order\.amount_cents\)/g) || []).length).toBe(3)
  })

  it('金额不足时记 amount_mismatch 留痕（供人工对账，不是静默吞掉）', () => {
    expect((APPPAY_MJS.code.match(/'amount_mismatch'/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('微信回调先验签再解析（验签失败直接 400，不进任何业务分支）', () => {
    // 🔴 只在 wechatNotify handler 体内定位：verifyWechatNotifySignature 作为导出
    //   纯函数在文件上部还有定义处，全文 indexOf 会先命中定义 → 顺序断言失真。
    const start = APPPAY_MJS.code.indexOf('async wechatNotify(')
    const src = start >= 0 ? APPPAY_MJS.code.slice(start) : ''
    const atVerify = src.indexOf('verifyWechatNotifySignature(')
    const atDecrypt = src.indexOf('decryptWechatNotifyResource(')
    const atSettle = src.indexOf('await settle({')
    expect(start >= 0 && atVerify >= 0 && atDecrypt > atVerify && atSettle > atDecrypt).toBe(true)
  })

  it('支付宝回调先验签、再校 app_id、再处理业务', () => {
    // 🔴 只在 alipayNotify 这个 handler 的函数体内定位：verifyAlipayNotifySignature
    //   作为**导出纯函数**在文件上部还有一次定义，全文 indexOf 会先命中定义处，
    //   导致顺序断言失真（护栏自身写错比没护栏更危险）。
    const start = APPPAY_MJS.code.indexOf('async alipayNotify(')
    const src = start >= 0 ? APPPAY_MJS.code.slice(start) : ''
    const atSign = src.indexOf('verifyAlipayNotifySignature(')
    const atAppId = src.indexOf('params.app_id !== cfg.alipayAppId')
    const atSettle = src.indexOf('await settle({')
    expect(start >= 0 && atSign >= 0 && atAppId > atSign && atSettle > atAppId).toBe(true)
  })

  it('rsaVerify 对任何异常一律返回 false（绝不因验签抛错而放行）', () => {
    expect(/export function rsaVerify[\s\S]*?catch \{\s*return false/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('回调解密失败一律 null（密钥错 / 报文篡改 / 非法 base64 同判）', () => {
    expect(/export function decryptWechatNotifyResource[\s\S]*?catch \{\s*return null/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('APIv3 密钥长度强校验 32 字节（AES-256-GCM 前提）', () => {
    expect(/if \(key\.length !== 32\) return null/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('下单金额与商品以 payment_orders 为唯一事实源（客户端只报 order_no）', () => {
    expect(/amount: \{ total: Number\(order\.amount_cents\)/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('支付宝金额由订单 amount_cents 换算（客户端传不进金额）', () => {
    expect(/total_amount: \(Number\(order\.amount_cents\) \/ 100\)\.toFixed\(2\)/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('owner 权威 = 订单 owner_id，回调路径传 null（支持代付，不信付款人）', () => {
    expect(/v_owner := v_order\.owner_id/.test(MIG_0047.code)).toBe(true)
  })

  it('回调路径 settle 的 ownerId 显式为 null（不得改用 payer openid）', () => {
    expect(/outTradeNo, ownerId: null, buyerId,/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('查单路径 settle 带 JWT sub（登录态可交叉校验归属）', () => {
    expect(/outTradeNo: orderNo, ownerId, buyerId: remote\.buyerId/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('prepay 拒绝已支付 / 已退款订单再下单（防重复扣款）', () => {
    expect(/order\.status === 'paid'/.test(APPPAY_MJS.code) && /order\.status === 'refunded'/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('prepay 校验订单 provider 与请求渠道一致（防跨渠道串单）', () => {
    expect(/'provider_mismatch'/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('订单归属不符返回 403（不得降级成 404 掩盖越权尝试）', () => {
    expect(/status: 403, message: '订单不属于当前用户'/.test(APPPAY_MJS.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-E · 「已扣款绝不报 error」——查单语义与支付宝 8000
// ---------------------------------------------------------------------------
describe('护栏 20-E · 已扣款未确认只说「到账中」，绝不报错', () => {
  it('支付宝 8000（处理中）与 9000 同路径处理，不 throw', () => {
    expect(/res\.resultStatus !== '9000' && res\.resultStatus !== '8000'/.test(ALIPAY.code)).toBe(true)
  })

  it('支付宝只对 6001（用户取消）抛「取消支付」', () => {
    expect(/if \(res\.resultStatus === '6001'\) \{\s*throw new Error\('取消支付'\)/.test(ALIPAY.code)).toBe(true)
  })

  it('查单外呼失败返回 200 + retry_later，不是 5xx / error', () => {
    expect(/status: 200, body: \{ settled: false, status: 'pending', retry_later: true \}/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('查单外呼失败只 warn 不 error（可自愈的抖动不该刷错误日志）', () => {
    expect(/logger\.warn\(`\[apppay\] \$\{provider\} 查单外呼失败/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('settle 失败返回 settling=true（不是 error），交后续重试补单', () => {
    expect(/settled: false, status: 'pending', settling: true, code: r\.code/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('客户端查单做有限重试（覆盖回调延迟窗口）', () => {
    expect(/const QUERY_ATTEMPTS = 4/.test(APPPAY_CLIENT.code) && /const QUERY_INTERVAL_MS = 1500/.test(APPPAY_CLIENT.code)).toBe(true)
  })

  it('客户端把 404/405/503 视为「通道不可用」返回 null（回退旧行为而非失败）', () => {
    expect(/if \(r\.status === 404 \|\| r\.status === 405 \|\| r\.status === 503\) return null/.test(APPPAY_CLIENT.code)).toBe(true)
  })

  it('客户端网络层异常也返回 null（不让支付因通道问题硬失败）', () => {
    // 🔴 断言写在 stripComments 之后的代码上：catch 块内的解释性注释已被抹成空格，
    //   故只匹配代码结构 `catch { return null }`，不引用注释文本（否则必然假红）。
    expect(/catch \{\s*return null\s*\}/.test(APPPAY_CLIENT.code)).toBe(true)
  })

  it('0047 把 verify_payment_order 对 wechat/alipay 改为查单语义（回调未到 → false）', () => {
    expect(/IF v_order\.provider IN \('wechat_xpay', 'wechat', 'alipay'\) THEN\s*RETURN false/.test(MIG_0047.code)).toBe(true)
  })

  it('verify_payment_order 骨架分支仍默认拒绝（未接验签的渠道不得白给会员）', () => {
    expect((MIG_0047.code.match(/RETURN false/g) || []).length).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-F · 路由装配与限流豁免（回调必须可达且不被 429）
// ---------------------------------------------------------------------------
describe('护栏 20-F · 网关路由装配正确（notify 不走 wrap、限流豁免）', () => {
  it('app.mjs 导入并装配 createAppPayHandlers', () => {
    expect(/import \{ createAppPayHandlers \} from '\.\/apppay\.mjs'/.test(APP_MJS.code) && /createAppPayHandlers\(\{/.test(APP_MJS.code)).toBe(true)
  })

  it('prepay 与 query 走 wrap()（需 Bearer，JSON 出入）', () => {
    expect(/router\.on\('POST', `\$\{P\}\/prepay`, wrap\(apppay\.prepay\)\)/.test(APP_MJS.code)).toBe(true)
  })

  it('query 同样走 wrap()', () => {
    expect(/router\.on\('POST', `\$\{P\}\/query`, wrap\(apppay\.query\)\)/.test(APP_MJS.code)).toBe(true)
  })

  it('微信回调**不走 wrap()**（wrap 的 readJson 会吃掉验签所需原始字节）', () => {
    expect(/router\.on\('POST', '\/\.cloud\/payment\/wechat-app\/notify', \(req, res\) => apppay\.wechatNotify\(req, res\)\)/.test(APP_MJS.code)).toBe(true)
  })

  it('支付宝回调同样不走 wrap()', () => {
    expect(/router\.on\('POST', '\/\.cloud\/payment\/alipay\/notify', \(req, res\) => apppay\.alipayNotify\(req, res\)\)/.test(APP_MJS.code)).toBe(true)
  })

  it('路由前缀与 apppay.mjs 内 notify_url 拼接的路径逐字一致', () => {
    const inApp = /'\/\.cloud\/payment\/wechat-app\/notify'/.test(APP_MJS.code)
    const inModule = /\/\.cloud\/payment\/wechat-app\/notify/.test(APPPAY_MJS.code)
    expect(inApp && inModule).toBe(true)
  })

  it('支付宝 notify_url 路径两端也逐字一致', () => {
    expect(/'\/\.cloud\/payment\/alipay\/notify'/.test(APP_MJS.code) && /\/\.cloud\/payment\/alipay\/notify/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('两个 notify 路径都在限流豁免名单里（平台重试不得被 429 放大）', () => {
    expect(/pathname === '\/\.cloud\/payment\/wechat-app\/notify' \|\|\s*pathname === '\/\.cloud\/payment\/alipay\/notify'/.test(APP_MJS.code)).toBe(true)
  })

  it('apppay 实例挂在 createApp 返回值上（自测可注入、可断言）', () => {
    expect(/server, router, otp, auth, llm, dbProxy, iap, xpay, apppay,/.test(APP_MJS.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-G · 数据库侧：幂等键、渠道约束、最小权限
// ---------------------------------------------------------------------------
describe('护栏 20-G · 0047 迁移的幂等键 / 渠道约束 / 权限收敛', () => {
  it('out_trade_no NOT NULL UNIQUE（幂等键 = 我方业务单号，不是平台交易号）', () => {
    expect(/out_trade_no\s+text\s+NOT NULL UNIQUE/.test(MIG_0047.code)).toBe(true)
  })

  it('provider CHECK 只放行 wechat / alipay（与 xpay 的 wechat_xpay 分表分渠道）', () => {
    expect(/CHECK \(provider IN \('wechat', 'alipay'\)\)/.test(MIG_0047.code)).toBe(true)
  })

  it('交易表与留痕表对 PUBLIC/anon/authenticated/dbee_app 先 REVOKE', () => {
    expect(/REVOKE ALL ON public\.app_payment_transactions\s+FROM PUBLIC, anon, authenticated, dbee_app/.test(MIG_0047.code)).toBe(true)
  })

  it('settle_app_payment 是 SECURITY DEFINER（只有属主角色能写权益）', () => {
    expect(/FUNCTION public\.settle_app_payment\([\s\S]*?SECURITY DEFINER/.test(MIG_0047.code)).toBe(true)
  })

  it('三个函数先 REVOKE 再 GRANT 给 dbee_app（0033 实测的 GRANT 追加语义坑）', () => {
    expect(/REVOKE ALL ON FUNCTION public\.settle_app_payment[\s\S]*?GRANT EXECUTE ON FUNCTION public\.settle_app_payment[\s\S]*?TO dbee_app/.test(MIG_0047.code)).toBe(true)
  })

  it('revoke / log 函数同样只授 dbee_app', () => {
    expect(
      /GRANT EXECUTE ON FUNCTION public\.revoke_app_payment\(text,text,text\) TO dbee_app/.test(MIG_0047.code) &&
        /GRANT EXECUTE ON FUNCTION public\.log_app_notification\(jsonb,text,text,text,text,boolean,text\) TO dbee_app/.test(MIG_0047.code),
    ).toBe(true)
  })

  it('写入 schema_migrations（水位可查，未应用时不得开构建开关）', () => {
    expect(/INSERT INTO public\.schema_migrations/.test(MIG_0047.code)).toBe(true)
  })

  it('权益模型逐字复用 0046：months 累加 + lifetime 不降级', () => {
    expect(/make_interval\(months => v_months\)/.test(MIG_0047.code) && /WHEN entitlements\.plan = 'lifetime' THEN NULL/.test(MIG_0047.code)).toBe(true)
  })

  it('撤销只清同渠道 source 的权益（不误伤兑换码 / 蜜糖兑换所得）', () => {
    expect(/WHERE owner_id = v_owner AND source = v_txn\.provider/.test(MIG_0047.code)).toBe(true)
  })

  it('payment_orders 无 provider CHECK 约束（0021 起即允许 wechat/alipay，不需追加迁移）', () => {
    expect(/provider\s+text\s+NOT NULL,/.test(MIG_0021.code) && !/CHECK \(provider/.test(MIG_0021.code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 护栏 20-H · 凭据边界：私钥 / APIv3 密钥不下发、不进日志
// ---------------------------------------------------------------------------
describe('护栏 20-H · 商户凭据边界（只在服务端签名，绝不出网关）', () => {
  it('前端零私钥处理（apppayClient 不含 crypto / privateKey / sign 计算）', () => {
    expect(/node:crypto|privateKey|createSign|rsaSign/.test(APPPAY_CLIENT.code)).toBe(false)
  })

  it('微信适配器不含签名计算（拉起参数由服务端二次签名后下发）', () => {
    expect(/createSign|rsaSign|privateKey/.test(WECHAT_PAY.code)).toBe(false)
  })

  it('支付宝适配器不含签名计算（orderStr 由服务端签好）', () => {
    expect(/createSign|rsaSign|privateKey/.test(ALIPAY.code)).toBe(false)
  })

  it('prepay 响应只回平台拉起参数（不含私钥 / APIv3 / 平台证书字段）', () => {
    expect(/return \{ status: 200, body: \{ order_no: order\.order_no, provider, prepay \} \}/.test(APPPAY_MJS.code)).toBe(true)
  })

  it('config 对微信半配（5 项缺一）启动即拦，不留到运行时 503', () => {
    expect(/wechatPaySet\.length > 0 && wechatPaySet\.length < wechatPayKeys\.length/.test(CONFIG_MJS.code)).toBe(true)
  })

  it('config 对支付宝半配（3 项缺一）启动即拦', () => {
    expect(/alipaySet\.length > 0 && alipaySet\.length < alipayKeys\.length/.test(CONFIG_MJS.code)).toBe(true)
  })

  it('有商户号但缺平台证书 → 启动即拦（否则回调永远验签不过 = 资损）', () => {
    expect(/cfg\.wechatPayMchid && !cfg\.wechatPayPlatformCert/.test(CONFIG_MJS.code)).toBe(true)
  })

  it('APIv3 密钥非 32 字节 → 启动即拦', () => {
    expect(/Buffer\.byteLength\(cfg\.wechatPayApiV3Key, 'utf8'\) !== 32/.test(CONFIG_MJS.code)).toBe(true)
  })

  it('未配置时给出 warnings 提示（渠道级 503，不影响另一渠道）', () => {
    expect(/!cfg\.wechatPayMchid\) w\.push/.test(CONFIG_MJS.code) && /!cfg\.alipayAppId\) w\.push/.test(CONFIG_MJS.code)).toBe(true)
  })
})
