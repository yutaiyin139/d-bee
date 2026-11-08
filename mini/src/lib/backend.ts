/**
 * 小程序后端接入点的唯一决策处（endpoint 开关）。
 *
 * ## 为什么单独抽一个文件
 *
 * `cloud.ts` 一 import 就会拉起整个 WorkBuddy 云 SDK（其小程序产物含微信虚拟支付、
 * 投诉、商户财务等大量端点），在 vitest 里测试它需要先 mock `@tarojs/taro`
 * ——而 `@tarojs/taro` 只存在于 `mini/node_modules`，根 `node_modules` 里没有，
 * `vi.mock('@tarojs/taro')` 的裸包名解析不到，得写成相对路径直指嵌套实例
 * （这个坑在 `tools/mini-invite-link.test.ts` 里踩过一次）。
 * 本文件**零依赖**（不 import 任何东西），解析逻辑可被直接单测。
 *
 * ## 唯一后端（2026-11-08 起：云库彻底废弃，无回滚通道）
 *
 * 🔴 自 2026-11-08 起**只接受 selfhost**（自托管 PG + 自建网关 = https://d-bee.cn）。
 *    云端库已按用户指令彻底废弃：代码里不再保留云端域名、不再保留 `cloud` 分支。
 *    显式传 `D_BEE_BACKEND=cloud` 或任何非 selfhost 值一律 throw —— 宁可构建失败，
 *    也不允许「以为切了其实没切」的包被发出去。应急回滚改走微信后台回退线上版本。
 *
 * 切 `selfhost` 需要 `D_BEE_SELFHOST_READY=true` 的显式二次确认，否则构建期 throw：
 *   1. `D_BEE_BACKEND=selfhost`（或留空 = 默认 selfhost）
 *   2. `D_BEE_SELFHOST_READY=true`  ← 显式二次确认
 *
 * 第 2 条不是形式主义。自托管链路（备案 + DNS + HTTPS + 网关 login-wechat +
 * ident_kind wechat + legal 口径）任何一环缺位，小程序都会全线失败，而错误现象
 * （网络不通 / 登录 404）离原因很远，排查成本高。强制二次确认 + throw 文案写明全部前置条件。
 *
 * ## 🔴 两层拦截（实测校准过，别只依赖本文件的 throw）
 *
 * 本文件是**运行时**护栏：`resolveBackendTarget()` 在小程序启动、`cloud.ts` 顶层
 * import 它时执行，误配则启动即崩。但 webpack **不执行**被打包的模块代码 —— 所以
 * 光有本文件的 throw，误切的包照样能 `build:weapp` 成功，等到发出去、用户打开才发现，太晚。
 *
 * 因此 `mini/config/index.ts` 里**额外调用了一次同一个 `resolveBackendTarget()`**：
 * 那个文件由 Node 在构建期执行，throw 能真正中断构建。两层复用同一函数而非各写一份判断，
 * 逻辑不会漂移。对齐主端思路：主端 `vite.config.ts:14-25` 构建期 + `cloudConfig.ts` 运行时。
 * 共同点：endpoint 解析失败必须炸，绝不静默兜底到另一个后端，且都要构建期+运行时双层。
 */

/**
 * 自托管后端（主端 Web/iOS/Android 原生包已连它，见 `src/cloudConfig.ts:19`）。
 * 🔴 2026-11-08 起为 mini 默认后端：域名已 ICP 下证（京ICP备2026075565号-2）、
 *    DNS + HTTPS 已就绪、网关 login-wechat 已部署、ident_kind 已扩 wechat。
 */
export const SELFHOST_HOST = 'https://d-bee.cn'

/** 2026-11-08 起只有一个合法值：云端库分支已整体移除。 */
export type BackendKind = 'selfhost'

export interface BackendTarget {
  kind: BackendKind
  endpoint: string
}

/** 构建期注入的开关值（`mini/config/index.ts` 的 defineConstants）。 */
interface BackendEnv {
  backend?: string
  selfhostReady?: string
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/**
 * 解析小程序应连的后端。
 *
 * @param env 开关值，默认从 `process.env` 读（构建期由 defineConstants 替换成字面量）。
 *            显式传参仅用于测试。
 * @throws 设了 selfhost（含默认）但缺 READY 确认、或值不认识时抛出。
 *         🔴 **不认识的 backend 值一律 throw**，不兜底 —— 静默兜底会让
 *         「以为切了其实没切」这类问题在运行时才暴露。
 */
export function resolveBackendTarget(
  env: BackendEnv = {
    backend: process.env.D_BEE_BACKEND,
    selfhostReady: process.env.D_BEE_SELFHOST_READY,
  },
): BackendTarget {
  const kind = normalize(env.backend)

  // 未设置 = 默认 selfhost（2026-11-08 起，云库已废弃）
  if (kind === '' || kind === 'selfhost') {
    if (normalize(env.selfhostReady) !== 'true') {
      throw new Error(
        '小程序后端为 selfhost（默认），但缺少 D_BEE_SELFHOST_READY=true 的显式确认。' +
          '自托管链路任何一环缺位，小程序都会全线失败。' +
          '前置条件（见 docs/小程序回迁自托管-数据处置与执行手册-2026-11-07.md）：' +
          '① ICP 企业备案下证（京ICP备2026075565号-2）；' +
          '② d-bee.cn 配 A 记录并签发 HTTPS 证书；' +
          '③ 微信后台把该域名加入 request 合法域名；' +
          '④ 网关已部署 /.cloud/auth/v1/login-wechat 路由；' +
          '⑤ app_users 的 ident_kind 已扩 wechat；' +
          '⑥ mini/src/content/legal.ts §三/§四 已改自托管公示口径。' +
          '全部就绪后再设 D_BEE_SELFHOST_READY=true。',
      )
    }
    return { kind: 'selfhost', endpoint: SELFHOST_HOST }
  }

  // 🔴 云端库已于 2026-11-08 彻底废弃：显式 cloud 与任何非 selfhost 值一律拒绝。
  throw new Error(
    `无法识别的 D_BEE_BACKEND 值：${JSON.stringify(env.backend)}（只接受 'selfhost'）。` +
      (kind === 'cloud'
        ? '云端库已彻底废弃，不再接受 cloud；请改用自托管后端，或在微信后台回退线上版本。'
        : '刻意不兜底：静默兜底会让「以为切了其实没切」在运行时才暴露。'),
  )
}

/**
 * 是否为自托管后端（2026-11-08 起恒为 true，只要没被 READY 门拦下）。
 *
 * 保留此函数是为了让依赖它的调用点与护栏不必跟着删改；云端库分支已整体移除，
 * 故不再需要两个公示口径分支 —— `mini/src/content/legal.ts` 的 §三/§四 现为
 * 单一自建库口径（存储=自建 PG、AI=DeepSeek + 阿里云百炼 Qwen-VL、短信=阿里云）。
 * 主端 `src/content/legal.ts` 是同口径的参照。
 */
export function isSelfhostBackend(): boolean {
  return resolveBackendTarget().kind === 'selfhost'
}
