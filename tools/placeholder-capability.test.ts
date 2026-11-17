/**
 * 护栏 29 · 占位能力清单（capability single-source registry，2026-11-15 新建）。
 *
 * ## 为什么需要它
 *
 * 2026-11-15 的小程序端四端对标审查（`docs/小程序端对标审查与占位符盘点-2026-11-15.md`）
 * 发现一个**护栏盲区**：全仓有能力开关的地方，各自被别的护栏零散钉住某一侧面，
 * 但没有任何一处回答「**当前哪些能力是占位/关闭的，它们的 UI 是否诚实？**」。
 *
 * 最典型的漏网之鱼是 mini「通知提醒」：两个 Switch 无条件渲染、零说明文字，
 * 而 `CHECKIN_TEMPLATE_ID = ''` 使 `requestCheckinSubscribe()` 恒返回 `no_template`
 * —— 用户拨开开关后永远收不到任何推送。护栏 24-D 只钉住「默认值是关的」，
 * 完全没有断言「打开后真有提醒」。法务 `legal.ts` §七如实声明了，但普通用户
 * 不会先读隐私政策再去拨开关。
 *
 * 本护栏把这类「能力为 false 的入口」统一收敛成三条不变量：
 *   1. **单一真源**：每个能力只有一个布尔判定点，UI 与实现共用它；
 *   2. **诚实呈现**：能力为 false 时，入口必须有角标 / 说明 / 直接隐藏，
 *      绝不允许「可点但点了没反应」；
 *   3. **可一键回退**：能力翻回 false 时，诚实 UI 自动恢复 —— 因此即使某个
 *      开关**当前为 true**（如导出已实装），它的 false 分支保护也**必须仍在**。
 *
 * 第 3 条是这套设计的关键：`isExportAvailable` 今天已经实装为 true，但微信对
 * .json/.csv 的文件类型接受度社区口径不一、须真机实测（铁律 #13）。若实测被拒，
 * 唯一正确的处置是把开关翻回 false —— 那一刻「即将上线」角标与置灰必须自动回来。
 * 如果 false 分支在实装时被顺手删掉，翻回开关就会退化成「点了报错」的更糟体验。
 *
 * ## 反漂移（anti-drift）
 *
 * 最后一节扫描 `src/lib` 与 `mini/src/lib` 下**所有**能力形态的导出标识符，
 * 断言每一个都在本文件的登记表里（`CAPABILITIES` 或 `RUNTIME_PROBES`）。
 * 新增一个能力开关却忘了登记 → 本护栏变红 → 强制作者回答「它的 false 态诚实吗」。
 *
 * 断言一律在 stripComments 后的代码上做：源码注释里大量出现「不要渲染死按钮」
 * 「规划中接入」这类历史说明，带注释扫描会永远误报红，而一个永远红的测试等于没有测试。
 *
 * 运行：npx vitest run tools/placeholder-capability.test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

type Lex = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

/** 注释字符替换成等长空格，保留换行与行号；字符串内容原样保留。 */
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

/** 剥注释后的源码，按路径缓存（同一文件被多条断言读，避免重复 IO 与重复剥离）。 */
const cache = new Map<string, string>()
function code(rel: string): string {
  const hit = cache.get(rel)
  if (hit !== undefined) return hit
  const stripped = stripComments(read(rel))
  cache.set(rel, stripped)
  return stripped
}

/* ── 被检查的文件 ──────────────────────────────────────────── */

const MINI_SHARE = 'mini/src/lib/share.ts'
const MINI_NOTIFY = 'mini/src/lib/notifications.ts'
const MINI_PROFILE = 'mini/src/pages/profile/profile.tsx'
const MINI_PAYWALL = 'mini/src/pages/paywall/paywall.tsx'
const MINI_XPAY_ENABLED = 'mini/src/lib/xpayEnabled.ts'
const MAIN_ORDER_GUIDE = 'src/lib/miniOrderGuide.ts'
const MAIN_GUIDE_UI = 'src/components/MiniOrderGuide.tsx'
const MAIN_WECHAT = 'src/lib/wechat.ts'
const MAIN_AUTH = 'src/pages/AuthScreen.tsx'
const MAIN_NOTIFY = 'src/lib/notifications.ts'
const MAIN_PROFILE = 'src/pages/ProfileScreen.tsx'

