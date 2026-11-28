/**
 * 运动健康对接 · 统一门面。
 *
 * 业务代码只从这里取数据/发起连接，不直接嗅探品牌或插件。
 * 平台差异、品牌差异、HealthKit 授权全部封在 health/ 内部。
 *
 * 连接状态（health_connected）存云端 profiles 表（跨设备一致），
 * 授权成功后置 true，下次登录据此「自动获取 + 连接按钮消失」。
 *
 * 当前实现分层：
 *   - getHealthVendor()           品牌识别（纯函数，零依赖）
 *   - isHealthConnectable()       是否显示「连接健康」入口（iOS + 插件可用）
 *   - isHealthConnected()         是否已连接（读云端 profile.health_connected）
 *   - connectHealth()             点击连接 → 调 HealthKit 授权 → 存云端状态
 *   - syncFromHealth()            拉取当天步数 + 活动能量
 *   - estimateActivityKcal()      步数 → 活动消耗换算（融热量缺口）
 */

import { detectHealthVendor, isWechatWebView } from './brand'
import type { HealthVendorInfo } from './brand'
import { isHealthKitAvailable, requestHealthAuthorization, fetchTodayHealth, fetchHealthKitDevices } from './healthkit'
import {
  isAndroidVendorHealthAvailable,
  requestAndroidVendorAuthorization,
  fetchAndroidVendorToday,
} from './android'
import {
  isHealthConnectAvailable,
  healthConnectInstallOffered,
  openHealthConnect,
  probeHealthConnectAvailability,
  requestHealthConnectAuthorization,
  fetchHealthConnectToday,
  fetchHealthConnectDevices,
} from './connect'
import { isWechatMiniProgram, isAndroid } from '../platform'
import { getProfile, saveProfile } from '../api'
import type { HealthSyncData } from './types'
import type { SmartDeviceSample } from '@dbee/shared'
import { healthVendorToDb, isVendorConnected } from '@dbee/shared'
import type { HealthVendorDb } from '@dbee/shared'

export type { HealthVendor, HealthVendorInfo } from './brand'
export type { HealthSyncData, HealthSyncStatus, HealthAuthResult, HealthAuthReason } from './types'
export { isUsableHealthStatus } from './types'
export { isHealthConnectAvailable, healthConnectInstallOffered, openHealthConnect, probeHealthConnectAvailability } from './connect'

export interface ConnectResult {
  ok: boolean
  /** 展示给用户的提示文案 */
  message: string
  /** 已连接的数据源标识 */
  vendor: HealthVendorInfo['vendor']
}

/** Health Connect 数据源的展示信息（跨品牌统一层，与机型品牌无关） */
const HEALTH_CONNECT_INFO: HealthVendorInfo = {
  vendor: 'health_connect',
  label: '系统健康',
  canSync: true,
  tip: '请在系统「健康连接（Health Connect）」里授权后使用。手表或手环要先在自己的健康 App 里打开向健康连接共享步数。',
}

/** 本机还没装健康连接，但系统允许安装。按钮去安装页，不写成「这台手机不支持」。 */
const HEALTH_CONNECT_INSTALL_INFO: HealthVendorInfo = {
  vendor: 'health_connect',
  label: '系统健康',
  canSync: true,
  tip: '本机还没有「健康连接」。安装后，在手表或手环的健康 App 里打开向它共享步数，再回到这里点连接。',
}

/**
 * 品牌识别入口。
 *
 * HC-1（2026-11-18）：Android 侧 **Health Connect 优先**于厂商 SDK ——
 * HC 是跨品牌系统统一层（一次授权通吃各家穿戴设备），厂商 SDK 只覆盖自家设备。
 * 判定同步读 probe 缓存（与 iOS `isHealthKitAvailable()` 同为同步），故 UI 调用点
 * 的 `useMemo(() => getHealthVendor(), [])` 形状零改动、与 iOS 端完全同构。
 *
 * 🔴 probe 之前 / 插件未就绪 → 缓存 false → 退回 UA 品牌识别，行为与改造前一致。
 *    probe 由 App 启动或健康页挂载时调 `probeHealthConnectAvailability()` 触发一次。
 */
export function getHealthVendor(): HealthVendorInfo {
  // isHealthConnectAvailable() 内部已 gate isAndroid()，非 Android 恒 false
  if (isHealthConnectAvailable()) return HEALTH_CONNECT_INFO
  if (healthConnectInstallOffered()) return HEALTH_CONNECT_INSTALL_INFO
  return detectHealthVendor()
}

