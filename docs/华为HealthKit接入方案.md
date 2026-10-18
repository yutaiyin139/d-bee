# 华为 Health Kit 接入方案（与 Apple HealthKit 逻辑对齐）

> 2026-10-18 · 应「华为端接入华为运动健康，确保与苹果端实现逻辑一致」成文。
> 结论先行：**架构完全复用 Apple 端**——只读平台层、统一门面、云端连接态、
> 步数 + 活动能量两指标、UI 三态。华为端只是把「原生插件 + 前端适配器」从
> HealthKit 换成 Health Kit，业务层零改动。

---

## 1. 关键事实澄清（修正旧结论）

旧结论（`docs/健康数据源方案.md` §3.2）写「华为 Health Kit 需企业开发者资质」，
**不准确**。经核对华为官方《数据开放总览》与《应用开发者申请资质说明》：

| 项 | 事实 |
|---|---|
| 步数、热量、距离（日常活动数据） | 属于**「基础数据」开放等级，个人与企业开发者均可申请** |
| 个人开发者资质 | 应用需**上架华为应用市场** + 个人无信用不良记录 |
| 企业开发者资质 | 实缴注册资本 ≥50 万（基础数据）/ ≥500 万（高阶数据），主体成立 ≥1 年 |
| 数据及时性 | 日常活动（步数/热量）为**小时级**（非实时） |
| 高阶数据（心率/血氧/睡眠/血压等） | 暂不对个人开发者开放，需企业 + 500 万实缴 |

**对 D-Bee 的意义**：我们只需「步数 + 活动能量」两个基础指标，**个人开发者即可申请**，
前置条件只有一个硬门槛——**应用上架华为应用市场**（当前 D-Bee 尚未上架任何应用市场，
这是真正要补的一步，见 §5）。

---

## 2. 与 Apple 实现逻辑的一致性映射

Apple 端已定稿的逻辑，华为端逐条复用：

| 维度 | Apple（已实现） | 华为（本方案） | 是否一致 |
|---|---|---|---|
| 数据通道 | 只读系统健康平台 HealthKit | 只读华为 Health Kit（运动健康开放平台） | ✅ 同为平台层，不直连手环 |
| 统一门面 | `lib/health/index.ts` connect/disconnect/sync | 完全复用，不改签名 | ✅ 零改动 |
| 连接状态真源 | 云端 `profiles.health_connected` | 同一字段 | ✅ 零改动 |
| 数据模型 | `{ steps, activeKcal }` | 同结构 | ✅ 零改动 |
| 数据兜底 | 拿不到不影响手动运动；`effectiveBurnKcal = max(burnKcal, activityKcal)` | 同规则 | ✅ 零改动 |
| UI 三态 | 未连接 / 连接中 / 已连接 | 同三态 | ✅ 零改动 |
| 原生插件 | `dbee-health`（Swift，iOS） | `dbee-health` 加 Android 实现（Health Kit SDK） | 🔧 加实现 |
| 前端适配器 | `lib/health/healthkit.ts` | 新增 `lib/health/huawei.ts`（同接口） | 🔧 加适配器 |
| 品牌识别 | `brand.ts` huawei 已识别 | `canSync` 由 false 改 true（资质就绪后） | 🔧 改一行 |
| 授权语义 | 读授权不可探测 → 流程走完即视为连接 | 华为授权**明确可感知**（登录+Scope 授权，拒绝会返回错误） | ⚠️ 见 §4.3 |

**结论**：前端业务代码（Dashboard / 我的>健康数据源 / 计算逻辑）**一行不改**，
改动全部收敛在「插件 + 适配器 + brand 探测」三层，符合架构铁律
「平台差异只走 src/lib 抽象层」。

---

## 3. 技术实现路径

### 3.1 原生插件（`native-plugins/dbee-health` 加 Android 实现）

现有插件只有 iOS。新增 Android 实现，接口与 Swift 侧严格对齐：

```
插件 JS 桥（前端调用，接口不变）
  requestAuthorization({ read: ['stepCount', 'activeEnergyBurned'] }) → { completed }
  fetchToday() → { steps, activeKcal }
```

Android 侧实现要点：

1. **依赖**：`implementation 'com.huawei.hms:health:{version}'`（HMS Health Kit SDK），
   并在 `android/app/build.gradle` 配 HMS Maven 仓库 `https://developer.huawei.com/repo/`。
2. **签名与 AppId**：华为应用市场生成的 AppId 写入 `AndroidManifest.xml`；
   签名证书指纹（SHA256）在华为 AGC 后台配置，**与打包 keystore 绑定**——换签名则失效。
3. **读步数**：
   ```java
   DataController dc = HuaweiHiHealth.getDataController(context);
   Task<SamplingData> t = dc.readTodaySummation(DataType.DT_CONTINUOUS_STEPS_DELTA);
   // 解析出当日步数增量
   ```
4. **读活动能量**：热量类型（见 §4.1 语义对齐），`readTodaySummation` 读当日热量。
5. **授权**：华为账号登录 + Scope 授权
   ```java
   Scope sport = new Scope(HiHealthExtendScope.HEALTHKIT_EXTEND_SPORT_READ); // 含步数/距离/热量
   // 走 HuaweiId 授权页，成功拿 authCode，失败明确返回 errorCode
   ```
