# 苹果 iOS 端 · 发布梳理与清单（V1.7.3）

> 更新：2026-10-29 ｜ 版本：1.7.3 (build 12) ｜ 开发机：Windows（无法本地编译/签名 iOS）  
> ✅ **10-29 五项实证结论**（本轮逐一联网/真机验证，非推断）：
> ① **云库存活**：iOS 数据面 `https://zilv-mifeng.app.workbuddy.host` 的 `publishableKey` **仍然有效**——`/.cloud/database/rest/` 返回 200 + PostgREST swagger，`/.cloud/auth/v1/user/me` 返回 401 `UNAUTHENTICATED`（路由正常）。此前一次探测报 `invalid_client` 是**发错了鉴权头**（正确头是 `x-wb-webapp-access-key`，且云端按 **Origin 精确匹配**校验，须同时带 `Origin`/`Referer`），不是凭证失效。→ **iOS 端登录与数据读写不受阻**。
> ② **审核演示账户已可用**：`dbeesupport@163.com` / `888888` 经真实 SDK `signInWithPassword` 验证**登录成功**（user.id `2115454156301934592`）。10-29 日志记的「验证码过期未完成」已过期作废。`tools/setup-review-account.mjs` 此前 `check` 误报失败，根因是脚本未注入 Origin，已修（补 `nodeFetch` 包装）。
> ③ **线上服务器已更新到 1.7.3**：`http://150.158.51.106/` 重新部署，`verify-legal.mjs` 全量 **PASS**（隐私门四要素、深链放行、七方 SDK 公示、6 条公示 URL 全 200、隐私政策正文 3082 字〔旧版仅 1531〕、页脚 v1.7.3、零 console/page error）。深链 `/legal/privacy`、`/legal/terms`、`/legal/disclaimer` 均 200 → **ASC 隐私政策 URL 可填 `http://150.158.51.106/legal/privacy`**。
> ④ **`d-bee.cn` 仍无 DNS 记录**（`nslookup` → Non-existent domain），企业 ICP 备案进行中。故 ASC **不要**填 `https://d-bee.cn/legal/privacy`（审核员点开即死链 → 2.1 拒审），先填上面的 IP 深链，备案通过后再改。
> ⑤ 🔴→✅ **修复一处生产缺陷：自建网关从未实现密码登录**（10-29 夜，用户在 web 端实测暴露）。用审核账户在 `http://150.158.51.106/` 密码登录报 **400「缺少 verification_token」**——根因是主端切自建网关时只实现了验证码路径，`server/lib/auth.mjs` 的 `signIn` 拿不到 `verification_token` 就直接拒，而 SDK `signInWithPassword` 发的是 `{username, password}`（`identity.mjs` 的 `verifyPassword()` 早已写好却从未被调用）。影响面是 **web 端所有设过密码的用户**，不止演示账户。已补 `signInWithPassword` 分支 + 手术式热修上线（不动 `gateway.env`），线上实测 **200 + access_token**、`user/me` 与业务表读取全通，防枚举/限流/日志脱敏自测 **35/35 通过**。⚠️ **注意两套数据面不要混淆**：web 端 = 自建网关 + 自建 PG；iOS 端 = WorkBuddy 云库（`zilv-mifeng.app.workbuddy.host`），两边 `dbeesupport@163.com` 是**互不相通的两个账户**（owner 分别为 `1793280185303313979` / `2115454156301934592`）。详见 §八.3。
>
> ⚠️ **10-28 三处口径更新**：① Bundle ID 已定案 `cn.com.dbee.app`（原 `com.dbee.app` 被 Apple 抢注弃用）；② 双域名规划落地——`d-bee.cn` = 自律蜜蜂 Web 端（隐私政策 / webhook / Universal Link / 原生端 endpoint），`d-bee.com.cn` = 公司官网；③ 对公账户已开立（10-28），但 Apple 账号仍是个人主体 → 付费协议今天先按个人版本办（W-8BEN + 本人卡），对公收款等 1.12 迁移后换绑。追踪底账以 `docs/收费模块-前置条件待办清单.md` §一 为准。  
> 一句话结论：**工程侧 V1.7.3 已全部就绪**（版本三端一致、隐私同意门 + 七方 SDK 公示已进 iOS 包、线上服务器已同步到 1.7.3、云库数据面与审核演示账户均已实证可用、付费墙 3.1.1/3.1.2 要件齐备）。**剩下的是 Mac 硬步骤 + 资质链**：Mac 上补 DEVELOPMENT_TEAM 并首次编译 3 个 Swift 插件 → Archive/Upload → **TestFlight 内测（今天/明天可做，不受备案号限制）**。🔴 **中国区正式上架明天做不到**：卡在企业 ICP 备案（进行中）与软著登记（总闸门·未提交，AI 条款须用户本人决策）→ App 备案号拿不到，ASC 无法提交中国区审核。详见 §八.5、§十.1。  
> ⚠️ 10-23 晚修正一处误判：IAP **不需要** Xcode capability（StoreKit 对 App Store 应用是隐式能力），收费前置在 ASC 与服务端。