/**
 * 是否显示「连接健康」入口。
 *
 * 原生 App 且健康平台插件可用时显示，微信小程序（微信运动）也显示：
 *   - iOS    ：Apple 健康（HealthKit）真同步
 *   - Android：**Health Connect（跨品牌统一层）优先** → 华为 Health Kit / 小米运动健康
 *              数据服务兜底（均依赖资质，未就绪时授权降级为引导）
 *   - 微信小程序：微信运动（wx.getWeRunData）真同步
 * 其它安卓厂商无公开读取 API；Web 也不显示。
 *
 * ⚠️ 零影响保证：现有三端走的是 isHealthKitAvailable()/isAndroidVendorHealthAvailable()，
 *   两者在非对应平台恒为 false；新增的 isWechatMiniProgram() 仅在小程序环境为 true，
 *   isHealthConnectAvailable() 在 probe 前恒 false，对 Web/iOS/Android 返回值不变。
 */
export function isHealthConnectable(): boolean {
  return (
    isWechatMiniProgram() ||
    isHealthKitAvailable() ||
    isHealthConnectAvailable() ||
    healthConnectInstallOffered() ||
    isAndroidVendorHealthAvailable()
  )
}

/**
 * 是否已连接健康数据源（读云端 profile）。
 *
 * WX-4（0053）：按「本端期望的来源」判定，杜绝跨端串台——
 * iPhone App 连了 Apple 健康后，小程序传 expectedVendor='werun'，
 * 读到的 health_vendor='apple' 不匹配 → 不算已连接（真机验收判据）。
 *
 * @param expectedVendor 本端期望来源；省略时按当前机型自动推断。
 *   旧数据（health_vendor 为空）回退布尔，兼容 0053 之前的旧包（见 shared isVendorConnected）。
 *
 * HC-1（2026-11-18）：推断来源前先 await probe（幂等，命中缓存零开销）。
 * 否则 Android 上「已连 HC」的用户在缓存就绪前会被误判为未连接
 * （UA 品牌 = huawei，而存储的 health_vendor = health_connect → 来源不匹配）。
 */
export async function isHealthConnected(expectedVendor?: HealthVendorDb): Promise<boolean> {
  try {
    const p = await getProfile()
    if (!p) return false
    if (expectedVendor === undefined && isAndroid()) await probeHealthConnectAvailability()
    const expect = expectedVendor ?? healthVendorToDb(getHealthVendor().vendor)
    // 本端无对应来源（如 Web / vivo / oppo）：按旧布尔口径，不阻断现有端
    if (!expect) return p.health_connected === true
    return isVendorConnected(p.health_connected, p.health_vendor, expect)
  } catch {
    return false
  }
}

/**
 * 点击「连接健康数据源」：调对应平台授权流程，走完后写云端连接状态。
 *
 * 流程：
 *   ① 调原生 requestAuthorization → 系统弹健康权限配置（首次）；
 *      已询问过时系统不再弹窗，流程直接走完（所以这里永远可以重连）
 *   ② 授权流程完成 → saveProfile({ health_connected: true, health_connected_at })
 *   ③ 返回 ok，前端据此隐藏按钮 + 触发一次同步
 *
 * ⚠️ 读授权不可探测：用户即使拒绝，流程也返回 completed=true。
 *   是否真有数据以 fetchToday 为准；步数一直为 0 时引导用户到
 *   iOS「设置 > 健康 > 数据访问权限 > D-Bee」勾选（见健康数据源页提示）。
 *
 * HC-1（2026-11-18）：分派源改为 getHealthVendor()（含 Health Connect），
 * Android 上 HC 可用时走 HC 分支，与 iOS 分支**完全同构**（授权→写云端→返回）。
 */
