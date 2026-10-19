/**
 * 小程序三端登录封装（code 换 openid，逻辑一致，仅拿 code 的 API 不同）。
 *
 * 三端拿 code：
 *  - 微信：wx.login() → code
 *  - 支付宝：my.getAuthCode() → authCode
 *  - 抖音：tt.login() → code
 *
 * 换取会话统一走云端的 signInWithWechat（SDK 内部 code→openid→Genie session）。
 * 注：支付宝/抖音的 code 换取在云端侧可能需对应 provider，当前先复用 wechat 通道
 * 做「拿 code → 换会话」的最小闭环，支付宝/抖音的专属 provider 待云端侧确认后替换。
 */
import Taro from '@tarojs/taro'
import { cloud } from './cloud'

/** 当前登录会话信息（内存缓存，避免重复读存储） */
export interface MiniSession {
  uid: string
  openid: string
}

let cachedSession: MiniSession | null = null

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
    // 微信：wx.login
    const res = await Taro.login()
    return { code: res.code, appid: getWechatAppId() }
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

/**
 * 建立云端登录会话。
 * @returns 会话 uid（openid 拼在 uid 里，形如 wx:xxxx）
 */
export async function signIn(): Promise<MiniSession> {
  if (cachedSession) return cachedSession

  const { code, appid } = await getLoginCode()
  if (!code) throw new Error('登录失败：未获取到登录凭证')

  const { data, error } = await cloud.auth.signInWithWechat(code, appid)
  if (error) throw new Error(`登录失败：${error.message ?? '未知错误'}`)

  // CloudResult：成功时 data 为 CloudSession，失败时 error 非空
  const uid = data?.user?.id
  if (!uid) throw new Error('登录失败：未返回用户标识')

  cachedSession = { uid, openid: uid.replace(/^wx:/, '') }
  return cachedSession
}

/** 是否已登录（不发起请求，仅看本地会话） */
export async function isSignedIn(): Promise<boolean> {
  if (cachedSession) return true
  const { data } = await cloud.auth.getSession()
  // getSession 返回 CloudSession | null（非 { session } 包裹）
  return !!data?.user
}

/** 退出登录（清内存 + 云端本地存储） */
export async function signOut(): Promise<void> {
  cachedSession = null
  await cloud.auth.signOut()
}