---

## 一、版本与工程状态

| 项                       | 值                                    | 位置                         | 状态                     |
| ----------------------- | ------------------------------------ | -------------------------- | ---------------------- |
| MARKETING_VERSION       | `1.7.3`                              | `project.pbxproj` ×2       | ✅ 本轮 bump（上一版 1.7.2）     |
| CURRENT_PROJECT_VERSION | `12`                                 | `project.pbxproj` ×2       | ✅ 本轮 bump（上一版 11）        |
| Bundle Identifier       | `cn.com.dbee.app`（⚠️ 已定案，原 `com.dbee.app` 被抢注弃用，勿改） | pbxproj + capacitor.config | ✅ 三端一致                 |
| Deployment Target       | iOS 15.0                             | pbxproj                    | ✅                      |
| Device Family           | `1,2`（iPhone+iPad）                   | pbxproj                    | ✅                      |
| Swift Version           | 5.0                                  | pbxproj                    | ✅                      |
| web 资源（public/）         | 已同步 **10-29 dist（1.7.3）**：含隐私同意门 `PrivacyGate`、七方 SDK 公示、修正后的公示 URL | `ios/App/App/public/`      | ✅ 本轮 `npm run build` + `cap sync ios`，已 grep 复核产物 |
| iOS 插件白名单               | 6 个：`@dbee/origin-proxy`、`@capacitor/share`、`@dbee/health`、`@dbee/iap`、`@capacitor/camera`、**`@capacitor/app`**（10-29 为隐私门「不同意即退出」新增） | `capacitor.config.ts` → 生成的 `capacitor.config.json` | ✅ `cap sync` 识别正确 |

**三端版本号统一确认（10-29）**：web `1.7.3` ｜ android `versionName 1.7.3 / versionCode 14` ｜ iOS `1.7.3 (12)`。  
**产物复核实证**：`ios/App/App/public/assets/index-*.js` 中 `version:"v1.7.3"` ✅、隐私门文案「同意并继续」4 处 ✅、`腾讯云计算（北京）`/`Open Food Facts` 公示 ✅、`corp.163.com/gb/legal.html`（替换原 404 的 `mail.163.com/mapp/...`）✅、数据面 host = `workbuddy.host`（2 处）✅、**未**混入未备案的 `d-bee.cn`（0 处）✅。

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
VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run native:ios
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

## 五、隐私与合规（✅ 已就绪，10-29 补强）

