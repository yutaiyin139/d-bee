# 苹果 iOS 端 · 发布梳理与清单（V1.7.2）

> 更新：2026-10-28 ｜ 版本：1.7.2 (build 11) ｜ 开发机：Windows（无法本地编译/签名 iOS）  
> ⚠️ **10-28 三处口径更新**：① Bundle ID 已定案 `cn.com.dbee.app`（原 `com.dbee.app` 被 Apple 抢注弃用）；② 双域名规划落地——`d-bee.cn` = 自律蜜蜂 Web 端（隐私政策 / webhook / Universal Link / 原生端 endpoint），`d-bee.com.cn` = 公司官网；③ 对公账户已开立（10-28），但 Apple 账号仍是个人主体 → 付费协议今天先按个人版本办（W-8BEN + 本人卡），对公收款等 1.12 迁移后换绑。追踪底账以 `docs/收费模块-前置条件待办清单.md` §一 为准。  
> 一句话结论：**工程配置、隐私合规、3 个 Swift 插件静态审查（对照官方 SDK 逐一核实 API 签名）全部就绪，web 资源已重建并同步到含网关验签的最新 dist；「上架」只剩 DEVELOPMENT_TEAM 等 Mac 硬步骤。今晚编译照《docs/今晚-Mac编译执行手册.md》执行。**  
> ⚠️ 10-23 晚修正一处误判：IAP **不需要** Xcode capability（StoreKit 对 App Store 应用是隐式能力），收费前置在 ASC 与服务端。

---

## 一、版本与工程状态

| 项                       | 值                                    | 位置                         | 状态                     |
| ----------------------- | ------------------------------------ | -------------------------- | ---------------------- |
| MARKETING_VERSION       | `1.7.0`                              | `project.pbxproj` ×2       | ✅ 与 web/android 对齐     |
| CURRENT_PROJECT_VERSION | `9`                                  | `project.pbxproj` ×2       | ✅ 已 bump（上一版 8）        |
| Bundle Identifier       | `cn.com.dbee.app`（⚠️ 已定案，原 `com.dbee.app` 被抢注弃用，勿改） | pbxproj + capacitor.config | ✅ 三端一致                 |
| Deployment Target       | iOS 15.0                             | pbxproj                    | ✅                      |
| Device Family           | `1,2`（iPhone+iPad）                   | pbxproj                    | ✅                      |
| Swift Version           | 5.0                                  | pbxproj                    | ✅                      |
| web 资源（public/）         | 已同步 10-23 dist（含 1.7.0 + UI token 化） | `ios/App/App/public/`      | ✅ 本轮 `cap sync ios` 完成 |

**三端版本号统一确认**：web `1.7.0` ｜ android `versionName 1.7.0 / versionCode 11` ｜ iOS `1.7.0 (9)`。

---

## 二、签名与 Capability（⚠️ 上架前必须在 Mac 上补）

| 项                          | 当前                                                         | 问题                                                                            | 处理                                                                       |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| CODE_SIGN_STYLE            | `Automatic`                                                | 自动签名，需登录 Apple ID                                                             | Mac 上 Xcode 登录开发者账号                                                      |
| **DEVELOPMENT_TEAM**       | **未设置**                                                    | 无 Team 无法签名/上架                                                                | Xcode → Signing & Capabilities 选 Team（个人开发者账号已通过）                        |
| HealthKit capability       | ✅ 已配（`App.entitlements` 含 `com.apple.developer.healthkit`） | —                                                                             | 需在 Apple Developer 后台 App ID 勾选 HealthKit                                |
| In-App Purchase capability | ✅ **无需配置**（2026-10-23 修正误判）                                | StoreKit IAP 对 App Store 应用是**隐式能力**，entitlements 无对应 key；Xcode 里加不加都不影响编译与运行 | 收费前置在 **App Store Connect**（建 App + 3 商品 + 接受付费应用协议），不在 Xcode capability |
| Associated Domains         | ❌ 未配                                                       | 微信 Universal Link 回跳需要                                                        | 待备案域名就绪后加 `applinks:<域名>` + 服务器放 `apple-app-site-association`            |

---

## 三、数据面 endpoint（🔴 核心约束 —— iOS 当前连云库，非服务器）

### 现状

- `src/cloudConfig.ts` 的原生分支：endpoint = `VITE_NATIVE_ENDPOINT`（未设置）→ **回退 `CLOUD_HOST = https://zilv-mifeng.app.workbuddy.host`（云库）**。
- 本轮 `dist` 实测编译进的 host = `https://zilv-mifeng.app.workbuddy.host`，即 **iOS 端数据面 = 腾讯云 workbuddy-cloud-postgres，不是 150.158.51.106 自建 PG**。

