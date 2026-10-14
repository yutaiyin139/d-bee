# D-Bee（自律蜜蜂）· 项目长期记忆

## 项目定位

Web 版 V1.0.1 已于 2026-10-13 定版上线（主包指纹 `index-HKJ5Fec4.js`，部署在
http://150.158.51.106/，归档在 `backups/d-bee-v1.0.1-20261013.{tar.gz,zip}`）。
当前主线工作是**从 PWA 迁到原生 App**，技术方案见 `docs/原生App化方案.md`（权威文档，555 行）。

## 已定技术路线（不要再重新讨论）

| 项 | 决策 |
|---|---|
| 混合壳方案 | **Capacitor 8.5.3**（已排除 React Native / Tauri 2 Mobile / 纯 PWA 包装）。原文档写 Capacitor 7，2026-10-14 实施时修订：Cap 7 的 Extended Support 2026-12-08 到期；Cap 8 要求的 Xcode 26+ 正是苹果上传强制门槛；Cap 8 默认 SPM，Mac 上免装 CocoaPods |
| Web 栈 | React 18 + Vite 5 + TypeScript，PWA |
| iOS 构建机 | **用户自己的 Mac mini M4**（Apple Silicon），不用云 macOS CI，不需要公网 IP |
| iOS / Android | **并行推进**：Windows 跑 Android 构建，Mac mini 跑 iOS 构建 |
| appId | `com.dbee.app`，appName `D-Bee` |
| 工具链 | Node ≥ 22、JDK 21、Xcode ≥ 26.0、Android Studio ≥ Otter 2025.2.1 |

## 阶段划分（方案文档 §4）

- **阶段 0 代码解耦** —— ✅ 2026-10-13 完成；2026-10-14 独立复验通过
  （typecheck 0 错、build 成功、主包仅 +1,068 B / +0.27%、CSS/分包哈希不变、
  登录页与近 7 天报告渲染正常；证据见 `docs/阶段0-代码解耦-验收报告.md` 与 `docs/verify/`）
- **阶段 1 Capacitor 骨架跑通**（约 1 周）—— ✅ **2026-10-14 Android 侧全部完成**（iOS 待 Mac 验证）。
  Capacitor 8.5.3 + `android/` + `ios/`（SPM）；debug APK 8.32 MB（含微信 SDK）。
  **四项验收全过**：登录页渲染 / 邮箱验证码登录 200 / 首页读到云端数据 /
  记一餐+杀进程重开云端恢复（证据 `docs/verify/phase1-02..05-*.png`，
  报告 `docs/原生App-阶段1-方案B落地与验收.md`）。
  登录阻塞（云端 Origin 校验）已用**方案 B：自建 OriginProxy 原生转发插件**解决（见坑 10）。
  **iOS 遗留**：Swift 侧代码已写好但未编译验证，Mac mini 首次构建需回归同四项验收；
  `ios/App/App/public` web 资源未更新（句柄锁），构建前 `cap sync` 重建即可。
- **阶段 2 原生能力补齐**（约 2–3 周，按对过审贡献度排序）
- **阶段 3 支付改造**（redeem code → IAP，Apple 3.1.1）
- **阶段 4 提审**

## 架构约定（阶段 0 建立，后续必须遵守）

1. **平台差异一律走 `src/lib/` 下的抽象层**，业务代码不直接嗅探 `window.Capacitor`、
   不直接用 `localStorage`、不直接写 `<input capture>`、不直接 `a.download`。
   现有抽象：`platform.ts` / `kv.ts` / `capture.ts` / `scan.ts` / `share.ts`。
2. **抽象层用运行时鸭子类型探测 `window.Capacitor`，不 import 任何 Capacitor 包。**
   目的是让 Web 构建产物零新增依赖、包体积不变。接入原生能力时才在抽象层内部
   填充分支实现，业务代码不动。
3. **`cloudConfig.ts` 刻意保持零项目内依赖**（不 import `lib/platform`）。它是模块级
   初始化常量、最早求值，`detectNative()` 在文件内独立实现以免循环引用。改动时勿破坏。
4. `lib/barcode.ts` 只被 `lib/scan.ts` 引用，接入 MLKit 时只改 `scan.ts` 三个函数：
   `nativeStartScan` / `decodeFromImage` / `warmUpDecoder`。