| 项                          | 状态    | 说明                                                                                                                                                |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **首次启动隐私同意门**              | ✅（10-29 新增） | `src/components/PrivacyGate.tsx` 包在 `main.tsx` 最外层：同意前不发起任何采集/上报；四要素齐备（同意并继续 / 不同意并退出 / 隐私政策 + 用户协议深链 / 可滚动全文）。同意态以 `LEGAL_UPDATED`（政策更新日期）为版本标识，政策改版会重新弹 |
| **第三方 SDK 公示（§四）**          | ✅（10-29 新增） | 七方逐条列出：腾讯云基础设施、AI 大模型平台、短信平台、网易邮箱、支付宝、微信支付、阿里云百炼（图像）；另加 Open Food Facts、微信 OpenSDK。**每条链接均实测 200**（`verify-legal.mjs` §0.7 已加为回归断言，死链即 FAIL） |
| 权限用途说明                     | ✅     | `NSCameraUsageDescription`/`NSPhotoLibraryUsageDescription`/`NSHealthShareUsageDescription`/`NSHealthUpdateUsageDescription` 均写明具体用途（避免 5.1.1 打回） |
| 隐私清单 PrivacyInfo.xcprivacy | ✅     | 声明手机号/邮箱/用户ID/健康/照片/其他用户内容 6 类采集 + UserDefaults(CA92.1)；无 Tracking                                                                                |
| 出口合规                       | ✅     | `ITSAppUsesNonExemptEncryption = false`（仅 HTTPS，豁免）                                                                                               |
| 未声明麦克风                     | ✅（刻意） | 本 App 不录音，多声明反被追问                                                                                                                                 |
| arm64-only                 | ✅     | `UIRequiredDeviceCapabilities = arm64`（已修正模板遗留的 armv7）                                                                                            |
| **隐私政策 URL（ASC 填报）**        | ⚠️ 需按下方填 | 🔴 **不要填 `https://d-bee.cn/legal/privacy`**——该域名当前无 DNS（企业备案中），审核员点开即死链 → 2.1 拒审。**现在填 `http://150.158.51.106/legal/privacy`**（实测 200，内容即 1.7.3 新版 3082 字政策），备案通过后再改域名 |
| `@capacitor/preferences` 未安装 | ⚠️ 已知降级（非阻断） | iOS 上隐私同意态回落 localStorage；WKWebView 存储紧张被清时会**重新弹同意门**——属安全降级（宁可多弹不可漏弹），不影响审核。如需持久化再装该插件 |

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

1. **Apple 3.1.1**：iOS 数字商品（会员）必须走 IAP，**兑换码方案提审前要删除**（禁止绕过 IAP）。→ ✅ **已确认**：`PaywallSheet.tsx` 的兑换码输入用 `!isIOS()` 包裹，iOS 下完全不渲染；付费墙 iOS 点商品直接 `buyProduct(id, 'apple')` 走内购。蜂蜜兑换（邀请中心）是 earned 积分，属 3.1.1 允许的虚拟货币，不受影响。
2. 订阅必须提供「恢复购买」+「管理订阅」入口（否则 2.1 / 3.1.2 被拒）。→ **恢复购买 ✅**：iOS 下 `isIOS()` 分支渲染「恢复购买」按钮，`restorePurchases` 已接线。**法律链接 ✅**：付费墙内含《使用条款》《隐私政策》按钮（3.1.2 硬要求）。⚠️ **「管理订阅」入口 ❌ 未实现**：全仓 `grep` 无 `管理订阅`/`itms-apps`/`showManageSubscriptions`，`@dbee/iap` 插件也未暴露该能力。**建议**：付费墙/我的页加一个「管理订阅」按钮跳 `itms-apps://apps.apple.com/account/subscriptions`（Apple 官方深链，无需新插件），成本极低、直接消掉一个 3.1.2 风险点。**注**：Apple 对「仅恢复购买、无管理订阅入口」通常按 3.1.2 打回而非硬拒，首发免费+订阅未开时可暂缓，但补上更稳。
3. **审核演示账户（5.1.1）**：✅ **两套数据面均已实证可用**——账号密码同为 `dbeesupport@163.com` / `888888`，但它们是**互不相通的两个账户**，务必按端对号入座：

   | 端 | 数据面 | 账户 owner | 验证方式与结果（10-29 夜实测） |
   | - | ----- | --------- | --------------------------- |
   | **iOS App（提审用的就是这条）** | WorkBuddy 云库 `https://zilv-mifeng.app.workbuddy.host` | `2115454156301934592` | ✅ 真实 SDK `signInWithPassword` 登录成功；`tools/setup-review-account.mjs check` 通过 |
   | **web 端（自建网关）** | `http://150.158.51.106` + 自建 PG | `1793280185303313979` | ✅ `POST /.cloud/auth/v1/signin {username,password}` → **200 + access_token**；`user/me` 200（`login_count` 递增）；`profiles`/`honey_ledger` 带 token 读取 200。**修复前此处报 400「缺少 verification_token」**（见卷首结论⑤） |

   ASC「App 审核信息」填：用户名 `dbeesupport@163.com`、密码 `888888`、备注「打开 App → 登录页切『邮箱』→ 点『已有密码？点此用密码登录』→ 输入上述邮箱与密码」。⚠️ 提审用的演示账户在**云库**，与 iOS 包数据面同源，审核员登录后能正常读写；**web 端那个账户的修复不影响 iOS 提审**，但它是产品自身可用性缺陷，必须修（已修）。
   🔴 **提审前复检命令**（任一端不可用即会被拒 2.1）：
   ```bash
   node tools/setup-review-account.mjs check          # iOS 侧（云库）
   node tools/selftest-password-login.mjs             # web 侧（网关，35 项断言）
   ```

