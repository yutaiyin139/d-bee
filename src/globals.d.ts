/**
 * Vite 在构建时注入的全局常量（见 vite.config.ts 的 define）。
 */

/** 应用版本号，取自 package.json 的 version，形如 `v1.0.0` */
declare const __APP_VERSION__: string

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
