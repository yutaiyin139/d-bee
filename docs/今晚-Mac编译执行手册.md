# 今晚 Mac 编译执行手册（iOS 1.7.0 build 9）

> 生成：2026-10-23 19:30 ｜ 对应提交：`9e1db43`（main，已推送 GitHub）
> 目标：首次在 Mac 上编译 D-Bee iOS 工程并**编译无误**，真机跑通基础回归。
> 本手册由 Windows 侧全量静态审查后产出，所有「预期错误点」均已逐一核对过官方 SDK 源码。

---

## 〇、结论速览（先读这个）

**编译通过置信度：高。** 静态审查已完成以下全部核对，未发现会阻断编译的问题：

| 审查项 | 结果 |
|---|---|
| 3 个自研 Swift 插件源码（iap/health/origin-proxy） | ✅ 类声明与官方 `SharePlugin`/`CameraPlugin` 逐字节同构（`@objc(Xxx)` + `CAPPlugin, CAPBridgedPlugin` + identifier/jsName/pluginMethods 三属性） |
| 插件调用的 Capacitor API 签名 | ✅ 对照本机 `@capacitor/ios@8.5.3` 源码逐一核实（`getArray`/`getObject`/`getString`/`resolve`/`reject` 全部存在且签名匹配） |
| StoreKit 2 API（`Product.products` / `purchase` / `Transaction.currentEntitlements` / `appStoreReceiptURL`） | ✅ 全部 iOS 15.0+ 可用，与工程 Deployment Target 15.0 匹配 |
| HealthKit API（`HKStatisticsQuery` / `requestAuthorization`） | ✅ 无版本问题 |
| SPM 清单链（CapApp-SPM → 3 本地包 + share/camera） | ✅ `cap sync ios` 在 Windows 上重跑成功，识别 5 插件，重生成清单与入库版本 0 diff；官方两插件包根 `Package.swift` 均存在且产品名匹配 |
| pbxproj | ✅ `CODE_SIGN_STYLE=Automatic`、BundleID `com.dbee.app`、iOS 15.0、arm64 声明正确；**DEVELOPMENT_TEAM 留空是预期**（Mac 上登录账号后 Xcode 自动写入） |
| entitlements | ✅ HealthKit 已配。**In-App Purchase 不需要 entitlements key**——StoreKit 对 App Store 应用是隐式能力（旧文档说要加 capability 是误判，已修正） |
| Info.plist | ✅ 相机/相册/健康四项用途说明齐全、`ITSAppUsesNonExemptEncryption=false`、微信占位 AppID 无副作用（入口已隐藏） |
| 隐私清单 PrivacyInfo.xcprivacy | ✅ 6 类采集 + UserDefaults(CA92.1)，无 Tracking |
| 微信插件 | ✅ 按设计排除在 iOS 外（`capacitor.config.ts` ios.includePlugins 无它），避开 SwiftPM 连字符包名 bug |
| web 资源 | ✅ 本机已重新 `npm run build` + `npx cap sync ios`，产物含轮 5 的网关验签切换（`payment/apple/verify`）。**但这些是 gitignore 的生成物，Mac 上 clone 后必须重跑**（见步骤 2） |
| TS 侧 | ✅ `npm run typecheck` 全绿 |

**今晚可达成的目标分两档：**
- ✅ **必达**：编译通过 + 真机运行 + 登录/记一餐/健康授权回归（数据面仍走云库，与现在 Android 端一致）
- ⏸ **不可达（依赖外部）**：沙盒购买全链路——需 App Store Connect 建 App + 3 商品 + 接受《付费应用协议》，且服务端 0037 迁移 + `APPLE_*` env 未部署。今晚编译后 IAP 代码可验证到 `getProducts` 返回空列表/报错为止（预期行为，不算故障）。

---

## 一、环境要求（缺一不可）

