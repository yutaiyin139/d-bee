# D-Bee 原生 App 化方案（iOS / Android）

> 目标：把现有 Web 版 D-Bee（React 18 + Vite 5 + TypeScript，PWA）打包为上架 App Store 与国内安卓商店的原生 App。
> 基准版本：V1.0.1（主包 `index-HKJ5Fec4.js`，2026-10-13）
> 编写日期：2026-10-13

---

## 一、结论摘要

| 项 | 结论 |
|---|---|
| **推荐路线** | **Capacitor 混合壳 + 原生能力插件**，不重写 UI（版本见下方注） |
| **技术可行性** | ✅ 高。云端 SDK 走 `fetch`（166 处）且无 cookie 依赖，原生层代理请求可绕过 CORS |
| **编码工作量** | 约 5–7 周（含联调与真机回归），不含资质办理 |
| **最大的技术阻塞** | `src/cloudConfig.ts` 的 endpoint 运行时推导在 WebView 里会失效（见 §2.1） |
| **最大的商业阻塞** | 现有 Pro 解锁用**兑换码**，直接违反苹果审核指南 3.1.1，必须改为 IAP |
| **最大的合规阻塞** | 工信部 **App 备案**（强制前置）+ 中国区 iOS 必须填备案号；AI 功能还需**算法备案**（约 2–3 个月） |
| **本机环境的硬约束** | ✅ **已解除**：Windows 本身无法构建 iOS，但已确认自备 **Mac mini M4（Apple Silicon）** 承担 iOS 构建，无需云端 macOS CI，也无需公网 IP |
| **建议节奏** | **先 Android 后 iOS**；立项即并行启动备案（它比编码慢得多） |

**一句话策略**：技术上是"给现有 Web 应用穿一件原生外壳 + 补几个原生能力"，真正的时间不在写代码，而在**资质办理**和**支付通道改造**上。

---

## 二、现状盘点：原生化的 7 个技术耦合点

这些是逐行核对现有代码后找出的、进了 WebView 一定会出问题的地方。

### 2.1 ★ endpoint 运行时推导会失效（最高优先级）

**位置**：`src/cloudConfig.ts:44-54`

```ts
function resolveEndpoint(): string {
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.location) {
    const { origin, protocol, hostname } = window.location
    if (origin && /^https?:$/.test(protocol) && hostname && !isLocalHostname(hostname)) {
      return origin            // ← 原生里这里拿不到你的服务器域名
    }
  }
  return CLOUD_HOST            // ← 会掉进这个分支，而注释已标注此路不通
}
```

**为什么坏**：Capacitor 的 WebView 页面来源是 `capacitor://localhost`（iOS）或 `https://localhost`（Android）。
- `protocol` 是 `capacitor:` → 正则不匹配；Android 下 `hostname` 是 `localhost` → 被 `isLocalHostname()` 判为本地
- 结果必然回退到 `CLOUD_HOST`（云端域名直连）
- 而该文件注释已明确记录：**直连云端会因跨域预检不允许 apikey 请求头而被整体拦掉（已实测）** → 数据库请求全挂，App 完全不可用

**改造**：让原生构建显式钉死 endpoint，并配合原生 HTTP 层绕开 CORS：

```ts
// 原生环境判定后走固定值
const isNative = typeof (window as any).Capacitor?.isNativePlatform === 'function'
        && (window as any).Capacitor.isNativePlatform()

function resolveEndpoint(): string {
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  if (isNative) return NATIVE_ENDPOINT      // 构建时注入，如 https://d-bee.com.cn
  /* Web 端保持原逻辑不变 */
}
```

同时**必须开启 Capacitor 的原生 HTTP 层**（`@capacitor/core` 内置 `CapacitorHttp`）：

```ts
// capacitor.config.ts
plugins: {
  CapacitorHttp: { enabled: true },   // patch window.fetch，请求由原生发出 → 无 CORS 限制
}
```

> 关键点：`CapacitorHttp` 在原生层发起请求并回填响应，WebView 只看到结果。
> 这是让 166 处 `fetch` 一行不改就能在原生环境跑通的关键，也是绕开"云端跨域预检"的**唯一**干净解法。
> 注意：钉死 endpoint 后必须用 **HTTPS 域名**（iOS ATS 默认只允许 HTTPS），裸 IP 需额外 ATS 例外配置。

**验收**：真机登录后，首页能读到云端数据（当前 `/` 能渲染但登录后无数据 = 此项没做对）。

---

### 2.2 相机与扫码

