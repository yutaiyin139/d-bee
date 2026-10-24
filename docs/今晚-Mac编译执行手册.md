# 今晚 Mac 编译执行手册（iOS 1.7.0 build 9）· 终版

> 生成：2026-10-23 21:00 ｜ 对应提交：**`dfa3191`**（远端已有；本地还有一个 internalID 格式微调 `47ff2ae` 因网络波动暂未推上，**不影响任何功能**，clone 到 `dfa3191` 即可开工）  
> 目标：首次在 Mac 上编译 D-Bee iOS 工程并**编译无误**，真机跑通基础回归 + **IAP 客户端链路本地实测**。

---

## 〇、结论速览

**编译通过置信度：高。** 静态审查全部完成（类声明与官方插件逐字节同构、Capacitor API 签名对照 8.5.3 源码核实、SPM 链 0 diff、`cap sync ios` 在 Windows 重跑通过、typecheck/build 全绿）。

**今晚新增能力（相比 19:30 版手册）**：

1. ✅ **本地 StoreKit 测试环境已配好**：`ios/App/DbeeProducts.storekit`（3 商品：月订阅 ¥18 / 年订阅 ¥128 / 终身买断 ¥328，zh_CN 本地化）+ 共享 scheme 已挂引用 → **不需要 App Store Connect 建商品，今晚真机就能测「拉商品→购买→恢复」**。
2. ✅ **付费墙接通商店价格**：iOS 打开付费墙时经 `DbeeIap.getProducts` 拉商店本地化价格展示（此前 fetchProducts 没有任何 UI 调用方，插件 getProducts 路径从未被触发）；拉不到时静默回退硬编码价。
3. ✅ **修了一个类型谎言**：`iosIap.ts fetchProducts` 此前把商店 ID（`dbee_pro_monthly`）直接 `as ProductId`（键是 `proMonthly`），调用方按键索引会全 miss；已建反向映射。

**今晚可达 / 不可达**：

| 链路                                                      | 今晚可测？                | 说明                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编译 + 真机运行                                               | ✅                    | 核心目标                                                                                                                                                                              |
| 登录（真短信）/记一餐/拍照/扫码/健康/分享                                 | ✅                    | 数据面走云库（与现状一致）                                                                                                                                                                     |
| **IAP 客户端**：getProducts 返回 3 商品、purchase 拉起支付面板、restore | ✅ **本地 StoreKit 环境** | scheme 已挂 `.storekit`，Run 即生效                                                                                                                                                     |
| **IAP 服务端核销**：购买后权益到账                                   | ⏸ 预期失败（见 §一-1.2③）    | 双重原因：①iOS 数据面=云库，云侧网关**没有** verify 端点→404→回退 RPC→云库 RPC apple 分支是 fail-closed TODO→恒 false；②自建服务器侧 0037 迁移未执行 + APPLE\_* env 未配。**前端会显示「支付校验失败」——这是设计内的 fail-closed（防白嫖），不是 bug** |
| 沙盒购买全链路（真 Apple 沙盒）                                     | ⏸                    | 需 ASC 建 App+商品+付费协议 + 服务端 A1 部署 + 备案域名（webhook）                                                                                                                                   |

---

## 一、前后端全链路逻辑（梳理终版）

### 1.1 数据面与请求通道（登录/数据 为什么能通）

```
iOS App (WebView, origin=capacitor://localhost)
  │
  ├─ endpoint 解析（src/cloudConfig.ts）：
  │    VITE_NATIVE_ENDPOINT 未注入 → 回退 CLOUD_HOST
  │    = https://zilv-mifeng.app.workbuddy.host（腾讯云库）
  │
  ├─ 所有云 SDK 请求（登录/REST/RPC）：
  │    cloud.ts 注入 createNativeFetch()
  │    → OriginProxy 原生插件代发（URLSession 强制注入
  │      Origin/Referer = CLOUD_ORIGIN，等价于 Nginx 那两行）
  │    → 云库按 Origin 精确匹配放行 ✅
  │
  └─ 短信验证码：云库侧有真短信服务 → iOS 能收码登录 ✅
     （对比：web 端走 150.158.51.106 自建网关，SMS_PROVIDER=log
       只写日志不真发 → 用万能码 MFzBoOi3kQnoHIHewRcrdpsw 登录）
```

