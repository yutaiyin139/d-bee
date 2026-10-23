# 苹果 iOS 端 · 发布梳理与清单（V1.7.0）

> 更新：2026-10-23 ｜ 版本：1.7.0 (build 9) ｜ 开发机：Windows（无法本地编译/签名 iOS）
> 一句话结论：**工程配置与隐私合规已就绪，web 资源已同步到最新 dist；但「上架」有 3 个只能在 Mac 上完成的硬步骤，且「数据面切自建服务器」被 HTTPS+备案域名阻塞。当前 iOS 端数据面仍指向云库。**

---

## 一、版本与工程状态

| 项 | 值 | 位置 | 状态 |
|---|---|---|---|
| MARKETING_VERSION | `1.7.0` | `project.pbxproj` ×2 | ✅ 与 web/android 对齐 |
| CURRENT_PROJECT_VERSION | `9` | `project.pbxproj` ×2 | ✅ 已 bump（上一版 8） |
| Bundle Identifier | `com.dbee.app` | pbxproj + capacitor.config | ✅ 三端一致 |
| Deployment Target | iOS 15.0 | pbxproj | ✅ |
| Device Family | `1,2`（iPhone+iPad） | pbxproj | ✅ |
| Swift Version | 5.0 | pbxproj | ✅ |
| web 资源（public/） | 已同步 10-23 dist（含 1.7.0 + UI token 化） | `ios/App/App/public/` | ✅ 本轮 `cap sync ios` 完成 |

**三端版本号统一确认**：web `1.7.0` ｜ android `versionName 1.7.0 / versionCode 11` ｜ iOS `1.7.0 (9)`。

---

## 二、签名与 Capability（⚠️ 上架前必须在 Mac 上补）

| 项 | 当前 | 问题 | 处理 |
|---|---|---|---|
| CODE_SIGN_STYLE | `Automatic` | 自动签名，需登录 Apple ID | Mac 上 Xcode 登录开发者账号 |
| **DEVELOPMENT_TEAM** | **未设置** | 无 Team 无法签名/上架 | Xcode → Signing & Capabilities 选 Team（个人开发者账号已通过） |
| HealthKit capability | ✅ 已配（`App.entitlements` 含 `com.apple.developer.healthkit`） | — | 需在 Apple Developer 后台 App ID 勾选 HealthKit |
| **In-App Purchase capability** | **❌ 未配** | 收费必需 | Xcode → Signing & Capabilities → `+ In-App Purchase` |
| Associated Domains | ❌ 未配 | 微信 Universal Link 回跳需要 | 待备案域名就绪后加 `applinks:<域名>` + 服务器放 `apple-app-site-association` |

---

## 三、数据面 endpoint（🔴 核心约束 —— iOS 当前连云库，非服务器）

### 现状
- `src/cloudConfig.ts` 的原生分支：endpoint = `VITE_NATIVE_ENDPOINT`（未设置）→ **回退 `CLOUD_HOST = https://zilv-mifeng.app.workbuddy.host`（云库）**。
- 本轮 `dist` 实测编译进的 host = `https://zilv-mifeng.app.workbuddy.host`，即 **iOS 端数据面 = 腾讯云 workbuddy-cloud-postgres，不是 150.158.51.106 自建 PG**。

### 为什么不能直接切 150.158.51.106
| 约束 | 说明 |
|---|---|
| **iOS ATS** | App Transport Security 默认**禁止 HTTP 明文**；`http://150.158.51.106` 会被 ATS 拦截（Info.plist 未配、也不应配 `NSAllowsArbitraryLoads`） |
| **必须 HTTPS + 域名** | ATS 要求合法 TLS 证书，证书需绑定**域名**（IP 证书不被信任/难签发） |
| **备案** | 国内服务器对外提供 Web 服务需 ICP 备案；`d-bee.com.cn` 当前**无 A 记录**且备案主体「个人→企业」变更中（备案期加解析会被拦截） |