4. 抽成：📌 **2026-03-15 起中国内地新费率**（Apple 官方公告，无需另签条款自动生效）——标准 IAP/付费 App **25%**（原 30%）；参加 **App Store Small Business Program**（年收入 <$100 万，新项目天然符合）或订阅第二年后续费 **12%**（原 15%）。SBP 报名入口在付费协议生效后出现，审核数周，建议协议 Active 后尽早报名。
5. 🔴 **中国区提审强制需「App 备案号」，且 Apple 后台有接口级强校验**（10-29 联网核实，此前文档只写了「需要备案号」，漏了校验规则）：

   Apple 自 2023-09-30 起要求中国大陆区提审必须填 ICP/App 备案号，无号无法提交。更关键的是**填号时 ASC 会实时调 MIIT 接口校验**，不匹配直接返回 **HTTP 409**、备案号**存都存不进去**（实测抓包错误码，来源见下）：

   | 校验项 | 错误码 | 强度 | 我方现状 |
   | ----- | ----- | ---- | ------- |
   | **App 名称** 须与 MIIT 备案名**逐字一致** | `STATE_ERROR.ICP_NUMBER_MIIT_APP_NAME_MISMATCH`（"Your app name does not match MIIT's records"） | 🔴 **强校验**（不过就存不进） | ⚠️ ASC 计划填 `自律蜜蜂 - 饮食热量记录`（含副标题后缀）。**备案时 App 名称必须按这一串逐字报**，否则两边对不上。若备案已按「自律蜜蜂」报名 → 要么改 ASC 名称，要么变更备案 |
   | **开发者主体** 须与备案主体一致 | `STATE_ERROR.ICP_NUMBER_MIIT_PROVIDER_NAME_MISMATCH`（"Your developer name does not match MIIT's records"） | 🟠 会弹提示（多方实测判断非硬阻断，因中文备案主体 vs 英文开发者名难对齐） | 🔴 **必然不匹配**：本次企业 ICP 备案主体 = **北京迪蜂科技有限公司**，而 Apple 开发者账号仍是**个人主体**（10-28 记录，对公换绑依赖 D-U-N-S + 1.12 迁移）。→ 填号时会弹 mismatch，需人工确认；**根治办法是账号迁移为组织主体** |

   **App 备案的前置依赖（10-29 按本项目资质底账核实，见 `docs/Android上线前置条件清单-2026-10-29.md` §一）**：

   ```
   软著登记（30–60 工作日，🔴 总闸门·尚未提交）
        + ICP 企业备案（2–5 周，进行中）
             → App 备案（7–20 工作日）
                  → 中国区正式上架
   ```

   🔴 **软著是整条资质链的总闸门，且当前「未提交」**——卡在 2026-03-15 新规「AI 条款」：经办人须**亲笔手抄**承诺「未使用 AI 编写代码/撰写文档/生成申报材料」，违者入**失信名单 + 个人征信**。本项目为 AI 深度协作，须由**用户本人**先致电中国版权保护中心问清「AI 辅助编程」与「AI 生成代码」的界定口径再决定提交（法律判断，不可代劳）。软著未下来 → App 备案无法办 → **中国区正式上架不可能在明天发生**（这不是工程问题，工程侧 V1.7.3 已就绪）。

   另：AIGC 类应用还须并行办**算法备案（2–3 个月）**。App 备案还需三项技术信息：包名 / 签名 SHA-256 / 签名公钥（**一个证书+包名组合只能备案一次**，换证书或改包名须重办）——即 **Mac 上定下 DEVELOPMENT_TEAM 并完成签名后**才能取到这三项，备案材料才算齐。

   ✅ **TestFlight 内测不受备案号限制**，可先行分发真机测试；正式提审须等备案号 + 名称对齐 + 主体问题有说法。

   > 来源：Apple 官方帮助「App 信息」ICP 字段说明 + 工信部 beian.miit.gov.cn；409 错误码与字段名来自开发者对 `appstoreconnect.apple.com/iris/v1/appIcpNumberDetails` 的实测抓包（2024-04 强校验生效后多方复现）。**最终以 ASC 后台实时提示为准。**