**关键约束**：ATS 禁止 http 明文 + IP 证书不可信 + 备案未完成 → 今晚**不切**数据面，iOS 继续连云库。这是既定决策，不是缺陷。

### 1.2 IAP 购买链路（四步，每步落点）

```
① 下单       checkout.ts → createPaymentOrder('dbee_pro_monthly','apple')
              → 云库 RPC create_payment_order（服务端查价，防篡改）✅ 已上云
② 平台支付   iosIap.ts adapter.purchase → DbeeIap 插件（StoreKit 2）
              → Product.purchase() → transactionId + appStoreReceiptURL 收据 base64
              → 今晚由本地 .storekit 环境应答（免 ASC）
③ 回传核销   api.ts verifyPaymentOrder：
              platformName()==='ios' → 先走网关
              POST {endpoint}/.cloud/payment/apple/verify（Bearer JWT）
              ├─ endpoint=云库 → 云侧网关无此端点 → 404 → null → 回退 RPC
              ├─ RPC verify_payment_order apple 分支 = TODO fail-closed → false
              └─ （未来自建端：网关 iap.mjs 验签 Apple → 0037
                   settle_apple_purchase 幂等落权益 → true）
④ 刷新权益   PlanProvider.refresh() → entitlements 表 → UI 解锁
```

**③ 的三态语义**（`verifyViaGateway` 返回 `boolean|null`）：

- `true/false` = 网关明确给出结果，**采信不回退**；
- `null` = 通道不可用（404/405/503/网络异常）→ 回退 RPC。  
  今晚云库侧必然走 404→回退→false→前端提示「支付校验失败」。

### 1.3 订阅续期权威链路（上线后）

```
Apple → POST https://d-bee.com.cn/.cloud/payment/apple/notifications
     → 网关 JWS x5c 证书链验签（钉扎 AppleRootCA-G3）
     → DID_RENEW：按 original_transaction_id 反查 owner → 顺延 pro_until
       （客户端不在线也能续；GREATEST 防乱序回拉）
     → REFUND/REVOKE：revoke_apple_purchase 回收权益
```

依赖：备案域名 + HTTPS + ASC 配 webhook URL + 服务端 A1（0037 + APPLE\_* env）。

### 1.4 插件注册链（编译产物怎么进 App）

```
capacitor.config.ts ios.includePlugins（5 个，微信刻意排除）
  → cap sync ios 生成 CapApp-SPM/Package.swift（本地 path 引用）
  → pbxproj XCLocalSwiftPackageReference "CapApp-SPM"
  → 运行时 Capacitor 按 packageClassList 注册
    OriginProxyPlugin / SharePlugin / DbeeHealthPlugin / DbeeIapPlugin / CAPCameraPlugin
  → JS 侧鸭子类型探测 window.Capacitor.Plugins.DbeeIap 等（零静态依赖）
```

---

## 二、环境要求

| 项        | 要求                                                                        |
| -------- | ------------------------------------------------------------------------- |
| Xcode    | **26.0+**（Capacitor 8 硬要求；2026-04-28 起 ASC 拒收旧 Xcode 构建）。**27.1 已核实可用**——UIScene 已采纳（`SceneDelegate.swift` + `Info.plist` 的 `UIApplicationSceneManifest` + `AppDelegate.configurationForConnecting`），满足 Apple TN3187「iOS 27 SDK 构建的 App 必须 scene-based，否则编译成功但启动即崩」；`swift-tools-version` 保持 **5.9**（Capacitor 8 尚不支持 Swift 6，勿擅自升级）                  |
| Node     | **22+**                                                                   |
| Apple ID | 已登录 Xcode（个人开发者账号已通过）                                                     |
| 真机       | iPhone（iOS 15+）+ 数据线 + 信任此电脑；iOS 16+ 需在 设置→隐私与安全性→开发者模式 打开 Developer Mode |
| 网络       | 首次编译要从 GitHub 拉 capacitor-swift-pm + ion-ios-camera 两个 SPM 远程包            |

