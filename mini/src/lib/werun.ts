/**
 * 微信运动主动同步（WX-2/WX-3，2026-11-17，WX-0 隐私指引已过）。
 *
 * ── 平台硬约束（规划 §8/§10，逐条对应代码）──────────────────────────
 *   ① 唯一读取出口 wx.getWeRunData()，返回 encryptedData + iv（项目 selfhost 无云开发，
 *      拿不到 cloudID，必须走服务端解密 —— 见 WX-1 werun.mjs）。
 *   ② 🔴 **授权弹窗必须由用户主动动作触发**，禁止凭生命周期弹框（平台规范）。
 *      但「读取步数」本身并不要求每次都点一下 —— 已授权用户可以静默读取。
 *      故本文件提供两条路径，区别只在**会不会弹框**：
 *        · syncWechatStepsActive() —— 用户点「同步微信运动」时调：未授权会弹
 *          授权框/跳设置页（主动动作触发，合规）。
 *        · syncWechatStepsSilent() —— 登录/进入时调：🔴 **零弹框**，仅在隐私已同意
 *          且 scope.werun 已授权时才读取；任一未授权立即静默放弃（返回 null），
 *          绝不触发 wx.authorize / wx.openSetting / requirePrivacyAuthorize。
 *   ③ 读取前置：隐私授权指引已声明「微信运动步数」(WX-0，用户后台审核通过) +
 *      scope.werun 用户授权。拒绝 → status:'denied'，引导 wx.openSetting。
 *   ④ 更新时机：微信运动只在用户进入小程序时更新，服务端不存在定时拉取。
 *      故 UI 必须标 syncedAt，绝不宣称实时。🔴 也正因如此，「实时刷新」的正确
 *      时机是**登录/进入小程序**这些真实节点，而不是 60s 轮询（轮询拿到的仍是
 *      同一份快照，白耗流量与网关调用）。
 *
 * ── 与网关的契约（WX-1）──────────────────────────────────────────────
 *   只上传 {code, appid, encryptedData, iv} 四元组 —— 🔴 绝不上传 steps（可伪造，
 *   直接影响净摄入/可吃回额度）。steps 只来自服务端解密结果。
 *   code 失效（40029/40163 → 401 invalid_grant）自动重新 wx.login 换 code 重试一次。
 */
import Taro from '@tarojs/taro'
import { getWechatAppId } from './auth'
import { gatewayPost, GatewayError } from './gateway'
import { ensurePrivacyAuthorized, isPrivacyError } from './privacy'
import { kvGet, kvSet } from './kv'

const SYNC_PATH = '/.cloud/auth/v1/werun/sync'
const CACHE_KEY = 'dbee:werun:cache'

/** 与 mini/src/lib/health/index.ts 的 HealthSyncData 同形状（避免循环 import） */
export interface WerunSyncData {
  steps: number
  activeKcal: number
  status: 'ok' | 'empty' | 'denied' | 'error' | 'unavailable'
  message?: string
  syncedAt?: string
}

/** 网关 werun/sync 成功返回体 */
interface WerunGatewayResult {
  steps: number
  activeKcal: number
  status: 'ok' | 'empty'
  syncedAt: string
}

/* ── wx 最小接口（鸭子类型，对齐 xpay.ts getWx 风格）───────────────── */

interface WerunFail {
  errMsg?: string
  errno?: number
}
interface WerunSettingRes {
  authSetting?: Record<string, boolean>
}
interface WerunDataRes {
  encryptedData?: string
  iv?: string
}
interface WxLike {
  getSetting?: (o: { success?: (r: WerunSettingRes) => void; fail?: (e: WerunFail) => void }) => void
  authorize?: (o: {
    scope: string
    success?: () => void
    fail?: (e: WerunFail) => void
  }) => void
  openSetting?: (o: { success?: (r: WerunSettingRes) => void; fail?: () => void }) => void
  getWeRunData?: (o: {
    success?: (r: WerunDataRes) => void
    fail?: (e: WerunFail) => void
  }) => void
}