| 位置 | 现状 | 原生下会怎样 |
|---|---|---|
| `src/lib/barcode.ts:155` | `navigator.mediaDevices.getUserMedia` 实时解码 | iOS WKWebView **不支持 `BarcodeDetector` API**，必然回退到 zxing-wasm（966 KB）；且 WebView 内相机启动慢、耗电高 |
| `src/pages/LogSheet.tsx:405,430,470` | `<input capture="environment">` | 可用，但用户拿到的是"网页选图片"体验；**高清原图直接进 WebView 易 OOM** |
| `src/lib/ai.ts:326,337` | `URL.createObjectURL` + `canvas` 压缩 | 4800 万像素原图先被读进内存再压缩，低端机有崩溃风险 |

**改造**：
- 扫码换 `@capacitor-mlkit/barcode-scanning` 或 `@capacitor/barcode-scanner`（原生解码，速度快数倍）→ **可同时删掉 `zxing-wasm` 依赖，直接省下 966 KB 安装包体积**
- 拍照换 `@capacitor/camera`，用 `quality` / `width` / `resultType: Uri` 让**原生侧先压好再交给 WebView**，避免大图入内存
- `Info.plist` 补 `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription`；Android 补 `<uses-permission>`、`<uses-feature android:required="false">`（避免平板被判定为不兼容）

---

### 2.3 数据导出

**位置**：`src/pages/ProfileScreen.tsx:150-154` — `URL.createObjectURL(blob)` + `a.download`

**为什么坏**：WebView 没有下载管理器，`a.download` 静默失败。而**这是 Pro 付费功能**（数据导出），坏掉就是付费功能不可用。

**改造**：`@capacitor/filesystem` 写入 Documents 目录 + `@capacitor/share` 调系统分享面板（存文件 / 发微信 / 发邮件）。

---

### 2.4 微信登录

**位置**：`src/pages/AuthScreen.tsx:160`

```ts
await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: location.origin })
```

**为什么坏**：`location.origin` 在原生下是 `capacitor://localhost`，微信开放平台**不接受**该回调地址，且 OAuth 跳转出 WebView 后回不来。

**改造**（二选一）：
- **A（推荐）**：接微信开放平台**移动应用**，用原生 SDK 拿 code，再把 code 交给 `cloud.auth` 换取会话
- **B（降级）**：v1 先只保留**手机号验证码 + 邮箱验证码**登录（这两条是纯 HTTP 请求，原生下天然可用），微信登录延后

> **2026-10-14 勘误与进展**：A 路线实测卡在**云端**而非客户端 —— `cloud.auth.signInWithWechat(code, appid)`
> 文档写明只接受**小程序** `wx.login` 的 code（服务端走 jscode2session），移动应用的 code
> 走的是 `sns/oauth2/access_token`，两者不能混用。客户端侧已全部就绪
> （插件 `@capgo/capacitor-wechat` + 双端工程配置 + 抽象层 `src/lib/wechat.ts`），
> 云端就绪前原生端入口按设计隐藏（避免 App Store 2.1/4.2「登录方式不可用」被拒）。
> 完整记录见 `docs/微信登录接入.md`。

---

### 2.5 存储抽象

| 位置 | 现状 |
|---|---|
| SDK 内部 | 用 `localStorage` 存会话（`lib/index.js` 中 4 处） |
| 项目代码 | `ai_usage` 等业务数据全在云端，本地不落库 |

**风险**：iOS WKWebView 的 `localStorage` 在存储紧张时**可能被系统清理**，且 App 卸载才彻底清。掉登录是小概率但真实的问题。

**改造**：业务侧新增键值读写统一走 `@capacitor/preferences`（Android 走 SharedPreferences，iOS 走 UserDefaults，且**原生侧有系统级持久保障**）。
⚠️ **但 SDK 内部那 4 处 `localStorage` 我们改不了**——这是已知限制，需在真机做长时间挂起/低存储回归，若掉登录频繁则考虑用官方 OAuth 原生流程替换。

---

### 2.6 Service Worker / PWA 残留

**位置**：`src/main.tsx:12-14`、`public/sw.js`、`public/manifest.webmanifest`

**为什么处理**：`capacitor://` 协议下 SW 注册无效且会报错，`manifest` 在 App 内无意义。
**改造**：用环境判断跳过 SW 注册；manifest 保留（Web 端仍需要），仅在原生包内忽略。

---

### 2.7 系统返回键 / 安全区 / 状态栏

- **Android 返回键**：必须接 `@capacitor/app` 的 `backButton` 事件，否则按返回直接退 App（而不是关闭弹层）
- **安全区**：`styles.css` 已有 8 处 `safe-area-inset` 适配、且用 `100dvh`（不是 `100vh`）—— **基础很好，无需大改** ✅
- **状态栏**：`@capacitor/status-bar` 让状态栏配色与页面一致，避免刘海区白条