---

## 三、逐步执行（照抄）

```bash
# 1. 拉代码
git clone https://github.com/yutaiyin139/d-bee.git
cd d-bee
git log --oneline -1
#   期望 ≥ dfa3191 feat(ios): 付费墙接入商店价格拉取 + 本地 StoreKit 测试环境
#   （若显示 47ff2ae fix(ios): storekit internalID... 更好，两者功能等价）

# 2. 装依赖 + 构建 web + 同步 iOS + 打开 Xcode
node -v            # 必须 ≥22
npm ci             # 2026-10-24 起自带 postinstall：装完依赖自动构建 packages/shared
                   # （若跳过 npm ci，shared 会报 sh: tsc: command not found）

# ⚠️ 关键：三步构建，顺序不能乱（dist/ 和 packages/shared/dist/ 都是 gitignore 的，
#    clone 后不存在，必须先各自 build 出来。① 在 npm ci 的 postinstall 已自动做过，
#    重复执行无害；若跳过 npm ci 则必须手动做①，否则②会因 tsc 缺失而失败）
cd packages/shared && npm run build && cd ../..   # ① 先构建 @dbee/shared（生成 shared/dist/）
npm run build                                     # ② 再构建 vite web（生成 dist/）
npx cap sync ios                                  # ③ 同步 web 资源 + 插件进 iOS 工程
#   成功标志：Found 5 Capacitor plugins for ios
#   （origin-proxy / share / health / iap / camera —— 没有 wechat 是刻意的）
#   然后手动打开 Xcode：open ios/App

# （等价一步式：npm run native:ios = 上面②③ + open，但依赖 shared 已 build，见下行）
#   即：cd packages/shared && npm run build && cd ../.. && npm run native:ios
```

```text
3. Xcode GUI 操作：
a) 顶栏 scheme 确认是 App（共享 scheme 已入库，Run 配置已挂 DbeeProducts.storekit）
   验证：Product → Scheme → Edit Scheme → Run → Options →
   StoreKit Configuration 应显示 DbeeProducts.storekit
   （若显示 None：手动下拉选中它——文件在工程导航器根级）
b) 设备选你的 iPhone 真机
c) TARGETS: App → Signing & Capabilities → Team: 选你的开发者账号
   Bundle Identifier 确认 com.dbee.app（自动签名会在后台注册 App ID，正常）
d) ⏺ Cmd+R —— 首次要解析 SPM 远程包，需联网，耐心等
e) 编译成功 → 自动装机启动
```

```text
4.（可选，今晚不强制）Archive → Upload：
   Product → Destination = Any iOS Device (arm64) → Product → Archive
   → Organizer → Distribute App → App Store Connect
   注意：ASC 还没建 App，Upload 会因「App 不存在」被拒——
   今晚到「Archive 成功产出 .xcarchive」即可证明 Release 编译无误。
```

---

## 四、真机回归清单

| #  | 用例                    | 预期                                                                                                                           | 涉及                            |
| -- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1  | 手机号+验证码登录             | ✅ 真短信送达（iOS 走云库）                                                                                                             | origin-proxy                  |
| 2  | 记一餐（文字）               | 保存成功                                                                                                                         | origin-proxy                  |
| 3  | 拍照识别                  | 权限弹窗文案=Info.plist 具体用途                                                                                                       | camera                        |
| 4  | 扫条码                   | 摄像头拉起、识别                                                                                                                     | camera+zxing                  |
| 5  | 健康数据源→连接 Apple Health | 授权弹窗（步数+活动能量）→ 今日数据计入                                                                                                        | dbee-health                   |
| 6  | 分享                    | 系统分享面板                                                                                                                       | share                         |
| 7  | **打开付费墙**             | **3 个商品按钮显示 StoreKit 本地化价格**（¥18.00/¥128.00/¥328.00，来自 .storekit 而非硬编码）                                                      | dbee-iap getProducts          |
| 8  | **点商品→购买**            | **拉起本地 StoreKit 支付面板**（显示「环境：Xcode」角标）→ 确认 → 购买成功回调 → **前端提示「支付校验失败，请稍后重试或联系客服」** ← ⚠️ 这是预期！服务端核销不可用（§一-1.2③），fail-closed 设计 | dbee-iap purchase + verify 链路 |
| 9  | **恢复购买**              | 走到「未找到可恢复的购买记录」或同样校验失败提示；不崩溃                                                                                                 | dbee-iap restore              |
| 10 | Xcode 底部 console      | 无红色崩溃栈；无 `[originProxy] 未发现插件` 警告                                                                                            | —                             |

