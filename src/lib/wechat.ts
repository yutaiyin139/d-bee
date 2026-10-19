/**
 * 微信登录抽象层。
 *
 * ⚠️ 当前状态（2026-10-15）：企业营业执照办理中，微信相关能力（小程序 / 公众号 /
 *    微信扫码登录）**整体暂缓**。登录目前只开放「短信验证 + 邮箱验证」。
 *    微信登录的完整代码保留在此文件，通过顶层开关 WECHAT_LOGIN_ENABLED 整体关闭；
 *    营业执照办下来、准备接微信登录时，把 WECHAT_LOGIN_ENABLED 改回 true 即可恢复，
 *    其余代码（含原生 SDK 路径）无需改动。
 *
 * Web 与原生是两条**完全不同**的路径，混在一起写就会出 bug，所以在这里一次说清：
 *
 *   Web  —— 走云 Relay 的「网页扫码登录」：
 *           signInWithOAuth({ provider: 'wechat', redirectTo: location.origin })
 *           → location.assign(url) → 用户微信扫码 → 回跳本页
 *           → App.tsx 的 handleWechatWebCallback() 用 code 换会话。
 *           **不需要自己的微信 AppID**（用的是平台统一回调域名），当前已在用。
 *
 *   原生 —— WebView 里绝对不能这么跳：origin 是 `https://localhost`(Android) /
 *           `capacitor://localhost`(iOS)，微信开放平台不认这个回调域名，
 *           而且 OAuth 跳出 WebView 之后回不来。必须改用微信开放平台
 *           「移动应用」+ 原生 SDK 拿 code。
 *
 *   微信小程序 —— 又是第三条路：小程序里既没有 `location.assign` 扫码回流，
 *           也没有移动应用 SDK，而是 `wx.login()` 拿临时 code，云端走 jscode2session
 *           换会话（这正是 cloud.auth.signInWithWechat(code, appid) 原生支持的场景）。
 *           当前总开关 WECHAT_LOGIN_ENABLED=false，小程序端登录一并关闭；
 *           未来接小程序时，在 isWechatLoginAvailable() 里增加 isWechatMiniProgram()
 *           分支即可，不影响 Web / 原生两条既有路径。
 *
 * ── 原生路径的前置条件（四条缺一不可）────────────────────────────────
 *   1. 微信开放平台「移动应用」审核通过，拿到 AppID
 *      （构建时注入 VITE_WECHAT_APPID，见 .env.example）
 *   2. iOS 需要一条 Universal Link（必须是已备案的 HTTPS 域名，
 *      注入 VITE_WECHAT_UNIVERSAL_LINK）；Android 不需要
 *   3. 原生工程侧配置：Android 的 WXEntryActivity + 包可见性 query、
 *      iOS 的 LSApplicationQueriesSchemes + CFBundleURLSchemes
 *   4. **云端需提供「移动应用 code 换会话」接口** ← 当前缺口就在这里
 *
 *   关于第 4 条：现有 `cloud.auth.signInWithWechat(code, appid)` 的文档写明是
 *   给**小程序 wx.login** 用的（服务端走 jscode2session），而移动应用拿到的 code
 *   需要走 sns/oauth2/access_token —— 两者不是同一个接口，不能混用。
 *   因此在云端补齐之前，原生微信登录**无法真正跑通**。
 *
 *   处理方式：`isWechatLoginAvailable()` 在原生端返回 false，UI 据此**隐藏**微信入口。
 *   这同时消掉了 App Store 审核的一类风险（登录方式点了没反应 → 2.1/4.2 被拒）。
 *   云端就绪后，把下面的 NATIVE_CODE_EXCHANGE_SUPPORTED 改成 true 即启用，
 *   其余代码无需改动。
 *
 * 与其他 lib 抽象一致：**不静态 import 任何 Capacitor 插件包**，只用运行时鸭子类型
 * 探测 window.Capacitor.Plugins，保证 Web 构建产物零新增依赖、体积不变。
 */

import { isIOS, isNative } from './platform'
import { cloud } from '../cloud'

/** @capacitor-wechat 插件的最小结构（见 @capgo/capacitor-wechat 的 definitions） */
interface WechatPlugin {
  initialize: (opts: { appId: string; universalLink?: string }) => Promise<void>
  isInstalled: () => Promise<{ installed: boolean }>
  auth: (opts: { scope: string; state?: string }) => Promise<{ code: string; state?: string }>
}

/**
 * 微信登录总开关。营业执照办理完成、准备接入微信登录时改回 true。
 * 关闭时所有端（Web / 原生）一律不展示微信登录入口，登录仅走短信 + 邮箱验证。
 */
const WECHAT_LOGIN_ENABLED = false

