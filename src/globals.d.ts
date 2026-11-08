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
 * Web 自身恒不收款、恒不创建订单 —— 开启本值也不会给 Web 增加任何支付能力。
 */
declare const __XPAY_SALE_ENABLED__: boolean

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