export async function connectHealth(): Promise<ConnectResult> {
  // HC 能力须在取 vendor 前就绪（probe 幂等，命中缓存零开销）
  if (isAndroid()) await probeHealthConnectAvailability()
  if (healthConnectInstallOffered()) {
    const opened = await openHealthConnect('install')
    return {
      ok: false,
      message: opened
        ? '已打开「健康连接」的安装页。安装完成，并在手表或手环的健康 App 里打开步数共享后，回到这里再点一次连接。'
        : '请到应用商店安装「健康连接（Health Connect）」。装好后，在手表或手环的健康 App 里打开向它共享步数，再回来连接。',
      vendor: 'health_connect',
    }
  }
  const v = getHealthVendor()

  if (v.vendor === 'health_connect') {
    // probe 已确认可用；防御性复查一次（防止极端时序下缓存被重置）
    if (!isHealthConnectAvailable()) {
      return { ok: false, message: HEALTH_CONNECT_INFO.tip, vendor: 'health_connect' }
    }

    const auth = await requestHealthConnectAuthorization()
    // 流程可以走完，但一项可读指标都没勾：不能写成已连接，否则首页一直是 0 步。
    if (auth.reason === 'no_types') {
      return {
        ok: false,
        message: '授权页已打开，但没有允许读取步数或活动能量。请再点一次连接并勾选这两项。手表或手环还要在自己的健康 App 里打开向「健康连接」共享步数。',
        vendor: 'health_connect',
      }
    }
    if (!auth.completed) {
      if (auth.reason === 'unavailable') {
        return {
          ok: false,
          message: '当前设备不支持 Health Connect，请手动记录运动。',
          vendor: 'health_connect',
        }
      }
      if (auth.reason === 'system_error') {
        return {
          ok: false,
          message: `健康授权失败（${auth.message ?? '系统错误'}），请稍后重试。`,
          vendor: 'health_connect',
        }
      }
      return {
        ok: false,
        message: '授权未完成，可稍后在「我的 > 健康数据源」里重新连接。',
        vendor: 'health_connect',
      }
    }

    // 授权流程完成 → 写云端连接态 + 来源（HC-1 已补 healthVendorToDb 映射，防串台）
    try {
      await saveProfile({
        health_connected: true,
        health_connected_at: new Date().toISOString(),
        health_vendor: 'health_connect',
      })
    } catch {
      // 存状态失败不阻断；本地连接态未落云端时按钮仍在，可重试
    }
    return { ok: true, message: '已连接系统健康（Health Connect），步数与活动能量将自动同步。', vendor: 'health_connect' }
  }

  if (v.vendor === 'apple') {
    if (!isHealthKitAvailable()) {
      // 插件未注入（非原生 iOS / 尚未编译插件）：保留原占位提示
      return { ok: false, message: 'Apple 健康同步正在接入中，当前请先手动记录运动。', vendor: 'apple' }
    }

    const auth = await requestHealthAuthorization()
    if (!auth.completed) {
      // 按原生透传的 reason 精确提示，不再一律显示「授权未完成」
      if (auth.reason === 'unavailable') {
        return {
          ok: false,
          message: '当前设备不支持 Apple 健康数据，请手动记录运动。',
          vendor: 'apple',
        }
      }
      if (auth.reason === 'system_error') {
        return {
          ok: false,
          message: `健康授权失败（${auth.message ?? '系统错误'}），请稍后重试。`,
          vendor: 'apple',
        }
      }
      return {
        ok: false,
        message: '授权未完成，可稍后在「我的 > 健康数据源」里重新连接。',
        vendor: 'apple',
      }
    }

    // 授权流程完成 → 存云端连接状态（跨设备一致）+ 来源（WX-4 防串台）
    try {
      await saveProfile({ health_connected: true, health_connected_at: new Date().toISOString(), health_vendor: 'apple' })
    } catch {
      // 存状态失败不阻断；本地连接态未落云端时按钮仍在，可重试
    }
    return { ok: true, message: '已连接 Apple 健康，步数与活动能量将自动同步。', vendor: 'apple' }
  }

  if (v.vendor === 'huawei' || v.vendor === 'xiaomi') {
    // 🔴 `canSync === false` ＝ 该机型当前**没有任何可用通道**，直接给可操作说明，
    //   **不假装调原生授权**（零假功能 / 铁律 #13）。
    //
    //   为什么必须拦在这里：原生厂商通道（DbeeHealthPlugin.requestAuthorization）
    //   恒返回 `reason='not_ready'`，而 `isAndroidVendorHealthAvailable()` 只检查
    //   「插件在不在」、不检查「厂商通道能不能用」→ 会返回 true，于是一路走到
    //   notReady 分支，只得到一句含糊的「接入正在申请资质」。用户既不知道
    //   **为什么**连不上，也不知道**现在该怎么办**（2026-11-18 华为 P40 实测反馈：
    //   「点击华为运动健康卡片右边的连接，没有任何反应」）。
    //
    //   华为具体三重锁：① Health Connect 需 Google Play services，华为无 GMS 装不上，
    //   且华为运动健康**不向 HC 写数据**（HMS/GMS 生态隔离）；② Health Kit 需企业资质
    //   + 应用先上架华为应用市场 + 约 25 工作日审核；③ HarmonyOS NEXT 只认 .hap、
    //   装不上 Android APK。资质就绪后把 brand.ts 的 canSync 改回 true 即恢复完整流程。
    if (!v.canSync) {
      return { ok: false, message: v.tip, vendor: v.vendor }
    }

    if (!isAndroidVendorHealthAvailable()) {
      // 插件未注入（非对应 Android / 尚未编译插件）：保留原占位提示
      return { ok: false, message: `${v.label}同步正在接入中，当前请先手动记录运动。`, vendor: v.vendor }
    }

    const auth = await requestAndroidVendorAuthorization()
    if (auth.notReady) {
      // 厂商资质未就绪（无真实授权 SDK），诚实引导，不误导为「用户拒绝授权」
      return {
        ok: false,
        message: `${v.label}接入正在申请资质，当前请先手动记录运动。`,
        vendor: v.vendor,
      }
    }
    if (!auth.completed) {
      return {
        ok: false,
        message: '授权未完成，可稍后在「我的 > 健康数据源」里重新连接。',
        vendor: v.vendor,
      }
    }

    // 授权流程完成 → 存云端连接状态（跨设备一致，与 Apple 端同一字段）+ 来源（WX-4 防串台）
    const dbVendor = healthVendorToDb(v.vendor) // huawei | xiaomi
    try {
      await saveProfile({
        health_connected: true,
        health_connected_at: new Date().toISOString(),
        ...(dbVendor ? { health_vendor: dbVendor } : {}),
      })
    } catch {
      // 存状态失败不阻断；本地连接态未落云端时按钮仍在，可重试
    }
    return { ok: true, message: `已连接${v.label}，步数与活动能量将自动同步。`, vendor: v.vendor }
  }

  if (v.vendor === 'wechat-miniprogram') {
    // WX-1~WX-3（2026-11-17）：微信运动真接入在**小程序端**实现（mini/src/lib/health）。
    // 主端 bundle 若在微信 WebView 里被加载，引导用户到微信运动入口主动同步；
    // 本端无 wx.getWeRunData 通道，不伪造连接成功（零假功能）。
    return {
      ok: false,
      message: '请在微信小程序内点「同步微信运动」连接；当前可先手动记录运动。',
      vendor: 'wechat-miniprogram',
    }
  }

  if (v.vendor === 'web') {
    if (isWechatWebView()) {
      return { ok: false, message: '微信运动数据请在微信内查看；D-Bee 已支持手动记录运动。', vendor: 'web' }
    }
    return { ok: false, message: '', vendor: 'web' }
  }

  return { ok: false, message: v.tip, vendor: v.vendor }
}