### 为什么不能直接切 150.158.51.106

| 约束                | 说明                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **iOS ATS**       | App Transport Security 默认**禁止 HTTP 明文**；`http://150.158.51.106` 会被 ATS 拦截（Info.plist 未配、也不应配 `NSAllowsArbitraryLoads`） |
| **必须 HTTPS + 域名** | ATS 要求合法 TLS 证书，证书需绑定**域名**（IP 证书不被信任/难签发）                                                                             |
| **备案**            | 国内服务器对外提供 Web 服务需 ICP 备案；`d-bee.cn` 当前**无 A 记录**且备案主体「个人→企业」变更中（注销个人备案+企业重备，两域名打包同一订单；备案期加解析会被拦截）                                        |

### 切换路径（待备案+HTTPS 就绪后）

```bash
# 原生端构建时注入绝对 HTTPS 域名（指向 150.158.51.106 的 nginx）
VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build
npx cap sync ios
```

- 服务器侧：nginx 切 selfhost 变体（`/.cloud/` 上游 = `127.0.0.1:8080` 网关 → 服务器 PG），见 `deploy/switch-nginx-selfhost.sh`。
- ⚠️ **在备案域名 + HTTPS 就绪前，iOS/Android 无法指向服务器；此时若释放云库，原生端将整体不可用。**

---

## 四、三个本地 Swift 插件（✅ 10-23 静态审查通过，首次 Mac 编译置信度高）

> 2026-10-23 晚完成全量静态审查：类声明与官方 SharePlugin/CameraPlugin 逐字节同构；  
> 所有 Capacitor API（getArray/getObject/resolve/reject）对照本机 @capacitor/ios@8.5.3  
> 源码核实签名；StoreKit 2 / HealthKit API 均 iOS 15+ 可用；SPM 清单链完整  
> （`cap sync ios` 重跑 0 diff，5 插件识别正确）。详见《docs/今晚-Mac编译执行手册.md》§〇。