5. **云端请求必须走 `OriginProxy` 转发（2026-10-14 方案 B）**：本地插件
   `native-plugins/dbee-origin-proxy` 在原生层强制注入 Origin/Referer（等于把 Nginx
   那两行搬进 App）。注入点用云 SDK 官方 `options.fetch`（`src/cloud.ts`），
   **不要 patch window.fetch**。Origin 值钉死三处：`src/lib/originProxy.ts` CLOUD_ORIGIN、
   Java/Swift 侧 DEFAULT_ORIGIN、Nginx —— 换域名必须三处同步改。
   Android 用 HttpURLConnection（勿引入 OkHttp）；响应体 Base64 回传；
   **不支持流式响应**（LLM stream 会退化为一次性返回）与 AbortSignal。

## 关键约束与坑

1. **endpoint 必须与页面来源同源（Web）或绝对 HTTPS（原生）。**
   - Web：取 `window.location.origin`，靠本站 Nginx 反代到云端（见 `deploy/nginx.conf.example`）
   - 原生：WebView origin 是 `capacitor://localhost`(iOS) / `https://localhost`(Android)，
     **不能**当 endpoint，必须钉死绝对 HTTPS 地址
   - 云 SDK 用绝对地址发请求，走跨域预检时**云端不允许 apikey 请求头**（已实测），
     所以 Web 端绝不能把 endpoint 指向云端域名，否则数据库请求整体被拦
2. **原生端直连云端依赖 `CapacitorHttp` 插件**（原生层补发请求绕过 WebView CORS 预检）。
   `capacitor.config.ts` 里必须 `plugins.CapacitorHttp.enabled = true`，否则 apikey 必挂。
3. **云 SDK 独占使用 localStorage 作为登录态真源**（其类型定义明确写「唯一真源」），无法抽象。
   原生 WKWebView 存储紧张时会清空 localStorage → 用户掉登录，这是**已知限制**，
   需要在 UI 做优雅降级，不要试图用 `kv.ts` 接管登录态。
4. **iOS ATS 要求 HTTPS**，裸 IP 需 ATS 例外。
5. `@capacitor-mlkit/barcode-scanning` 可省掉 966 KB 的 zxing wasm —— iOS WKWebView
   **不支持** `BarcodeDetector` API，只能走 zxing，所以原生端换 MLKit 既减包又提速。
6. **2026-04-28 起 App Store 上传强制要求 Xcode 26+**。
7. **Service Worker 在 `capacitor://` 协议下不注册**，且原生端要反注册历史 SW。
8. **微信登录（2026-10-14 接通代码侧，详见 `docs/微信登录接入.md`）**：
   - Web 走云 Relay 扫码（不需要自己的 AppID）；**原生端卡在云端**——
     `cloud.auth.signInWithWechat()` 只收**小程序** wx.login 的 code（jscode2session），
     移动应用 code 走 sns/oauth2/access_token，不能混用
   - 代码侧已就绪：`src/lib/wechat.ts` 抽象层 + `@capgo/capacitor-wechat` 插件 +
     双端工程配置；云端就绪前原生入口**整块隐藏**（`isWechatLoginAvailable()` 裁决），
     改 `NATIVE_CODE_EXCHANGE_SUPPORTED=true` 即启用，业务代码零改动
   - Android 微信回调 Activity 必须位于 `<包名>.wxapi.WXEntryActivity`，
     **applicationId 改名时必须同步改名**；app/build.gradle 必须显式声明
     wechat-sdk-android-without-mta:6.8.0（插件 implementation 不透出类型）
   - iOS Info.plist 的 CFBundleURLSchemes 是占位 `wx0000000000000000`，**提审前必须替换**；
     iOS 微信 SDK 来自第三方 SPM 镜像 yanyin1986/WechatOpenSDK（供应链风险，上线前核对）
   - 接微信 SDK 的体积代价：APK +3.27 MB（5.05→8.32 MB）
9. **cap sync 的 safe-delete 守卫（2026-10-14 升级）**：会中断删除
   `android/capacitor-cordova-android-plugins/` 和 `ios/App/App/public/`；守卫
   `ETIMEDOUT` 时目录被锁死，连 `mv`/`Rename-Item` 都 Permission denied（gradle daemon
   与进程句柄都会引发）。绕法按优先级：① 变更仅涉及 web 资源时 `npx cap copy android`
   （不删插件目录，最省事）；② 构建前 `./gradlew --stop` 再 `mv` 目标目录到临时目录
   （非删除、不触发守卫）后跑 `cap sync` 完整重建；③ 实在不行留给 Mac 侧 cap sync 重建。
