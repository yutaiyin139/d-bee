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
 * ## 开关语义
 *
 * 默认 `cloud`（WorkBuddy 云），即当前线上行为，**不设任何环境变量 = 零改变**。
 *
 * 切 `selfhost`（自托管 PG + 自建网关）需要**同时**满足两个条件，否则构建期 throw：
 *   1. `D_BEE_BACKEND=selfhost`
 *   2. `D_BEE_SELFHOST_READY=true`  ← 显式二次确认
 *
 * 第 2 条不是形式主义。自托管域名 `d-bee.cn` 目前 **无 A 记录、未备案、无 HTTPS**
 * （依据：`docs/备案材料清单.md` §0「`d-bee.com.cn` 当前本就无 A 记录，线上一直走 IP
 * 直连」；ICP 企业备案在办，北京不在「个人→企业」直接变更白名单，须注销重备）。
 * 若只认一个变量，任何人手滑设成 selfhost 就会得到一个「小程序请求全部失败」的包，
 * 而错误现象（网络不通）离原因（域名未就绪）很远，排查成本高。
 * 强制二次确认 + throw 文案里写明全部前置条件。
 *
 * ## 🔴 两层拦截（实测校准过，别只依赖本文件的 throw）
 *
 * 本文件是**运行时**护栏：`resolveBackendTarget()` 在小程序启动、`cloud.ts` 顶层
 * import 它时执行，误配则启动即崩。但 webpack **不执行**被打包的模块代码 —— 所以
 * 光有本文件的 throw，误切的包照样能 `build:weapp` 成功（实测：D_BEE_BACKEND=selfhost
 * 且缺 READY 时构建仍 exit=0），等到发出去、用户打开才发现，太晚。
 *
 * 因此 `mini/config/index.ts` 里**额外调用了一次同一个 `resolveBackendTarget()`**：
 * 那个文件由 Node 在构建期执行，throw 能真正中断构建（实测 exit=1）。两层复用同一
 * 函数而非各写一份判断，逻辑不会漂移。实测四场景：默认→构建成功；selfhost 缺
 * READY→构建失败；不认识的值→构建失败；selfhost+READY=true→构建成功且产物 endpoint
 * 指向 d-bee.cn。
 *
 * 对齐主端思路：主端 `vite.config.ts:14-25` 构建期 throw + `src/cloudConfig.ts:109-112`
 * 运行时 throw 是**防静默回退云库**；本文件方向相反，是**防误连未就绪的自托管**。
 * 两者共同点：endpoint 解析失败必须炸，绝不静默兜底到另一个后端，且都要构建期+运行时双层。
 */

/** WorkBuddy 云（当前线上后端）。公开值，无密钥。 */
export const CLOUD_HOST = 'https://zilv-mifeng.app.workbuddy.host'

/**
 * 自托管后端（主端 Web/iOS/Android 原生包已连它，见 `src/cloudConfig.ts:19`）。
 * 🔴 该域名当前不可用（无 DNS / 未备案 / 无 HTTPS），故被 READY 门拦住。
 */
export const SELFHOST_HOST = 'https://d-bee.cn'

export type BackendKind = 'cloud' | 'selfhost'

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
 * @throws 设了 selfhost 但缺 READY 确认、或值不认识时抛出。
 *         🔴 **不认识的 backend 值一律 throw**，不兜底成 cloud —— 静默兜底会让
 *         「以为切了其实没切」这类问题在运行时才暴露。
 */
export function resolveBackendTarget(
  env: BackendEnv = {
    backend: process.env.D_BEE_BACKEND,
    selfhostReady: process.env.D_BEE_SELFHOST_READY,
  },
): BackendTarget {
  const kind = normalize(env.backend)

  // 未设置 = 当前线上行为
  if (kind === '' || kind === 'cloud') {
    return { kind: 'cloud', endpoint: CLOUD_HOST }
  }

  if (kind === 'selfhost') {
    if (normalize(env.selfhostReady) !== 'true') {
      throw new Error(
        '小程序后端已设为 selfhost，但缺少 D_BEE_SELFHOST_READY=true 的显式确认。' +
          '自托管域名 d-bee.cn 目前无 A 记录、未完成 ICP 备案、无 HTTPS 证书，' +
          '切过去会导致小程序所有网络请求失败。' +
          '前置条件（见 docs/小程序回迁自托管-切换清单-2026-11-03.md）：' +
          '① ICP 企业备案下证；② d-bee.cn 配 A 记录并签发 HTTPS 证书；' +
          '③ 微信后台把该域名加入 request 合法域名；' +
          '④ 网关补 /.cloud/auth/v1/login-wechat 路由；' +
          '⑤ app_users 的 ident_kind 扩展 wechat；' +
          '⑥ mini/src/content/legal.ts §三/§四 改为自托管公示口径。' +
          '全部就绪后再设 D_BEE_SELFHOST_READY=true。',
      )
    }
    return { kind: 'selfhost', endpoint: SELFHOST_HOST }
  }

  throw new Error(
    `无法识别的 D_BEE_BACKEND 值：${JSON.stringify(env.backend)}（只接受 'cloud' 或 'selfhost'）。` +
      '刻意不兜底为 cloud：静默兜底会让「以为切了其实没切」在运行时才暴露。',
  )
}

/**
 * 当前是否为自托管后端。供 legal.ts 等需要区分公示口径的地方使用。
 *
 * 🔴 用它的地方必须两个分支都实现。回迁时 `legal.ts` 的 §三（信息的存储）与
 * §四（第三方服务与 SDK 目录）公示主体不同：
 *   · cloud    → 腾讯云计算（北京）有限责任公司（WorkBuddy 云服务）；AI 由平台侧
 *                按任务动态匹配模型，**我们不持有厂商密钥、也无法指定底层模型**
 *   · selfhost → 我们自己部署运维的数据库（云基础设施由腾讯云提供）；AI 直连
 *                DeepSeek（文本）+ 阿里云百炼 Qwen-VL（图像）；短信走阿里云
 * 把 selfhost 的公示文案抄进 cloud 分支 = 虚假公示（反之亦然）。
 * 主端 `src/content/legal.ts:205,215-219` 是 selfhost 口径的现成参照。
 */
export function isSelfhostBackend(): boolean {
  return resolveBackendTarget().kind === 'selfhost'
}