| 插件                   | 源文件                                                                           | 实现状态                                                                    | 风险                                                                                     |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@dbee/iap`          | `native-plugins/dbee-iap/ios/Sources/DbeeIap/DbeeIapPlugin.swift`             | StoreKit 2：`getProducts`/`purchase`/`restore` + 验签 + 收据 base64，**代码完整** | 从未编译；StoreKit 2 API 细节（`Transaction.currentEntitlements`、`appStoreReceiptURL`）需真机/沙盒验证 |
| `@dbee/health`       | `.../dbee-health/ios/Sources/DbeeHealth/DbeeHealthPlugin.swift`               | HealthKit 读写骨架                                                          | 从未编译；HealthKit 权限弹窗需真机                                                                 |
| `@dbee/origin-proxy` | `.../dbee-origin-proxy/ios/Sources/OriginProxyPlugin/OriginProxyPlugin.swift` | 原生层补发跨域请求（绕 WebView CORS）                                               | 从未编译                                                                                   |

**SPM 依赖**（`ios/App/CapApp-SPM/Package.swift`，由 cap 管理）：capacitor-swift-pm 8.5.3 + 上述 3 本地包 + @capacitor/share + @capacitor/camera。

> 首次 Mac 构建命令：`npm ci && npm run native:ios`（dist 与 ios public 不入库，clone 后必须重建）。静态审查未发现阻断性错误；若仍出现 Swift 编译错误，把报错发回 Windows 侧即时修复推 GitHub。

---

## 五、隐私与合规（✅ 已就绪）

| 项                          | 状态    | 说明                                                                                                                                                |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限用途说明                     | ✅     | `NSCameraUsageDescription`/`NSPhotoLibraryUsageDescription`/`NSHealthShareUsageDescription`/`NSHealthUpdateUsageDescription` 均写明具体用途（避免 5.1.1 打回） |
| 隐私清单 PrivacyInfo.xcprivacy | ✅     | 声明手机号/邮箱/用户ID/健康/照片/其他用户内容 6 类采集 + UserDefaults(CA92.1)；无 Tracking                                                                                |
| 出口合规                       | ✅     | `ITSAppUsesNonExemptEncryption = false`（仅 HTTPS，豁免）                                                                                               |
| 未声明麦克风                     | ✅（刻意） | 本 App 不录音，多声明反被追问                                                                                                                                 |
| arm64-only                 | ✅     | `UIRequiredDeviceCapabilities = arm64`（已修正模板遗留的 armv7）                                                                                            |

---

## 六、微信登录（⚠️ 提审前必须替换占位 AppID）

- `Info.plist` 的 `CFBundleURLSchemes` 当前是占位 `wx0000000000000000`。
- `LSApplicationQueriesSchemes` 已含 `weixin`/`weixinULAPI`/`weixinURLParamsAPI`（canOpenURL 检测 + Universal Link 回跳）。
- **提审前**：替换为真实微信开放平台「移动应用」AppID；Universal Link 还需 Associated Domains + `apple-app-site-association`（依赖备案域名）。
- 未配 AppID 时原生端微信入口本身隐藏，占位值无副作用。

---

## 七、IAP 收费链路（详见 `docs/iOS收费IAP落地清单.md`）

> 2026-10-23 更新：**服务端验签已在 Node 网关落地**（10-22 决策 #6）。  
> 0029（pg_net 方案）已标 void 作废；替代实现 = `server/lib/iap.mjs` +  
> 迁移 `0037-apple-iap-settlement.sql`（幂等表 + definer 核销函数）。  
> 自测 `tools/iap-selftest.mjs` 41 项全过（含 21007 沙盒切换、bundle_id 钉扎、  
> 换账号重放 409、DID_RENEW 续订、REFUND 撤销、JWS x5c 验签失败拒收）。

| 层                | 状态                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端 payment 模块    | ✅ `src/lib/payment/`（types/checkout/iosIap），含 `restorePurchases`，PaywallSheet 已接线                                                                                     |
| 前端核销通道           | ✅ `api.ts verifyPaymentOrder`：iOS 优先走网关 `POST /.cloud/payment/apple/verify`（Bearer 鉴权），网关不可用（404/503）回退 RPC                                                           |
| 原生 StoreKit 2 插件 | ✅ 代码完整，⚠️ 未在 Mac 编译                                                                                                                                                   |
| 服务端订单表/RPC       | ✅ `payment_products`/`payment_orders` + 下单 RPC 已上云                                                                                                                    |
| 凭证验签             | ✅ **网关已实现**（`server/lib/iap.mjs`：verifyReceipt 沙盒/生产自动切换 + bundle_id 钉扎 + transaction_id 全服幂等）。⚠️ 迁移 0037 待在服务器执行                                                     |
| 订阅 webhook       | ✅ **V2 通知端点已实现**（`/.cloud/payment/apple/notifications`：x5c 证书链钉扎验签，SUBSCRIBED/DID_RENEW 续订核销、REFUND/REVOKE 撤销权益、全量落库留痕）。⚠️ 需在 App Store Connect 配置通知 URL（依赖 HTTPS 域名） |
| **整体**           | ⚠️ 代码链路完整；上线前置 = 0037 执行 + 网关 env 配 APPLE_BUNDLE_ID/SHARED_SECRET + Mac 侧硬步骤                                                                                          |

**商品 ID**（App Store Connect 必须与代码一致）：`dbee_pro_monthly`(¥18 订阅) / `dbee_pro_yearly`(¥128 订阅) / `dbee_lifetime`(¥298 买断)。

---

## 八、审核红线（提审前必看）

1. **Apple 3.1.1**：iOS 数字商品（会员）必须走 IAP，**兑换码方案提审前要删除**（禁止绕过 IAP）。
2. 订阅必须提供「恢复购买」+「管理订阅」入口（否则 2.1 / 3.1.2 被拒）—— 前端已具备 restore，管理订阅入口需确认。
3. 抽成：📌 **2026-03-15 起中国内地新费率**（Apple 官方公告，无需另签条款自动生效）——标准 IAP/付费 App **25%**（原 30%）；参加 **App Store Small Business Program**（年收入 <$100 万，新项目天然符合）或订阅第二年后续费 **12%**（原 15%）。SBP 报名入口在付费协议生效后出现，审核数周，建议协议 Active 后尽早报名。

---

## 九、发布分步清单

### A. Windows 上可完成（本轮已做 / 可做）

- [x] 版本号 bump 1.7.0(9)
- [x] `npm run build` + `npx cap sync ios`（web 资源同步到最新 dist）
- [x] UI token 化三端一致（web `:root` ↔ mini `tokens.scss`，8 个语义衍生色同名同值）
- [x] 隐私清单 / 权限说明 / 出口合规核对
- [ ] 数据面决策（见第三节，受备案阻塞）
- [x] ✅ **商店展示截图（10-28 已补齐）**：Apple 2026-10 起 iPhone 必填槽位为 **6.3" 中型屏 1179×2556 或 1206×2622**；已用 `deploy/shot-store.mjs`（store-preview.html 假 iOS 环境 + Playwright 精确像素）生成 5 张 **1179×2556**（`deploy/screenshots/store/iphone-*.png`），付费墙 iOS 形态 7 项断言全过（有恢复购买、无微信/支付宝/兑换码、价格 ¥18/¥128/¥298），详见《AppStore产品页-填报包-2026-10-28.md》§五。⚠️ 上传前人工过目画面；最终以 ASC 上传页实际标红槽位为准（若提示 6.9" 按 1320×2868 重出）
- [x] ✅ **iPad 截图同为必填（10-28 已补齐）**：`TARGETED_DEVICE_FAMILY = "1,2"`（iPhone+iPad）→ 已生成 5 张 **2048×2732**（`deploy/screenshots/store/ipad-*.png`，`node deploy/shot-store.mjs --ipad`，`?full=1` 解除 480px 宽限铺满屏宽），无需再改 Device Family
- [x] 产品页元数据文案（名称/副标题/关键词/推广文本/描述/版权 + 3 商品显示名与描述）已备齐并通过字数实测，见《AppStore产品页-填报包-2026-10-28.md》

### B. 必须在 Mac 上完成（上架硬步骤）

1. `npm install && npx cap sync ios`，Xcode 打开 `ios/App`
2. 编译 3 个本地 Swift 插件（dbee-iap / dbee-health / origin-proxy），**修首次编译错误**
3. Signing & Capabilities：登录 Apple ID → 选 **DEVELOPMENT_TEAM**（HealthKit capability 已在 entitlements 配好；**IAP 无需加 capability**——StoreKit 对 App Store 应用是隐式能力，2026-10-23 修正）
4. 替换微信真实 AppID（如启用微信登录）
5. App Store Connect：创建 App（`cn.com.dbee.app`）→ 配 3 个商品（18/128/298）→ 填协议/税务/银行（⚠️ 个人主体先按 W-8BEN + 本人账户办；对公换绑等账号迁移，见收费清单 1.5/1.12）→ 生成 App 共享密钥 → 配 Server Notifications URL = `https://d-bee.cn/.cloud/payment/apple/notifications`（依赖备案+HTTPS，暂不可填）
6. 服务器执行 `0037-apple-iap-settlement.sql` + 网关 env 配 `APPLE_BUNDLE_ID`/`APPLE_SHARED_SECRET`（App Store Connect → App 信息 → 共享密钥）+ 重启网关（收费前置；0029 已作废勿执行）
7. Archive → Upload → TestFlight 内测（沙盒账号走 `APPLE_SANDBOX=1`，验签已支持 21007/21008 自动切换）→ 提审（🔴 **中国区提审强制需 App 备案号**，App 备案依赖软著 + ICP 备案，见收费清单 1.13；TestFlight 内测不受此限）

