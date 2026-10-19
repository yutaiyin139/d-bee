/**
 * 小程序全局对象最小类型声明（零依赖，与主工程 src/globals.d.ts 对齐思路）。
 *
 * Taro 官方未为支付宝/抖音的部分专有 API 提供类型化封装，这里只声明
 * 本工程用到的极小结构，避免引入完整平台类型包。
 */

/** 支付宝小程序全局对象 `my`（仅声明用到的 getAuthCode） */
declare const my: {
  getAuthCode(options: {
    scopes?: string | string[]
    success?: (res: { authCode?: string; authErrorScopes?: Record<string, unknown> }) => void
    fail?: (err: { errorMessage?: string; error?: number }) => void
  }): void
}