/**
 * 拉取当天步数 + 活动能量，并返回数据来源状态。
 * 按品牌分派：iOS → HealthKit；华为/小米 → 各自 Health Kit；否则 no_plugin。
 * 登录后（Dashboard 加载时）若已连接，调用本函数自动同步。
 *
 * status 用于区分「今天真的 0 步」与「读不到数据」：
 * 调用方应仅在 isUsableHealthStatus(status) 时把数值写回 UI，
 * 其余状态保留旧值并展示对应引导（授权被拒 → 去系统设置；出错 → 稍后重试）。
 *
 * HC-1（2026-11-18）：Android 上 **HC 优先**于厂商 SDK。probe 幂等（缓存命中
 * 零开销），故 60s 轮询热路径不会重复打跨进程查询。
 */
/** 智能设备面板用的当天读数。非 Android / 非 iOS 返回 null。 */
export async function fetchSmartDeviceReadings(): Promise<SmartDeviceSample | null> {
  if (isAndroid()) {
    await probeHealthConnectAvailability()
    if (!isHealthConnectAvailable()) return null
    return fetchHealthConnectDevices()
  }
  if (isHealthKitAvailable()) return fetchHealthKitDevices()
  return null
}

export async function syncFromHealth(): Promise<HealthSyncData> {
  if (isAndroid()) await probeHealthConnectAvailability()
  const v = getHealthVendor()
  if (v.vendor === 'apple') {
    if (!isHealthKitAvailable()) return { steps: 0, activeKcal: 0, status: 'no_plugin' }
    return fetchTodayHealth()
  }
  if (v.vendor === 'health_connect') {
    if (!isHealthConnectAvailable()) return { steps: 0, activeKcal: 0, status: 'no_plugin' }
    return fetchHealthConnectToday()
  }
  if (v.vendor === 'huawei' || v.vendor === 'xiaomi') {
    if (!isAndroidVendorHealthAvailable()) return { steps: 0, activeKcal: 0, status: 'no_plugin' }
    return fetchAndroidVendorToday()
  }
  // 微信小程序（wechat-miniprogram）：真同步在小程序端 mini/src/lib/health 独立实现
  // （用户主动触发 + 本地缓存）。主端 bundle 无 wx.getWeRunData 通道，保持 no_plugin
  // 静默降级，不影响任何现有端。
  return { steps: 0, activeKcal: 0, status: 'no_plugin' }
}

