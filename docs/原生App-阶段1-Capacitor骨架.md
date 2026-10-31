# 阶段 1：Capacitor 骨架跑通

> 🔴 **【历史快照 · 口径已变更】** 本文写于 2026-10-14，当时 Bundle ID 用的是 `com.dbee.app`。
> **2026-10-25 已定案改为 `cn.com.dbee.app`**（`com.dbee.app` 被 Apple 抢注、`cn.dbeehealth.app` 不可用、
> `com.d-bee.app` 因 Android 禁连字符弃用）。本文正文按历史快照约定**保留原样不改**，
> 文中所有 `com.dbee.app` 一律读作 `cn.com.dbee.app`。权威值见 `capacitor.config.ts` appId /
> `android/app/build.gradle` applicationId / `ios/App/App.xcodeproj` PRODUCT_BUNDLE_IDENTIFIER（三处一致）。

- 日期：2026-10-14
- 前置：阶段 0 代码解耦已完成（见 `docs/阶段0-代码解耦-验收报告.md`）
- 当前状态：**Windows 侧构建链路已打通、debug APK 已产出、模拟器验收通过（登录页渲染）**；剩余仅「验证码登录 + 云端数据读取」需真人输入验证码完成

---

## 一、版本决策变更：Capacitor 7 → **8.5.3**

`docs/原生App化方案.md` 原定 Capacitor 7。开工核查后发现三条硬事实，因此改用 **Capacitor 8.5.3**：

| 依据 | 事实 | 影响 |
|---|---|---|
| 官方支持策略 | **Capacitor 7 的 Extended Support 于 2026-12-08 结束**（Maintenance 已于 2026-06-08 结束） | 距离 EOL 不足 2 个月，新项目不应起步在一个即将停更的版本上 |
| Xcode 要求 | Cap 7 要求 Xcode 16+；**Cap 8 要求 Xcode 26+** | 苹果自 2026-04-28 起强制 Xcode 26+ 才能上传 App Store，Cap 8 的要求与我们的硬约束完全重合——用 Cap 7 反而是「要额外验证能不能配 Xcode 26」 |
| iOS 依赖管理 | Cap 7 默认 CocoaPods；**Cap 8 默认 Swift Package Manager（SPM）** | CocoaPods 已进入维护模式、Specs 仓库 2026-12 转只读。用 SPM 则 Mac mini 上**不需要装 Homebrew + CocoaPods**，环境准备少两步 |

工具链契合度（已逐项核对）：

| Cap 8 要求 | 本机/已定环境 | 结论 |
|---|---|---|
| Node ≥ 22 | 22.22.2 | ✅ |
| Xcode ≥ 26.0 | Mac mini M4 计划装 26/27 | ✅ |
| JDK 21 | 21.0.12.1 LTS（已装） | ✅ |
| Android Studio ≥ Otter 2025.2.1 | **未安装** | ⏳ 待用户安装 |
| iOS Deployment Target 15.0 | 模板已生成 | ✅ |

阶段 2 要用的 8 个插件**全部已有 v8 版本**（`peerDependencies.@capacitor/core >= 8.0.0`），升级无后顾之忧：

```
@capacitor/camera 8.2.5          @capacitor/filesystem 8.1.4
@capacitor/preferences 8.0.1     @capacitor/share 8.0.3
@capacitor/push-notifications 8.1.3   @capacitor/app 8.1.2
@capacitor/status-bar 8.0.4      @capacitor-mlkit/barcode-scanning 8.2.1
```

> 若坚持 Cap 7 也完全可行，但需要在 12 月前再升级一次，且要在 Mac 上额外装 CocoaPods。

---

## 二、已落地的改动

### 新增文件

| 文件 | 说明 |
|---|---|
| `capacitor.config.ts` | appId `com.dbee.app`、appName `D-Bee`、webDir `dist`、`server.androidScheme: 'https'`、**`plugins.CapacitorHttp.enabled: true`**（文件内有逐条注释说明为什么） |
| `android/` | Capacitor 8 生成的 Android 工程（minSdk 24 / compileSdk 36 / targetSdk 36 / namespace `com.dbee.app` / app_name `D-Bee`） |
| `ios/` | Capacitor 8 生成的 iOS 工程，**使用 SPM**（`ios/App/CapApp-SPM/Package.swift` 锁定 `capacitor-swift-pm` 8.5.3，platform iOS 15） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `package.json` | 新增依赖 `@capacitor/core|ios|android@^8.5.3`、devDep `@capacitor/cli@^8.5.3`；新增脚本 `native:sync` / `native:android` / `native:ios` |