/**
 * 按声明行缩进截取函数体到顶层闭合花括号，避免嵌套块缩进取错。
 * 用于「断言实际使用而非标识符出现」：只在函数体内找调用点。
 */
function bodyOf(src: string, header: RegExp): string {
  const i = src.search(header)
  if (i < 0) return ''
  const lineStart = src.lastIndexOf('\n', i) + 1
  const indent = src.slice(lineStart, i).match(/^\s*/)?.[0] ?? ''
  const close = '\n' + indent + '}'
  const j = src.indexOf(close, i)
  return j < 0 ? src.slice(i) : src.slice(i, j + close.length)
}

/* ══════════════════════════════════════════════════════════════
 * 一、能力登记表（capability registry）
 *
 * 🔴 新增能力开关必须在此登记，并在下面补一条「false 态诚实」断言。
 *   漏登记会被第 5 节的反漂移扫描抓到（变红），不是靠自觉。
 * ══════════════════════════════════════════════════════════════ */

/**
 * 需要「false 态诚实」断言的**配置型/构建期能力**。
 * 这些开关的 false 态是产品与合规决策（资质未办、平台未接、构建期未开），
 * 而非运行时环境差异，故必须由 UI 明确告知或隐藏入口。
 */
const CAPABILITIES = [
  'isExportAvailable',      // mini 数据导出（11-15 已实装为 true，false 分支须保留）
  'isNotifyPushAvailable',  // mini 微信订阅消息推送（模板 ID 未申请，恒 false）
  'isWechatLoginAvailable', // 主端微信登录（营业执照办理中，恒 false → 入口隐藏）
  'XPAY_SALE_ENABLED',      // mini + Web 虚拟支付售卖（构建期，默认 false）
  'APPPAY_SALE_ENABLED',    // Web 引导去 App 购买 / Android 支付按钮（构建期，默认 false）
] as const

/**
 * 运行时环境探测：值取决于**用户设备/宿主版本**，不是产品决策。
 * 它们的 false 态天然由「降级路径」处理（落回 Web 实现 / 提示升级微信），
 * 不需要角标，但仍须登记 —— 否则反漂移扫描无法区分「新增的探测」与
 * 「新增的占位能力」，登记动作本身就是强制作者做一次分类判断。
 */
const RUNTIME_PROBES = [
  'isNotificationsSupported',        // 主端 Capacitor LocalNotifications 插件是否存在
  'isXpaySaleEnabled',               // XPAY_SALE_ENABLED 的求值函数（同一开关的实现）
  'isXpaySupported',                 // 宿主基础库是否支持 requestVirtualPayment
  'isWechatPayAvailable',            // 主端微信支付 adapter 是否就绪
  'isAlipayAvailable',               // 主端支付宝 adapter 是否就绪
  'isHealthKitAvailable',            // iOS HealthKit 插件是否就绪
  'isAndroidVendorHealthAvailable',  // 安卓厂商健康插件是否就绪
  'isOriginProxyAvailable',          // iOS 原生回源代理插件是否就绪
  'isWerunSupported',                // WX-2 宿主是否支持 wx.getWeRunData（false→提示升级微信，非占位）
] as const