6. 🟠 **经营性业务可能需 ICP 经营许可证（增值电信 B25）**：多个备案服务口径指出，App 含**付费会员/充值**属经营性互联网信息服务，除 ICP 备案外还需 ICP 经营许可证（注册资本、经营范围有门槛）。我方有 Pro 月/年订阅 + 终身买断。→ **建议向备案服务商确认**：① 首发若 ASC **暂不配 IAP 商品**（付费墙走兜底价、点击报错但不崩溃，见 §七），能否按非经营性先上；② 若必须办许可证，周期与门槛如何。⚠️ 此项为合规风险提示，非 Apple 审核项，不影响能否提审。

7. ⚠️ **备案号未注入产物**：`.env` 的 `VITE_ICP_BEIAN` 当前为**空**，`dist` 里编译成 `VITE_ICP_BEIAN:""`，线上页脚因此**不显示备案号**（`verify-legal.mjs` §2 反而断言「页面出现『ICP备』字样: NO（正确）」）。备案号下来后需：写入 `.env` → 重新 `npm run build` + `cap sync ios` → 重新部署，让 Web 页脚与 App 内「关于」页展示备案号（多地通管局要求 App 内标注）。

---

## 九、发布分步清单

### A. Windows 上可完成（本轮已做 / 可做）

