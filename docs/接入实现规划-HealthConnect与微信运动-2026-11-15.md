# 接入实现规划 · Health Connect 与微信运动（2026-11-15）

> 承接 `docs/HealthConnect重点规划-2026-11-15.md`（产品方向与架构主线）与
> `docs/智能设备功能梳理-2026-11-15.md`（现状盘点）。本文只回答**「怎么落地」**：
> 文件清单、接口契约、平台约束、验收探针、里程碑与红线。
>
> 🔴 本轮**只做规划，零功能代码改动、零构建、零生产变更**。
> 外部能力以 2026-11-15 现查的官方文档 / 微信开放社区为准，社区技术文仅作实现参考。

---

## 0. 两个改变方案的发现（先看这里）

| # | 发现 | 对方案的影响 |
|---|---|---|
| **F1** | Health Connect 官方要求累计型数据用 **`aggregate()`** 而非 `readRecords()`，且 Aggregate API **自带**按用户设定的 Activity/Sleep 应用优先级做多源去重 | 原「HC-3 自研多源去重」从「必须自研」降级为「平台已解决 + 只需处理 HC 与厂商 SDK 双通道冲突」，工作量与虚高消耗风险大幅下降 |
| **F2** | 项目 **0046 迁移 + `server/lib/wechatSession.mjs` + `auth.mjs exchangeWechatCode()`** 已具备 `wx.login → code2Session → session_key` 全链路，且 `app_users.wechat_session_key_enc` 已 AES-256-GCM 加密落库 | 微信运动解密**不需要新表、新 env、新迁移、新后端服务**；只需在网关加一个端点，复用现成凭据与 `WECHAT_MINI_SECRETS` |

另有两处**旧结论需纠偏**（详见 §2.1、§3.1）：
- 项目护栏注释写「`wx.getWeRunData` 需运动健康类目资质」—— 类目限制针对**写入（分享数据到微信运动）**，读取方向的硬前置是《用户隐私保护指引》声明 + 用户授权，不是换类目。
- 小程序「微信运动」不是「没能力」，是**有官方通道但零实现**；且只能由**用户主动点击**触发，与现有自动轮询冲突（§3.4 给出解法）。

---

# 第一部分 · Health Connect 实现

## 1. 可复用的现成资产（不用重写）

| 层 | 文件 | 现状 | 本规划的动作 |
|---|---|---|---|
| 门面 | `src/lib/health/index.ts` | `connectHealth()` / `syncFromHealth()` 按 vendor 分派 | **加分派分支**，不动函数签名与调用方 |
| 类型 | `src/lib/health/types.ts` | 7 态 `HealthSyncStatus` + `normalizeHealthStatus()` | **零改动**，HC 复用同一枚举 |
| iOS 适配器 | `src/lib/health/healthkit.ts` | 同构适配器样板 | 作为 `connect.ts` 的**形状模板** |
| Android 适配器 | `src/lib/health/android.ts` | 厂商白名单，插件鸭子类型探测 | 保留作**补充通道**；白名单不再是唯一判据 |
| 品牌识别 | `src/lib/health/brand.ts` | 纯函数，UA 关键字 | 不动枚举；HC 能力由插件运行时返回，不靠 UA 猜 |
| 原生插件 | `native-plugins/dbee-health/android/.../DbeeHealthPlugin.java` | 骨架，`not_ready` 恒返回 | **新增 HC 读取实现**（建议 Kotlin 文件） |
| 计算口径 | `src/pages/Dashboard.tsx` + `mini/src/pages/index/index.tsx` | `activityKcal = healthActiveKcal > 0 ? : estimateActivityKcal(steps,…)`；`max(手动, 活动) × 0.5` | **零改动**，新增数据源只提供输入 |
| 常量 | `packages/shared/src/constants/index.ts` | `ACTIVITY_EATBACK_RATIO=0.5` / `DEFAULT_STEP_GOAL=6000` / `HEALTH_SYNC_INTERVAL_MS=60_000` | **零改动**，四端单一真源 |
| 目录 | `packages/shared/src/myPage.ts` | `HEALTH_APP_CATALOG` 6 行；`healthCatalogKeyForVendor()` 按机型过滤 | 是否新增「系统健康」行 = **待拍板 D1** |

## 2. 目标架构与文件清单