**用例 8 判定标准**：插件层成功（支付面板拉起、transactionId 返回）= **今晚 IAP 客户端链路验证通过**；核销失败提示 = 服务端未部署的已知状态。可用 Xcode 菜单 Debug → StoreKit → Manage Transactions 查看本地交易记录佐证。

---

## 五、预期错误点与修法

| # | 症状                                                                | 修法                                                                            |
| - | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 | `Signing for "App" requires a development team`                   | 步骤 3c 选 Team                                                                  |
| 2 | SPM 拉包失败（`failed to clone capacitor-swift-pm` / `ion-ios-camera`） | File → Packages → Reset Package Caches 重试；必要时挂代理                              |
| 3 | `Missing package product 'Wechat_...'`                            | 不该出现；检查 capacitor.config.ts ios.includePlugins 无 wechat，重跑 `npx cap sync ios` |
| 3b | **`Missing package product 'capapp-smp'` / `'CapApp-SPM'`**（主本地包解析失败，首次构建高发） | **Xcode 还没解析本地 CapApp-SPM 包或 SPM 缓存陈旧**：① `File → Packages → Reset Package Caches` → ② `File → Packages → Resolve Package Versions`；仍不行 ③ 清 `~/Library/Caches/org.swift.swiftpm ~/Library/Developer/Xcode/DerivedData` 后重启 Xcode。首次必须联网（拉 `capacitor-swift-pm` 8.5.3 + `ion-ios-camera` 两个远程包） |
| 3c | **`CocoaPods is not installed` + `xcrun: error: invalid active developer path` / `xcrun --find xcrun` 报 `failed to locate xcrun`** | 🔴 **真因是 Xcode 的 active developer path 指向了不存在工具链的位置**（升级 Xcode 后高发：旧 app 被删/改名，`/Applications/Xcode.app` 成空壳）。D-Bee **纯 SPM、仓库从无 Podfile**，装 pod 是错方向。**决定性一步**：`mdfind "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"` 找出 Xcode 真实路径 → `sudo xcode-select -s <真实路径>/Contents/Developer` → `sudo xcodebuild -license accept` → `sudo xcodebuild -runFirstLaunch`（新装/升级后必做，装缺失组件）→ 验 `xcrun --find xcrun` 与 `xcodebuild -version` 都正常返回。⚠️ 不要删 `ios/App/CapApp-SPM`（`cap sync` 不会重建它，删了就永久回退 CocoaPods 分支） |
| 3d | **（10-24 实测进展）`xcode-select -s` 已成功、`sudo xcodebuild` 不报错，但普通用户 `xcrun --find xcrun` 仍报 `Failed to locate 'xcrun'`** | 🔴 **sudo 下能跑、普通用户跑不了 = Xcode.app 包内权限问题**（xcrun 的 `access(X_OK)` 检查在用户身份下失败：某级目录缺 `+x` 穿越权，或 xcrun 无执行位，或属主异常）。**决定性测试（不加 sudo）**：`ls -l /Applications/Xcode.app/Contents/Developer/usr/bin/xcrun`（Permission denied 即实锤）+ `xcrun --version` + `xcodebuild -version`（不加 sudo）。修法：`sudo chmod -R a+rX /Applications/Xcode.app`（只加读/执行、从不减权，安全）→ 必要时 `sudo chown -R root:wheel /Applications/Xcode.app` → 重验。若 `file` 显示 empty/`du -sh` 仅几 GB → 才是 xip 解压损坏，须重装 |
| 3e | **（10-24 09:39 实锤）`xcodebuild -version` 显示 Xcode 27.1 但 `/Applications/Xcode.app` 仅 3.8G 且缺 `Developer/usr/bin/xcrun`** | 🔴 **生效工具链是 Command Line Tools，不是 Xcode**——CLT 的 xcodebuild 也会报「Xcode 27.1」（版本号随 CLT 对齐），极具迷惑性；**CLT 无 iOS SDK，编不了 App**。判定铁律：`xcodebuild -showsdks \| grep -i ios`——列出 iphoneos SDK 才能编 iOS。修法 = 装完整 Xcode 27.1（App Store 流式装，35GB 勉强够但建议先删坏壳 + 旧模拟器 runtime + DerivedData 腾到 ≥50GB）→ `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` → `runFirstLaunch` → 重验 `-showsdks`。**教训：验证 Xcode 完好要看 `du -sh`（≥15GB）+ `-showsdks` 有 iphoneos，不能只看 `-version`** |
| 4 | `no such module 'Capacitor'`                                      | Reset Package Caches；仍不行 `rm -rf ~/Library/Caches/org.swift.swiftpm` 重开       |
| 5 | 真机白屏                                                              | public/ 没同步：终端重跑 `npm run build && npx cap sync ios` 再 Cmd+R                  |
| 6 | 付费墙价格仍是硬编码文案（¥18 / 月 而非 ¥18.00）                                   | scheme 没挂上 .storekit（步骤 3a 验证）；或插件未注册（console 看 DbeeIap 探测日志）                 |
| 7 | 购买后提示「支付校验失败」                                                     | **预期行为**（§一-1.2③），不是 bug，不要修                                                  |
| 8 | HealthKit 模拟器不可用                                                  | 用真机（插件已防御不崩溃）                                                                 |
| 9 | 清单外 Swift 编译错误                                                    | 完整报错发回 Windows 侧，即时修源码推 GitHub，Mac `git pull`                                 |