- [x] 版本号 bump **1.7.3 (12)**（package.json / pbxproj ×2 / build.gradle 四处，10-29）
- [x] `npm run build` + `npx cap sync ios`（web 资源同步到最新 dist，含隐私门与七方 SDK 公示；产物已 grep 复核）
- [x] **线上服务器重新部署到 1.7.3**（10-29）：此前线上跑旧版（隐私政策仅 1531 字、无隐私门、SDK 公示全缺），而 ASC 填的隐私政策 URL 指向它 → 审核员会看到不合规的旧页面。已用 `SKIP_BUILD=1 bash deploy/deploy.sh`（纯前端更新，不动 nginx）修复，`verify-legal.mjs http://150.158.51.106/` **全量 PASS**。⚠️ 部署用 SSH 账号是 `.env` 里的 `USER=ubuntu` + `SSH_PWD`，**不是** `DBEE_USER=dbee_app`（那是应用/DB 账号，用它 SSH 会 Authentication failed）
- [x] **审核演示账户实证可用**（10-29）：`node tools/setup-review-account.mjs check` → 登录成功；顺带修了脚本缺 Origin 导致的误报
- [x] 🔴→✅ **修复自建网关「密码登录」缺失并热修上线**（10-29 夜）：`server/lib/auth.mjs` 新增 `signInWithPassword` 分支（原 `signIn` 只认 `verification_token`，SDK 的 `{username,password}` 无路可走 → 400「缺少 verification_token」）。含标识归一化（SDK 手机侧发 `+86 138…` 带空格形态，库内 `ident_hash` 按裸 11 位算，不归一化必查不到人）、防枚举（账户不存在/密码错/未设密码一律同文案 401 + DUMMY 哈希恒定耗时）、双维度限流（标识 10 次/15 分钟 + IP 30 次/15 分钟）、日志脱敏。`identity.mjs` 补 `findUserWithPasswordByIdent`（独立函数而非给 `findUserByIdent` 加敏感列）与 `DUMMY_PASSWORD_HASH`。自测 `node tools/selftest-password-login.mjs` → **35/35 通过**。
  ⚠️ **部署红线**：**绝不能跑 `deploy-gateway.sh`**——它会用本地模板覆盖 `/etc/dbee/gateway.env`，而本地 `.env` 缺 `IDENT_PEPPER`/`JWT_SECRET`/SMTP，覆盖会致 `ident_hash` 无法重算、**全站永久锁死**。改用手术式脚本 `deploy/apply-password-login-fix.sh`（只传两个代码文件 → 语法校验 → env 指纹备份 → install → 重启 → healthz 探活失败自动回滚 → **断言 env sha256 前后一致**）。实测：healthz 200、env sha256 一致、备份在 `/opt/dbee-gateway/.bak-20261029-220823/`。
- [x] **云库存活性实证**（10-29）：iOS 数据面凭证有效，登录/读写不受阻
- [x] UI token 化三端一致（web `:root` ↔ mini `tokens.scss`，8 个语义衍生色同名同值）
- [x] 隐私清单 / 权限说明 / 出口合规核对
- [x] ✅ **商店展示截图（10-28 已补齐）**：Apple 2026-10 起 iPhone 必填槽位为 **6.3" 中型屏 1179×2556 或 1206×2622**；已用 `deploy/shot-store.mjs`（store-preview.html 假 iOS 环境 + Playwright 精确像素）生成 5 张 **1179×2556**（`deploy/screenshots/store/iphone-*.png`），付费墙 iOS 形态 7 项断言全过（有恢复购买、无微信/支付宝/兑换码、价格 ¥18/¥128/¥298），详见《AppStore产品页-填报包-2026-10-28.md》§五。⚠️ 上传前人工过目画面；最终以 ASC 上传页实际标红槽位为准（若提示 6.9" 按 1320×2868 重出）。⚠️ 10-29 提示：截图出自 1.7.2 产物，**新增了首启隐私同意门**——若截图里含首屏画面，建议重出一张避免与实际不符（2.3.3 风险）
- [x] ✅ **iPad 截图同为必填（10-28 已补齐）**：`TARGETED_DEVICE_FAMILY = "1,2"`（iPhone+iPad）→ 已生成 5 张 **2048×2732**（`deploy/screenshots/store/ipad-*.png`，`node deploy/shot-store.mjs --ipad`，`?full=1` 解除 480px 宽限铺满屏宽），无需再改 Device Family
- [x] 产品页元数据文案（名称/副标题/关键词/推广文本/描述/版权 + 3 商品显示名与描述）已备齐并通过字数实测，见《AppStore产品页-填报包-2026-10-28.md》
- [ ] ⚠️ **「管理订阅」入口未实现**（见 §八.2）：建议加 `itms-apps://apps.apple.com/account/subscriptions` 跳转按钮，低成本消掉 3.1.2 风险
- [ ] 数据面决策（见第三节，受备案阻塞；**当前维持云库，已实证可用，V1.7.3 可正常上架**）
- [x] ✅ **创意素材（Creative Assets，10-29 已出图）**：与设备截图是**两套独立资产**（横版营销图 vs 竖屏界面，比例不同不可互相缩放），用于产品页面标题 / 搜索结果版位，**选填**（iOS/iPadOS 27 起）；走 ASC **Asset Library** 上传（非截屏区），首个版本未获批前须随 App 版本一起提交。已按官方三个尺寸精确出图：`creative-16x9-5244x2950-v0.png`（仅 PNG，**brand 布局**——核心内容收敛进 Apple 模板 art safe area 1402×962/8.7%，因 16:9 是 universal 素材会被 21:9 与 3:2 两版位裁切）、`creative-3x2-3840x2560-v0.png` 与 `creative-3x2-1920x1280-v0.png`（showcase 满幅 UI 布局，版位原始尺寸不被裁），均在 `deploy/screenshots/creative/`；另有 16:9 满幅备选 `-showcase.png`（须先过 ASC 预览工具才可用）。PIL 复核尺寸精确 + **RGB 无 alpha 通道**（Apple 硬约束）+ 无 transparency；DOM 断言 **126 项全过**（3 尺寸 × 3 文案变体，含 art safe area 与安全区外无文字检查）；对 16:9 产物做 21:9/3:2/交集三种裁切实证均无内容切断。复现 `node deploy/verify-creative.mjs && node deploy/shot-creative.mjs`，详见《AppStore产品页-填报包-2026-10-28.md》§五·补

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

