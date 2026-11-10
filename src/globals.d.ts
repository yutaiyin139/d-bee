/**
 * Vite 在构建时注入的全局常量（见 vite.config.ts 的 define）。
 */

/** 应用版本号，取自 package.json 的 version，形如 `v1.0.0` */
declare const __APP_VERSION__: string

/**
 * 🔴 小程序虚拟支付售卖能力是否在构建期开启（见 vite.config.ts 的 resolveXpaySaleFlag）。
 *
 * 与 mini 端 `XPAY_SALE_ENABLED`（mini/src/lib/xpayEnabled.ts）**同源同值**：
 * 两端读同一个环境变量 `D_BEE_XPAY_ENABLED`，一个包卖不卖钱是构建期不可变事实。
 *
 * Web 侧它只门控**一件事**：是否展示「去微信小程序下单」引导。
 * **当前** Web 不收款、不创建订单 —— 开启本值也不会给 Web 增加任何支付能力。
 * 🔴 2026-11-09 用户定案（推翻同日「办妥 ICP 经营许可证后 Web 可独立收款」的改判）：
 *    Web **暂不收费**，商业逻辑由「引导到微信端 + App 端购买」闭环，不新增 Web
 *    收款能力、不启动 Web 支付通道、不为此办证。见 `docs/Web引导闭环与Android收款实装-2026-11-09.md`。
 */
declare const __XPAY_SALE_ENABLED__: boolean

/**
 * 🔴 App 端（Android 原生包）第三方支付是否在构建期开启（resolveApppaySaleFlag）。
 *
 * 与 `__XPAY_SALE_ENABLED__` 平行但**相互独立**：mini 走微信虚拟支付，App 走
 * 微信/支付宝 APP 支付，两条通道各自就绪后各自开启。
 *
 * 两个使用点，必须同值（同源的意义）：
 *   · `src/pages/PaywallSheet.tsx` —— Android 是否渲染可点支付按钮；
 *   · `src/lib/miniOrderGuide.ts` → `MiniOrderGuide` —— Web 是否引导「去 App 内购买」。
 * 默认 false 时两者都被 terser 折叠，产物零购买入口、零 App 引导。
 */
declare const __APPPAY_SALE_ENABLED__: boolean

/**
 * 微信小程序全局对象（仅在微信小程序运行时由宿主注入）。
 * 这里只声明最小结构用于平台探测，不引入任何类型库；非小程序环境恒为 undefined。
 */
declare const wx:
  | {
      getSystemInfoSync?: () => unknown
      login?: (...args: unknown[]) => unknown
      request?: (...args: unknown[]) => unknown
      [key: string]: unknown
    }
  | undefined