---

## 三、路线选择

| 维度 | **Capacitor 7**（推荐） | React Native 重写 | Tauri 2 Mobile | 纯 PWA 套壳 |
|---|---|---|---|---|
| 现有代码复用 | **~95%** | 0%（UI 全重写） | ~95% | 100% |
| 工作量 | 5–7 周 | 4–6 个月 | 6–8 周 | 1 周 |
| 能否过 4.2 反套壳 | ✅ 需补原生能力 | ✅ 天然 | ⚠️ 生态较新 | ❌ 必被拒 |
| 1180 条食物数据 | 直接复用 | 需迁移 | 直接复用 | 直接复用 |
| 云端 SDK 兼容 | ✅ 已验证 `fetch` 无 CORS 依赖 | ❌ 需适配 RN 网络层 | ✅ | ✅ |
| 插件成熟度（IAP/推送/相机） | ✅ 官方 + RevenueCat 官方支持 | ✅ | ⚠️ 偏少 | — |
| 团队技能匹配 | ✅ 现有 React/TS 技能直接迁移 | ❌ 需学 RN 生态 | ✅ | ✅ |

**选 Capacitor 的核心理由**：
1. 现有资产（380 KB JS + 1180 条食物库 + 完整业务逻辑 + 云端 SDK 集成）**全部保留**，重写等于把已验证的东西推倒
2. 大厂在用同一条路（Shopify、Salesforce、BBC 新闻），插件生态成熟
3. **RevenueCat 官方提供 `@revenuecat/purchases-capacitor`** —— 内购这块最麻烦的活有现成方案
4. 一套代码同时产出 **iOS + Android + PWA**，Web 端继续可用，不必维护两份

**结论：Capacitor 是唯一在"复用率"与"过审能力"上都不吃亏的选项。**

---

## 四、技术方案（分阶段）

### 阶段 0：代码解耦（约 1 周，Web 端零功能变化）

纯重构，不做任何产品改动，**每步完成后 Web 版必须仍然正常**。

| # | 任务 | 涉及文件 |
|---|---|---|
| 0.1 | 抽出环境抽象层 `src/lib/platform.ts`：`isNative()` / `isIOS()` / `isAndroid()` | 新增 |
| 0.2 | `resolveEndpoint()` 增加原生分支 + 构建期注入 `NATIVE_ENDPOINT` | `src/cloudConfig.ts` |
| 0.3 | 抽出存储接口 `kv.get/set/remove`，Web 走 localStorage、原生走 Preferences | 新增 `src/lib/kv.ts` |
| 0.4 | 抽出相机接口 `captureImage()`，Web 走 input、原生走 Camera | 新增 `src/lib/capture.ts` |
| 0.5 | 抽出扫码接口 `scanBarcode()`，Web 走 getMediaStream、原生走 MLKit | `src/lib/barcode.ts` |
| 0.6 | 抽出导出接口 `shareFile()`，Web 走 a.download、原生走 Filesystem+Share | `src/pages/ProfileScreen.tsx` |
| 0.7 | SW 注册加原生判断 | `src/main.tsx` |

> **这一步的价值**：把"平台差异"全部收敛到 5 个接口后面。之后接 Capacitor 只是**填实现**，业务代码一行不动。即使将来放弃原生，Web 端也变得更干净了。

**验收**：Web 版功能回归全通过，`npm run typecheck` 无错。

---

### 阶段 1：Capacitor 骨架跑通（约 1 周）

> **⚠️ 版本变更（2026-10-14 实施时修订）**：实际采用 **Capacitor 8.5.3**，不是本文原写的 7。
> 原因：Cap 7 的 Extended Support 于 2026-12-08 结束；Cap 8 要求的 Xcode 26+ 正好是苹果强制
> 的上传门槛；Cap 8 默认用 SPM，Mac mini 上无需再装 CocoaPods。
> 详细决策依据、落地文件与验证结果见 **`docs/原生App-阶段1-Capacitor骨架.md`**。
> 下文命令中的版本号请按 8.x 理解。

```bash
npm i @capacitor/core @capacitor/cli
npx cap init "D-Bee" com.dbee.app --web-dir=dist
npm i @capacitor/ios @capacitor/android
npx cap add android
npx cap add ios
```

`capacitor.config.ts`：

```ts
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.dbee.app',
  appName: 'D-Bee',
  webDir: 'dist',
  server: {
    androidScheme: 'https',      // 关键：避免混合内容与 Secure Context 问题
  },
  plugins: {
    CapacitorHttp: { enabled: true },   // ★ 见 §2.1
  },
}

export default config
```