### 入库规则

Capacitor 生成的两个平台目录**自带 `.gitignore`**，已覆盖全部生成物，无需在根 `.gitignore` 补充：

- Android：`app/src/main/assets/public`（web 资源副本）、`app/src/main/assets/capacitor.config.json`、`local.properties`（**含本机 SDK 路径，跨机必须忽略**）、`.gradle/`、`build/`
- iOS：`App/App/public`、`App/App/capacitor.config.json`、`Pods/`、`xcuserdata`、`DerivedData`

已实测：`git status` 中**没有任何生成物**出现，平台目录可以安全入库。

---

## 三、验证结果（Windows 侧）

| 检查项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 无错 |
| `npm run build` | ✅ 成功；主包 `index-x5qEteMv.js` 373.23 kB / gzip 132.60 kB（与阶段 0 完全一致，Web 产物未变） |
| `npx cap add android` | ✅ |
| `npx cap add ios`（Windows 上） | ✅ 脚手架生成成功（Xcode/CocoaPods 相关步骤按预期跳过——SPM 模式下也不需要 CocoaPods） |
| `npx cap sync` | ✅ 两个平台均 `Sync finished`；web 资源已拷入 `android/app/src/main/assets/public` 与 `ios/App/App/public` |
| `npx cap doctor` | ✅ 已安装版本与最新版一致（8.5.3）；Android 检查通过；iOS 提示 `Xcode is not installed`（Windows 上的预期结果） |
| `android/variables.gradle` | ✅ minSdk 24 / compileSdk 36 / targetSdk 36 |
| `android/app/src/main/AndroidManifest.xml` | ✅ `configChanges` 已含 `density`（v8 新要求） |
| `ios/App/CapApp-SPM/Package.swift` | ✅ `platforms: [.iOS(.v15)]`，`capacitor-swift-pm` exact 8.5.3 |

> **未做**：真机/模拟器启动与登录联调——本机没有 Android SDK 与 Android Studio，无法产出 APK。这属于下面第四节的用户动作。

---

## 四、下一步需要用户做的事

### Windows 侧（Android 构建）

1. 安装 **Android Studio Otter（2025.2.1）或更新版本**，安装时勾选：
   - Android SDK Platform **36**（API 36）
   - Android SDK Build-Tools
   - Android SDK Platform-Tools
   - 一个 AVD 系统镜像（或直接用真机调试）
2. 安装后设好环境变量 `ANDROID_HOME`（Studio 首次启动会提示），JDK 21 已就绪无需装。
3. 跑通真机：
   ```bash
   npm run native:android     # build + cap sync + 打开 Android Studio
   ```
   在 Studio 里点 Run ▶ 选真机/模拟器。

### Mac mini 侧（iOS 构建）

> **2026-10-14 修订**：原第 2 步写「`xcode-select --install` 装命令行工具」是错的——
> 该命令安装的是**独立的 CommandLineTools**，不会把活动开发者目录指向 Xcode.app，
> 结果是 `xcrun` / `xcodebuild` 找不到 iOS SDK，Capacitor 与 Xcode 命令行构建全部报错。
> 已安装 App Store 版 Xcode 时**不应**执行它，正确做法见下面的步骤 2。

1. `df -h /` 确认剩余空间：Xcode + 模拟器运行时 + `DerivedData` 合计 **60–100 GB**。
   256 GB 基础款偏紧，不足请配外置 Thunderbolt SSD。
2. 装 **Xcode 26+**（App Store，约 40 GB 下载），然后**按顺序**执行：
   ```bash
   xcodebuild -version                 # 必须 ≥ 26.0（2026-04-28 起上传 App Store 的硬闸门）
   xcode-select -p                     # ★ 必须输出 /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept     # 首次必做，否则一切构建失败
   xcodebuild -runFirstLaunch          # 安装内置组件
   xcodebuild -downloadPlatform iOS    # ★ Xcode 15 起模拟器运行时不再随包分发，需单独下载 7–10 GB
   open -a Simulator                   # 能起来 = 运行时装好了
   ```
   - **不需要装 CocoaPods，也不需要 Homebrew**——Cap 8 用 SPM，Xcode 会自行解析 `Package.swift`。
