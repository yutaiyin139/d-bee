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
 * cloudConfig.ts 完全一致，属公开值（无密钥）。
 *
 * 🔴⚠️ 2026-10-29 更正：本文件此前写「三端共用同一云端」，**该说法不成立**，
 *   已导致 mini/src/content/legal.ts 出现与实际链路不符的第三方公示。事实是：
 *     · 小程序连的是 WorkBuddy 云（本文件的 CLOUD_HOST），数据与 AI 均由该平台承载；
 *     · 主工程 Web/iOS/Android 连的是**自托管 PostgreSQL + 自建网关**
 *       （nginx 反代 /.cloud/ 到 d-bee.cn，见 src/cloudConfig.ts 与 deploy/nginx.conf.example）。
 *   两者**不是同一后端、数据不互通**（依据：docs/四端一致性与配置迁移综合报告-2026-10-25.md §1.3-C，
 *   docs/数据库规划.md「数据不在你的腾讯云服务器上，而在 WorkBuddy 云服务托管的 PostgreSQL 里」）。
 *   因此两端的隐私政策公示主体不同：小程序公示 WorkBuddy 云平台（腾讯云计算（北京）），
 *   主工程公示自建库 + 网关直连的 DeepSeek / 阿里云百炼。**改任一端 legal.ts 前先确认此结论。**
 *   📌 「小程序是否回迁自托管统一后端」在 docs 中仍是待拍板项；一旦回迁，
 *      本文件的 resourceId/endpoint 与 legal.ts 的 §三/§四 须一并改为主工程口径。
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