| 项 | 要求 | 原因 |
|---|---|---|
| macOS | 能装 Xcode 26 的版本（macOS 15+） | Capacitor 8 硬要求 Xcode 26.0+ |
| Xcode | **26.0+**（App Store 或 developer.apple.com 下载，首次启动会装组件） | Capacitor 8；且 2026-04-28 起 ASC 拒收旧 Xcode 构建 |
| Node | **22+**（`node -v` 确认） | Capacitor 8 CLI 声明 engines ≥22 |
| Apple ID | 已登录 Xcode，且是**已通过的开发者账号**（个人开发者已通过） | 签名必需 |
| 真机 | iPhone（iOS 15+），数据线 + 已信任此电脑 | HealthKit/StoreKit 模拟器不可全测 |

---

## 二、逐步命令（照抄即可）

```bash
# 1. 拉代码（若 Mac 上已有仓库则 git pull；确认 HEAD = 9e1db43 或更新）
git clone https://github.com/yutaiyin139/d-bee.git
cd d-bee
git log --oneline -1        # 应显示 9e1db43 feat(iap): Apple 验签落地...

# 2. 装依赖 + 重建 web 产物 + 同步 iOS 工程（一条命令搞定）
#    ⚠️ dist/ 与 ios/App/App/public/ 不入库，clone 下来没有，必须重建！
node -v                      # 确认 ≥22
npm ci                       # 严格按 package-lock 安装（含内部 SDK，公共 registry，可复现）
npm run native:ios           # = vite build + cap sync ios + cap open ios（会自动开 Xcode）
#    若不想自动开 Xcode，用：npm run build && npx cap sync ios
```

**`npm run native:ios` 成功标志**：输出 `Found 5 Capacitor plugins for ios`（origin-proxy / share / health / iap / camera，**没有** wechat——这是刻意的），然后 Xcode 自动打开。

```text
# 3. Xcode 内操作（GUI，无法命令化）
a) 顶部 scheme 确认选中 App，设备选你的 iPhone 真机
b) 左侧项目树点 App（蓝色图标）→ TARGETS: App → Signing & Capabilities
   → Team: 选你的开发者账号（个人）
   → Bundle Identifier 确认是 com.dbee.app（若 ASC 还没建这个 App ID，
     自动签名会在 Developer 后台自动注册一个，正常）
c) ⏺ Product → Run（Cmd+R）—— 首次编译要解析 SPM 远程包
   （capacitor-swift-pm 8.5.3 + ion-ios-camera），需联网，耐心等
d) 编译成功 → 自动装到真机并启动
```

```text
# 4. Archive（可选，仅当今晚要传 TestFlight 时才做；建议先真机 Run 回归）
Product → Destination 改 Any iOS Device (arm64) → Product → Archive
→ Organizer 弹出 → Distribute App → App Store Connect
（注意：沙盒 IAP 测试用 TestFlight 也可以，但商品未建则无意义）
```

---

## 三、预期错误点与修法（按出现概率排序）

| # | 症状 | 原因 | 修法 |
|---|---|---|---|
| 1 | `Signing for "App" requires a development team` | DEVELOPMENT_TEAM 留空（预期状态） | Signing & Capabilities → Team 选账号（步骤 3b） |
| 2 | SPM 拉包超时/失败（`failed to clone ... capacitor-swift-pm`） | 首次编译需从 GitHub 拉两个远程包，国内网络波动 | Xcode → File → Packages → Reset Package Caches 后重试；或挂代理；`ion-ios-camera` 来自 `github.com/ionic-team`，同理 |
| 3 | `Missing package product 'Wechat_CapgoCapacitorWechat'` | 不该出现（微信插件已按平台排除）。若出现说明 `capacitor.config.ts` 被改过 | 检查 `ios.includePlugins` 里**没有** `@capgo/capacitor-wechat`；重跑 `npx cap sync ios` |
| 4 | `no such module 'Capacitor'`（自研插件报） | SPM 本地包缓存脏 | Reset Package Caches；仍不行则 `rm -rf ~/Library/Caches/org.swift.swiftpm` 后重开 |
| 5 | HealthKit 相关真机报错 `healthkit not available`（模拟器） | 模拟器无 HealthKit | 用真机；插件已防御（`isHealthDataAvailable()` 检查，模拟器返回 0 不崩溃） |
| 6 | 真机启动后白屏 | `ios/App/App/public` 没同步到最新 dist | 回终端重跑 `npm run build && npx cap sync ios`，Xcode 里 Cmd+R 重跑 |
| 7 | 编译警告 `was never used` / deprecation | 无害 | 忽略，不阻断 Archive |