## 十、硬阻塞与依赖汇总（10-29 重排：按「是否挡住明天上架」排序）

| # | 阻塞 | 挡住明天上架？ | 影响 | 解除条件 |
| - | ---- | ---------- | ---- | ------- |
| 1 | 🔴 **中国区提审需 App 备案号 + 三重对齐** | **是（硬阻塞）** | 无备案号 ASC 无法提交中国区审核；填号时还会强校验 **App 名称与 MIIT 逐字一致**（409 `APP_NAME_MISMATCH`，不过存不进）、校验**开发者主体与备案主体一致**（409 `PROVIDER_NAME_MISMATCH`，我方必然不匹配：备案主体=北京迪蜂科技有限公司 vs Apple 账号=个人主体） | 软著证书 + **企业 ICP 备案通过** → 办 App 备案取号；**备案时 App 名称须按 `自律蜜蜂 - 饮食热量记录` 逐字报**；主体问题根治靠账号迁移为组织。当前企业备案进行中、`d-bee.cn` 无 DNS → **明天大概率拿不到**。✅ **TestFlight 不受此限**，可先内测。详见 §八.5 |
| 2 | 🔴 **无 DEVELOPMENT_TEAM** | **是（硬阻塞）** | 无法签名/Archive/Upload，连 TestFlight 都发不出 | Mac 上 Xcode 登录开发者账号 → Signing & Capabilities 选 Team |
| 3 | 🟠 Swift 插件从未编译 | 可能 | 3 个本地插件（iap/health/origin-proxy）首次编译可能报错，需现场修 | ✅ 10-23 静态审查通过（API 签名逐一对照官方 SDK），风险已降为「低」；仍需 Mac 首次构建确认。报错发回 Windows 侧即修即推 |
| 4 | 🟠 **ASC 隐私政策 URL 若填 `d-bee.cn` = 死链** | 是（若填错） | 审核员点开死链 → 2.1 拒审 | ✅ 已有解：**改填 `http://150.158.51.106/legal/privacy`**（10-29 实测 200，内容为 1.7.3 新版政策）。备案通过后再换域名 |
| 5 | 🟡 「管理订阅」入口未实现 | 否（风险） | 3.1.2 可能被打回（非硬拒） | 加 `itms-apps://apps.apple.com/account/subscriptions` 跳转按钮 |
| 6 | 🟡 0037 迁移未执行 + 网关 `APPLE_*` env 未配 | 否（若首发不开付费） | IAP 核销落库无入口（端点 503），沙盒购买后权益不生效 → 审核员若测购买会看到失败 | 服务器执行 `0037-apple-iap-settlement.sql` + 配 `APPLE_BUNDLE_ID`/`APPLE_SHARED_SECRET` + 重启网关（**代码已就绪**）。⚠️ 若 ASC 未配商品，iOS 付费墙走 `PRICE_TAG` 兜底展示 ¥18/¥128/¥298，点击购买会报错提示（不崩溃） |
| 7 | 🟡 备案域名 + HTTPS 未就绪 | 否 | 数据面无法切服务器（**但云库已实证可用，不挡上架**）；微信 Universal Link、IAP webhook URL 不可填 | `d-bee.cn` 备案完成 + 签证书 + 加 A 记录 |
| 8 | 🟡 微信 AppID 仍是占位 `wx0000000000000000` | 否 | 未配 AppID 时原生端微信入口本身隐藏，占位值无副作用 | 替换真实「移动应用」AppID（Universal Link 另需备案域名） |
| 9 | ⚪ Apple 账号为个人主体 | 否 | 对公账户已开立（10-28）但无法绑定；付费协议先按个人办（W-8BEN + 本人卡） | D-U-N-S 下证 → 账号迁移为组织 → 重签协议 + W-8BEN-E + 绑对公（生产售卖前完成） |