**必做验证（跑通即止，先不接原生能力）**：
- [ ] App 启动 → 登录页正常渲染
- [ ] 手机验证码登录成功
- [ ] 登录后首页能读到云端数据（**验证 §2.1 的 endpoint 方案真的有效**）
- [ ] 记录一餐、写库成功、重启 App 数据仍在
- [ ] 打通后再往下走，否则一切免谈

**构建链**：
- Android：Windows + Android Studio 可完成 ✅
- iOS：**需要 macOS**（见 §7 风险 R1）

---

### 阶段 2：原生能力补齐（约 2–3 周）

按对"过审"的贡献度排序，**前 4 项同时是反击苹果 4.2 条款的弹药**：

| 优先级 | 能力 | 插件 | 对过审的价值 |
|---|---|---|---|
| P0 | 原生相机拍照 | `@capacitor/camera` | 4.2（真实设备能力） |
| P0 | 原生条码扫描 | `@capacitor-mlkit/barcode-scanning` | 4.2 + 顺带减包 966 KB |
| P0 | 推送通知 | `@capacitor/push-notifications` | 4.2（"有理由留在主屏"）；国内需接厂商通道 |
| P0 | 离线可用 | `@capacitor/preferences` + 本地缓存最近记录 | 4.2（离线行为） |
| P1 | 原生分享/导出 | `@capacitor/filesystem` + `@capacitor/share` | 修复 Pro 功能 |
| P1 | 返回键/状态栏/安全区 | `@capacitor/app`、`@capacitor/status-bar` | 体验，避免被判定"像网页" |
| P2 | 桌面小组件（今日热量环） | 原生小组件 | **强烈建议**：最能体现"不是网页"的原生特性 |
| P2 | 健康数据同步（HealthKit / Health Connect） | 社区插件 | 差异化卖点，饮食类 App 天然契合 |

> **过 4.2 的关键认知**：苹果不看你用什么技术做的，只看**结果是不是"薄"**。
> 一个能被 Safari 收藏夹替代的 App 会被拒；有推送、有原生相机、有离线数据、有桌面小组件的 App 不会被拒。
> 建议提交审核时在"审核备注"里明确列出这些原生能力清单。

---

### 阶段 3：过审合规改造（约 1–2 周）

这部分是**代码改动**，与阶段 4 的**资质办理**并行推进。

| # | 改动 | 依据 | 涉及文件 |
|---|---|---|---|
| 3.1 | **下线兑换码，接 IAP** | 苹果 3.1.1 | `src/lib/entitlement.ts`、`PaywallSheet.tsx`、新增 `src/lib/purchase.ts` |
| 3.2 | **App 内账号删除入口** | 苹果 5.1.1(v) | `ProfileScreen.tsx` + 云端删除函数 |
| 3.3 | **AI 调用的显式同意步骤** | 苹果 5.1.1（2025 年末起要求：个人数据送第三方 AI 服务前须显式授权） | `LogSheet.tsx`、`CoachSheet.tsx` 首次调用前弹同意 |
| 3.4 | 隐私政策细化：写明照片/文本会送往第三方 AI 服务、模型名称与备案号 | 苹果 5.1.1 + 国内要求 | `src/content/legal.ts` |
| 3.5 | **AI 生成内容标识**（显式标注 + 隐式元数据/水印） | 国内深度合成规定 | 识别结果与 AI 问答展示处 |
| 3.6 | **App 内展示备案号** | 工信部要求（审核员会真机抽查） | `SiteFooter.tsx`（`VITE_ICP_BEIAN` 通道已就绪，补一个"关于我们"页） |
| 3.7 | 清除所有占位内容与"即将上线"字样 | 苹果 2.1 | 全量排查（V1.0.1 已确认无占位符） |
| 3.8 | 权限用途文案（permission strings）写具体理由 | 苹果 5.1.1 | `Info.plist` / `AndroidManifest.xml` |
| 3.9 | 首次启动隐私同意弹窗 | PIPL + 苹果 | 新增引导页 |

> ⚠️ **3.1 是本次改造中唯一"必须重新设计商业模型"的一项**，单独在 §5 展开。

---

### 阶段 4：资质办理与上架（约 2–4 个月，**非编码工作，越早启动越好**）

