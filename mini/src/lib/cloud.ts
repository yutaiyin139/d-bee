/**
 * D-Bee 小程序云端接入层（单一真相源，与主工程 src/cloud.ts 对齐）。
 *
 * 与主工程的差异点：
 *  - 主工程 Web 端用「同源反代」（endpoint = window.location.origin），
 *    小程序无同源反代，endpoint 必须是绝对地址（由 ./backend.ts 解析）。
 *  - 主工程原生端靠 OriginProxy 插件补 Origin 头；小程序由 SDK 的
 *    createMiniProgramWorkBuddyCloud 内部用 wx.request 做 fetch polyfill，
 *    无需 OriginProxy。
 *
 * 公开配置（endpoint / publishableKey）与主工程 cloudConfig.ts 对齐，属公开值（无密钥）。
 * 🔴 2026-11-08 云库彻底废弃后，mini **不再传 `oauthRelayBaseUrl`**：该字段只服务
 *    `signInWithOAuth` 的网页扫码/统一登录，小程序只用 `signInWithWechat`
 *    （SDK 内 `postForSession(AUTH_PATHS.loginWechat)` 直接打 endpoint）。
 *    留着它虽不会被请求，但会在小程序产物里残留平台域名 `www.workbuddy.cn`，
 *    让「只需配一个 request 合法域名」这件事变得不确定。主工程 Web 端仍保留该字段
 *    （网页扫码登录可能用到），不受本变更影响。
 *
 * 🔴 2026-11-08 现状更正（下文 10-29 / 11-03 段落是历史记录，结论已过时）：
 *   四端已统一到自托管 PG（d-bee.cn），云端库彻底废弃、不再是任何生产依赖。
 *   mini 的 endpoint 由 ./backend.ts 决定，默认 **selfhost**；显式 `cloud` 一律 throw。
 *   legal.ts 的 §三/§四 也已改为自建库口径。下文凡写「默认 cloud / 双后端 /
 *   公示主体不同」处，均只作历史追溯，不代表当前行为。
 *
 * 🔴⚠️ 2026-10-29 更正：本文件此前写「三端共用同一云端」，**该说法不成立**，
 *   已导致 mini/src/content/legal.ts 出现与实际链路不符的第三方公示。事实是：
 *     · 小程序连的是 WorkBuddy 云（endpoint 由 ./backend.ts 解析，默认 cloud），
 *       数据与 AI 均由该平台承载；
 *     · 主工程 Web/iOS/Android 连的是**自托管 PostgreSQL + 自建网关**
 *       （nginx 反代 /.cloud/ 到 d-bee.cn，见 src/cloudConfig.ts 与 deploy/nginx.selfhost.conf.example；
 *        旧云端版模板 deploy/nginx.conf.example 已于 2026-10-31 废弃为仅存档）。
 *   两者**不是同一后端、数据不互通**（依据：docs/四端一致性与配置迁移综合报告-2026-10-25.md §1.3-C，
 *   docs/数据库规划.md「数据不在你的腾讯云服务器上，而在 WorkBuddy 云服务托管的 PostgreSQL 里」）。
 *   因此两端的隐私政策公示主体不同：小程序公示 WorkBuddy 云平台（腾讯云计算（北京）），
 *   主工程公示自建库 + 网关直连的 DeepSeek / 阿里云百炼。**改任一端 legal.ts 前先确认此结论。**
 *   📌 「小程序是否回迁自托管统一后端」在 docs 中曾是待拍板项；2026-11-03 已拍板**四端最终
 *      都迁回自托管**，故本文件已接入 ./backend.ts 的 endpoint 开关（默认仍是 cloud，
 *      需 D_BEE_BACKEND=selfhost + D_BEE_SELFHOST_READY=true 双确认才切）。
 *      🔴 更正旧记载：回迁时**只需改 endpoint**，resourceId 不必改（见下方 publicConfig
 *      注释的核对结论）；legal.ts 的 §三/§四 则确实必须一并改为主工程口径。
 *      切换清单见 docs/小程序回迁自托管-切换清单-2026-11-03.md。
 *   📌 2026-10-31 补充：WorkBuddy 云库侧已补齐 0039 权益闸门（db/cloud-patch-0039/），
 *      小程序走云库的流量同样吃到库内闸门校验（grant_honey 验事实、限额库内化、
 *      redeem_honey 加锁）。回迁与否已不再是「有无闸门」的安全问题，而是数据归属问题。
 */