### 10-29 已实证解除的「疑似阻塞」（勿再重复排查）

| 曾疑似的问题 | 实证结论 |
| --------- | ------- |
| 云库凭证失效（`invalid_client / credential is invalid or revoked`） | ❌ **误判**。根因是探测时发错鉴权头：正确头为 `x-wb-webapp-access-key`（非 `apikey`），且云端按 **Origin 精确匹配**校验，须同时带 `Origin`/`Referer`。补齐后 `/.cloud/database/rest/` → 200 + PostgREST swagger，`/.cloud/auth/v1/user/me` → 401 `UNAUTHENTICATED`（路由正常）。**iOS 数据面健康** |
| 审核演示账户未注册（10-29 日志「验证码过期未完成」） | ❌ **已过期作废**。`signInWithPassword` 实测登录成功，user.id `2115454156301934592`。脚本 `check` 曾误报失败，根因同上是缺 Origin，已修 |
| 线上服务器跑旧版隐私页 | ✅ **已修复**。重新部署 1.7.3，`verify-legal.mjs` 全量 PASS |
| web 端密码登录报 400「缺少 verification_token」 | ✅ **真缺陷，已修并上线**（10-29 夜，commit `8d4a0ef`）。自建网关 `signIn` 只实现了验证码路径，SDK `signInWithPassword` 的 `{username,password}` 无分支可走。影响面 = **web 端所有设过密码的用户**。修复含标识归一化 / 防枚举 / 双维度限流 / 日志脱敏，`selftest-password-login.mjs` **35/35**，线上 signin 200 + access_token、`user/me` 200、业务表带 token 读取 200。⚠️ 部署走手术式脚本，**绝不可跑 `deploy-gateway.sh`**（覆盖 `gateway.env` 会丢 `IDENT_PEPPER` → 全站永久锁死）。详见卷首结论⑤、§八.3、§九.A |

### ⚠️ 10-29 夜新增的「未来阻塞」（现在不挡，但切库时必炸）

| 隐患 | 触发时机 | 后果 | 预防 |
| --- | ------- | --- | --- |
| **演示账户在两套库里是互不相通的两个账户** | iOS 数据面从云库切到自建库（备案 + HTTPS 就绪后） | 审核员登录进**空账户**（无档案、无蜂蜜、无记录）→ Guideline 2.1「App Completeness」风险 | 切库时必须在自建库**重建** `dbeesupport@163.com` 并**预置演示数据**（`profiles` / `honey_ledger` / 若干 `meal_entries`），再跑一遍 §八.3 的复检命令 |
| 自建库现有 6 个真实用户是迁移/注册产生的，与云库用户**无对应关系** | 同上 | 老用户在 iOS 上的历史数据不会跟过来 | 切库前先做一次云库 → 自建库的**用户与数据迁移方案**（含 `ident_hash` 需用自建库的 `IDENT_PEPPER` 重算，两套 pepper 不同则哈希不可搬） |
