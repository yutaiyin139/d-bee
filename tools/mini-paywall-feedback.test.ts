/**
 * mini 付费墙「成功反馈必须可见 + 档位文案不得谎报」护栏（2026-11-11 新增）。
 *
 * 起因（用户实测反馈原话）：「我在 mini 端输入了兑换码，点击兑换，没有提示兑换成功；
 * 感觉怪怪的，实际上已经兑换成功了，建议有一个兑换成功的提示。」
 *
 * 复盘定位到两个**叠加**缺陷，都不是「忘了写提示」：
 *
 *   ① 提示存在但**物理上看不见**：成功提示条渲染在页面顶部，而用户的视线与手指都在
 *      底部的「兑换」按钮上；紧接着 1.4s 后 `Taro.navigateBack()` 连带销毁本页，
 *      顶部提示条根本没机会进入用户视野 → 主观体验就是「点了没反应」。
 *      修法：追加 `Taro.showToast`（**应用级**，navigateBack 后仍会把剩余时长显示完）。
 *
 *   ② 文案写死「终身会员已生效」= **谎报所购档位**：0044 迁移起兑换码已支持
 *      月/年/终身三档，月卡用户兑换成功却被告知「终身」，事后极易被当成欺诈投诉。
 *      比「没提示」更严重。修法：文案下沉 shared `redeemSuccessText(ent)`，
 *      按刷新到的**真实权益**生成，日期走 datefmt 的确定性格式。
 *
 * 🔴 为什么 toast 的 icon 必须是 'none' 而不是 'success'：
 *   wx.showToast 带 icon（success/error/loading）时 title **只展示前 7 个汉字**。
 *   'success' 会把「兑换成功，会员有效期至 2026/12/11 🐝」截断成「兑换成功，会员有」
 *   —— 正好砍掉用户最需要确认的到期日，退化成一句无信息量的口号。
 *
 * 🔴 断言纪律（护栏三铁律）：一个 it 一条断言；匹配「实际使用」而非「标识符出现」；
 *   生效代码断言一律在 stripComments() 之后做（paywall.tsx 里有大段纪律说明注释，
 *   注释中出现的「终身会员已生效」「icon success」等字样是解释而非违规，不得误报红）。
 *
 * 运行：npx vitest run tools/mini-paywall-feedback.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// 注释剥离（与 four-end-consistency / xpay-consistency 同款：注释 → 等长空格，行号保留）
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
          out[i] = ' '; out[i + 1] = ' '; s = 'code'; i += 2; continue
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
        // 模板串整体视为字符串，不递归解析 ${}。保守方向：宁可误报不漏报。
        if (c === '\\') { i += 2; continue }
        if (c === '`') s = 'code'
        i++; continue
    }
  }
  return out.join('')
}

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string): string => stripComments(read(p))

const MINI_PAYWALL = 'mini/src/pages/paywall/paywall.tsx'
const MAIN_PAYWALL = 'src/pages/PaywallSheet.tsx'
const SHARED_RULES = 'packages/shared/src/rules/index.ts'

/**
 * 取出指定函数的函数体（生效代码，已剥离注释）。
 *
 * 🔴 为什么必须按函数切片而不是全文扫描：paywall.tsx 同时有 submitCode（兑换）与
 *   handleBuy（购买）两条成功路径，全文扫描无法区分「兑换成功到底有没有弹 toast」
 *   —— 只要任一分支写了 showToast，全文正则就会假绿。这正是护栏铁律②
 *   「匹配实际使用，而非标识符出现」要防的事。
 */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`)
  if (start < 0) return ''
  let i = src.indexOf('{', start)
  if (i < 0) return ''
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

const pwCode = code(MINI_PAYWALL)
const submitCode = bodyOf(pwCode, 'submitCode')
const handleBuy = bodyOf(pwCode, 'handleBuy')
const mainCode = code(MAIN_PAYWALL)

/* ── 0. 切片自检：函数体真的取到了（否则下面所有断言都是对空串假绿）── */

describe('mini 付费墙成功反馈 · 切片自检（防假绿）', () => {
  it('submitCode 函数体确实被切出（非空且含 redeemByCode 调用）', () => {
    expect(submitCode.includes('redeemByCode('), 'submitCode 切片失败 → 后续断言全部假绿').toBe(true)
  })

  it('handleBuy 函数体确实被切出（非空且含 buyProduct 调用）', () => {
    expect(handleBuy.includes('buyProduct('), 'handleBuy 切片失败 → 后续断言全部假绿').toBe(true)
  })
})

/* ── 1. 成功反馈必须「看得见」：navigateBack 前弹应用级 toast ───────── */

describe('mini 付费墙成功反馈 · 缺陷①「提示看不见」不得复发', () => {
  it('兑换成功路径调用 Taro.showToast（页内提示条在顶部，1.4s 后即 navigateBack 销毁本页）', () => {
    expect(
      /Taro\.showToast\s*\(/.test(submitCode),
      '兑换成功只剩页面顶部的提示条 + 1.4s 后 navigateBack → 用户视线在底部按钮上，' +
        '提示条随页面销毁根本没机会被看见（= 用户反馈的「点了没反应，实际已成功」）',
    ).toBe(true)
  })

  it('购买成功路径同样调用 Taro.showToast（与兑换同一缺陷，不得只修一处）', () => {
    expect(
      /Taro\.showToast\s*\(/.test(handleBuy),
      'handleBuy 成功也只写页内提示 → 与 submitCode 同一「看不见」缺陷；' +
        '两处必须同修，否则开启售卖后购买用户会遇到一模一样的静默成功',
    ).toBe(true)
  })

  it('toast 的 icon 必须是 none（带 icon 时 title 只展示前 7 个汉字，会砍掉到期日）', () => {
    const toasts = submitCode.match(/Taro\.showToast\s*\(\s*\{[^}]*\}/g) ?? []
    expect(toasts.length, 'submitCode 内未找到 showToast 调用参数').toBeGreaterThan(0)
    for (const t of toasts) {
      // 🔴 断言在「实际调用参数」上：icon:'success' 会把「兑换成功，会员有效期至
      //   2026/12/11 🐝」截断成「兑换成功，会员有」—— 正好砍掉用户最需要的到期日。
      expect(t.includes("icon: 'none'"), `toast 用了会截断文案的 icon：${t}`).toBe(true)
    }
  })

  it('toast 文案与页内提示条同源（同一个 msg 变量，不得两处各写一份文案）', () => {
    // 两处文案副本必然漂移（与定价三副本、会员文案两副本是同一种病）。
    expect(
      /setOkMsg\(msg\)/.test(submitCode) && /showToast\(\{\s*title:\s*msg/.test(submitCode),
      'toast 与 okMsg 各写一份文案 → 改一处漏一处，用户会看到两种不同的确认信息',
    ).toBe(true)
  })
})

/* ── 2. 档位文案不得谎报：一律走 shared redeemSuccessText ───────────── */

describe('mini 付费墙成功反馈 · 缺陷②「谎报终身会员」不得复发', () => {
  it('兑换成功文案由 shared redeemSuccessText 生成（按真实权益，不写死档位）', () => {
    expect(
      /redeemSuccessText\s*\(/.test(submitCode),
      '文案未走 shared redeemSuccessText → 0044 起兑换码支持月/年/终身三档，' +
        '写死任一句都会在另一档上向用户谎报他实际买到了什么（欺诈投诉风险）',
    ).toBe(true)
  })

  it('paywall.tsx 生效代码里零处硬编码「终身会员已生效」（只能出现在 shared 的 lifetime 分支）', () => {
    expect(
      !pwCode.includes('终身会员已生效'),
      'mini 页面又出现写死的「终身会员已生效」→ 月卡/年卡用户兑换成功会被告知是终身会员；' +
        '该字面量的唯一合法出处是 shared redeemSuccessText 的 isLifetime 分支',
    ).toBe(true)
  })

  it('shared redeemSuccessText 按 lifetime / pro / 兜底三分支生成（缺任一分支即谎报或谎报失败）', () => {
    const src = code(SHARED_RULES)
    const start = src.indexOf('export function redeemSuccessText(')
    const end = src.indexOf('\n}', start)
    const fn = start >= 0 && end > start ? src.slice(start, end + 2) : ''
    expect(
      fn.includes('isLifetime(ent)') && fn.includes('isPro(ent)') &&
        fn.includes('proUntilText(') && fn.includes('会员权益已生效'),
      'redeemSuccessText 三分支不完整 → lifetime 分支缺失会漏报终身、pro 分支缺 proUntilText ' +
        '会丢到期日、兜底分支缺失则「权益刷新失败」时要么谎报档位要么把已核销的成功报成失败',
    ).toBe(true)
  })

  it('兑换成功后重新拉取真实权益（文案的数据来源，不得复用刷新前的旧 state）', () => {
    // 兑换前的 entitlement 必然是 free/null（否则付费墙不会给兑换入口），
    // 不重新拉取就只能靠猜档位 —— 这正是当初写死「终身」的根因。
    expect(
      /getEntitlement\(\)/.test(submitCode),
      'submitCode 未重新 getEntitlement → 拿不到兑换后的真实档位，只能写死一句文案（谎报根因）',
    ).toBe(true)
  })
})

/* ── 3. 主端不得留下同类写死文案（四端一致性）────────────────────── */

describe('mini 付费墙成功反馈 · 主端同源检查', () => {
  it('主端 PaywallSheet 生效代码里零处硬编码「终身会员已生效」', () => {
    expect(
      !mainCode.includes('终身会员已生效'),
      '主端也出现写死的「终身会员已生效」→ 主端兑换码同样支持三档（plan.tsx redeem → ' +
        'redeemByCode），写死即谎报；两端必须同口径，文案一律出自 shared',
    ).toBe(true)
  })

  it('主端成功提示条渲染在 Sheet 顶层（不得埋在 iOS 下隐藏的条件区块内）', () => {
    // 回归护栏：11-07 修过的真实缺陷 —— ok 曾只渲染在「兑换码」区块内，
    // 而该区块在 iOS 下为规避 Apple 3.1.1 被刻意隐藏 → iOS 上所有成功/失败提示全部静默。
    const okIdx = mainCode.indexOf('ok && <div className="ok-msg"')
    const redeemBlockIdx = mainCode.indexOf('{!isIOS() && (')
    expect(okIdx, '主端未找到顶层 ok 渲染点').toBeGreaterThan(-1)
    expect(
      redeemBlockIdx === -1 || okIdx < redeemBlockIdx,
      'ok 提示又被挪回 !isIOS() 条件区块内 → iOS 下该区块整体不渲染，' +
        '购买/恢复购买/兑换的成功与失败提示会全部静默（11-07 已修缺陷复发）',
    ).toBe(true)
  })
})