/** 云端是否已支持「移动应用 code 换会话」。云端补齐后改为 true 即启用原生微信登录。 */
const NATIVE_CODE_EXCHANGE_SUPPORTED = false

/** 微信开放平台「移动应用」AppID（构建时注入；未配置返回空串） */
export function wechatAppId(): string {
  return ((import.meta.env.VITE_WECHAT_APPID as string | undefined) ?? '').trim()
}

/** iOS 专用：与微信应用关联的 Universal Link（必须是已备案的 HTTPS 域名） */
export function wechatUniversalLink(): string {
  return ((import.meta.env.VITE_WECHAT_UNIVERSAL_LINK as string | undefined) ?? '').trim()
}

function getPlugin(): WechatPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.CapacitorWechat
  if (!p || typeof p !== 'object') return null
  const candidate = p as Partial<WechatPlugin>
  if (typeof candidate.initialize !== 'function' || typeof candidate.auth !== 'function') return null
  return candidate as WechatPlugin
}

/**
 * 微信登录入口是否应该展示给用户。
 *
 * 总开关 WECHAT_LOGIN_ENABLED 未打开时，所有端一律返回 false（营业执照办理中，
 * 微信登录整体暂缓）。开关打开后：
 *   Web 端恒为 true（扫码登录现成可用）；
 *   原生端需要「凭据 + 插件 + 云端接口」三者齐备；
 *   iOS 额外要求 Universal Link（微信 SDK 缺它初始化会崩，宁可隐藏也不能点崩）。
 */
export function isWechatLoginAvailable(): boolean {
  if (!WECHAT_LOGIN_ENABLED) return false
  // 微信小程序：走 wx.login + jscode2session（规划中），当前总开关关闭故不会到达；
  // 未来启用时在此用 isWechatMiniProgram() 分流，避免小程序误走下方「Web 扫码」分支。
  if (!isNative()) return true
  if (!NATIVE_CODE_EXCHANGE_SUPPORTED) return false
  if (!wechatAppId()) return false
  if (isIOS() && !wechatUniversalLink()) return false
  return getPlugin() !== null
}

export type WechatNativeResult =
  | { status: 'ok' }
  | { status: 'cancelled'; message?: string }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

/**
 * 原生端微信登录：调原生 SDK 拿 code，再交给云端换会话。
 *
 * 返回 'cancelled' 表示用户在微信里主动取消，UI 应静默处理（不要弹错误）。
 * 返回 'unsupported' 表示环境不具备条件（未配 AppID / 插件缺失 / 云端未就绪）。
 */
export async function signInWithWechatNative(): Promise<WechatNativeResult> {
  if (!WECHAT_LOGIN_ENABLED) {
    return { status: 'unsupported', message: '微信登录暂未开放，请使用手机号或邮箱登录' }
  }
  if (!isNative()) {
    return { status: 'unsupported', message: '当前环境不是原生 App' }
  }
  if (!NATIVE_CODE_EXCHANGE_SUPPORTED) {
    return {
      status: 'unsupported',
      message: '微信登录正在接入中，请使用手机号或邮箱登录',
    }
  }
  const appId = wechatAppId()
  if (!appId) {
    return { status: 'unsupported', message: '微信登录未配置 AppID' }
  }
  const plugin = getPlugin()
  if (!plugin) {
    return { status: 'unsupported', message: '微信登录组件不可用' }
  }

  try {
    const universalLink = wechatUniversalLink()
    if (isIOS() && !universalLink) {
      // 微信 iOS SDK 缺 Universal Link 会在初始化时崩溃，必须提前拦住
      return { status: 'unsupported', message: '微信登录未配置 Universal Link' }
    }
    await plugin.initialize(universalLink ? { appId, universalLink } : { appId })

    const { installed } = await plugin.isInstalled()
    if (!installed) {
      return { status: 'error', message: '未检测到微信，请先安装微信后再试' }
    }

    // snsapi_userinfo 才能在云端换到用户昵称头像；登录-only 可用 snsapi_login
    const { code } = await plugin.auth({ scope: 'snsapi_userinfo' })
    if (!code) {
      return { status: 'cancelled' }
    }

    const res = await cloud.auth.signInWithWechat(code, appId)
    if (res.error) {
      return { status: 'error', message: res.error.message || '微信登录失败' }
    }
    return { status: 'ok' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // 微信 SDK 把「用户取消」也抛成错误，只能按文案识别；识别不出就按真实错误处理，
    // 避免把「初始化失败」这类问题伪装成用户取消而静默吞掉。
    if (/cancel|取消|拒绝|denied/i.test(message)) {
      return { status: 'cancelled', message }
    }
    return { status: 'error', message: message || '微信登录失败' }
  }
}