### 切换路径（待备案+HTTPS 就绪后）
```bash
# 原生端构建时注入绝对 HTTPS 域名（指向 150.158.51.106 的 nginx）
VITE_NATIVE_ENDPOINT=https://d-bee.com.cn npm run build
npx cap sync ios
```
- 服务器侧：nginx 切 selfhost 变体（`/.cloud/` 上游 = `127.0.0.1:8080` 网关 → 服务器 PG），见 `deploy/switch-nginx-selfhost.sh`。
- ⚠️ **在备案域名 + HTTPS 就绪前，iOS/Android 无法指向服务器；此时若释放云库，原生端将整体不可用。**

---

## 四、三个本地 Swift 插件（🔴 从未在 Mac 编译，首次构建大概率要修）

| 插件 | 源文件 | 实现状态 | 风险 |
|---|---|---|---|
| `@dbee/iap` | `native-plugins/dbee-iap/ios/Sources/DbeeIap/DbeeIapPlugin.swift` | StoreKit 2：`getProducts`/`purchase`/`restore` + 验签 + 收据 base64，**代码完整** | 从未编译；StoreKit 2 API 细节（`Transaction.currentEntitlements`、`appStoreReceiptURL`）需真机/沙盒验证 |
| `@dbee/health` | `.../dbee-health/ios/Sources/DbeeHealth/DbeeHealthPlugin.swift` | HealthKit 读写骨架 | 从未编译；HealthKit 权限弹窗需真机 |
| `@dbee/origin-proxy` | `.../dbee-origin-proxy/ios/Sources/OriginProxyPlugin/OriginProxyPlugin.swift` | 原生层补发跨域请求（绕 WebView CORS） | 从未编译 |

**SPM 依赖**（`ios/App/CapApp-SPM/Package.swift`，由 cap 管理）：capacitor-swift-pm 8.5.3 + 上述 3 本地包 + @capacitor/share + @capacitor/camera。

> 首次 Mac 构建命令：`npm install && npx cap sync ios`，再用 Xcode 打开 `ios/App` 编译。预期需修 Swift 编译错误（Windows 上只写了骨架，从未过编译器）。

---

## 五、隐私与合规（✅ 已就绪）

| 项 | 状态 | 说明 |
|---|---|---|
| 权限用途说明 | ✅ | `NSCameraUsageDescription`/`NSPhotoLibraryUsageDescription`/`NSHealthShareUsageDescription`/`NSHealthUpdateUsageDescription` 均写明具体用途（避免 5.1.1 打回） |
| 隐私清单 PrivacyInfo.xcprivacy | ✅ | 声明手机号/邮箱/用户ID/健康/照片/其他用户内容 6 类采集 + UserDefaults(CA92.1)；无 Tracking |
| 出口合规 | ✅ | `ITSAppUsesNonExemptEncryption = false`（仅 HTTPS，豁免） |
| 未声明麦克风 | ✅（刻意） | 本 App 不录音，多声明反被追问 |
| arm64-only | ✅ | `UIRequiredDeviceCapabilities = arm64`（已修正模板遗留的 armv7） |

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

| 层 | 状态 |
|---|---|
| 前端 payment 模块 | ✅ `src/lib/payment/`（types/checkout/iosIap），含 `restorePurchases`，PaywallSheet 已接线 |
| 前端核销通道 | ✅ `api.ts verifyPaymentOrder`：iOS 优先走网关 `POST /.cloud/payment/apple/verify`（Bearer 鉴权），网关不可用（404/503）回退 RPC |
| 原生 StoreKit 2 插件 | ✅ 代码完整，⚠️ 未在 Mac 编译 |
| 服务端订单表/RPC | ✅ `payment_products`/`payment_orders` + 下单 RPC 已上云 |
| 凭证验签 | ✅ **网关已实现**（`server/lib/iap.mjs`：verifyReceipt 沙盒/生产自动切换 + bundle_id 钉扎 + transaction_id 全服幂等）。⚠️ 迁移 0037 待在服务器执行 |
| 订阅 webhook | ✅ **V2 通知端点已实现**（`/.cloud/payment/apple/notifications`：x5c 证书链钉扎验签，SUBSCRIBED/DID_RENEW 续订核销、REFUND/REVOKE 撤销权益、全量落库留痕）。⚠️ 需在 App Store Connect 配置通知 URL（依赖 HTTPS 域名） |
| **整体** | ⚠️ 代码链路完整；上线前置 = 0037 执行 + 网关 env 配 APPLE_BUNDLE_ID/SHARED_SECRET + Mac 侧硬步骤 |