/**
 * 把同步状态翻译成给用户看的一句话（无可展示信息时返回空串）。
 *
 * 集中在此处而不是散在各页面：三处调用点（Dashboard 自动同步、Dashboard 手动连接、
 * 「我的 > 健康数据源」）需要完全一致的措辞，否则用户会以为是两个不同问题。
 *
 * @param isHealthConnect 数据来源是否为 Health Connect（Android 统一层）。
 *   🔴 denied 的权限入口两端不同：iOS 在「系统设置 > 健康 > 数据访问权限」，
 *   Android HC 在「Health Connect 应用 > 应用权限」。措辞错了用户找不到开关，
 *   会误判为「功能坏了」。默认 false → mini 端与 iOS 措辞零变化。
 *   🔴 empty 同理：HC 是**中转层**，本身不产生数据 —— 步数为空的真实原因几乎都是
 *   「数据源应用（小米运动健康 / 华为运动健康 / 手环 App）没往 HC 里写」。
 *   只说「今天还没有数据」会让用户干等（2026-11-18 小米 15 Ultra 实测：
 *   授权成功但读数一直无反应），必须给出可操作的检查路径。
 */
export function healthStatusHint(
  status: HealthSyncData['status'],
  vendorLabel: string,
  isHealthConnect = false,
): string {
  switch (status) {
    case 'denied':
      return isHealthConnect
        ? `${vendorLabel}读取权限未开启，步数不会同步。请打开「Health Connect」应用 > 应用权限 > 自律蜜蜂，勾选步数与活动热量。`
        : `${vendorLabel}读取权限未开启，步数不会同步。请到系统设置 > 健康 > 数据访问权限中勾选「自律蜜蜂」。`
    case 'error':
      return '读取健康数据时出错，请稍后重试；步数暂时保持上次结果。'
    case 'unavailable':
      return '当前设备不支持健康数据同步，请手动记录运动。'
    case 'not_ready':
      return `${vendorLabel}接入正在申请资质，当前请先手动记录运动。`
    case 'empty':
      return isHealthConnect
        ? `今天还没有读到步数。「${vendorLabel}」只是中转层，需要数据源先写入：请确认手机自带健康 App（如小米运动健康 / 华为运动健康）或手环 App 里，已开启向「Health Connect」共享步数，然后点「重新读取」。`
        : `今天还没有${vendorLabel}数据。确认设备已同步后，会自动读取。`
    case 'no_plugin':
    case 'ok':
    default:
      return ''
  }
}

/**
 * 解除连接：清云端状态，UI 恢复「连接」入口。
 * 不清系统侧授权（iOS 无 API 可撤销第三方读授权），
 * 重新连接时系统大概率不再弹窗、直接走完流程。
 */
export async function disconnectHealth(): Promise<void> {
  try {
    await saveProfile({ health_connected: false, health_connected_at: null, health_vendor: null })
  } catch {
    // 状态清除失败不抛出：下次连接会重新覆盖
  }
}

/**
 * 步数 → 活动消耗（kcal）换算。
 *
 * 采用「步幅法」估算：步行距离 = 步数 × 步幅，再按体重折算消耗。
 * 步幅按身高估算（身高 × 0.45，单位米），无身高时用默认 0.72m。
 * 每公斤体重每公里步行约消耗 0.75 kcal（中等步速）。
 *
 * 返回 0 安全值：缺体重或步数为 0 时不产生负值。
 */
export function estimateActivityKcal(
  steps: number,
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
): number {
  const s = Math.max(0, Math.round(steps || 0))
  if (s <= 0 || !weightKg || weightKg <= 0) return 0
  const strideM = heightCm && heightCm > 0 ? (heightCm / 100) * 0.45 : 0.72
  const km = (s * strideM) / 1000
  return Math.round(km * weightKg * 0.75)
}

/**
 * 活动消耗计入「可吃回」额度的比例（50%）。
 *
 * 依据：手环/步数普遍高估消耗 20% 左右，若 100% 回补会让人越减越肥
 * （Cal AI 用 80%、自律茄子用 100%，均被第三方评测点名）。50% 是安全折中。
 */
// 🔴 2026-11-08：值已下沉 @dbee/shared（四端单一真相源），此处保留同名导出，
//    Dashboard 的 import 路径不变，避免改动无关页面。
export { ACTIVITY_EATBACK_RATIO, DEFAULT_STEP_GOAL } from '@dbee/shared'