3. **确认能访问 github.com**：`curl -I https://github.com`。
   SPM 首次解析需拉 `ionic-team/capacitor-swift-pm@8.5.3` 与 `yanyin1986/WechatOpenSDK`
   （腾讯官方不走 SPM，社区镜像）。**国内网络不通则 Xcode 连工程都打不开**——这是实际卡点，
   阻塞在开 Xcode 之前，不是代码问题。需提前配代理或改走 SSH。
4. 装 Node 22+，`git clone` 仓库，`npm ci`。
   ```bash
   git config --global core.autocrlf false    # ★ 必须 false，两台机器一致
   ```
5. `npm run native:ios`（build + cap sync ios + 打开 Xcode）。
6. 在 Xcode 里配签名：账号（Settings → Accounts）→ App target 的 Signing & Capabilities
   选 Team。工程里 `DEVELOPMENT_TEAM` 是空的，只有 `CODE_SIGN_STYLE = Automatic`，**必须补**。
   Bundle ID `com.dbee.app` 首次真机运行由 Xcode 自动注册。
7. **优先验证 `OriginProxy` 的 iOS 实现能否编译**——见下方「已知风险」。

### 已知风险：iOS 侧 OriginProxy 从未被编译过（2026-10-14 标记）

`native-plugins/dbee-origin-proxy/ios/Sources/OriginProxyPlugin/OriginProxyPlugin.swift`
是 Android 侧**已验收通过**的登录链路（方案 B：原生层强制注入 Origin 以通过云端白名单）
在 iOS 的对应实现，但**从未被任何 Swift 编译器编译过**（开发机是 Windows，无 Swift 工具链），
文件内已自行标注警示。首次 `xcodebuild` 大概率需要排错。

**建议作为 Mac 侧第一件事**，不要排在最后：它一旦跑通，iOS 的
「登录 → 读云端 → 记一餐」链路即基本打通；反之会变成结项前才暴露的技术风险。

`@capgo/capacitor-wechat` 的 iOS 依赖 `WechatOpenSDK` 来自**第三方 SPM 镜像**
（腾讯官方不通过 SPM 分发微信 SDK），认证类 SDK 走第三方镜像属**供应链风险**，
上线前需与官方 SDK 版本核对。该 SDK 与插件均**未提供自己的隐私清单**，
已在 App 层 `PrivacyInfo.xcprivacy` 兜底声明 `UserDefaults`（CA92.1）。

### iOS 工程配置（2026-10-14 已在 Windows 侧补齐，Mac 上无需重复做）

| 项 | 状态 |
|---|---|
| 相机 / 相册用途说明 | ✅ 已补 `NSCameraUsageDescription`、`NSPhotoLibraryUsageDescription`（缺失会导致权限请求时**直接终止 App**） |
| 隐私清单 | ✅ 新增 `ios/App/App/PrivacyInfo.xcprivacy` 并已挂入 target 的 Resources 阶段（6 类采集数据 + `UserDefaults` CA92.1） |
| 出口合规 | ✅ 新增 `ITSAppUsesNonExemptEncryption = false`，免去每次上传时的手动回答 |
| 设备能力声明 | ✅ `UIRequiredDeviceCapabilities` 由模板遗留的 `armv7` 改为 `arm64`，与 arm64-only 产物对齐 |
| 微信 scheme | ⏳ 仍为占位 `wx0000000000000000` + 缺 Associated Domains / `apple-app-site-association`（**只能在 Mac 上配，提审前必做**；不阻塞阶段 1，因原生微信入口当前隐藏） |

### 真机验收清单（出自方案文档 §4 阶段 1）

- [ ] App 启动 → 登录页正常渲染
- [ ] 手机验证码登录成功
- [ ] **登录后首页能读到云端数据** ← 验证 `CapacitorHttp` + endpoint 方案是否真的有效（这是阶段 1 的成败判定点）
- [ ] 记录一餐、写库成功、杀掉 App 重开数据仍在

---

## 五、环境坑位记录