**商品 ID**（App Store Connect 必须与代码一致）：`dbee_pro_monthly`(¥18 订阅) / `dbee_pro_yearly`(¥128 订阅) / `dbee_lifetime`(¥328 买断)。

---

## 八、审核红线（提审前必看）

1. **Apple 3.1.1**：iOS 数字商品（会员）必须走 IAP，**兑换码方案提审前要删除**（禁止绕过 IAP）。
2. 订阅必须提供「恢复购买」+「管理订阅」入口（否则 2.1 / 3.1.2 被拒）—— 前端已具备 restore，管理订阅入口需确认。
3. 抽成：首年 30%，次年/中小开发者 15%。

---

## 九、发布分步清单

### A. Windows 上可完成（本轮已做 / 可做）
- [x] 版本号 bump 1.7.0(9)
- [x] `npm run build` + `npx cap sync ios`（web 资源同步到最新 dist）
- [x] UI token 化三端一致（web `:root` ↔ mini `tokens.scss`，8 个语义衍生色同名同值）
- [x] 隐私清单 / 权限说明 / 出口合规核对
- [ ] 数据面决策（见第三节，受备案阻塞）

### B. 必须在 Mac 上完成（上架硬步骤）
1. `npm install && npx cap sync ios`，Xcode 打开 `ios/App`
2. 编译 3 个本地 Swift 插件（dbee-iap / dbee-health / origin-proxy），**修首次编译错误**
3. Signing & Capabilities：登录 Apple ID → 选 **DEVELOPMENT_TEAM** → 加 **In-App Purchase** capability（HealthKit 已有）
4. 替换微信真实 AppID（如启用微信登录）
5. App Store Connect：创建 App（`com.dbee.app`）→ 配 3 个商品 → 填协议/税务/银行（**对公账户下来后填银行账户**）→ 配 Server Notifications URL = `https://d-bee.com.cn/.cloud/payment/apple/notifications`（依赖 HTTPS）
6. 服务器执行 `0037-apple-iap-settlement.sql` + 网关 env 配 `APPLE_BUNDLE_ID`/`APPLE_SHARED_SECRET`（App Store Connect → App 信息 → 共享密钥）+ 重启网关（收费前置；0029 已作废勿执行）
7. Archive → Upload → TestFlight 内测（沙盒账号走 `APPLE_SANDBOX=1`，验签已支持 21007/21008 自动切换）→ 提审

### C. 依赖外部条件
- 备案域名 + HTTPS 证书 → 数据面切服务器 + Associated Domains（微信 Universal Link）+ webhook URL 配置

---

## 十、硬阻塞与依赖汇总

| 阻塞 | 影响 | 解除条件 |
|---|---|---|
| 无 DEVELOPMENT_TEAM | 无法签名/上架 | Mac 上 Xcode 登录开发者账号 |
| Swift 插件未编译 | 可能编译失败 | Mac 首次构建 + 修错 |
| 无 In-App Purchase capability | 收费不可用 | Xcode 添加 capability |
| 备案域名 + HTTPS 未就绪 | 数据面无法切服务器；微信 Universal Link 与 webhook URL 不可用 | `d-bee.com.cn` 备案完成 + 签证书 + 加 A 记录 |
| 0037 迁移未执行 + 网关 APPLE_* env 未配 | IAP 核销落库无入口（端点 503） | 服务器执行 0037 + env 配置 + 重启网关（**代码已就绪**） |
| 对公账户未下来 | App Store Connect 银行/税务信息无法填全 → 商品不能售卖 | 对公账户办结（申请中） |
