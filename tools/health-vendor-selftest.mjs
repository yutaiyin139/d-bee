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

// ── 华为（HUAWEI / HONOR / HarmonyOS 三种 UA 都识别为 huawei）──
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; HUAWEI Mate 60) AppleWebKit/537.36')
v = detectHealthVendor()
assert('HUAWEI → huawei / 可同步', v.vendor === 'huawei' && v.canSync === true, JSON.stringify(v))

mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; HONOR Magic6) AppleWebKit/537.36')
assert('HONOR → huawei', detectHealthVendor().vendor === 'huawei')

mockEnv('android', 'Mozilla/5.0 (Linux; HarmonyOS 4.0; HUAWEI) AppleWebKit/537.36')
assert('HarmonyOS → huawei', detectHealthVendor().vendor === 'huawei')

// ── 小米（Xiaomi / Redmi / MI 型号 / MIUI / HyperOS 五种 UA）──
mockEnv('android', 'Mozilla/5.0 (Linux; Android 14; Xiaomi 14) AppleWebKit/537.36')
v = detectHealthVendor()
assert('Xiaomi → xiaomi / 可同步', v.vendor === 'xiaomi' && v.canSync === true, JSON.stringify(v))

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