function getWx(): WxLike | null {
  try {
    const w = (globalThis as unknown as { wx?: WxLike }).wx
    return w && typeof w === 'object' ? w : null
  } catch {
    return null
  }
}

/** 非微信端 / 基础库不支持 getWeRunData → 不可用 */
export function isWerunSupported(): boolean {
  if (process.env.TARO_ENV !== 'weapp') return false
  return typeof getWx()?.getWeRunData === 'function'
}

/* ── 本地缓存（自动路径只读它）──────────────────────────────────────── */

/**
 * 读最近一次主动同步的步数快照。
 * 🔴 只返回缓存值，绝不触发任何 wx API —— 这是「自动轮询零 getWeRunData」的关键。
 * 无缓存 → status:'empty'（UI 提示「点一下同步微信运动」，不弹系统授权框）。
 */
export async function readWechatStepsCache(): Promise<WerunSyncData> {
  try {
    const raw = await kvGet(CACHE_KEY, '')
    if (!raw) return { steps: 0, activeKcal: 0, status: 'empty' }
    const c = JSON.parse(raw) as Partial<WerunSyncData>
    const steps = Number(c.steps)
    if (!Number.isFinite(steps) || steps < 0) return { steps: 0, activeKcal: 0, status: 'empty' }
    return {
      steps: Math.round(steps),
      activeKcal: 0,
      status: c.status === 'ok' || c.status === 'empty' ? c.status : 'empty',
      syncedAt: typeof c.syncedAt === 'string' ? c.syncedAt : undefined,
    }
  } catch {
    return { steps: 0, activeKcal: 0, status: 'empty' }
  }
}

async function writeCache(data: WerunGatewayResult): Promise<void> {
  try {
    await kvSet(CACHE_KEY, JSON.stringify({
      steps: data.steps,
      activeKcal: 0,
      status: data.status,
      syncedAt: data.syncedAt,
    }))
  } catch {
    // 缓存写失败不阻断本次同步结果展示
  }
}

/* ── 授权检查：主动路径（可弹框）与静默路径（零弹框）──────────────── */

/**
 * 读 scope.werun 当前授权态。🔴 只读不写：getSetting 不弹框，安全。
 */