---

## 六、今晚之后的衔接（按优先级）

1. **服务端 A1**（Windows 侧 1 次 SSH，随时可做）：执行 0037 迁移 + 网关 env 配 `APPLE_BUNDLE_ID=com.dbee.app`、`APPLE_SHARED_SECRET`（ASC 生成后）、`APPLE_SANDBOX=1` + 重启网关。做完后自建端点的 verify/notifications 即活。
2. **ASC 建 App + 3 商品**（ID 必须与代码一致：`dbee_pro_monthly`/`dbee_pro_yearly`/`dbee_lifetime`）+ 接受《付费应用协议》（协议「有效」才能沙盒测试）→ 之后把 scheme 的 StoreKit Configuration 切回 None（走真沙盒）。
3. **短信**：服务已购，等公章签协议 → 我切 `SMS_PROVIDER=tencent` + 删万能码 + 加 `DBEE_PROD=1`。
4. 个人→公司开发者迁移（D-U-N-S）；备案+HTTPS 后切数据面、配 webhook、Associated Domains；微信真实 AppID。

---

## 七、一页速查

```text
Xcode 26+ ｜ Node 22+ ｜ iPhone 真机 ｜ 开发者账号已登录

git clone https://github.com/yutaiyin139/d-bee.git && cd d-bee
git log --oneline -1          # ≥ dfa3191
npm ci
cd packages/shared && npm run build && cd ../..   # ① shared 构建（dist/ 是 gitignore 的，必做）
npm run build                 # ② vite web 构建（生成 dist/）
npx cap sync ios              # ✔ Found 5 Capacitor plugins（无 wechat）
#   或一步式：cd packages/shared && npm run build && cd ../.. && npm run native:ios

Xcode: Scheme Run→Options 确认挂 DbeeProducts.storekit
       Signing 选 Team → Cmd+R（首次拉 SPM 远程包，慢）

回归: 登录(真短信)→记一餐→拍照→扫码→健康→分享
IAP:  付费墙显示商店价(¥18.00/¥128.00/¥328.00)
      → 购买拉起本地支付面板 → 「支付校验失败」= 预期(服务端未部署)
      Debug→StoreKit→Manage Transactions 可查本地交易
报错对照 §五；清单外错误发回即时修
```