10. **云端按 Origin 做客户端校验 —— 已解决（方案 B，2026-10-14）**：Web 端靠 Nginx 强制
    `proxy_set_header Origin https://zilv-mifeng.app.workbuddy.host` 过白名单；原生端
    CapacitorHttp 不发 Origin，`/signup`/`/signin` 一律 401 `invalid_grant`（发码/验码却 200）。
    JS 补 Origin 无效（forbidden header 被 Request 构造过滤，logcat 已证实）。
    ~~云方加白名单~~ 已核实平台无此配置入口（publishable key 的 Origin 是创建时预留的
    发布域名，一应用一个、不可改，ops-free 无控制台）。**实际修复 = 自建 OriginProxy
    插件**（架构约定第 5 条），对照实验证实：错误 Origin → 403 access_denied、
    正确 Origin → 进业务校验。诊断：`adb logcat | grep d-bee-origin` 看每请求的 Origin。
11. **邮箱注册的 `is_user` 判断有坑**：signup 401（会话签发失败）但账号实际已建；
    重试时 is_user 变 true、signup 变 409 ALREADY_EXISTS。需把 409 引导到登录路径。
    云端错误文案是英文透传，需在 AuthScreen 做中文映射。
12. **模拟器网络修复**：沙箱会拦虚拟网卡（只有 lo/dummy0）→ 必须沙箱外启动；
    起来后 `cmd wifi connect-network AndroidWifi open`；若 `Active default network: none`
    则关强制门户（captive_portal_mode 0）再重连，否则 App 无 DNS（ping 通 IP 但域名解析失败）。
13. **验收工具**：`tools/android-cdp.py` 可在原生 WebView 里执行 JS（CDP），
    替代盲点坐标；依赖 websocket-client（已装 WorkBuddy venv）。登录页底部有
    「连接自检」面板（`src/native/`，动态 import，Web 主包仅 +531 B），
    结构化结果同时写 logcat，`adb logcat | grep d-bee-diag` 可读。

## 过审合规要点（不能忘）

- **Apple**：4.2（最低功能，前 4 项原生能力是主要弹药）、3.1.1（数字内容必须 IAP，
  `src/lib/entitlement.ts` 里的 `REDEEM_CODES` 必须在阶段 3 删掉）、
  5.1.1(v)（账号删除）、5.1.1（AI 第三方数据告知同意）、2.1、2.3.3、1.5
- **中国**：ICP 备案、App 备案、软件著作权、算法备案、大模型服务登记、
  ICP 经营许可证（收费才需要）、PIPL 隐私同意

## 工作方式约定

- 用户偏好**需求驱动、多轮递进**的工作方式，要求「写 → 验 → 报」小步验证
- 交付缺陷/进度类文档用 **`.docx`** 形式
- 仓库跨机同步**只走 Git 私有仓库**，绝不用共享目录（换行符 / 权限位差异会引发难以排查的构建错误）
- 用户会要求「记录进度，明天继续」——收工时要把**进度快照 + 明日待办 + 需用户拍板的前置决策**
  一并写入当日日志

## 待用户拍板的开放决策

1. ~~是否立即 `git init` 并提交阶段 0~~ ✅ 2026-10-14 已完成（基线 `f99a2c5`）
2. 是否先补最小回归用例集再进阶段 1（建议：是，项目当前无任何测试框架）
3. ~~远程私有仓库放哪~~ ✅ 已定 GitHub（`yutaiyin139/d-bee`）；若推送持续不畅可加 Gitee 镜像
4. 是否启用自有域名 `d-bee.com.cn`（涉及备案进度）

## 环境备忘

- 项目**已于 2026-10-14 纳入 Git**：远端 `https://github.com/yutaiyin139/d-bee.git`，
  分支 `main`，基线提交 `f99a2c5`（108 文件）。**推送尚未成功**——本机到 github.com
  不通（代理 502 / 直连超时），需用户在有代理的网络下执行
  `git push -u origin main`，或改用 SSH / Gitee。离线兜底：
  `backups/d-bee-baseline-<提交号>.bundle`（可拷到 Mac 直接 `git clone`）。
- 换行符策略：仓库根有 `.gitattributes`（`* text=auto eol=lf` + 二进制白名单），
  **两台机器都必须 `git config --global core.autocrlf false`**，不得设 true。
- 双机同步流程见 `docs/Git工作流.md`（权威文档）。
- `package.json` **无测试框架、无 lint 脚本**；scripts 只有 `dev` / `build` / `typecheck` / `preview` / `start`
- 本机 3000 端口常被占用，`npm run dev` 会自动退到 3001
- 访问本机 dev server 时 curl 需加 `--noproxy '*'`（环境有代理）
- 本机 `git` 走 https 访问 github.com 会被沙箱代理拦（`CONNECT tunnel failed, 502`），
  直连也超时——涉及 GitHub 的网络操作交给用户执行
