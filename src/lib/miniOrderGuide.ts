/**
 * Web → 微信端 / App 端购买引导的**唯一配置真源**（2026-11-08 建，11-09 扩为双渠道）。
 *
 * ## 为什么必须有这个模块
 *
 * 付费墙（`pages/PaywallSheet.tsx`）与公开定价页（`pages/PricingSheet.tsx`）都要展示
 * 同一套「网页不收款 + 去对应端下单」的口径。若两处各写一份小程序/App 名称、各拼一份文案，
 * 改口径必漏改一处 —— 而这里漏改的后果不是样式问题，是**法务文案与实际不符**
 * （《广告法》第 4 条「不得含有虚假或者引人误解的内容」）。故名称、跳转配置、
 * 售卖开关全部收敛到本模块，两个页面只 import，不自己拼。
 *
 * 🔴 2026-11-09 用户定案：**Web 暂不收费，靠「引导到微信端 + App 端购买」完成商业闭环**。
 *    这推翻了同日「办妥 ICP 经营许可证后 Web 可独立收款」的改判 —— Web 不新增支付能力、
 *    不启动 Web 支付通道、不为此办证，四端业务逻辑（定价 / 权益 / 免费额度 / 口径 /
 *    数据面）一律不变。文件名沿用 `miniOrderGuide` 只是历史沿革，实际已是双渠道真源。
 *
 * ## 🔴 与 mini 端同源（最重要的一条）
 *
 * `XPAY_SALE_ENABLED` 来自构建期常量 `__XPAY_SALE_ENABLED__`，该常量由
 * `vite.config.ts` 的 `resolveXpaySaleFlag()` 从 **`D_BEE_XPAY_ENABLED`** 注入 ——
 * 与 mini 端 `mini/src/lib/xpayEnabled.ts` 读的是**同一个环境变量、同一套 true/false 校验**。
 *
 * 一个变量同时决定两端：小程序卖不卖、Web 引不引导。这是刻意的强耦合：
 *   · 只开 Web 不开 mini → 用户扫码进小程序发现「免费提供、不销售任何商品」
 *     = 引导到一个买不到东西的入口，虚假宣传；
 *   · 只开 mini 不开 Web → 小程序在收费而 Web 法务文案说没有购买渠道 = 口径不一致。
 * 两端同值时不可能出现上述任一情况。发布纪律见 `docs/待办清单-云库废弃收尾-2026-11-08.md` §十一。
 *
 * ## 默认关闭（当前状态）
 *
 * 未设 `D_BEE_XPAY_ENABLED=true` 时 `XPAY_SALE_ENABLED === false`：
 * Web 只展示三档价格 + 明示「网页不收取任何费用」，**不出现任何「去小程序下单」字样**，
 * 与 mini 默认「免费提供」口径一致。同理 `D_BEE_APPPAY_ENABLED` 未设时
 * `APPPAY_SALE_ENABLED === false`，Web 零「去 App 内购买」引导。
 * **当前** Web 不收款、不创建订单；开启任一开关只增加对应端的引导，
 * 绝不给 Web 增加任何支付能力（护栏 18 与 20 共同钉死）。
 *
 * 🔴 两条渠道**独立门控**：mini 走微信虚拟支付、App 走微信/支付宝 APP 支付，
 *    谁的平台侧前置就绪就开谁，不必互相等待，也绝不「引导到还没开放的渠道」。
 *    详见 `docs/Web引导闭环与Android收款实装-2026-11-09.md` §二。
 */

/**
 * 小程序虚拟支付售卖能力（构建期字面量，与 mini 端 `XPAY_SALE_ENABLED` 同源同值）。
 *
 * 🔴 `typeof` 兜底：若某条构建路径漏注入该常量（例如新增了一个不带 define 的入口），
 * 求值结果是 **false**（安全默认）而不是 ReferenceError 白屏。方向刻意选「宁可少引导，
 * 不可错引导」—— 错引导是合规事故，少引导只是少一个入口。
 */
export const XPAY_SALE_ENABLED: boolean =
  typeof __XPAY_SALE_ENABLED__ !== 'undefined' && __XPAY_SALE_ENABLED__ === true

/**
 * App 端售卖能力（构建期字面量，来源 `D_BEE_APPPAY_ENABLED`）。
 *
 * 与 `XPAY_SALE_ENABLED` 平行但独立：原生包与 Web 用同一条 vite `define`，
 * 故「Android 是否可发起支付」与「Web 是否引导去 App 购买」必然同值。
 * `typeof` 兜底同样选 false（漏注入时宁可少引导，不可错引导）。
 */
export const APPPAY_SALE_ENABLED: boolean =
  typeof __APPPAY_SALE_ENABLED__ !== 'undefined' && __APPPAY_SALE_ENABLED__ === true

