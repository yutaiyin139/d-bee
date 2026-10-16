import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置。
 *
 * 设计要点（改动前请先读 docs/原生App化方案.md §2.1 与 §4）：
 *
 * 1. `server.androidScheme = 'https'`
 *    原生 WebView 若用 `http://localhost` 承载页面，页面不是 Secure Context，
 *    getUserMedia（扫码用）会直接不可用；且 http 与云端 https 混用会触发混合内容拦截。
 *    设为 https 后 Android 侧来源为 `https://localhost`。
 *
 * 2. `plugins.CapacitorHttp.enabled = true` ← 阶段 1 的成败关键
 *    云 SDK 以绝对地址 `${endpoint}/.cloud/...` 发请求并携带 apikey 请求头，
 *    在原生 WebView 里属于跨域；而云端在 CORS 预检时**不允许 apikey 请求头**
 *    （已实测）。开启 CapacitorHttp 后这些请求由原生层代发，绕开 WebView 的
 *    CORS 预检，apikey 才能生效。
 *    ⚠️ 关掉它 = 原生端登录后读不到任何数据。
 *
 * 3. webDir 指向 `dist`
 *    与 vite 构建输出一致；`npx cap sync` 会把它拷进两个原生工程。
 *    注意 `dist/` 与原生工程内的 web 资源副本都不入库（见 .gitignore）。
 */
const config: CapacitorConfig = {
  appId: 'com.dbee.app',
  appName: 'D-Bee',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  // iOS 端只纳入白名单插件。微信插件（@capgo/capacitor-wechat）当前因
  // 营业执照未办、WECHAT_LOGIN_ENABLED=false 而整体关闭，且其 SPM 包名
  // 带连字符与 Capacitor 8 的 CapApp-SPM 模板叠加会触发 SwiftPM 模块名
  // 转换兼容 bug（报 Missing package product Wechat_CapgoCapacitorWechat）。
  // 先排除它让 iOS 编译跑通；办照后启用微信时再单独处理其 SDK 集成。
  includePlugins: ['@dbee/origin-proxy', '@capacitor/share'],
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
}

export default config