| 材料 | 主管/用途 | 周期 | 备注 |
|---|---|---|---|
| **ICP 备案**（域名） | 工信部 | 20 工作日 | ⏳ 已在办理中（V1.0.1 页脚已预留位置） |
| **App 备案**（移动应用） | 工信部，经接入服务商提交 | 7–20 工作日 | **强制前置**，未备案不得上架；备案号须在 App 内展示 |
| **软件著作权** | 中国版权保护中心 | 30–60 工作日（可加急） | 国内安卓商店**强制**（华为/小米/OPPO/vivo/应用宝）；名称必须与上架名完全一致 |
| **算法备案**（生成合成类） | 网信办 `beian.cac.gov.cn` | 2–3 个月 | AI 识别/问答属"生成合成类"。**仅调用第三方已备案大模型 API、无自研微调 → 只需算法备案，不需要完整大模型备案** ✅ |
| **大模型服务登记** | 网信办 | 随算法备案 | 因走 `cloud.llm` 调第三方模型，属轻量化 AIGC 应用 |
| **安全评估报告** | 属地网信办 | 伴随算法备案 | 生成式 AI 服务需对照 GB/T 45654 评估 |
| **ICP 经营许可证** | 通信管理局 | 1–3 个月 | ⚠️ **有会员付费即属经营性互联网信息服务**，需此证；内资企业、注册资本 ≥ 100 万 —— 见 §5 的规避建议 |
| **Apple 开发者账号** | Apple | 1–3 天 | $99/年；企业账号需 **D-U-N-S 编码**（免费但可能等数天至数周，**第一周就申请**） |
| **企业主体营业执照** | 工商 | 视情况 | 个人主体 2026 年起**严禁**涉电商/付费/强监管领域，商业化必须企业主体 |

---

## 五、支付方案（商业模型必须重做）

### 5.1 为什么现有方案一定过不了审

现在 Pro 解锁靠 `src/lib/entitlement.ts:22` 的**硬编码兑换码**：

```ts
export const REDEEM_CODES = ['DBEE-PRO-2026', 'MIFENG-VIP', 'BEE2026']
```

苹果审核指南 3.1.1 要求：**应用内解锁数字功能/订阅，必须走 Apple 内购（IAP）**，并明确点名禁止"自建机制，如许可证密钥（licence keys）或二维码"。
→ 兑换码恰好是**被点名禁止的那一类**。原样打包提交，必然被拒。

### 5.2 分平台支付通道

| 平台 | 通道 | 抽成 | 方案 |
|---|---|---|---|
| **iOS（全球）** | Apple IAP（StoreKit 2） | 30%，小企业计划（年收入 < 100 万美元）**15%** | `@revenuecat/purchases-capacitor` |
| **Android（海外）** | Google Play Billing | 15–30% | 同上（RevenueCat 统一封装） |
| **Android（国内）** | 微信支付 / 支付宝 | 约 0.6% 费率 | ⚠️ RevenueCat **不覆盖**国内商店（它们不用 Play Billing），需接各家渠道 SDK 或聚合支付 |
| **Web（PWA）** | 微信 / 支付宝 | 约 0.6% | 现有逻辑可保留 |

> **国内安卓的现实**：华为 AppGallery、小米、OPPO、vivo、应用宝各有自己的支付与分包要求，需要逐个接入。这也是"先 Android 后 iOS"策略里要正视的成本。

### 5.3 ★ 强烈建议的 v1 策略：先做免费版上架

**理由**：付费这条线一次性绑定三道最难的关：苹果 IAP 改造 + 国内 ICP 经营许可证（注册资本 ≥100 万）+ 多商店支付接入。

**建议拆分**：

| 版本 | 内容 | 目的 |
|---|---|---|
| **v1.0 原生版（上架）** | 免费全文功能；**移除兑换码与付费墙**；保留全部 AI 能力（含同意步骤与内容标识） | 用最低合规成本先过审、先拿真实用户、先积累数据 |
| **v1.1 付费版** | 接入 IAP（iOS）+ 国内聚合支付；恢复 Pro 分层 | 等企业主体、ICP 经营许可证、IAP 商品配置齐备后再上 |

**好处**：
- 绕开 3.1.1 与 ICP 经营许可证这两个最重的门槛
- 免费版没有付费逻辑，审核面更小、更容易一次过
- 已有真实用户量后，IAP 商品定价与转化率才有数据支撑

> 注：移除付费**不等于**可以不办算法备案——只要面向公众提供 AI 生成服务，算法备案就是硬要求，与收不收费无关。

### 5.4 若坚持 v1 就收费

必须同时完成：
1. App Store Connect 创建**自动续期订阅**商品（如 `dbee.pro.monthly` / `.yearly`），配置好价格与续订条款
2. 接入 `purchases-capacitor`，实现**购买 + 恢复购买**（缺恢复购买会被 2.1 拒）
3. 付费墙**明示价格与续订条件**，且与商店标价一致（审核员会逐项比对）
4. 服务端校验收据，权益落库（现有 `entitlements` 表结构可复用，需把来源从"兑换码"换成"商店交易 ID"）
5. 国内主体另办 ICP 经营许可证