/** 小程序名称。默认 A1 定案值，可用 VITE_MINI_APP_NAME 覆盖，避免再写一份名称副本。 */
export const MINI_APP_NAME =
  (import.meta.env.VITE_MINI_APP_NAME as string | undefined)?.trim() || '自律蜜蜂'

/**
 * 静态小程序码图片路径（MP 后台生成后放 `public/`，零 AppSecret，推荐方案）。
 * 生成步骤见 `docs/Web端跳转小程序-静态码操作手册-2026-11-08.md`。
 */
export const MINI_ORDER_QR = (import.meta.env.VITE_MINI_ORDER_QR as string | undefined)?.trim() || ''

/**
 * URL Link 协议白名单过滤（抽成纯函数以便单测，2026-11-08）。
 *
 * 🔴 只接受 https 绝对地址：构建期配置写错（如 `javascript:alert(1)`、`data:...`、
 * `http://...`、相对路径）一律返回空串，绝不把可执行/降级协议渲染进 `<a href>`。
 * `<a href>` 是 DOM 里唯一能执行任意协议的属性，故这里做协议白名单而非依赖转义。
 *
 * 为什么抽成导出纯函数：`import.meta.env.VITE_MINI_ORDER_LINK` 是 vite 的**构建期字符串
 * 替换**（字面量会原样留在产物里，运行时才求值），无法像布尔开关那样被 terser 死代码折叠，
 * 因此「grep 产物」验证不了过滤是否生效。抽成纯函数后可直接单测各种恶意/畸形输入
 * （见 tools/web-no-payment.test.ts 护栏 W8），安全逻辑才是可验证的。
 */
export function sanitizeMiniOrderLink(raw: string | undefined | null): string {
  const t = (raw ?? '').trim()
  if (!t) return ''
  try {
    const u = new URL(t)
    return u.protocol === 'https:' ? u.toString() : ''
  } catch {
    // 相对路径 / 畸形 URL：new URL 抛错 → 拒绝
    return ''
  }
}

/** URL Link（需服务端用 AppSecret 签发，二期方案）。过滤规则见 sanitizeMiniOrderLink。 */
export const MINI_ORDER_LINK = sanitizeMiniOrderLink(
  import.meta.env.VITE_MINI_ORDER_LINK as string | undefined,
)

/**
 * App 下载 / 商店落地页（https 白名单过滤，与小程序链接**同一个纯函数**）。
 *
 * 复用 `sanitizeMiniOrderLink` 而不是另写一个：协议白名单是安全逻辑，多一份实现
 * 就多一份漂移风险；护栏 W8 的 12 项断言因此同时覆盖两个渠道的链接过滤。
 * 未配置时 App 引导退化为纯文字「在应用商店搜索 App 名」，绝不渲染死链接。
 */
export const APP_DOWNLOAD_LINK = sanitizeMiniOrderLink(
  import.meta.env.VITE_APP_DOWNLOAD_LINK as string | undefined,
)

/** App 下载二维码图片路径（放 `public/`，与小程序码同理，零 AppSecret）。 */
export const APP_DOWNLOAD_QR =
  (import.meta.env.VITE_APP_DOWNLOAD_QR as string | undefined)?.trim() || ''

/**
 * 是否具备「引导去小程序下单」的完整条件。
 *
 * 售卖开关是唯一必要条件：跳转凭证（码 / 链接）**可以都为空** —— 那时退化为
 * 「在微信中搜索小程序名」的纯文字引导，仍然真实可用，绝不渲染点了没反应的死按钮。
 */
export function canGuideToMiniSale(): boolean {
  return XPAY_SALE_ENABLED
}

/** 是否具备「引导去 App 内购买」的完整条件（与 Android 支付按钮同源同值）。 */
export function canGuideToAppSale(): boolean {
  return APPPAY_SALE_ENABLED
}

/**
 * 网页版不收款声明（付费墙与公开定价页共用同一句，杜绝两处措辞漂移）。
 *
 * 这句在**两个开关开与关的四种组合里都必须存在**：Web 只发布价格信息、
 * 不缔约、不收钱，与微信端/App 卖不卖无关。
 *
 * 🔴 2026-11-09 用户定案：Web **暂不收费，以引导闭环**，商业逻辑由
 *    「引导到微信端 + App 端购买」完成，不新增 Web 收款能力、不为此办证。
 *    这推翻了同日「办妥 ICP 经营许可证后 Web 可独立收款」的改判，故本文案
 *    与护栏 18 的「Web 零收款」语义**保持有效，无需改写**。
 *    🔴 渠道隔离仍是硬约束：Web 不得成为小程序虚拟商品的支付落地页
 *    （小程序运营规范 2.5.13 / 2.14.7 禁止引导至网站成交），引导只做导流。
 */
export const WEB_NO_CHARGE_TEXT = '网页版仅展示价格，不提供在线支付，也不会通过网页收取任何费用。'