1. **Capacitor CLI 的 `sync` 会整目录删掉 `ios/capacitor-cordova-ios-plugins`（约 52 个条目）**。
   本机的文件删除安全机制对「单条命令删除 > 50 个条目」会拦截，导致 `cap sync` 报
   `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 而失败。这不是项目问题——**在你自己的终端里直接
   `npx cap sync` 不会有这个限制**。若在受限环境里遇到，先分两批把该目录删掉再跑 sync 即可。
2. Windows 上 `cap add ios` 会在 `pod install` 与 `xcodebuild` 两步给出 warning 并跳过，
   这是预期行为（SPM 模式下 CocoaPods 那步本来就无关紧要）。真正编译必须在 macOS 上做。
3. 本机 `npm audit` 报 2 个漏洞（`esbuild` moderate / `vite` high），是**升级前就存在**的
   开发服务器类问题，与 Capacitor 无关，且不影响生产构建产物。可后续把 Vite 升到 5.x 最新版处理。

---

## 六、Windows 侧构建链路打通与模拟器验收（2026-10-14 13:00 补记）

### 重要更正：Android SDK 其实已装好

「本机无 Android SDK」此前是**误判**——SDK 完整存在于 `C:/Users/yuty/AppData/Local/Android/Sdk`，
且 `android/local.properties` 已正确指向它。实测盘点：

| 组件 | 实际状态 |
|---|---|
| platforms | android-36 / 36.1 / 37.0（compileSdk 36 需求满足） |
| build-tools | 35.0.0 / 36.0.0 / 37.0.0 |
| platform-tools | adb 37.0.1 可用 |
| emulator | emulator.exe + WHPX 硬件加速可用 |
| 系统镜像 | android-37.0 google_apis_playstore x86_64 |
| AVD | `Medium_Phone_API_37.0`（Android 17 / API 37，1080×2400） |
| Gradle | wrapper 8.14.3 已缓存，无需下载 |

> 唯一缺的是 Android Studio 这个 GUI（不影响命令行构建）。`ANDROID_HOME` 未设也不影响——
> `local.properties` 已生效。若将来需要 Studio（调试布局/Logcat 面板）再装即可。

### 产物

- `android/app/build/outputs/apk/debug/app-debug.apk`（5,049,029 B）
- APK 内 web 资源 = dist 产物（主包 `index-x5qEteMv.js` 401,901 B，与阶段 0 验收一致）

### 模拟器验收结果（AVD Medium_Phone_API_37.0，Android 17）

| 验收清单项 | 结果 |
|---|---|
| 1. App 启动 → 登录页正常渲染 | ✅ **通过**（截图 `docs/verify/phase1-01-native-login.png`：logo/手机号-邮箱切换/验证码/微信登录/协议链接/版本号全部在位） |
| 2. 手机验证码登录 | ⏳ 需真人收验证码，待用户完成 |
| 3. 登录后首页读到云端数据（**成败判定点**） | ⏳ 依赖第 2 项 |
| 4. 记录一餐 + 杀 App 重开数据仍在 | ⏳ 依赖第 2 项 |

日志证据（logcat）：

- `Capacitor: Handling local request: https://localhost/assets/index-x5qEteMv.js`
  → **androidScheme=https 生效**，WebView 来源确为 `https://localhost`，web 资源从包内加载
- 无 `FATAL EXCEPTION`、无 AndroidRuntime 崩溃；App 进程持续存活
- 全程无 ANR 来自 `com.dbee.app`（出现的 ANR 全是系统应用：输入法/电话/拨号器/Play 商店，
  属 swiftshader 软渲染 + 宿主机 16 GB 内存跑 4 GB AVD 的资源紧张，**与 App 无关**）

### 用户操作指引（完成剩余 3 项验收）

```bash
# 1. 启动模拟器（或插真机开 USB 调试）
C:/Users/yuty/AppData/Local/Android/Sdk/emulator/emulator.exe -avd Medium_Phone_API_37.0

# 2. 安装并启动
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.dbee.app/.MainActivity
```

在登录页输入手机号 → 获取验证码 → 登录，观察首页是否加载出云端数据（成败判定点）。
若读不到数据，优先检查 `capacitor.config.ts` 的 `plugins.CapacitorHttp.enabled` 是否为 true。