---

## 六、合规清单（一次核对，避免反复驳回）

### 苹果侧
- [ ] 4.2 Minimum Functionality —— 已否有足够原生能力（§4 阶段 2）
- [ ] 3.1.1 IAP —— 数字商品必须走内购（§5）
- [ ] 5.1.1(v) —— App 内可删除账号
- [ ] 5.1.1 —— 数据送第三方 AI 服务前**显式同意**（2025 年末起新增要求）
- [ ] 2.1 —— 无占位内容、无崩溃、无死链
- [ ] 2.3.3 —— 截图必须来自**真实构建**，不能是登录页或宣传图
- [ ] 1.5 —— 支持链接真实可用、无需登录即可打开
- [ ] 隐私清单（Privacy Nutrition Label）与实际收集行为一致
- [ ] 提供**可用的测试账号**（审核员要能登录并体验全部功能）

### 工信部侧
- [ ] ICP 备案（域名）
- [ ] App 备案（应用本身）+ 备案号在 App 内显著展示
- [ ] 软著证书（安卓商店强制，名称须与上架名一致）
- [ ] 服务器在境内（✅ 腾讯云 150.158.51.106 已满足）
- [ ] 隐私政策、用户协议、个人信息保护影响评估（如需）

### 网信办侧
- [ ] 算法备案（生成合成类）
- [ ] 大模型服务登记（调第三方已备案模型）
- [ ] 安全评估报告
- [ ] AI 生成内容标识（显式 + 隐式）
- [ ] 算法备案号在产品显著位置公示

### 隐私侧（PIPL）
- [ ] 首次启动隐私同意弹窗（**先同意后收集**）
- [ ] 权限用途文案具体化
- [ ] 数据最小化：只申请核心功能必需的权限

---

## 七、风险登记

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| **R1** | ~~Windows 无法构建 iOS~~ | 🟢 **已解除** | **已确认自备 Mac mini M4（Apple Silicon）**，可直接承载 iOS 构建（见附二）。无需云端 CI |
| **R1b** | ~~Mac mini 机型过旧（Intel）~~ | 🟢 **不适用** | 机型为 M4（Apple Silicon），可升最新 macOS 与 Xcode 27，无降级断供风险 |
| **R1c** | Mac mini 基础款 256 GB 存储被 Xcode 占满 | 🟡 中 | Xcode + 模拟器运行时 + `DerivedData` 可占用 60–100 GB。开工前核对剩余空间（`df -h /`），不足则配外置 Thunderbolt SSD（比 Apple 内置升级便宜得多） |
| **R2** | 苹果 4.2 判定为"网页套壳" | 🔴 高 | 阶段 2 的原生能力不可省；尤其**推送 + 桌面小组件**；审核备注主动说明 |
| **R3** | 3.1.1 因兑换码被拒 | 🔴 高 | 按 §5.3 先出免费版，或按 §5.4 完整接 IAP |
| **R4** | 备案周期（2–4 个月）拖住上线 | 🟠 中高 | **与编码并行启动**，不要等开发完才办 |
| **R5** | 算法备案对 AI 功能的审核不确定性 | 🟠 中高 | 提前联系属地网信办确认口径；备好内容审核规则、敏感词库、拒答机制说明 |
| **R6** | SDK 的 `localStorage` 会话在 iOS 被清理 | 🟡 中 | 真机长时挂起 + 低存储回归；若掉登录频繁改用 OAuth 原生流程 |
| **R7** | 国内安卓多商店支付接入成本 | 🟡 中 | v1 免费版规避；收费版用聚合支付（如 Ping++ / BeeCloud）或 RevenueCat + 自建 |
| **R8** | WebView 内大图内存崩溃 | 🟡 中 | 用 `@capacitor/camera` 原生侧压缩，避免原图进 WebView |
| **R9** | 审核被拒的试错周期 | 🟡 中 | 首次提交前按 §6 清单逐项自查；准备测试账号与审核说明 |

---

## 八、建议执行顺序

```
第 1 周    ├─ 【并行】申请 D-U-N-S 编码 + Apple 开发者账号（企业）
           ├─ 【并行】启动 App 备案 / 软著（周期最长，先跑）
           ├─ 【并行】Mac mini M4 环境准备：升级 macOS → 装 Xcode 26/27 → Node → 拉仓库
           └─ 【编码】Windows 侧：阶段 0 代码解耦（平台抽象层）
第 2 周    ├─ 【编码】阶段 1：Capacitor 骨架
           │         Windows → Android 真机跑通 ｜ Mac mini → iOS 真机跑通（并行）
           └─ 【已就绪】构建环境 = 自备 Mac mini M4（原 R1 决策项已闭合）
第 3–5 周  ├─ 【编码】阶段 2：原生能力（相机/扫码/推送/离线段）
           └─ 【并行】算法备案材料准备
第 6 周    ├─ 【编码】阶段 3：过审改造（免费版策略则大幅简化）
           └─ 【真机】一餐 3–4 道菜的照片回归 + 低端机测试
第 7 周    ├─ 提审 Android（华为/小米优先）
           └─ iOS 提审（备案号到位后）
持续       └─ 备案/软著/算法备案跟进（决定实际上线时间）
```