6. **运行时要求**：HMS Core APK ≥ 5.0.4.300、华为运动健康 App ≥ 11.0.0.512；
   接口调用需**应用在前台**且**手机亮屏**（华为硬约束，错误码
   `APPLICATION_NOT_FORGROUND` / `DISABLE_DATA_OPERATION`）。

### 3.2 前端适配器（`lib/health/huawei.ts`）

与 `healthkit.ts` 同接口，封装 `DbeeHealth` 插件（Android 侧同名注入，前端无感知）：

```ts
// 与 healthkit.ts 完全同构，只换实现来源
export async function requestHealthAuthorization(): Promise<boolean>  // → 调插件
export async function fetchTodayHealth(): Promise<{steps, activeKcal}> // → 调插件
export function isHealthKitAvailable(): boolean // isAndroid() && 插件可用 && 品牌=huawei
```

### 3.3 门面层（`lib/health/index.ts`）

只改 `connectHealth()` 的 `vendor === 'huawei'` 分支——从「引导提示」升级为「真同步」，
其余（isHealthConnected / syncFromHealth / disconnectHealth / estimateActivityKcal）
**零改动**。

### 3.4 brand 探测（`lib/health/brand.ts`）

华为 vendor 的 `canSync` 由 `false` 改 `true`（资质就绪后）。识别逻辑已就绪：
`UA` 含 `HUAWEI | HONOR` 即命中。

---

## 4. 数据语义对齐（唯一需要小心的地方）

### 4.1 活动能量（activeKcal）口径

- Apple `activeEnergyBurned` = **活动能量**（主动消耗，不含基础代谢 BMR）。
- 华为「热量」类型有多个口径，**实现时需先确认** `DT_CONTINUOUS_CALORIES_DELTA`
  （热量增量）返回的是「活动消耗」还是「总消耗（含 BMR）」：
  - 若为活动消耗 → 直接对齐 Apple，`activeKcal` 直接赋值；
  - 若含 BMR → 不能直接当 `activeKcal` 用（会虚高），需换算或改用华为的活动热量类型。

**决策（默认）**：优先找华为的活动热量类型对齐；拿不到活动口径时，华为端**只同步步数、
`activeKcal` 置 0**，活动消耗走前端 `estimateActivityKcal(步数)` 步幅法估算——这与
「拿不到数据就不影响」的兜底原则一致，且永不虚高。

### 4.2 步数

`DT_CONTINUOUS_STEPS_DELTA`（当日步数增量）语义与 HealthKit `stepCount` 一致，直接对齐。

### 4.3 授权语义差异（诚实标注）

- **Apple**：读授权不可探测，只能「流程走完即视为连接」。
- **华为**：授权结果明确可感知（拒绝会返回明确 errorCode）。

华为端可以做得更准：`requestAuthorization` 返回 `completed=false` 时，前端能如实提示
「未授权」。但因为我们要「逻辑一致」，连接状态仍以云端 `health_connected` 为真源，
数据以 `fetchToday` 为准——华为的明确失败只是让「连接中 → 已连接」的跳转更诚实，
不引入新的第四态（仍遵守 UI 三态原则）。

---

## 5. 前置条件与资质清单（真·阻塞项）

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 华为开发者账号（实名认证） | 待办 | 个人即可 |
| 2 | **应用上架华为应用市场** | **待办（硬门槛）** | 个人开发者未上架则华为不开放 Health Kit 数据 |
| 3 | 开通 Account Kit + Health Kit 服务 | 待办 | 华为 AGC 后台申请 |
| 4 | 申请「日常活动数据」读权限（基础等级） | 待办 | 步数/热量，个人可申请 |
| 5 | 隐私合规材料 + 业务合理性说明 | 待办 | 审核约 15 个工作日 |
| 6 | AppId + 签名证书指纹配置 | 待办 | 与 keystore 绑定 |

> 提示：D-Bee 现有 IAP 也在等 Apple 开发者账号、微信在等营业执照——华为这条线
> 的「上架华为应用市场」可与「App 备案/软著」合并推进（上架应用市场本身也要软著）。
> 见 `docs/备案材料清单.md`。

---

## 6. 分阶段落地

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 阶段 3a（本方案，纯代码） | 插件 Android 实现 + huawei.ts 适配器 + brand 开启 | 无（可先写，未上架时授权会失败，走兜底） |
| 阶段 3b（资质） | 上架华为应用市场 + 申请 Health Kit 权限 | 上架流程 + 审核 |
| 阶段 3c（联调） | 华为真机授权 → 读步数/热量 → 与手动运动 max 计算 | 3b 完成 |

---

## 7. 验收清单（华为真机，阶段 3c 执行）

- [ ] 华为手机上首次点「连接华为运动健康」→ 华为账号登录 + 授权页 → 同意 → 已连接 + 步数出现
- [ ] 拒绝授权 → 明确提示（华为可感知，与 Apple 不同）→ 到「我的>健康数据源」重连
- [ ] 已连接后杀 App 重开 → 自动同步，无需再授权
- [ ] 「解除连接」→ 云端 health_connected=false → 恢复连接按钮
- [ ] 步数/活动能量与华为运动健康 App 数值一致（小时级延迟允许）
- [ ] 手动运动 + 健康数据并存时，`effectiveBurnKcal = max(burnKcal, activityKcal)` 正确
- [ ] 手机锁屏/后台时接口报错不影响 UI（静默兜底）
