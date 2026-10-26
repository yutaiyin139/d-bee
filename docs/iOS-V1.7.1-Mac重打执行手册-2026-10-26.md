# iOS V1.7.1（build 10）Mac 重打执行手册

> 生成：2026-10-26 ｜ 对应提交：**`5f0a099`**（远端 main 最新，clone/pull 到该提交即可开工）
> 目标：把「问问小蜜」超时+无思考链路的修复打进 iOS 包，真机安装验证。
> 前置：本手册是《今晚-Mac编译执行手册.md》（1.7.0 build 9）的增量续篇，环境准备（Xcode、CocoaPods/SPM、证书、StoreKit 本地环境）沿用原手册，不再重复。

---

## 〇、为什么必须重打包（背景速览）

iOS 用户实测 V1.7.0：点「在饮食上拿不准的？问问小蜜」→ 无思考链路 → 约 60 秒后「网络超时，请稍后重试」。

根因（两层，都在安装包里，无法热修）：

1. **旧原生插件 60 秒硬超时**：`OriginProxyPlugin.swift` 旧版用 `dataTask` 整体缓冲响应，`timeoutIntervalForResource = 60s`。LLM 教练回答常超 60 秒 → `NSURLErrorTimedOut` → JS 侧 TypeError → 文案匹配 `/timeout/i` → 「网络超时」。
2. **无流式通道**：旧插件把 SSE 响应憋到结束才一次性回传，用户全程看不到增量输出（「没有思考链路」）。

修复内容（已在远端 main）：

| 层 | 改动 | 文件 |
|---|---|---|
| 原生插件 | `readTimeout` 60→**180s**；资源总时长 600s；新增 `requestStream` 方法（`StreamDelegate` 逐块 `notifyListeners`：`originProxyChunk`/`originProxyEnd`/`originProxyError`；非 SSE 整体缓冲带 `data`） | `native-plugins/dbee-origin-proxy/ios/Sources/OriginProxyPlugin/OriginProxyPlugin.swift` |
| JS 适配 | `nativeHasStreamMethod()` 经 `Capacitor.PluginHeaders` 探测（规避 Capacitor Proxy typeof 恒真陷阱）；SSE 请求走 `nativeStreamFetch`，失败自动回退 `bufferedFetch` | `src/lib/originProxy.ts` |
| JS UI | 教练回答打字机渲染：先插 streaming 气泡显「正在结合你的数据思考…」，`onDelta` 增量追加 + `.coach-caret` 光标；失败保留已吐部分 | `src/pages/CoachSheet.tsx`、`src/lib/ai.ts`、`src/styles.css` |

版本号已就绪：`MARKETING_VERSION = 1.7.1`、`CURRENT_PROJECT_VERSION = 10`（pbxproj 已提交，无需手改）。

---

## 一、Mac 上的操作步骤

```bash
# 1. 取代码（若已有 clone 则 pull）
git clone https://github.com/yutaiyin139/d-bee.git && cd d-bee
git checkout 5f0a099   # 或直接 git pull 到 main 最新

# 2. 安装依赖 + 构建 Web 资产（dist/ 不入库，必须本地构建）
npm ci
npm run build          # vite build，产出 dist/

# 3. 同步到 iOS 工程（会把 dist/ 拷入 + 链接本地插件 @dbee/origin-proxy）
npx cap sync ios

# 4. Xcode 打开工程
npx cap open ios
```

Xcode 内：

1. **确认插件源码是新版**：左侧 Pods/CapApp-SPM 下找到 `OriginProxyPlugin.swift`，检索应能看到 `requestStream` 与 `StreamDelegate`（若看不到，说明 SPM 缓存旧版 → `File ▸ Packages ▸ Reset Package Caches` 后重新 sync）。
2. 选真机目标 → **Product ▸ Run**（开发证书直装）或 **Product ▸ Archive** → Distribute（TestFlight/Ad Hoc）。
3. ⚠️ 本机（Windows）无法编译 Swift，本文件已人工逐行核验语法与 API 签名（Capacitor 8.5.3），但**首次构建若报错，大概率是 SPM 缓存或 Pod 版本问题，不是代码问题**——先 Reset Package Caches。

## 二、真机验收清单（重点：小蜜链路）

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 登录（真短信验证码） | 正常进入首页 |
| 2 | 点「在饮食上拿不准的？问问小蜜」 | 立即出现教练气泡，显示「正在结合你的数据思考…」 |
| 3 | 等待回答 | **逐字打字机输出**（带闪烁光标），不再是干等 60 秒 |
| 4 | 长回答（>60s 场景） | 不再报「网络超时」；块间空闲超 180s 才会失败 |
| 5 | 断网提问 | 报错但**保留已吐出的部分文字**，不白屏 |
| 6 | 回归：记一餐/拍照/扫码/健康数据/分享 | 与 1.7.0 行为一致（`request` 旧方法未动语义，仅超时放宽） |
| 7 | IAP（如测） | 沿用原手册 §一-1.2 结论：本地 StoreKit 可拉商品/购买面板；服务端核销 fail-closed 属设计内 |

## 三、分发给测试用户（18611114399）

- **最快**：Mac 上 Xcode 直连该 iPhone Run 安装（需设备 UDID 注册进开发证书 Profile）。
- **正式**：Archive → App Store Connect → TestFlight（需 ASC App 已建 + 备案域名问题不阻塞 TestFlight 内部测试）。
- 旧 V1.7.0 无法热修，**必须覆盖安装新包**后问题才消失。

## 四、四端状态对照（2026-10-26 10:55）

| 端 | 修复状态 |
|---|---|
| Web | ✅ 已发布上线并实测「秒回复+打字机」（http://150.158.51.106/） |
| Android | ✅ 新 APK 已打好待分发：`release/D-Bee-1.7.1-vc12-release.apk`（含流式插件，解包已验证） |
| 小程序 | ⚠️ 代码已修（networkTimeout 180s + 打字机），**需在微信开发者工具上传发布** |
| iOS | ⏳ 代码已修已推远端，**待本手册在 Mac 上重打 build 10 并安装** |
