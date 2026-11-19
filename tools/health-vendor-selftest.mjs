/**
 * 品牌识别 + 三机型隔离自测。
 *
 * 覆盖 detectHealthVendor() 在 iOS / 华为 / 小米 / vivo / OPPO / 其它安卓 / Web
 * 七类环境下的返回，确保「三种真同步机型（Apple/华为/小米）互不影响、web 不变」。
 *
 * 通过 mock globalThis.window.Capacitor 与 globalThis.navigator.userAgent 模拟
 * 不同平台与 UA（brand.ts / platform.ts 均只做运行时探测，无编译期依赖）。
 *
 * 运行：node tools/health-vendor-selftest.run.mjs
 */
import { detectHealthVendor, isWechatWebView } from '../src/lib/health/brand'

let failed = 0
const assert = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

/** 模拟运行环境：platform 为 null 表示无原生容器（Web），ua 为 null 表示无 navigator */
function mockEnv(platform, ua) {
  if (platform === null) {
    // 无原生容器：删除 window（模拟纯浏览器）
    try {
      delete globalThis.window
    } catch {
      /* ignore */
    }
  } else {
    Object.defineProperty(globalThis, 'window', {
      value: { Capacitor: { getPlatform: () => platform, isNativePlatform: () => true } },
      configurable: true,
      writable: true,
    })
  }
  // Node 22 的 globalThis.navigator 是只读 getter，须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: ua === null ? undefined : { userAgent: ua },
    configurable: true,
    writable: true,
  })
}

// ── iOS 原生 ──────────────────────────────────────────────
mockEnv('ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/537.36')
let v = detectHealthVendor()
assert('iOS → apple / 可同步', v.vendor === 'apple' && v.canSync === true, JSON.stringify(v))

// ── 华为（HUAWEI / HarmonyOS 识别为 huawei；🔴 HONOR 已独立，见下）──
// 🔴 canSync 断言口径变更（2026-11-18 华为 P40 实测）：
//   华为三重锁（无 GMS 装不上 Health Connect / 华为运动健康不向 HC 写数据 /
//   Health Kit 需企业资质且应用须先上架华为应用市场）→ 厂商 SDK 恒返回 not_ready，
//   永远连不上。原先断言 canSync === true 等于把「点了必然失败的假连接按钮」钉进护栏，
//   与铁律 #13（零假功能）冲突。现钉死为 false：按钮显示「查看」而非「连接」。
//   资质获批后须**同时**改 brand.ts 与本断言（两处一起改才可能通过红验证）。
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; HUAWEI Mate 60) AppleWebKit/537.36')
v = detectHealthVendor()
assert('HUAWEI → huawei / 不可真同步', v.vendor === 'huawei' && v.canSync === false, JSON.stringify(v))
// 🔴 label 与 tip 都不得含华为品牌字样（华为把「入口/提示消息中出现 Huawei、华为运动健康
//   等字样」列为资质申请驳回理由 Incorrect Brand Icon Usage）
assert('HUAWEI 文案不含品牌字样', !/华为|HUAWEI|Huawei/i.test(`${v.label}${v.tip}`), JSON.stringify(v))

mockEnv('android', 'Mozilla/5.0 (Linux; HarmonyOS 4.0; HUAWEI) AppleWebKit/537.36')
assert('HarmonyOS → huawei', detectHealthVendor().vendor === 'huawei')

// 🔴 荣耀（HONOR）已于 2020 年从华为独立、跑 MagicOS 且**带 GMS**，是两个不同厂商。
//   原正则 /HUAWEI|HONOR|HarmonyOS/ 会把荣耀误判成华为 → 荣耀机型既拿到华为的错误
//   引导文案，又被华为的 canSync=false 连坐（荣耀其实可能能用 Health Connect）。
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; HONOR Magic6) AppleWebKit/537.36')
v = detectHealthVendor()
assert('HONOR → android-other（不误标华为）', v.vendor === 'android-other', JSON.stringify(v))
assert('HONOR 不等于 huawei', v.vendor !== 'huawei', JSON.stringify(v))

// ── 小米（Xiaomi / Redmi / MI 型号 / MIUI / HyperOS 五种 UA）──
// 🔴 canSync 同华为口径收紧：厂商 SDK 通道未接资质（恒 not_ready），故标 false。
//   小米真正可用的是 Health Connect（Android 14+ 系统内置），那条路由门面
//   getHealthVendor() 优先返回 health_connect（canSync=true），不经本分支。
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; Xiaomi 14) AppleWebKit/537.36')
v = detectHealthVendor()
assert('Xiaomi → xiaomi / 厂商通道不可真同步', v.vendor === 'xiaomi' && v.canSync === false, JSON.stringify(v))
// 同华为口径：提示里不出现厂商品牌名（各厂商开放平台协议多有同类条款）
assert('Xiaomi 文案不含品牌字样', !/小米|Xiaomi|Redmi|MIUI|HyperOS/i.test(`${v.label}${v.tip}`), JSON.stringify(v))

mockEnv('android', 'Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36')
assert('Redmi → xiaomi', detectHealthVendor().vendor === 'xiaomi')

mockEnv('android', 'Mozilla/5.0 (Linux; Android 13; MI 9) AppleWebKit/537.36')
assert('MI 9 → xiaomi', detectHealthVendor().vendor === 'xiaomi')

mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; MIUI/14) AppleWebKit/537.36')
assert('MIUI → xiaomi', detectHealthVendor().vendor === 'xiaomi')

mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; HyperOS 1.0) AppleWebKit/537.36')
assert('HyperOS → xiaomi', detectHealthVendor().vendor === 'xiaomi')

// ── vivo / OPPO：引导查看，不可真同步 ──────────────────────
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; vivo X100) AppleWebKit/537.36')
v = detectHealthVendor()
assert('vivo → vivo / 不可同步', v.vendor === 'vivo' && v.canSync === false, JSON.stringify(v))

mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; OPPO Find X7) AppleWebKit/537.36')
v = detectHealthVendor()
assert('OPPO → oppo / 不可同步', v.vendor === 'oppo' && v.canSync === false)

// ── 其它安卓品牌 → android-other，不可同步 ─────────────────
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36')
v = detectHealthVendor()
assert('Samsung → android-other / 不可同步', v.vendor === 'android-other' && v.canSync === false)

// ── Web（无 Capacitor）→ web，不显示连接入口 ──────────────
mockEnv(null, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36')
v = detectHealthVendor()
assert('Web → web / 不可同步', v.vendor === 'web' && v.canSync === false, JSON.stringify(v))

// ── 微信内置浏览器识别 ─────────────────────────────────────
mockEnv(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/537.36 MicroMessenger/8.0.49')
assert('微信 UA → isWechatWebView true', isWechatWebView() === true)

mockEnv(null, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120')
assert('普通浏览器 → isWechatWebView false', isWechatWebView() === false)

console.log(failed === 0 ? '\n=== 品牌识别自测全部通过 ===' : `\n=== ${failed} 项失败 ===`)
process.exit(failed === 0 ? 0 : 1)