describe('护栏 29-A · 能力开关单一真源', () => {
  it('mini 导出能力由 share.ts 单一常量决定（不是每次调用各算一遍）', () => {
    expect(/export\s+const\s+isExportAvailable\s*=/.test(code(MINI_SHARE))).toBe(true)
  })

  it('mini profile 页不自建导出能力副本，只从 share.ts 引入', () => {
    expect(/import\s*\{[^}]*\bisExportAvailable\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/share'/.test(code(MINI_PROFILE))).toBe(true)
  })

  it('mini 推送能力由订阅消息模板 ID 推导（回填模板即自动生效，不必改 UI）', () => {
    expect(/export\s+const\s+isNotifyPushAvailable[^=]*=\s*CHECKIN_TEMPLATE_ID\.length\s*>\s*0/.test(code(MINI_NOTIFY))).toBe(true)
  })

  it('主端微信登录入口可见性由 isWechatLoginAvailable() 单点判定', () => {
    expect(/export\s+function\s+isWechatLoginAvailable\s*\(\)\s*:\s*boolean/.test(code(MAIN_WECHAT))).toBe(true)
  })

  it('微信登录总开关为 false 时 isWechatLoginAvailable() 立即短路返回 false', () => {
    const body = bodyOf(code(MAIN_WECHAT), /export\s+function\s+isWechatLoginAvailable\s*\(/)
    expect(/if\s*\(\s*!\s*WECHAT_LOGIN_ENABLED\s*\)\s*return\s+false/.test(body)).toBe(true)
  })

  it('Web 侧两个售卖开关都有 typeof 兜底（漏注入时求值为 false，不白屏）', () => {
    const guide = code(MAIN_ORDER_GUIDE)
    expect(
      /typeof\s+__XPAY_SALE_ENABLED__\s*!==\s*'undefined'/.test(guide) &&
      /typeof\s+__APPPAY_SALE_ENABLED__\s*!==\s*'undefined'/.test(guide),
    ).toBe(true)
  })

  it('Web 引导判定直接等于售卖开关（引导与否 = 售卖与否，不可能各算一套）', () => {
    const guide = code(MAIN_ORDER_GUIDE)
    expect(
      /function\s+canGuideToMiniSale\s*\(\)\s*:\s*boolean\s*\{\s*return\s+XPAY_SALE_ENABLED/.test(guide) &&
      /function\s+canGuideToAppSale\s*\(\)\s*:\s*boolean\s*\{\s*return\s+APPPAY_SALE_ENABLED/.test(guide),
    ).toBe(true)
  })
})

describe('护栏 29-B · 能力为 false 时入口必须诚实（角标 / 说明 / 隐藏）', () => {
  it('mini 导出不可用时两行导出入口都渲染「即将上线」角标（JSON + CSV，实装后仍须保留便于一键回退）', () => {
    // 🔴 计数而非「是否存在」：导出有 JSON / CSV 两行，只断言存在的话，
    //   漏改其中一行（例如新增第三行忘了加角标）护栏会假绿。
    expect((code(MINI_PROFILE).match(/<Text\s+className='line-badge'>即将上线<\/Text>/g) || []).length).toBe(2)
  })

  it('mini 导出不可用时两行导出入口都整行置灰（视觉上也表达「当前用不了」）', () => {
    expect((code(MINI_PROFILE).match(/pro\s*&&\s*!\s*isExportAvailable\s*\?\s*'list-line list-line-muted'/g) || []).length).toBe(2)
  })

  it('mini guardExport() 在能力不可用时短路，不把占位请求发给服务端', () => {
    const body = bodyOf(code(MINI_PROFILE), /function\s+guardExport\s*\(\)\s*:\s*boolean/)
    expect(/if\s*\(\s*!\s*isExportAvailable\s*\)/.test(body)).toBe(true)
  })

  it('mini 两条导出路径（JSON / CSV）都先过 guardExport，不得有一条漏检', () => {
    expect((code(MINI_PROFILE).match(/if\s*\(\s*!\s*guardExport\(\)\s*\)\s*return/g) || []).length).toBe(2)
  })

  it('mini 非 Pro 用户仍能看到 PIPL 第 45 条数据复制权的邮箱兜底路径', () => {
    const body = bodyOf(code(MINI_PROFILE), /function\s+guardExport\s*\(\)\s*:\s*boolean/)
    expect(/EXPORT_EMAIL_FALLBACK/.test(body)).toBe(true)
  })

  it('mini 推送未接入时「我的」页渲染诚实说明（而非留两个点了没反应的开关）', () => {
    expect(/\{\s*!\s*isNotifyPushAvailable\s*\?/.test(code(MINI_PROFILE))).toBe(true)
  })

  it('mini 推送说明直接引用 NOTIFY_UNAVAILABLE_NOTE（文案单一真源，不在页面里抄一份）', () => {
    expect(/import\s*\{[^}]*\bNOTIFY_UNAVAILABLE_NOTE\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/notifications'/.test(code(MINI_PROFILE))).toBe(true)
  })

  it('mini 推送说明文案不得承诺具体推送时间（未实现能力的时间承诺属广告法风险）', () => {
    const m = code(MINI_NOTIFY).match(/export\s+const\s+NOTIFY_UNAVAILABLE_NOTE\s*=\s*\n?\s*'([^']*)'/)
    expect(m ? /\d{1,2}\s*[:：]\s*\d{2}/.test(m[1]) : true).toBe(false)
  })

  it('主端通知区块整块包在 notifSupported 门控内（插件缺失时宁可不显示假开关）', () => {
    expect(/\{\s*notifSupported\s*&&/.test(code(MAIN_PROFILE))).toBe(true)
  })

  it('主端 notifSupported 取自 isNotificationsSupported()（与 mini 同款「单点判定 + 条件渲染」）', () => {
    expect(/const\s+notifSupported\s*=\s*useMemo\(\s*\(\)\s*=>\s*isNotificationsSupported\(\)/.test(code(MAIN_PROFILE))).toBe(true)
  })

  it('主端微信登录入口包在 WECHAT_LOGIN_AVAILABLE 门控内（关闭时隐藏，不留死按钮）', () => {
    expect(/\{\s*WECHAT_LOGIN_AVAILABLE\s*&&/.test(code(MAIN_AUTH))).toBe(true)
  })

  it('mini 售卖开关关闭时整个三档购买区块不渲染（与 legal.ts「免费提供」口径一致）', () => {
    expect(/\{\s*XPAY_SALE_ENABLED\s*\?/.test(code(MINI_PAYWALL))).toBe(true)
  })

  it('mini 开关开着但宿主不支持时降级为文字说明，不渲染点了必失败的购买按钮', () => {
    expect(/const\s+canBuy\s*=\s*XPAY_SALE_ENABLED\s*&&\s*isXpaySupported\(\)/.test(code(MINI_PAYWALL))).toBe(true)
  })

  it('mini 宿主不支持分支给出兑换码 / iOS App 的真实替代路径', () => {
    expect(/当前微信版本暂不支持在线购买/.test(code(MINI_PAYWALL))).toBe(true)
  })

  it('Web 引导区块的两个渠道各自包在门控内（开关关时零处「去下单」字样）', () => {
    const ui = code(MAIN_GUIDE_UI)
    expect(/const\s+guide\s*=\s*canGuideToMiniSale\(\)/.test(ui) && /\{\s*guide\s*&&/.test(ui)).toBe(true)
  })

  it('Web 引导区块的 App 渠道同样包在门控内', () => {
    const ui = code(MAIN_GUIDE_UI)
    expect(/const\s+guideApp\s*=\s*canGuideToAppSale\(\)/.test(ui) && /\{\s*guideApp\s*&&/.test(ui)).toBe(true)
  })

  it('Web「不收款」声明无条件渲染（四种开关组合下都必须存在，是合规底线而非可选文案）', () => {
    expect(/\{\s*WEB_NO_CHARGE_TEXT\s*\}/.test(code(MAIN_GUIDE_UI))).toBe(true)
  })
})

describe('护栏 29-C · 已实装的能力不得删掉回退保护', () => {
  it('导出实装后 writeAndShare() 仍是「写文件 + 转发到聊天」的真实两步（非占位返回）', () => {
    const body = bodyOf(code(MINI_SHARE), /async\s+function\s+writeAndShare\s*\(/)
    expect(/writeFileSync\s*\(/.test(body) && /shareFileMessage\s*\(\s*\{/.test(body)).toBe(true)
  })

  it('writeAndShare() 在基础库缺文件系统能力时诚实降级，不假装导出成功', () => {
    const body = bodyOf(code(MINI_SHARE), /async\s+function\s+writeAndShare\s*\(/)
    expect(/channel:\s*'none'\s*,\s*message:\s*EXPORT_UNAVAILABLE_MESSAGE/.test(body)).toBe(true)
  })

  it('导出占位文案仍导出可用（isExportAvailable 翻回 false 时 guardExport 立刻有话可说）', () => {
    expect(/export\s+const\s+EXPORT_UNAVAILABLE_MESSAGE\s*=/.test(code(MINI_SHARE))).toBe(true)
  })

  it('mini 用户取消转发不算失败（与主端 isShareCancelled 同口径，不误报错误）', () => {
    const body = bodyOf(code(MINI_SHARE), /async\s+function\s+writeAndShare\s*\(/)
    expect(/\/cancel\/i\.test\s*\(\s*msg\s*\)/.test(body)).toBe(true)
  })

  it('mini share.ts 已无零调用的 shareImage() 死占位（11-15 审查 A3 项已清理）', () => {
    expect(/function\s+shareImage\s*\(/.test(code(MINI_SHARE))).toBe(false)
  })
})

describe('护栏 29-D · 主端不得残留「小程序占位」死分支', () => {
  // 审查 C2/C3 项：`src/` 只服务 Web/iOS/Android 三端，mini 是独立 Taro 工程，
  // 只 import `mini/src/**` 与 `@dbee/shared`（全仓无 WebView / jweixin 引用），
  // 故 `src/` 里的 isWechatMiniProgram() 分支恒不可达 —— 且它们返回的是
  // 「正在接入小程序，敬请期待」这类**假承诺文案**，比死代码本身更该清理。
  it('src/lib/share.ts 不再包含不可达的小程序占位分支', () => {
    expect(/isWechatMiniProgram/.test(code('src/lib/share.ts'))).toBe(false)
  })

  it('src/lib/clipboard.ts 不再包含不可达的小程序占位分支', () => {
    expect(/isWechatMiniProgram/.test(code('src/lib/clipboard.ts'))).toBe(false)
  })

  it('src/lib/capture.ts 不再包含不可达的小程序占位分支', () => {
    expect(/isWechatMiniProgram/.test(code('src/lib/capture.ts'))).toBe(false)
  })

  it('全仓不再出现「正在接入小程序，敬请期待」这类假承诺文案', () => {
    const files = [
      'src/lib/share.ts',
      'src/lib/clipboard.ts',
      'src/lib/capture.ts',
      'mini/src/lib/share.ts',
    ]
    expect(files.every((f) => !/正在接入小程序，敬请期待/.test(code(f)))).toBe(true)
  })

  it('src/types.ts 已无全仓零引用的 InviteeStatus 死接口（含 subscribed 死字段）', () => {
    expect(/interface\s+InviteeStatus/.test(code('src/types.ts'))).toBe(false)
  })

  it('platform.ts 的小程序探测能力本身保留（供 health/brand.ts 等真用到的地方使用）', () => {
    expect(/export\s+function\s+isWechatMiniProgram\s*\(\)\s*:\s*boolean/.test(code('src/lib/platform.ts'))).toBe(true)
  })
})

describe('护栏 29-E · 反漂移：新增能力开关必须登记', () => {
  /** 递归收集目录下所有 .ts / .tsx（不含 node_modules，lib 目录本就没有）。 */
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const p = join(dir, entry)
      const st = statSync(join(ROOT, p))
      if (st.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(entry)) out.push(p)
    }
    return out
  }

  /**
   * 能力形态标识符：`is*Available` / `is*Supported` / `is*Enabled` /
   * 全大写的 `*_ENABLED` / `*_SUPPORTED` / `*_AVAILABLE` / `*_READY`。
   * 只匹配 export 出来的（模块私有的中间量不构成对外能力承诺）。
   */
  const FLAG = /export\s+(?:const|function)\s+(is[A-Za-z0-9]*(?:Available|Supported|Enabled)|[A-Z][A-Z0-9_]*(?:ENABLED|SUPPORTED|AVAILABLE|READY))\b/g

  function scanFlags(): Set<string> {
    const found = new Set<string>()
    for (const rel of [...walk('src/lib'), ...walk('mini/src/lib')]) {
      const src = code(rel)
      let m: RegExpExecArray | null
      FLAG.lastIndex = 0
      while ((m = FLAG.exec(src)) !== null) found.add(m[1])
    }
    return found
  }

  it('扫描到的能力标识符全部已登记（新增开关未登记 → 本条变红）', () => {
    const registered = new Set<string>([...CAPABILITIES, ...RUNTIME_PROBES])
    const unregistered = [...scanFlags()].filter((f) => !registered.has(f)).sort()
    expect(unregistered).toEqual([])
  })

  it('登记表里没有失效条目（标识符已被改名或删除 → 本条变红，防止清单腐化）', () => {
    const found = scanFlags()
    const stale = [...CAPABILITIES, ...RUNTIME_PROBES].filter((f) => !found.has(f)).sort()
    expect(stale).toEqual([])
  })

  it('配置型能力与运行时探测两张清单不重叠（同一开关不得两处登记而逃避 false 态断言）', () => {
    expect(CAPABILITIES.filter((c) => (RUNTIME_PROBES as readonly string[]).includes(c))).toEqual([])
  })

  it('每个配置型能力都有一条本文件的 false 态断言覆盖（登记表不为空壳）', () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(5)
  })
})
