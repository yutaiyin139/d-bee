# 阶段 1 登录链路核查（Android 原生端）

- 日期：2026-10-14
- 范围：阶段 1 剩余 3 项验收（验证码登录 / 云端数据读取 / 记一餐持久化）
- 结论：**原生网络链路本身已打通**；登录被**云端的 Origin 白名单**卡住，根因已精确定位，需要云端配置变更或自建原生转发插件。

---

## 一、结论摘要

| 事项 | 结果 |
|---|---|
| 登录页在原生 WebView 渲染 | ✅ 此前已通过（`phase1-01-native-login.png`） |
| CapacitorHttp 原生 HTTP 通道 | ✅ **已在真实原生运行时验证生效** |
| 云端可达（DNS/TLS/HTTP/apikey） | ✅ 200 / 401 / 200（见下） |
| 邮箱验证码登录 | ❌ 被**云端 Origin 白名单**拒绝（401 `invalid_grant`） |
| 云端数据读取、记一餐持久化 | ⏸ 依赖登录，阻塞中 |

**一句话**：阶段 1 最担心的「CapacitorHttp + 钉死 HTTPS endpoint」方案被证明**有效**；真正卡住登录的是一个此前完全未知的云端约束——**云端按请求来源（Origin）做客户端校验**，原生端不发 Origin，因此过不去。

---

## 二、已验证通过的证据

### 2.1 静态层（APK 解包）

| 检查项 | 结果 |
|---|---|
| `assets/native-bridge.js`（53,118 B） | ✅ 存在于 APK，Capacitor 桥会被注入 |
| 桥内 fetch 补丁代码 | ✅ 含 `window.fetch` 覆写 + `CapacitorWebFetch` 备份 + `cap.nativePromise('CapacitorHttp','request',…)` 转发 |
| `AndroidManifest.xml` | ✅ `INTERNET` 权限在位 |
| `capacitor.config.json`（已同步） | ✅ `androidScheme: https`、`CapacitorHttp.enabled: true` |
| Web 资源 | ✅ 与 dist 哈希一致（index-B7iWuvOD.js 402,872 B） |

### 2.2 运行时层（真实原生 WebView，CDP 取证）

`window.Capacitor` 存在，`getPlatform()=android`，WebView 来源 `https://localhost`，**`httpPatched: true`**（`window.fetch !== window.CapacitorWebFetch`），插件 `[SystemBars, CapacitorCookies, WebView, CapacitorHttp, CapacitorWechat]`。

原生 WebView 内实测（Android 17 模拟器，网络打通后）：

| 请求 | 结果 | 含义 |
|---|---|---|
| `GET  https://zilv-mifeng.app.workbuddy.host/` | **200** | DNS + TLS + HTTP 全通 |
| `GET  /.cloud/database/rest/v1/`（带 apikey） | **401** | 服务器已应答：**apikey 头穿过原生层未被 CORS 拦** |
| `GET  /auth/session` | **200** | 认证接口可达 |

logcat 同时记录了请求被重写进原生拦截器：
`Handling CapacitorHttp request: https://localhost/_capacitor_http_interceptor_?u=https%3A%2F%2Fzilv-mifeng.app.workbuddy.host%2F...`

> 这三条就是阶段 1 的**成败判定点**。它证明：只要登录能完成，后续数据库读写会走同一条已验证的通路。

### 2.3 连接自检面板（新增能力）

登录页底部新增「🔍 连接自检（原生端专用）」，在真机上 8 项全绿（截图 `phase1-02-native-selfcheck.png`），结构化结果同时写入 logcat：

```json
{"tag":"d-bee-diag","platform":"platform=android · isNative=true",
 "endpoint":"https://zilv-mifeng.app.workbuddy.host","httpPatched":true,
 "root":"200 · 6339ms","db":"401 · 651ms（服务器已应答）","session":"无会话","bad":[]}
```

- 实现：`src/native/NativeDiagnostics.tsx` + `src/native/useDiagnosticsEntry.ts`
- **Web 端零影响**：面板走动态 import，Web 端 `isNative()` 恒 false，分包永不加载
- 体积影响：主包 402,341 → 402,872 B（**+531 B / +0.13%**），CSS/分包/wasm 哈希不变；面板本体 6.5 KB 为独立分包，仅原生加载
- 读取方式：屏幕直读，或 `adb logcat | grep d-bee-diag`

---

## 三、阻塞点：云端 Origin 白名单（根因）

### 3.1 现象

原生 App 内走邮箱验证码登录：发码 200 → 验码 200 → **建会话 401**：