**里程碑 M1（第 2 周末）**：**Android 与 iOS 双端**真机均能登录、读云端数据、记一餐 —— 证明技术路线成立
**里程碑 M2（第 5 周末）**：原生能力全部就位，可内部体验
**里程碑 M3（第 7 周末）**：提交审核（**是否可上线取决于备案进度，而非代码**）

---

## 九、待决策事项

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| D1 | 商业化主体？ | 个人 / 企业 | 个人主体 2026 年起不能做付费类 App，**要收费必须企业** |
| D2 | v1 是否带付费？ | 免费版先上 / 直接收费 | 决定是否要做 IAP + ICP 经营许可证（见 §5.3，**建议免费版**） |
| D3 | 先做哪个平台？ | **并行（已定）** | 已有 Mac mini M4：Windows 跑 Android 构建 + Mac 跑 iOS 构建，两条线并行 |
| D4 | iOS 构建环境？ | **自备 Mac mini M4（已定）** | 阻塞项已解除（R1）。无需公网 IP、无需云端 CI、无需外包 |
| D5 | 桌面小组件与健康数据同步要不要做？ | 做 / 不做 | 显著提升过审把握与产品差异化，但增加 1–2 周 |
| D6 | 微信登录 v1 是否保留？ | 保留（接原生 SDK）/ 先下线 | 影响登录体验与工作量 |

---

## 附：Capacitor 关键依赖清单（阶段 1–3 预期引入）

```
生产依赖
  @capacitor/core
  @capacitor/camera
  @capacitor/app
  @capacitor/preferences
  @capacitor/filesystem
  @capacitor/share
  @capacitor/status-bar
  @capacitor/push-notifications
  @capacitor-mlkit/barcode-scanning     ← 替换 zxing-wasm，减包 966 KB
  @revenuecat/purchases-capacitor       ← 仅收费版需要

开发依赖
  @capacitor/cli
  @capacitor/android
  @capacitor/ios
```

**可移除**：`zxing-wasm`（约 966 KB，改原生扫码后不再需要）

---

## 附二：自备 Mac mini 作为 iOS 构建机的可行性（2026-10-13 核查）

**结论：可用，且没有公网 IP 完全不影响。**

> **✅ 已确认（2026-10-13）：用户自备机器为 Mac mini M4（Apple Silicon，2024 款）——完全满足要求，R1 阻塞项解除，无需云端 macOS CI。**

### 硬门槛：必须能装 Xcode 26

Apple 官方规定（`developer.apple.com/news/upcoming-requirements`）：

> **自 2026 年 4 月 28 日起**，上传到 App Store Connect 的包**必须**用 Xcode 26 或更高版本构建，且使用 iOS 26 / iPadOS 26 SDK。这是硬闸门——不满足的包在**上传阶段就被拒**，根本进不到人工审核。

而 Xcode 本身对系统有要求：

| Xcode 版本 | 要求的 macOS | 备注 |
|---|---|---|
| 26.0 – 26.3 | macOS Sequoia **15.6**+ | 仍可装在 Intel Mac 上 |
| 26.4 – 26.6（当前） | macOS Tahoe **26.2**+ | |
| 27.x（2026-09-14 发布） | 仅 Apple Silicon | **Intel 到此为止** |

### 机型判定

| Mac mini 机型 | 能否用 | 说明 |
|---|---|---|
| **M4 / M2 / M1（2020 年及以后）** | ✅ **推荐** | 可升到最新 macOS + Xcode 27，长期可用。**← 本机为 M4，已确认** |
| **2018 Intel** | ⚠️ **勉强可用但不建议** | macOS Tahoe 26 **不支持 Intel Mac mini**（仅支持 4 款 Intel 机型：2019 Mac Pro、2019 16″ MBP、2020 13″ MBP 4×TB3、2020 27″ iMac），故系统封顶 Sequoia、Xcode 封顶 **26.3**；Xcode 27 起完全不支持 Intel。今天能开工，一年内必然断供 |

**自查方法**（在 Mac mini 上执行任一条）：

