/**
 * D-Bee 小程序云端接入层（单一真相源，与主工程 src/cloud.ts 对齐）。
 *
 * 与主工程的差异点：
 *  - 主工程 Web 端用「同源反代」（endpoint = window.location.origin），
 *    小程序无同源反代，endpoint 直接钉死云端域名。
 *  - 主工程原生端靠 OriginProxy 插件补 Origin 头；小程序由 SDK 的
 *    createMiniProgramWorkBuddyCloud 内部用 wx.request 做 fetch polyfill，
 *    无需 OriginProxy。
 *
 * 公开配置（endpoint / publishableKey / oauthRelayBaseUrl）与主工程
 * cloudConfig.ts 完全一致，属公开值（无密钥），三端共用同一云端。
 */
import { createMiniProgramWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk/miniprogram'

const CLOUD_HOST = 'https://zilv-mifeng.app.workbuddy.host'

export const publicConfig = {
  resourceId: 'wbcs_45DQ4I52Uv2NUAKAJkWdq1',
  endpoint: CLOUD_HOST,
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E',
} as const

/**
 * 全局唯一的小程序云端客户端。
 * createMiniProgramWorkBuddyCloud 会自动：
 *  - 注入 wx.request 作为 fetch（小程序无标准 fetch）
 *  - 用 wx.setStorageSync 做本地存储（登录态持久化）
 *  - 挂载微信虚拟模块（登录 code 换 openid 等）
 */
export const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
})