// 🔴 必须在创建 cloud 客户端之前补 TextDecoder：SDK 的 SSE 解析器会
//    `new TextDecoder('utf-8')`，但它自带的 ensureMiniProgramPolyfills 漏了这一项，
//    微信体验版 JSCore 无此全局 → 记一餐等所有流式 AI 功能抛
//    「TextDecoder is not defined」(2026-11-08 实测)。详见 ./textDecoderPolyfill.ts。
import { ensureTextDecoder } from './textDecoderPolyfill'
import { reportBootError } from './bootReport'
import { createMiniProgramWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk/miniprogram'
import { resolveBackendTarget } from './backend'

/**
 * 后端接入点由 `./backend.ts` 统一决策（2026-11-08 起默认 selfhost，云库已废弃）。
 *
 * 🔴 回迁自托管时**只换 endpoint** —— 这是核对主端得出的结论：
 * `src/cloudConfig.ts` 切到 d-bee.cn 后，resourceId / publishableKey 的值与云库版
 * **逐字相同**：它们是 SDK 的资源标识与公开访问键，网关按 `WB_PUBLISHABLE_KEY`
 * 校验 access-key（`server/lib/config.mjs`），沿用同值即可，不必换。
 * `oauthRelayBaseUrl` 已于 11-08 移除（mini 不用网页扫码登录，理由见文件头）。
 * 真正的成本在网关侧（见 backend.ts 注释列出的前置条件），现已全部就绪。
 */
// 幂等安装，且必须早于 createMiniProgramWorkBuddyCloud（后者会注册流式 fetch）。
ensureTextDecoder()

const target = resolveBackendTarget()

export const publicConfig = {
  resourceId: 'wbcs_45DQ4I52Uv2NUAKAJkWdq1',
  endpoint: target.endpoint,
  publishableKey: 'wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E',
} as const

/** 当前实际连接的后端类型，供 legal.ts 区分公示口径、构建日志排查用。 */
export const BACKEND_KIND = target.kind

/**
 * 全局唯一的小程序云端客户端。
 * createMiniProgramWorkBuddyCloud 会自动：
 *  - 注入 wx.request 作为 fetch（小程序无标准 fetch）
 *  - 用 wx.setStorageSync 做本地存储（登录态持久化）
 *  - 挂载微信虚拟模块（登录 code 换 openid 等）
 */
/**
 * 🔴 2026-11-08 iOS 微信登录白屏排障：本对象是**模块级常量**，创建失败会让整个
 * common.js 求值中断 → 所有页面白屏且不会发出任何请求（服务端实证零 login-wechat）。
 * 小程序无 DOM 可画红屏，这里用微信原生 Modal 自报，把静默白屏变成可读错误。
 *
 * 🔴 14:5x 二次加固：iOS 真机调试出现 `RangeError: Maximum call stack size exceeded`
 * （appservice 同一栈帧无限重复）。**绝不再 `throw e`** —— rethrow 会直接中断
 * common.js 求值，App 都注册不上，Modal 也来不及显示；错误只留在 Console 里，
 * 用户看到的就是纯白屏。改为：自报 + 保存错误 + 返回空壳，让 App 与页面正常挂出，
 * 后续任何 cloud.* 调用由 ./auth.ts 转成可读错误并再次自报。
 * 正常路径零副作用。详见 ./bootReport.ts 文件头。
 */
let initError: unknown = null

/** 启动期 SDK 初始化失败的真实原因（正常路径恒为 null）。 */
export function cloudInitError(): unknown {
  return initError
}

export const cloud = (() => {
  try {
    return createMiniProgramWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      publishableKey: publicConfig.publishableKey,
    })
  } catch (e) {
    initError = e
    reportBootError('云端客户端初始化失败', e)
    // 🔴 不 rethrow：保住 App 注册与页面渲染，把「白屏」降级为「可读错误弹窗」。
    return {} as ReturnType<typeof createMiniProgramWorkBuddyCloud>
  }
})()