> **若出现清单外的 Swift 编译错误**：把完整报错发回来（截图或文本），Windows 侧可即时修源码推 GitHub，Mac 端 `git pull` 即可。3 个插件总共 ~400 行 Swift，单点修复很快。

---

## 四、真机回归清单（编译通过后按序验证）

| # | 用例 | 预期 | 涉及插件 |
|---|---|---|---|
| 1 | 手机号 + 短信验证码登录 | ✅ 能收到真短信（iOS 数据面走云库，云侧有真短信服务） | origin-proxy（Origin 注入） |
| 2 | 记一餐（文字） | 保存成功，列表可见 | origin-proxy |
| 3 | 拍照/相册识别餐食 | 相机权限弹窗文案 = Info.plist 里写的具体用途 | camera |
| 4 | 扫码 | 摄像头拉起、条码识别 | camera + zxing |
| 5 | 我的 → 健康数据源 → 连接 Apple Health | 授权弹窗（步数+活动能量）→ 完成后今日步数计入活动消耗 | dbee-health |
| 6 | 分享 | 系统分享面板拉起 | share |
| 7 | 付费墙打开 → 商品列表 | ⏸ **预期为空或报错**（ASC 商品未建、服务端 0037 未部署）。只需确认 App 不崩溃、不白屏 | dbee-iap |
| 8 | 控制台看原生日志 | Xcode 底部 console 无红色崩溃栈；`[originProxy]` 无「未发现插件」警告 | — |

**用例 7 特别说明**：`DbeeIap.getProducts` 在 ASC 无商品时 StoreKit 返回空数组，前端付费墙应显示兜底文案。若前端因此崩溃才是要修的 bug；返回空/报错本身是预期。

---

## 五、今晚之后的衔接（不阻塞编译，列出备忘）

1. **服务端 A1**（Windows 侧可随时做，1 次 SSH）：服务器执行 `0037-apple-iap-settlement.sql` + 网关 env 配 `APPLE_BUNDLE_ID=com.dbee.app` / `APPLE_SHARED_SECRET`（ASC 生成后）/ `APPLE_SANDBOX=1` + 重启网关。
2. **ASC 建 App + 3 商品**（`dbee_pro_monthly` ¥18 / `dbee_pro_yearly` ¥128 / `dbee_lifetime` ¥328）+ 接受《付费应用协议》——**沙盒购买测试的前置**。协议必须「有效」状态沙盒才能测。
3. **个人→公司开发者迁移**（企业主体已注册，D-U-N-S 申请）——迁移期间 App 所有权转移要评估时间窗。
4. webhook URL（`https://d-bee.com.cn/.cloud/payment/apple/notifications`）等备案 + HTTPS 就绪后配。
5. 微信真实 AppID 替换占位值（开放平台「移动应用」审核通过后）。

---

## 六、一页速查（打印/手机上看）

```text
环境：Xcode 26+ ｜ Node 22+ ｜ 开发者账号已登录 ｜ iPhone 真机

git clone https://github.com/yutaiyin139/d-bee.git && cd d-bee
git log --oneline -1            # ≥ 9e1db43
npm ci
npm run native:ios              # build + sync + 开 Xcode
  ✔ 成功标志：Found 5 Capacitor plugins（无 wechat）

Xcode：TARGETS App → Signing → Team 选账号
       → Cmd+R（首次拉 SPM 远程包需联网，慢）
       → 报错先查手册 §三 对照表

回归：登录(真短信) → 记一餐 → 拍照 → 扫码 → 健康授权 → 分享
     付费墙商品列表为空 = 预期（ASC 未建商品）
```
