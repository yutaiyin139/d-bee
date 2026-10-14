# 阶段 1 · 方案 B（原生 Origin 转发）落地与验收

- 日期：2026-10-14
- 前置：`docs/原生App-阶段1-登录链路核查.md`（定位登录阻塞根因 = 云端 Origin 校验，选定方案 B）
- 结论：**方案 B 落地完成，阶段 1 四项验收全部通过**

---

## 一、一句话结论

自建 `OriginProxy` 原生转发插件后，原生端登录、云端读写、持久化全链路走通；
对照实验（错误 Origin → 403）证实 Origin 确实由原生层送达并被云端接受。

## 二、实现

| 组件 | 位置 | 说明 |
|---|---|---|
| 本地 Capacitor 插件 | `native-plugins/dbee-origin-proxy/` | Android（`HttpURLConnection`，零新增依赖）+ iOS（URLSession，**未在 Mac 上编译验证**） |
| JS 抽象层 | `src/lib/originProxy.ts` | 不 import 任何 Capacitor 包；返回 fetch 兼容实现；Web 端恒 undefined |
| 注入点 | `src/cloud.ts` | 用云 SDK 官方 `options.fetch` 注入，**不 patch window.fetch**，影响面仅限云 SDK 自身请求 |
| 诊断日志 | Java 侧 `Log.d("d-bee-origin", …)` | `adb logcat \| grep d-bee-origin` 可看每个请求的 method/url/Origin（不含凭据） |
| 自检面板 | `src/native/NativeDiagnostics.tsx` | 新增「Origin 转发」「转发实测」两项 |

关键设计决策：

1. **走 SDK 官方注入点而非 patch fetch** —— auth/database/storage/llm 四模块共享同一
   `config.fetch`（源码核实 `createWorkBuddyCloud` → `createCloudFetch`），注入一处全覆盖。
2. **Android 用 `HttpURLConnection`** —— 不引 OkHttp，杜绝与 Capacitor 内部传递依赖的版本冲突。
3. **响应体 Base64 回传** —— 规避 charset 与二进制两类问题；JS 侧解回 `ArrayBuffer` 构造 `Response`。
4. **剔除响应头 `content-encoding`/`content-length`/`transfer-encoding`** —— 原生层已解压，透传会让 body 与元数据不一致。

## 三、对照实验（机制证明）

在原生 WebView 内（CDP）用同一 signin 请求、仅切换 Origin：

| 路径 | 结果 |
|---|---|
| 插件 + 正确 Origin | **400** `INVALID_ARGUMENT`（参数校验 —— 已通过 Origin 校验，进入业务层） |
| 插件 + **错误 Origin** | **403** `access_denied: the request origin is not allowed for this client` |
| 原生 fetch（无 Origin） | 400（该端点的 Origin 校验发生在签发环节） |

错误 Origin 被云端明确拒绝 ⇒ Origin 头确实由原生层送达并被云端识别。

## 四、端到端验收（全部通过）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | App 启动 → 登录页正常渲染 | ✅ | `docs/verify/phase1-02-native-selfcheck.png` |
| 2 | 验证码登录 | ✅ | 邮箱全流程：App 内发码 → 收码 → 填码 → **signin 200 进入 App**（此前 401 `invalid_grant`） |
| 3 | 登录后首页读到云端数据（成败判定点） | ✅ | 每日目标 2267 kcal / 蛋白 105g 等由 onboarding 写入、云端读回；`docs/verify/phase1-03-native-dashboard.png` |
| 4 | 记一餐 + 杀进程重开数据仍在 | ✅ | 午餐「糙米饭（熟）200g = 224 kcal」计算正确；`force-stop` 重开后记录由云端加载恢复；`docs/verify/phase1-04/05-*.png` |

logcat 佐证：冷启动后每个请求带 `Origin=https://zilv-mifeng.app.workbuddy.host`（`d-bee-origin` 标签）。

## 五、顺带发现并修复：冷启动健壮性缺陷

- 现象：`force-stop` 后重启，App 卡在 onboarding（已 onboarded 的老用户被误当新号）。
- 根因（logcat 取证）：模拟器 DNS 短暂未就绪 → 启动期 `getProfile()` 整批失败
  （SDK 内部已重试 3 次，仍不够）；`App.tsx` 对该失败的处理是**留在 onboarding 且不再重试**。
- 修复：`enterApp` 对 `getProfile` 做有限次退避重试（3 次，1.5s/3s），全部失败才降级。
- 修复后复验：冷启动直达首页 ✓。

## 六、已知限制与遗留

1. **iOS 侧 Swift 代码未编译验证**（当前开发机为 Windows）；Mac mini 首次构建时需回归同四项验收。
2. **不支持流式响应**：LLM `stream: true` 会退化为一次性返回；接 AI 对话时需关流式或扩展插件（阶段 2）。
3. **不支持中途取消**：不响应 `AbortSignal`。
4. `ios/App/App/public` 的 web 资源本轮未能更新（目录句柄被锁）——Mac 构建前跑 `cap sync` 会重建，无实际影响。
5. Origin 值钉死在两处：`src/lib/originProxy.ts` 的 `CLOUD_ORIGIN` 与 Java/Swift 侧 `DEFAULT_ORIGIN`；
   将来启用自有域名时三处（含 Nginx）必须同步改。
6. 邮箱注册的 409 `ALREADY_EXISTS` 引导、云端错误文案中文映射仍未做（3.5 遗留项）。

## 七、本轮环境坑（新增）

- **模拟器网络会反复掉**：表现为 App 内请求 `Unable to resolve host`。
  修复 runbook 见《原生App-阶段1-登录链路核查.md》§5.2（wifi 开关 + connect-network）。
- **safe-delete 守卫升级**：`cap sync` 的删除在守卫 `ETIMEDOUT` 时直接失败，且被锁目录
  连 `mv`/`Rename-Item` 都会 Permission denied（进程句柄）。绕法升级：
  变更仅涉及 web 资源时用 `npx cap copy android`（不触发删除插件目录）替代 `cap sync`。