```json
{"error":"invalid_grant","error_description":"the session is invalid, expired or issued for another client"}
```

### 3.2 排除过程（关键实验）

| 实验 | 结果 |
|---|---|
| 宿主机 curl 直连云端域名，无 Origin，跑完 发码→验码→signin | signin 同样 401 `invalid_grant` |
| 宿主机 curl 走**生产同源入口** `http://150.158.51.106`（Nginx 反代） | 发码 200 → 验码 200 → **signin 200，拿到 access_token** ✅ |
| curl 直连云端域名但带 `Origin: http://150.158.51.106` | **403 `access_denied`：the request origin is not allowed for this client** |

### 3.3 根因

`deploy/nginx.conf.example` 的反代里**显式强制覆写**了来源：

```nginx
proxy_set_header Origin  "https://zilv-mifeng.app.workbuddy.host";
proxy_set_header Referer "https://zilv-mifeng.app.workbuddy.host/";
```

Web 端能登录，靠的就是这两行。而原生端的请求由 CapacitorHttp 在原生层直发，**不带 Origin/Referer**（logcat 实测请求头只有 `content-type` 与 `x-wb-webapp-access-key`）。

又验证过「从 JS 里补一个 Origin 头」不可行：`Origin` 属于 fetch 规范的 forbidden header name，`Request` 构造时会把它过滤掉——logcat 证实原生层收到的请求头里没有它。

### 3.4 修复路径

> ⚠️ **先纠正一个说法**：云端那套来源校验**不是一份可以增删的域名名单**（依据见 3.4.1），因此「方案 A」不是去某个面板加一行，而是走**平台级例外申请**。原稿「在允许来源列表里增加原生客户端来源」的表述不成立，已修正。

| 方案 | 做法 | 可行性 |
|---|---|---|
| **A. 请求云方放行原生来源** | 向 WorkBuddy 云服务方提申请，为该 publishable key 额外登记原生客户端来源（`https://localhost` / `capacitor://localhost`） | ⚠️ **成功率存疑**：这两个是所有 Capacitor 应用的**通用 origin**，无法区分具体应用；放行等于对这个 key 打开任意 Capacitor 壳。平台定位 ops-free、不暴露控制台，此类例外通常不做 |
| **B. 自建原生转发插件（推荐）** | 写一个极小的 Capacitor 插件：原生层接管 `/.cloud/*` 与 `/auth/*`，用 OkHttp / URLSession 转发到云端并**强制带上 Origin 头** —— 等于把 Nginx 那两行搬进 App | ✅ 双端各约 100 行；完全自主可控，不依赖云方；双端行为一致 |
| ~~C. 改 `server.hostname` 让 origin 天然匹配~~ | 把 WebView hostname 设为 `zilv-mifeng.app.workbuddy.host`，使 origin 变成 `https://zilv-mifeng.app.workbuddy.host` | ❌ **仅 Android 可行**。iOS 的 `iosScheme` 不能设为 `https`（WKWebView 已占用），origin 只能是 `capacitor://…`，仍不匹配 → 半解，不采纳 |

**结论：跳过 A，直接做 B。**

#### 3.4.1 为什么「方案 A 没有可添加的位置」（核查依据）

1. `publishableKey` 只标识「是哪个应用」，**本身不带任何权限**；服务端执行的是 **exact Origin match**（精确来源匹配）。
2. 该 Origin = 应用**创建时预留的发布域名**（由 `domainPrefix` 决定），**一个应用一个，创建后不可更改**。换域名的结果不是「名单多一项」，而是登录直接失效。
3. 平台的管理接口只有 Provider 开关（email / phone / wechat / workbuddy）与只读用户列表，**没有任何 origin / allowed-origins / 域名的配置接口**。
4. 平台设计目标是 ops-free ——「WorkBuddy hosts everything, the user never has to touch an underlying console」，因此**不存在面向用户的来源白名单面板**。

本应用身份：`applicationId = wbapp_w6iIU6TqTyHvJxESPTxBTy`，预留来源 `https://zilv-mifeng.app.workbuddy.host`。
若仍要试 A，可直接把下面这段发给云服务方（预期回复是「不支持」，届时立即转 B）：

