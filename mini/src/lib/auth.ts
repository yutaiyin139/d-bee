/**
 * 小程序三端登录封装。
 *
 * 登录方式分两路（云端 SDK 0.1.3 的 auth 端点决定）：
 *  - 微信：wx.login() → code → signInWithWechat → /v1/login-wechat（唯一小程序登录端点）
 *  - 支付宝 / 抖音：云端**没有** login-alipay / login-douyin 端点，改用
 *    手机号验证码登录（sendOtp + verifyOtp → /v1/verification + /v1/signin），三端通用。
 */
import Taro from '@tarojs/taro'
import { cloud, cloudInitError } from './cloud'

/**
 * 启动期 SDK 初始化失败时，`cloud` 是空壳（见 ./cloud.ts）。直接调 cloud.auth.*
 * 只会得到「Cannot read properties of undefined」这类无信息量的 TypeError；
 * 这里把真实原因带出来，交给登录页 catch → 自报 Modal，用户能看懂。
 */
function assertCloudReady(): void {
  const e = cloudInitError()
  if (!e) return
  let msg = '云端客户端初始化失败'
  try {
    const m = (e as { message?: unknown } | null)?.message
    if (typeof m === 'string' && m) msg = `云端客户端初始化失败：${m}`
  } catch {
    /* 异常对象不可读时用兜底文案 */
  }
  throw new Error(msg)
}

/** 当前登录会话信息（内存缓存，避免重复读存储） */
export interface MiniSession {
  uid: string
  openid: string
}

let cachedSession: MiniSession | null = null

/** 当前端是否有「code 换 openid」的原生登录通道（仅微信有） */
export function canNativeSignIn(): boolean {
  return process.env.TARO_ENV === 'weapp'
}

/** 当前平台名（用于 UI 提示） */
export function currentPlatformName(): string {
  if (process.env.TARO_ENV === 'weapp') return '微信'
  if (process.env.TARO_ENV === 'alipay') return '支付宝'
  if (process.env.TARO_ENV === 'tt') return '抖音'
  return '当前平台'
}

/** 拿微信小程序 appid（试用/正式两套独立，必须取当前账号的 appid） */
function getWechatAppId(): string {
  try {
    const info = Taro.getAccountInfoSync()
    return info?.miniProgram?.appId || ''
  } catch {
    return ''
  }
}

/**
 * 拿各端登录 code。
 * 用 Taro 的条件编译 / 运行时判断区分三端。
 */
async function getLoginCode(): Promise<{ code: string; appid: string }> {
  if (process.env.TARO_ENV === 'weapp') {
    // 微信：wx.login。🔴 2026-11-08 iOS 真机白屏排查：每一步带明确阶段文案，
    //   避免 SDK 因 appid 为空直接 fail() 却「不发请求、看不出哪里错」。
    //   自报统一由调用方（登录页 catch / cloud.ts 初始化）负责，避免重复弹窗。
    let code: string
    try {
      const res = await Taro.login()
      code = res.code
    } catch (e) {
      throw new Error(`微信登录凭证获取失败（wx.login）：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!code) throw new Error('微信登录凭证为空，请重启微信后重试')
    const appid = getWechatAppId()
    if (!appid) {
      throw new Error('未获取到小程序 AppID（getAccountInfoSync 不可用），请重启微信后重试')
    }
    return { code, appid }
  }
  if (process.env.TARO_ENV === 'alipay') {
    // 支付宝：my.getAuthCode（scope auth_base 静默授权）
    const res = await new Promise<{ authCode?: string }>((resolve, reject) => {
      my.getAuthCode({
        scopes: 'auth_base',
        success: (r: { authCode?: string }) => resolve(r),
        fail: (e: { errorMessage?: string }) => reject(new Error(e?.errorMessage || '支付宝授权失败')),
      })
    })
    // 支付宝 authCode 复用同一换取通道；appid 由云端配置决定，这里传空
    return { code: res.authCode || '', appid: '' }
  }
  if (process.env.TARO_ENV === 'tt') {
    // 抖音：tt.login
    const res = await Taro.login()
    return { code: res.code, appid: '' }
  }
  throw new Error('当前环境不是小程序，无法登录')
}

/** 从 CloudSession 提取 uid 并缓存 */
function cacheSession(data: { user?: { id?: string } } | null): MiniSession {
  const uid = data?.user?.id
  if (!uid) throw new Error('登录失败：未返回用户标识')
  cachedSession = { uid, openid: uid.replace(/^wx:/, '') }
  return cachedSession
}

/**
 * 微信原生登录（code 换 openid）。仅微信端可用。
 * @returns 会话 uid（openid 拼在 uid 里，形如 wx:xxxx）
 */
export async function signIn(): Promise<MiniSession> {
  if (cachedSession) return cachedSession
  assertCloudReady()

  const { code, appid } = await getLoginCode()
  if (!code) throw new Error('登录失败：未获取到登录凭证')

  const { data, error } = await cloud.auth.signInWithWechat(code, appid)
  if (error) {
    // 带上 kind / status：iOS 上若为网络层失败（status=0 / kind=network），
    // 能一眼区分「请求根本没发出」与「网关返回业务错误」。
    throw new Error(
      `登录失败（${error.kind ?? 'unknown'} / ${error.status ?? 0}）：${error.message ?? '未知错误'}`,
    )
  }
  return cacheSession(data)
}

/**
 * 发送手机号验证码。
 * @returns verificationId（验码时需回传）与 isExistingUser（决定登录/注册）
 */
export async function sendPhoneOtp(phone: string): Promise<{ verificationId: string; isExistingUser: boolean }> {
  assertCloudReady()
  const { data, error } = await cloud.auth.sendOtp({ phone })
  if (error) throw new Error(`发送验证码失败：${error.message ?? '未知错误'}`)
  if (!data?.verificationId) throw new Error('发送验证码失败：未返回凭证')
  return { verificationId: data.verificationId, isExistingUser: data.isExistingUser }
}

/**
 * 手机号验证码登录（支付宝/抖音端的主登录方式，微信端亦可作兜底）。
 * 新用户自动注册（isExistingUser=false 时走注册后登录）。
 */
export async function signInWithPhone(phone: string, token: string, verificationId: string, isExistingUser: boolean): Promise<MiniSession> {
  if (cachedSession) return cachedSession
  assertCloudReady()

  const { data, error } = await cloud.auth.verifyOtp({
    verificationId,
    token,
    phone,
    isExistingUser,
  })
  if (error) throw new Error(`登录失败：${error.message ?? '未知错误'}`)
  return cacheSession(data)
}

/** 是否已登录（不发起请求，仅看本地会话） */
export async function isSignedIn(): Promise<boolean> {
  if (cachedSession) return true
  // 启动期 SDK 已初始化失败并自报过，这里不再抛错，保住首页/登录页渲染。
  if (cloudInitError()) return false
  try {
    const { data } = await cloud.auth.getSession()
    // getSession 返回 CloudSession | null（非 { session } 包裹）
    return !!data?.user
  } catch {
    // 本地会话读取异常按「未登录」处理，避免整页白屏（异常已由 cloud.ts 自报）
    return false
  }
}

/** 退出登录（清内存 + 云端本地存储） */
export async function signOut(): Promise<void> {
  cachedSession = null
  await cloud.auth.signOut()
}