### C. 依赖外部条件

- 备案域名 + HTTPS 证书 → 数据面切服务器 + Associated Domains（微信 Universal Link）+ webhook URL 配置

---

## 十、硬阻塞与依赖汇总

| 阻塞                               | 影响                                            | 解除条件                                                                                         |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 无 DEVELOPMENT_TEAM               | 无法签名/上架                                       | Mac 上 Xcode 登录开发者账号                                                                          |
| Swift 插件未编译                      | 可能编译失败                                        | ✅ 10-23 静态审查通过（API 签名逐一对照官方 SDK 核实），风险已降级为「低」；仍需 Mac 首次构建确认                                  |
| ~~无 In-App Purchase capability~~ | ~~收费不可用~~                                     | **2026-10-23 修正：StoreKit IAP 无需 capability**（隐式能力）。收费真正前置 = ASC 建 App+商品+付费协议 + 服务端 0037/env |
| 备案域名 + HTTPS 未就绪                 | 数据面无法切服务器；微信 Universal Link 与 webhook URL 不可用 | `d-bee.cn` 备案完成 + 签证书 + 加 A 记录                                                           |
| 0037 迁移未执行 + 网关 APPLE\_* env 未配  | IAP 核销落库无入口（端点 503）                           | 服务器执行 0037 + env 配置 + 重启网关（**代码已就绪**）                                                        |
| ~~对公账户未下来~~                   | ✅ 已开立（10-28）；⚠️ 但 Apple 账号为个人主体，对公换绑依赖 1.12 迁移        | D-U-N-S 下证 → 账号迁移为组织 → 重签协议 + W-8BEN-E + 绑对公（生产售卖前完成）                                                                                  |