> 应用 `wbapp_w6iIU6TqTyHvJxESPTxBTy`（D-Bee）以 Capacitor 原生壳承载，publishable key `wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E`。
> 原生 WebView origin 为 Android `https://localhost` / iOS `capacitor://localhost`，**无法发送 Origin/Referer 头**（CapacitorHttp 原生直发）。
> 现象：`/.cloud/auth/v1/verification` 与 `/verification/verify` 返回 200，但 `/signup`、`/signin` 返回
> `401 {"error":"invalid_grant"}`；带其他 Origin 直连则返回 `403 access_denied: the request origin is not allowed for this client`。
> 请确认：能否为该应用登记原生客户端来源，或明确原生端应使用的 Origin 值？

### 3.5 顺带发现的两个问题

1. **云端错误文案直接透传英文**：UI 显示 `the session is invalid, expired or issued for another client`，用户看不懂。建议在 `AuthScreen` 对 `invalid_grant` / `access_denied` / `resource_exhausted` 等已知错误码做中文映射。
2. **邮箱注册的 `is_user` 判断有坑**：首次注册时 `signup` 返回 401（会话签发失败），但**账号实际已创建**；重试时 `is_user` 变 true、`signup` 变 409 `ALREADY_EXISTS`。即使方案 A 落地，也建议把 409 引导到登录路径，避免用户卡死在「注册说他存在、登录说没会话」。

---

## 四、阶段 1 验收清单状态

| # | 清单项 | 状态 |
|---|---|---|
| 1 | App 启动 → 登录页正常渲染 | ✅ 通过 |
| 2 | 手机验证码登录 | ⏳ 手机号通道未测（需真人收码）；邮箱通道已被 3.3 的根因阻塞 |
| 3 | 登录后首页读到云端数据（**成败判定点**） | ✅ **网络通路已验证**（2.2）；差最后一步「带会话的读」 |
| 4 | 记录一餐 + 杀 App 重开数据仍在 | ⏸ 依赖 #2 |

---

## 五、本轮新增工具与复用方法

### 5.1 `tools/android-cdp.py`（重要）

通过 Chrome DevTools Protocol 直接在原生 WebView 里执行 JS，替代「盲点坐标 + 肉眼看截图」：

```bash
python tools/android-cdp.py targets                       # 列出可调试页面
python tools/android-cdp.py eval "1+1"                    # 执行 JS 并返回 JSON
python tools/android-cdp.py eval-file check.js            # 执行 JS 文件
```

依赖：`pip install websocket-client`（已装入 WorkBuddy 托管 venv）。前置：debug 包 + App 在前台。
React 受控输入的写法见脚本内 `snippet` 子命令（必须用原生 setter + input 事件）。

### 5.2 模拟器网络修复 runbook（本机踩坑实录）

模拟器冷启动后**没有任何网络接口**（只有 `lo`/`dummy0`，无 `wlan0`），按顺序做：

1. **在沙箱外启动模拟器**（沙箱会拦掉虚拟网卡，只起 netsim 的软 AP，永远关联不上）。
2. 启动后手动关联：`adb shell cmd wifi connect-network AndroidWifi open`
3. 若 `dumpsys connectivity` 仍显示 `Active default network: none`（表现为 ping 得通 IP 但 App 解析不了域名）：
   ```bash
   adb shell settings put global captive_portal_mode 0
   adb shell settings put global captive_portal_detection_enabled 0
   adb shell cmd wifi set-wifi-enabled disabled && adb shell cmd wifi set-wifi-enabled enabled
   adb shell cmd wifi connect-network AndroidWifi open
   ```
   关掉强制门户校验后，网络才会被选为默认网络，App 才有 DNS。

### 5.3 环境坑位补充

- **邮箱验证码有配额**：同一邮箱连续发码会 429 `RESOURCE_EXHAUSTED`（本轮触发），排查时别把配额烧完。
- **系统 ANR 弹窗（Pixel Launcher / System UI isn't responding）**：swiftshader 软渲染 + 16 GB 宿主机跑 4 GB AVD 的资源紧张所致，**与 App 无关**（App 进程全程存活、无崩溃）。点 Wait 即可继续。

---

## 六、下一步

1. **主线：直接做方案 B**（自建原生转发插件，原生层强制带 Origin）。方案 A 经核查**没有自助配置入口**，且请求的通用 origin 大概率不被受理，不再作为阻塞项等待。
2. 插件落地后，重跑本轮流程即可完成 #2/#3/#4：`adb install -r app-debug.apk` → 登录 → 看首页数据 → 记一餐 → 杀进程重开。
3. 顺带项：错误文案中文映射（3.5-1）、注册 409 引导（3.5-2）、账号注销（Apple 5.1.1(v)）。
4. 方案 A 仅作**并行知会**（把 3.4.1 末尾那段发给云方即可），不阻塞开发。