```bash
# 看芯片：出现 "Apple M*" 即 Apple Silicon，出现 "Intel" 则需按上表评估
uname -m && sysctl -n machdep.cpu.brand_string

# 看系统版本：需 ≥ 15.6
sw_vers

# 看 Xcode 版本（若已装）：需 ≥ 26
xcodebuild -version
```

GUI 路径：系统设置 → 通用 → 关于本机 → 「芯片」一栏。

### 为什么不需要公网 IP

整条 iOS 构建链路**只有出站流量**，从不需要外部主动连入你的 Mac mini：

| 环节 | 网络方向 | 说明 |
|---|---|---|
| 下载 Xcode / 模拟器运行时 | 出站 443 | Apple 服务器，体积大（首次约 40 GB 可用空间） |
| `npm ci` / CocoaPods / SPM 拉依赖 | 出站 443 | npm registry、GitHub |
| 登录 Apple Developer / App Store Connect | 出站 443 | 浏览器正常上网即可 |
| 上传 IPA（Xcode Organizer 或 Transporter） | 出站 443 | **NAT 内网完全没问题** |
| 真机调试 | USB 线或同一 Wi-Fi | 走本地链路 |
| APNs 推送（阶段 2 要做） | **双向都是出站** | App → Apple 出站；你的服务端 → Apple 也是出站 |
| App 运行时访问后端 | App 出站 → 公网后端 | 由 WorkBuddy 云承担（`zilv-mifeng.app.workbuddy.host`），已公网可访问 |

苹果审核只要求"**App 所访问的网络服务**可公网访问"，不是要求"**开发机**可公网访问"。前者已经满足，后者从来不需要。

### 唯一会用到"外网连入"的场景：远程操作这台 Mac

如果 Mac mini 不放在你办公桌前，而你想从 Windows 那边操作它：

- **同一局域网**：macOS 自带「屏幕共享」（系统设置 → 通用 → 共享 → 屏幕共享），零配置
- **跨网络（推荐）**：装 **Tailscale**（或 ZeroTier），免费版够用，**不需要公网 IP、不需要端口映射、不涉及备案**。装完两端就像在同一局域网，直接用系统自带的屏幕共享即可
- 其他可行但更绕：Cloudflare Tunnel / ngrok

### 反例：什么情况才真的需要公网 IP

**把后端服务放在家里自建**——比如早前讨论过的"自建 AI 中转服务以使用自己的 API Key"。这一路在国内会撞三堵墙：家庭宽带通常不分配公网 IP（CGNAT）、80/443 端口被运营商封禁、且对外提供服务必须 ICP 备案。这也是 §4.2 里否掉"自建 AI 中转"的原因之一。**V1 的纯静态 + 云后端架构不涉及这个问题。**

### 其他一次性的成本与准备

- **Apple Developer Program**：$99/年（约 ¥688），个人或企业主体均可购买，网页即可注册
- **磁盘空间（M4 基础款要留意）**：M4 Mac mini 起步配置为 **16 GB 统一内存 / 256 GB SSD**，且**内存不可后期升级**（M4 系列焊死）。Xcode + 模拟器运行时 + `DerivedData` 合计可占 **60–100 GB**，256 GB 会偏紧。开工前先跑 `df -h /` 看剩余；不够就配外置 **Thunderbolt SSD**（比 Apple 内置升杯便宜得多，Thunderbolt 速度日常无感）。16 GB 内存跑本项目够用
- **内存**：8 GB 是底线，**16 GB 会明显更顺**（模拟器 + 构建同时跑时差别很大）；M4 基础款即 16 GB，满足
- **代码同步**：Windows 与 Mac mini 之间建议走 Git 私有仓库（Gitee/GitHub/Coding），不要用共享目录，避免 macOS 与 Windows 的换行符/权限位差异引发诡异构建错误

### 对排期的影响（更新 D3）

**已确认机型为 M4，以下并行方案成立：**

自备 Mac mini M4 后，**iOS 与 Android 可以并行推进**，不必再"Android 优先"——Windows 上跑 Capacitor 的 Android 构建没有障碍，Mac mini 跑 iOS。原来 D3 建议的"Android 优先"前提是"没有 macOS 环境"，这条前提现在不成立。

**代价是环境准备要提前**：Mac mini 需要在第 1 周就完成 macOS 升级 → 安装 Xcode（约 40 GB 下载）→ 装 Node → 拉取仓库，否则第 2 周的 iOS 骨架会卡在环境上。

---

*本方案基于 V1.0.1 代码逐文件核对编写。技术事实（Capacitor 版本、审核条款、备案周期、Xcode 系统要求）来自 2026-10 的公开资料检索，政策类信息请以主管部门最新口径为准。*