function readWerunScope(): Promise<boolean | undefined> {
  const wx = getWx()
  if (!wx || typeof wx.getSetting !== 'function') return Promise.resolve(undefined)
  return new Promise<boolean | undefined>((resolve) => {
    try {
      wx.getSetting!({
        success: (r) => resolve((r ?? {}).authSetting?.['scope.werun']),
        fail: () => resolve(undefined),
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * 静默路径的隐私门禁：🔴 **只查不弹**。
 * ensurePrivacyAuthorized() 在 needAuthorization=true 时会调 requirePrivacyAuthorize
 * 弹框 —— 静默路径绝不能走它，只能读一次 getPrivacySetting：
 *   needAuthorization=false（已同意过 / 后台未声明）→ 放行；否则一律静默放弃。
 */
async function isPrivacyAlreadyGranted(): Promise<boolean> {
  try {
    if (typeof Taro.getPrivacySetting !== 'function') return true
    const s = await new Promise<{ needAuthorization?: boolean }>((resolve) => {
      Taro.getPrivacySetting({ success: (r) => resolve(r ?? {}), fail: () => resolve({}) })
    })
    return !s.needAuthorization
  } catch {
    // 查询自身故障 → 静默放弃（不是 fail-open：这里放行只会多一次必然失败的外呼）
    return false
  }
}

/**
 * 主动路径授权（用户点了「同步微信运动」）：未授权则弹框/跳设置页。
 * @returns 'ok' 已授权 · 'denied' 被拒 · 'unavailable' 环境不支持
 */
async function ensureWerunAuth(): Promise<'ok' | 'denied' | 'unavailable'> {
  const wx = getWx()
  if (!wx || typeof wx.getWeRunData !== 'function' || typeof wx.getSetting !== 'function') {
    return 'unavailable'
  }
  // ① 微信平台层隐私授权（隐私指引已在 WX-0 审核通过）
  const privacy = await ensurePrivacyAuthorized()
  if (!privacy.ok) return 'denied'

  // ② scope.werun 授权状态
  const scope = await readWerunScope()
  if (scope === false) {
    // 用户曾拒绝 → 引导去设置页开启，返回 denied 让 UI 提示
    try {
      wx.openSetting?.({ success: () => {}, fail: () => {} })
    } catch {
      /* 引导失败不抛 */
    }
    return 'denied'
  }
  if (scope !== true && typeof wx.authorize === 'function') {
    const granted = await new Promise<boolean>((resolve) => {
      try {
        wx.authorize!({
          scope: 'scope.werun',
          success: () => resolve(true),
          fail: () => resolve(false),
        })
      } catch {
        resolve(false)
      }
    })
    if (!granted) return 'denied'
  }
  return 'ok'
}

/**
 * 静默路径授权：🔴 **零弹框**。只在「隐私已同意 + scope.werun 已授权」时返回 'ok'，
 * 其余一律 'silent_skip'（调用方据此回退缓存，绝不提示、绝不弹窗）。
 */
async function checkWerunAuthSilent(): Promise<'ok' | 'silent_skip'> {
  const wx = getWx()
  if (!wx || typeof wx.getWeRunData !== 'function') return 'silent_skip'
  if (!(await isPrivacyAlreadyGranted())) return 'silent_skip'
  // 🔴 只有**明确 true** 才继续；false（曾拒绝）与 undefined（从未授权/查询失败）
  //   都静默跳过 —— 两者都会导致 getWeRunData 失败或触发弹框，均不可接受。
  if ((await readWerunScope()) !== true) return 'silent_skip'
  return 'ok'
}

function getWeRunEncrypted(): Promise<WerunDataRes | null> {
  const wx = getWx()
  if (!wx || typeof wx.getWeRunData !== 'function') return Promise.resolve(null)
  return new Promise<WerunDataRes | null>((resolve) => {
    try {
      wx.getWeRunData!({
        success: (r) => resolve(r ?? null),
        fail: () => resolve(null),
      })
    } catch {
      resolve(null)
    }
  })
}

/** 拿同批次 login code（每次主动同步都新登录，保证与密文同批次 session_key） */
async function freshLoginCode(): Promise<string> {
  const res = await Taro.login()
  return typeof res?.code === 'string' ? res.code : ''
}

/**
 * 授权通过之后的共用同步核心：wx.login → getWeRunData → 网关解密 → 写缓存。
 * 主动路径与静默路径**共用这一份**，避免两条链路漂移（各自实现迟早不一致）。
 *
 * 🔴 上传 payload 只含密文四元组，绝不含 steps —— 步数只来自服务端解密值，
 *   客户端伪造 steps 不影响净摄入/可吃回额度（与 WX-1 服务端红线③对应）。
 */
async function syncWithGateway(appid: string): Promise<WerunSyncData> {
  let code = ''
  try {
    code = await freshLoginCode()
  } catch (e) {
    return { steps: 0, activeKcal: 0, status: 'error', message: `获取登录凭证失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!code) {
    return { steps: 0, activeKcal: 0, status: 'error', message: '登录凭证为空，请重试。' }
  }

  const enc = await getWeRunEncrypted()
  if (!enc?.encryptedData || !enc?.iv) {
    return {
      steps: 0, activeKcal: 0, status: 'denied',
      message: '未能读取微信运动数据，请确认已开启微信运动后重试。',
    }
  }

  // 只上传四元组；🔴 绝不上传 steps（服务端只信解密值）
  // 每次调用新建 payload：重试时必须带上新的 login code，不能复用第一次的对象。
  const doSync = (loginCode: string): Promise<WerunGatewayResult> => {
    const payload = { code: loginCode, appid, encryptedData: enc.encryptedData, iv: enc.iv }
    return gatewayPost<WerunGatewayResult>(SYNC_PATH, payload)
  }

  try {
    let result: WerunGatewayResult
    try {
      result = await doSync(code)
    } catch (e) {
      // code 失效（40029/40163 → 401 invalid_grant）→ 重新 wx.login 换 code 重试一次
      if (e instanceof GatewayError && (e.status === 401 && e.code === 'invalid_grant')) {
        code = await freshLoginCode()
        if (!code) throw new GatewayError(401, 'invalid_grant', '登录凭证刷新失败')
        result = await doSync(code)
      } else {
        throw e
      }
    }
    await writeCache(result)
    return {
      steps: result.steps,
      activeKcal: 0,
      status: result.status,
      syncedAt: result.syncedAt,
    }
  } catch (e) {
    // 隐私类错误（errno 112）翻成人话，指向 WX-0 后台声明
    if (isPrivacyError(e) || (e instanceof GatewayError && /privacy|scope/i.test(e.code))) {
      return {
        steps: 0, activeKcal: 0, status: 'error',
        message: '微信运动隐私声明尚未生效，请联系客服反馈。',
      }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return { steps: 0, activeKcal: 0, status: 'error', message: `同步失败：${msg.slice(0, 60)}` }
  }
}

/**
 * 用户主动点击「同步微信运动」时调用 —— 完整链路：
 *   隐私授权 → scope.werun（未授权会弹框）→ syncWithGateway()
 * 🔴 本函数**可能弹授权框**，故只能由用户主动动作触发，禁止放生命周期/定时器。
 */
export async function syncWechatStepsActive(): Promise<WerunSyncData> {
  if (!isWerunSupported()) {
    return { steps: 0, activeKcal: 0, status: 'unavailable', message: '当前环境不支持微信运动同步。' }
  }

  const auth = await ensureWerunAuth()
  if (auth === 'unavailable') {
    return { steps: 0, activeKcal: 0, status: 'unavailable', message: '当前微信版本不支持微信运动同步，请升级后重试。' }
  }
  if (auth === 'denied') {
    return {
      steps: 0, activeKcal: 0, status: 'denied',
      message: '未获得微信运动授权，请在「设置 > 关于 > 权限管理」中开启后重试。',
    }
  }

  const appid = getWechatAppId()
  if (!appid) {
    return { steps: 0, activeKcal: 0, status: 'error', message: '未获取到小程序 AppID，请重启微信后重试。' }
  }

  return syncWithGateway(appid)
}

/**
 * 🔴 **静默实时同步**（用户「每次登录都要看到当时步数」的诉求，2026-11-18）。
 *
 * 与 syncWechatStepsActive 的唯一区别是**零弹框**：只在隐私已同意且 scope.werun
 * 已授权时才真的去读；任一条件不满足立即返回 null（= 本次没试），由门面回退本地缓存。
 * 这样已连接用户每次进入/登录都能拿到微信运动当时的步数，而新用户绝不会
 * 在进小程序时莫名弹出一个授权框（那才是平台规范要禁的行为）。
 *
 * @returns null 表示「未授权/不支持，本次未尝试」，调用方应回退缓存而非报 0
 */
export async function syncWechatStepsSilent(): Promise<WerunSyncData | null> {
  if (!isWerunSupported()) return null
  if ((await checkWerunAuthSilent()) !== 'ok') return null
  const appid = getWechatAppId()
  if (!appid) return null
  const r = await syncWithGateway(appid)
  // 静默路径的失败不该打扰用户：denied/error 一律降级为 null 走缓存兜底，
  // 只有真拿到数据（ok/empty）才回传给 UI。
  return r.status === 'ok' || r.status === 'empty' ? r : null
}