```
穿戴设备 / 厂商 App ──写入──> Health Connect（系统聚合层，设备本地）
                                  │ aggregate() 读当天
                                  ▼
   DbeeHealth Android 插件（Kotlin：getSdkStatus → 授权 → 聚合读）
                                  │ JS Bridge：{ steps, activeKcal, status, availability }
                                  ▼
   src/lib/health/connect.ts     ← 第三适配器，与 healthkit.ts / android.ts 同接口
                                  ▼
   src/lib/health/index.ts 门面 ──> Dashboard（现有计算零改动）
```

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/lib/health/connect.ts` | 新增 | `isHealthConnectAvailable()` / `requestHealthConnectAuthorization()` / `fetchHealthConnectToday()`；沿用 `HealthSyncData` |
| `src/lib/health/index.ts` | 改 | Android 分派：HC 可用 → HC；否则 → 厂商适配器；`isHealthConnectable()` 纳入 HC 能力 |
| `src/lib/health/android.ts` | 改（小） | 去掉「只有白名单才算可连接」的隐含假设；`fetchToday()` 增加 `availability` 透传 |
| `native-plugins/dbee-health/android/.../HealthConnectReader.kt` | 新增 | HC 客户端、权限、聚合读、状态映射 |
| `DbeeHealthPlugin.java` | 改 | 桥接 Kotlin Reader；`requestAuthorization` / `fetchToday` 返回真实值；厂商 SDK 骨架保留为 fallback |
| `android/app/src/main/AndroidManifest.xml` | 改 | 只读权限 + provider 可见性 + 权限说明 intent-filter |
| `android/app/build.gradle` | 改 | `androidx.health.connect:connect-client`（官方起步文档示例 `1.1.0-rc03`，落地以最新稳定版为准）+ Kotlin/协程 |
| `tools/*.test.ts` | 改 | 新增 HC 护栏（**先写断言 → 红验证 → 再改源码**） |

## 3. 插件接口契约（JS Bridge，前端无感知平台差异）

沿用现有两个方法，只**扩展返回字段**，保证 Web / iOS / 旧包不回归：

```ts
// 现有两个适配器统一形状，connect.ts 严格对齐
requestAuthorization({ read: string[] }) -> { completed: boolean; reason?: string }
fetchToday() -> { steps: number; activeKcal: number; status: string; message?: string }
// 新增可选字段（旧包不带 → 前端按 no_plugin 静默降级，见 types.ts 的兼容约定）
fetchToday() -> { ...; availability?: 'available' | 'unavailable' | 'update_required' }
```

**7 态映射**（决定 UI 是显示数值还是引导，沿用 `healthStatusHint()`）：

| 原生情况 | status | 用户看到 |
|---|---|---|
| `SDK_UNAVAILABLE` | `unavailable` | 当前设备不支持健康数据同步，请手动记录运动 |
| `SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED` | `unavailable` | 同上 + 引导升级 Health Connect |
| `getGrantedPermissions()` 缺读权限 | `denied` | 去系统设置 > 健康 > 数据访问权限勾选 |
| 聚合查询抛异常 | `error` | 稍后重试，步数保留上次结果 |
| 查得到但当天 0 | `empty` | 今天还没有数据 |
| 查得到且非 0 | `ok` | 正常显示 |
| 插件未注入 / 旧包 | `no_plugin` | 静默降级 |

## 4. 原生实现步骤（Kotlin，逐条对应官方 API）

1. **可用性探测**：`HealthConnectClient.getSdkStatus(context, "com.google.android.apps.healthdata")`。
   三态分别处理；`SDK_UNAVAILABLE` 必须**早退**，绝不降级成「0 步」（否则用户以为没运动）。
2. **取客户端**：`HealthConnectClient.getOrCreate(context)`（仅 `SDK_AVAILABLE` 时）。
3. **权限声明**（`AndroidManifest.xml`）：只申**读**权限，D-Bee 不写回系统健康平台。
   `android.permission.health.READ_STEPS` / `READ_ACTIVE_CALORIES_BURNED` / `READ_DISTANCE`；
   不申 `WRITE_*`、不申 `READ_HEALTH_DATA_HISTORY`、不申 `READ_HEALTH_DATA_IN_BACKGROUND`。
   > 理由：只读当天 → 不受「首次授权前 30 天」历史限制；只在用户打开 App 时前台读 → 不需要后台权限。
   > 两项都是 Play 健康类应用审核与实际兼容性的高风险项，最小权限能省掉整轮审核。
   同时加 provider `<queries>` 可见性与 `ACTION_SHOW_PERMISSIONS_RATIONALE` 说明入口（官方要求）。
4. **授权**：`PermissionController.createRequestPermissionResultContract()` 发起；
   **每次读之前**都调 `getGrantedPermissions()` 复查（用户可随时在系统里撤销）。
5. **读数（关键）**：用 `aggregate()`，不用 `readRecords()`：
   ```
   healthConnectClient.aggregate(AggregateRequest(
     metrics = setOf(StepsRecord.COUNT_TOTAL,
                     ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL),
     timeRangeFilter = TimeRangeFilter.between(本地当天零点, now)
   ))
   ```
   - `aggregate()` 会按用户在 Health Connect 里设置的 Activity 应用优先级**自动去重**多 App 重复写入的步数，官方明确用它避免重复计数 → **F1**。
   - 🔴 **不要写死 `dataOriginFilter` 包名**：2026-06 起设备本地步数（`TYPE_STEP_COUNTER`）的 DataOrigin 归因从 `android` 包名改为 device-specific SPN，按包名过滤会静默漏掉步数。
   - 时间窗起点用设备本地时区的当天零点，不用 UTC，否则「今日步数」跨时区错位。
   - `activeKcal` 是否含 BMR 需真机与厂商 App 对照（与华为方案 §4.1 同款风险），未确认前保守不采信为「活动能量」。
6. **回传**：`steps` / `activeKcal` 取整非负，`status` 按 §3 映射；`message` 只带可展示错误摘要，**不写任何健康明细到日志**。
7. **Java ↔ Kotlin**：现有插件是 Java，HC client 是 Kotlin suspend API。建议新增 `.kt` Reader + 协程作用域，Java 插件用回调桥接；Gradle 加 Kotlin 插件。需 Android/Gradle 真机构建验证 —— 开发机是 Windows，不能凭本地绿判完成（铁律 #13）。

## 5. 门面分派与目录冲突（需拍板 D1）

Android 优先级：**HC 可用 → HC；否则 → 华为/小米厂商适配器；否则 → 引导**。
但上一轮刚拍板「连接按钮按机型过滤」（`healthCatalogKeyForVendor(vendorKey)`），HC 是**跨品牌统一层**，与「一行只匹配一个机型」的假设直接冲突：

| 方案 | 做法 | 代价 |
|---|---|---|
| **D1-A（推荐）** | 目录新增一行「系统健康（Health Connect）」，按运行时 HC 能力显示，可匹配所有安卓机型；品牌行保留为 SDK 补充 | `healthCatalogKeyForVendor()` 需支持「一行多机型」，护栏随之扩展 |
| D1-B | 不新增行，把 HC 挂到当前机型那一行（华为机上点「华为运动健康」实际走 HC） | 改动最小，但**名实不符**，与「零假功能」原则冲突 |

## 6. 里程碑与验收（细化 HC-0~HC-5）

| # | 任务 | 验收探针 |
|---|---|---|
| **HC-0** | 真机覆盖率矩阵：品牌 × Android 版本 × 厂商 App 版本 → `getSdkStatus` 结果、能否写入HC、重启是否掉线 | 用户本人真机；产出《可用性表》，**对外文案以此表为准** |
| **HC-1** | `connect.ts` 接口占位 + 护栏断言（零功能、不依赖资质） | 护栏先红后绿；`npm test` 28 文件全绿、两端 typecheck 0 |
| **HC-2** | Kotlin Reader + 权限 + 聚合读 + 7 态 + `profiles.health_vendor`（建议 0052） | 真机读数与厂商 App 对齐（小时级延迟允许）；产物字节探针 |
| **HC-3** | 双通道冲突处理：HC 与华为/小米 SDK 同时有数时，按「单一来源优先」而非相加 | 双源并存时 `effectiveBurnKcal` 不得虚高；`max()` / 50% 口径不变 |
| **HC-4** | 发布侧：Play Console Health apps declaration（每个读类型逐一说明用途）；国内应用市场健康数据合规评估 | 未声明时用户连接 HC 会看到系统错误弹窗，须在发版前完成 |
| **HC-5** | 对外话术合规复核 | 按 HC-0 表分机型表述，不宣称「全机型支持」；不碰 `legal.ts`「不构成医疗诊断」红线 |

每阶段一律：真机实测 + 红绿产物探针 + 四端护栏；新增/放宽护栏必须先红验证。

## 7. 红线

- 🔴 **不修改网关部署脚本 `deploy-gateway.sh`**（缺 `IDENT_PEPPER` 会重置 → 全站身份永久失效）；网关改动一律手术式脚本。
- 🔴 原生包禁用 `npm run build`（白屏）；`build:web` 会删 `dist/legal/`，native 与 web 共用 `dist/`，部署前必须重跑并比对入口 js 文件名。
- 🔴 健康数据属敏感个人信息：单独告知 + 单独同意 + 撤销即删，隐私政策 §五 待拍板；
  `legal.ts`「不构成医疗诊断」意味着心率/睡眠即使读到也**不得**做诊断色带、燃脂心率或疗效承诺。
- 🔴 覆盖率事实如实保留：国行华为运动健康、vivo 健康、欢太健康未集成 HC；小米 Mi Fitness 部分版本可手动开启但重启静默掉线。这是分期推进的工程约束，**不是降级理由**（用户 17:51 拍板 HC 是亮点），但**不得**用于对外宣称全支持。

---

# 第二部分 · 小程序关联微信运动

## 8. 平台事实（2026-11-15 现查）

| 项 | 事实 |
|---|---|
| 唯一官方读取出口 | `wx.getWeRunData()`（基础库 1.2.0+），需先 `wx.login()`；公众号 / H5 / 服务端**均无**「按 openid 查步数」接口 |
| 返回内容 | `encryptedData` + `iv`（AES-128-CBC / PKCS#7，`session_key` 解密）；`cloudID` 仅云开发返回 —— **项目是 selfhost，无云开发，必须走密文解密** |
| 明文结构 | `{ stepInfoList: [{ timestamp: 当天零点秒级时间戳, step }, ...], watermark: { appid, timestamp } }`，覆盖**过去 31 天** |
| 更新时机 | 官方文档原话：**步数在用户主动进入小程序时更新**。服务端不存在「定时拉取某人步数」；用户 3 天不打开，手里就是 3 天前的数据 |
| 触发方式 | 必须由用户点击等交互触发，不能在 `onLoad` 等生命周期自动调用（平台规范，违反会审核不通过）；需 `scope.werun` 授权 |
| 隐私前置 | 后台《用户隐私保护指引》声明「收集您的微信运动步数」并审核通过；`wx.getPrivacySetting` → `wx.requirePrivacyAuthorize`（基础库 2.32.3+）。**未声明时接口直接禁用**，开发者工具里就不通 |
| 类目纠偏 | 「体育-在线健身」类目限制的是**分享数据到微信运动（写入）**的接口权限；D-Bee 只做**读取**，不换类目。⚠️ 仍须 WX-0 在小程序后台实证确认 |

### 8.1 项目内现状（零实现，但底座齐全）

- `mini/src/lib/health/index.ts`：`connectHealth()` 恒 `no_plugin` +「微信运动接入正在准备中」；`syncFromHealth()` 恒 `{steps:0, activeKcal:0, status:'no_plugin'}`。
- `HEALTH_APP_CATALOG.weapp` = `planned`「小程序 · 规划中」。
- `tools/four-end-consistency.test.ts:906` 护栏**钉死**了 `no_plugin` 与那句文案 → 真接入时必须**先改护栏 + 红验证**，否则测试会挡住实现。
- ✅ **已有底座（F2）**：`server/lib/auth.mjs exchangeWechatCode()` 已实现 appid 白名单 + `jscode2session` + 畸形 openid 拦截；`server/lib/wechatSession.mjs` 已实现 `save/loadSessionKey`（AES-256-GCM、appid 绑定、72h TTL）；`WECHAT_MINI_SECRETS` 已配置多小程序凭据；`mini/src/lib/xpay.ts:195-200` 已有「`publicConfig.endpoint` + `wx.request` + `Bearer ${token}`」调自建网关端点的**现成范式**。

## 9. 推荐架构：新增一个网关端点，不落库

```
[用户点「同步步数」按钮]  ← 必须主动触发
  ├ wx.getPrivacySetting → wx.requirePrivacyAuthorize（未同意时）
  ├ wx.getSetting / wx.authorize(scope.werun)（拒绝 → wx.openSetting 引导）
  ├ wx.login() → code                 ← 与密文同批次
  └ wx.getWeRunData() → encryptedData + iv
            ▼ POST /.cloud/auth/v1/werun/sync { code, appid, encryptedData, iv } + Bearer
[网关 server/lib/werun.mjs]
  ├ 校验 Bearer → ownerId
  ├ exchangeWechatCode(code, appid) → 本次 session_key（内存瞬时，不落库）
  ├ AES-128-CBC 解密 → 校验 watermark.appid === 配置 appid
  └ 从 stepInfoList 取「北京时间当天零点」那条 step
            ▼ 仅返回 { steps, activeKcal: 0, status, syncedAt }
[mini/src/lib/health/index.ts syncFromHealth()] → 现有 Dashboard 计算零改动
```

**端点契约与安全红线**

| 项 | 规定 |
|---|---|
| 鉴权 | 必须 Bearer（用户态）；`checkAccessKey` 的公开键校验不足以保护步数 |
| 归属绑定 | `code2Session` 返回的 openid 必须与 Bearer token 的 `owner_id`（`wx:<openid>`）一致，否则 403 —— 防止 A 用户借用 B 的会话解出 B 的步数 |
| 输入 | **只接受 `{ code, appid, encryptedData, iv }`**；🔴 **绝不接受客户端传的 `steps` 数值**（否则步数可伪造，直接影响 `netKcal` 与「可吃回」额度） |
| session_key | 只在内存瞬时用于解密；**不下发前端、不进日志、本端点不落库**。`wechatSession.mjs` 三条红线原样保留 |
| 完整性 | 解密后校验 `watermark.appid`；`iv` 长度 / 填充 / 时间戳异常一律 `error`，不猜值 |
| 输出最小化 | 只返回**当天步数**，31 天明细不落库、不回传、不上传；`activeKcal` 恒 0 |
| 失败映射 | `40029/40163`（code 失效）→ 前端重新 `wx.login` 重试一次；授权拒绝 → `denied`；解密失败 → `error`；无当天样本 → `empty` |

**为什么不复用 `loadSessionKey()`（备选方案 B，已否决）**：
① 该函数 TTL 72h，用户 3 天不登录即判失效；② 用户重新登录会换发 `session_key`，而 `encryptedData` 必须用**同批次** session_key 才能解开，旧密文会静默解不开；③ `wx.getWeRunData` 官方要求先 `wx.login()`。
方案 A 每次拿新 code 即时换取，天然同批次、绕开 TTL，且 session_key 完全不落库，比 B 更安全。**代价**：每次主动同步多一次 `jscode2session` 外呼 —— 但该调用本来就在 `loginWechat` 里做了限流与白名单，复用同一套即可。

## 10. 前端改造与「必须主动触发」的冲突解法

**冲突**：`Dashboard.tsx:143-162` 与 `mini/src/pages/index/index.tsx:122-134` 会在登录后**自动**并按 `HEALTH_SYNC_INTERVAL_MS = 60_000` **定时**调用 `syncFromHealth()`；但微信运动禁止生命周期自动调用 `getWeRunData`。

**解法（推荐，不改四端门面形状）**：

| 场景 | `syncFromHealth()` 小程序端行为 |
|---|---|
| 用户**主动点击**「连接微信运动 / 同步步数」 | 走完整链路（隐私 → 授权 → login → getWeRunData → 端点解密），成功后把 `{steps, syncedAt}` 写入本地 storage |
| 登录后自动 / 60s 定时 / `onShow` | **只读本地缓存**并返回缓存值，`status: 'ok'` 或 `empty`；**绝不触发** `wx.getWeRunData` |
| 缓存过期 / 无缓存 | `status: 'empty'`，UI 提示「点一下同步微信运动」，不弹系统授权框 |

- UI 明示「数据更新于 HH:mm（微信运动在您打开小程序时更新）」，**不宣称实时**。
- `activeKcal = 0`：微信运动只有步数，现有 `estimateActivityKcal(steps, 体重, 身高)` 步幅法自动兜底，`max(手动, 活动) × 0.5` 口径零改动 → **无需引入新数据口径**。
- 文案措辞改动必须**四端同源**：主端 `src/lib/health/index.ts` 的 `wechat-miniprogram` 分支与 mini 门面逐字对齐，护栏同步。

## 11. 连接态串台（必须先解）

`profiles.health_connected` 是**单布尔、跨端共享**（0022）。用户在 iPhone App 连了 Apple 健康 → 小程序里 `isHealthConnected()` 也返回 true → 会误判「微信运动已连接」并触发同步，属**假绿**。

建议与 HC-2 合并引入 `profiles.health_vendor text`（新迁移，暂编号 0052），取值
`apple | health_connect | huawei | xiaomi | werun | null`；
`isHealthConnected(expectedVendor?)` 按当前端期望的来源判定；`health_connected` 保留兼容旧包。
这条对两条链路都是前置条件，**待拍板 D3**。

## 12. 里程碑与验收

| # | 任务 | 验收 |
|---|---|---|
| **WX-0** | 小程序后台实证：隐私指引勾选「微信运动步数」并提交审核通过；确认读取方向无需换类目；`app.json` 隐私配置 | 开发者工具里 `wx.getWeRunData` 能返回密文（不通过则接口直接禁用）—— **硬前置，需用户本人后台操作** |
| **WX-1** | 网关 `werun.mjs` 端点 + 自测（mock `jscode2session` + 构造 AES 密文） | 归属不符 403、watermark 不符拒绝、日志不含 session_key、响应不含 31 天明细；沿用 `tools/wechat-login-selftest.mjs` 的 mock 范式 |
| **WX-2** | 小程序 `werun.ts`（复用 xpay 的 gateway request 范式，建议抽 `mini/src/lib/gateway.ts` 共用）+ 隐私/授权链路 | 拒绝授权 → `denied` + `wx.openSetting`；code 失效自动重试一次 |
| **WX-3** | 门面 `syncFromHealth()` 缓存优先改造 + 目录 `weapp: planned → available` + 护栏红验证 | 护栏先红后绿；自动轮询**零** `getWeRunData` 调用（产物探针）；真机步数与微信运动榜单对齐 |
| **WX-4** | `health_vendor` 迁移 + 跨端连接态复核 | iPhone App 连 Apple 健康后，小程序不显示「微信运动已连接」 |
| **WX-5** | 隐私政策 §五 补「微信运动步数」单独告知 + 撤销即删；发版留证 | 法务三页版本号同步；不构成医疗诊断红线不破 |

## 13. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 隐私指引未通过 / 未声明 | 接口直接禁用，全线不可用 | WX-0 硬前置，先做后台再写代码 |
| 用户不打开小程序 | 步数是上次进入时的快照 | UI 标 `syncedAt`，不宣称实时；不做服务端定时拉取（平台不支持） |
| session_key 换发 / TTL | 密文静默解不开 | 每次新 code 同批次换（§9 方案 A） |
| 直接接受客户端 steps | 伪造步数 → 净摄入与可吃回额度被篡改 | 端点只返回服务端解密值，输入不含 steps |
| 四端文案/状态分叉 | 某端显示「已连接」另一端显示「准备中」 | shared 目录单一真源 + 护栏红验证 |
| `cloudID` 误用 | 项目无云开发，拿不到开放数据 | 明确走 `encryptedData` 解密 |

---

## 14. 共通约束

- 两条链路**共用**：`HealthSyncData` 7 态、门面 `healthStatusHint()`、`max()` / 50% 计算口径、`@dbee/shared` 常量、四端护栏、`health_vendor` 字段、隐私政策 §五。
- 均按铁律 #13：**本地绿 ≠ 线上绿**，必须有真机 / 生产侧实证；护栏新增或放宽必须先红验证。
- 均不改任何生产库、网关部署脚本、法务文案（本轮零代码）；mini 端真机生效仍需用户本人上传体验版。

## 15. 待拍板（D1 / D3 / D4 于 11-15 18:23 已拍板）

**18:23 用户拍板（后续开工据此，不再重复请示）：**

| # | 结论 | 落地含义 |
|---|---|---|
| **D1** | **D1-A**：目录单独新增「系统健康（Health Connect）」行 | `HEALTH_APP_CATALOG` 增至 7 行；`healthCatalogKeyForVendor()` 放宽为「一行可匹配多机型」，护栏同步扩展并先红验证 |
| **D3** | **合并一次迁移（0052）** | `profiles.health_vendor text` 与 HC-2 / WX-4 一起做，`health_connected` 保留兼容旧包 |
| **D4** | **先开工 HC；微信后台由用户本人办理** | HC 线不依赖任何审批，立即启动；WX-1 起等 WX-0 隐私指引审核通过后再动代码 |

D2（真机覆盖率需用户本人设备）、D5 / D6 / D7 维持原建议，暂不执行。

原建议表（存档）：

| # | 决策 | 建议 |
|---|---|---|
| **D1** | 目录是否新增「系统健康（Health Connect）」行（D1-A）还是挂到机型行（D1-B） | **D1-A**，名实相符；代价是扩展 `healthCatalogKeyForVendor()` |
| **D2** | HC-0 真机覆盖率矩阵由谁提供设备 | 需用户本人真机，本会话无法代跑 |
| **D3** | `profiles.health_vendor`（0052）是否与 HC-2 / WX-4 合并上线 | **合并**，两条链路共用一次迁移，避免两次改连接态 |
| **D4** | WX-0 隐私指引由谁在小程序后台提交 | 需用户本人；这是其余 WX 阶段的前置 |
| **D5** | HC-1 / WX-1 零功能接口占位是否现在合入 | 建议**先 HC-1**（不依赖资质），WX-1 等 WX-0 后台通过后再动 |
| **D6** | 是否做「写入微信运动 / 分享数据到微信运动」 | **不做**：需「体育-在线健身」类目 + 后台接口权限，超出产品边界 |
| **D7** | 微信运动 `weapp` 目录状态何时从 `planned` 改 `available` | WX-3 真机验收**之后**，不提前（零假功能） |

---

## 16. WX-0 后台操作手册（用户本人执行，11-15 现查官方口径）

> 微信规则：**仅在《用户隐私保护指引》中声明过的信息类型，才能调用对应接口；未声明则接口直接禁用**。
> `wx.getWeRunData` 对应「微信运动步数」。这条是硬前置，代码侧无法绕过，也无法自动勾选。

### 16.1 操作路径

1. 管理员登录 `https://mp.weixin.qq.com/`（需小程序管理员微信扫码）。
2. 左下角「账号设置」／侧栏「设置」→ **基本设置** → 找到 **服务内容声明** → **用户隐私保护指引** → 点「去完善 / 更新」。
3. 在「1. 开发者处理的信息」里点 **增加信息类型**，勾选 **「微信运动步数」**（系统也会按代码扫描结果自动列出隐私项，手动补勾即可）。
4. 用途填**专用且与实际功能一致**的一句话，建议：
   > 用于读取你当天的微信运动步数，在「今日目标」中展示步数并估算活动消耗，辅助饮食与运动记录。
   🔴 不要写「排行榜 / 用户互动 / 运动成就」——项目没有这些功能，用途不实是审核被拒的高频原因；也不要顺手勾选未使用的类型（位置、通讯录等），多勾属超范围收集。
5. 检查其余必填项（联系方式、存储期限、第三方 SDK 信息）与现有声明保持一致，**不要改动已生效的「照片 / 摄像头」两项**（拍照识别在用）。
6. 点 **预览后提交协议** → 等审核。**1–3 个工作日，通常当天，不支持加急。**

### 16.2 🔴 生效条件（本项目最可能踩的坑）

后台「设置」页更新的是**现网版本**的指引。若小程序**尚无正式发布的现网版本**（只有体验版），即使这里审核通过也**不会生效**，隐私授权功能仍不可用。

- 正确做法：走 **版本管理 → 提交代码审核**，在提审信息页**底部**补充／确认《用户隐私保护指引》，随版本一起审核通过并**发布上线**后才生效。
- 项目 `mini/src/lib/privacy.ts` 文件尾清单第 3 点已记同一条：「后台设置管开发环境，提审页设置管线上环境，两处不一致仍会 errno 112」。
- 两处声明必须一致；只改一处仍会报 `api scope is not declared in the privacy agreement`（errno 112）。

### 16.3 代码侧配套（我方后续做，用户无需操作）

- 复用现成的 `mini/src/lib/privacy.ts` → `ensurePrivacyAuthorized()`，不重写授权弹窗。
- 链路顺序：用户**主动点击**「同步微信运动」→ 隐私授权 → `scope.werun` → `wx.login()` → `wx.getWeRunData()` → 网关 `werun/sync` 端点。
- 🔴 禁止在 `onLoad` / 60s 轮询里自动调 `getWeRunData`（平台要求用户主动触发、且微信运动只在用户进入小程序时更新）；mini 门面改缓存优先。
- 待纠偏的旧注释（WX-1 一并改）：`mini/src/lib/health/index.ts:12` 与 `mini/src/lib/privacy.ts:153` 写「需『运动健康』类目资质」——**读取方向**的硬前置是隐私指引声明 + 用户授权，类目限制针对**写入／分享到微信运动**（D6 已决定不做）。

### 16.4 验收判据（WX-0 通过才算数）

- 真机（不是开发者工具）触发一次同步，能拿到 `encryptedData` + `iv`，且**不报** errno 112 / `api scope is not declared`。
- 首次触发时正常弹出隐私授权框；用户点「不同意」仅停用该功能，不影响其余页面。
- 审核通过后开发者工具**重新编译**再验（旧进程不会自动刷新声明状态）。

### 16.5 关于「微信昵称、头像」这项：当前**不要勾**（11-15 代码核查）

全仓库核查结论：小程序**没有**调用 `wx.getUserProfile` / `chooseAvatar`，也**没有** `avatarUrl` 字段。

- 登录只走 `wx.login()` → code → `openid`（`mini/src/lib/auth.ts:67-108`）；法务文案 `mini/src/content/legal.ts:223` 也只声明「登录凭证 code 与 openid」，未提昵称头像。
- 「我的」页昵称是**用户自己手填**的 `profiles.nickname`（`profile.tsx` 输入框 + `NICKNAME_RULE` 1–20 字）；头像位是**昵称首字的文字占位**（`:550`），不是微信头像。
- 榜单刻意脱敏，后端不返回头像 / 完整昵称（`db/migrations/0028-leaderboard.sql:13`）。
- 项目 `mini/src/lib/privacy.ts` 文件尾清单也只列了「照片 / 摄像头」两项需声明。

→ 后台若自动列出「微信昵称、头像」，**不要勾选**：勾了等于声明收集并未实际收集的信息，属超范围声明，是审核被拒的高频原因（官方《合规开发指引》：仅处理实现功能所必要的信息；不使用某接口建议删除相关代码再提交）。
→ 若将来真的接入微信头像昵称，届时再勾并填「用于在『我的』页展示你的微信头像与昵称，便于识别本人账号」，且**必须配套真实接口**，不能只写用途。
→ 用户手填的昵称属「非接口形式收集」，如需在指引中体现，应走对应的自定义信息类型描述，**不能**借「微信昵称、头像」这一项。

### 16.6 用途文案（可直接复制，务必与实际功能一致）

下表按微信后台「为了【此句】，开发者将在获取你的明示同意后，收集你的…」的**填空句式**书写；若该栏是自由文本框，句首自行加「用于」即可。

| 信息类型 | 用途（填进表单括号里的一句） |
|---|---|
| 微信运动步数 | 在「今日目标」中展示你当天的步数并估算活动消耗，辅助饮食与运动记录 |
| 选择的照片或视频信息 | 拍摄或选择餐食照片，由 AI 识别食物并估算营养 |
| 访问你的摄像头 | 拍摄餐食照片，由 AI 识别食物并估算营养 |
| 微信昵称、头像 | **当前不勾**（见 16.5）。若将来真接入：在「我的」页展示你的微信头像与昵称，便于识别本人账号 |

🔴 微信表单填空有前后固定句式（「为了【…】，开发者将在获取你的明示同意后，收集你的…」），填进去要**语句通顺**；官方点名的高频被拒写法：① 描述宽泛如「获取你的权限」「实现用户登录」；② 所有信息类型都填同一句；③ 写了产品根本没有的功能（如排行榜、运动成就、用户互动）；④ 勾了未使用的类型。
