# 发版留证 · 健康管理方案四端同构 + Android V1.7.5 / vc23

> 执行时间：2026-11-14 13:00–13:40（GMT+8）
> 用户指令：「修改的满意，推广到其他 3 端；确保 UI 一致，推 git，发布 android，定义版本为 V1.7.5」
> 版本：**V1.7.5** / Android `versionCode 23` / iOS `MARKETING_VERSION 1.7.5`
> git：`6a0e936`（代码与版本，已 push origin/main）→ 本留证为补交

---

## 一、四端同构架构决策

主端 `src/` = **Web + iOS + Android 共用**（同一份 React 代码，Capacitor 打包）；
mini 是独立 Taro 工程。为从根上保证「UI 一致」，把方案页的**文案与展示层纯函数下沉为单一真源**：

| 层 | 文件 | 职责 |
|---|---|---|
| 单一真源 | `packages/shared/src/healthPlan.ts`（新增） | 全部可见文案常量、4 条透明化说明、`HealthPlanInput/View` 类型、`buildHealthPlanViewCore()` 纯函数、`isHealthPlanReadyCore()` |
| 导出面 | `packages/shared/src/index.ts` | `export * from './healthPlan'` |
| 主端适配 | `src/lib/healthPlan.ts`（重写） | 把 `Profile` 映射为 Input，注入 `GOAL_LABELS[goal]`；re-export 全部常量 |
| mini 适配 | `mini/src/lib/healthPlan.ts`（新增） | 同形状适配，注入 mini 的 `GOAL_LABELS`；另导出一次性引导旗标 key |
| 主端组件 | `src/components/HealthPlanSheet.tsx`（改） | Web/iOS/Android 共用；文案全部改走 shared 常量 |
| mini 组件 | `mini/src/components/HealthPlanSheet.tsx` + `.scss`（新增） | Taro 同构，独立 `hp-` 前缀样式 |

**UI 一致性实现口径**：颜色走 `mini/src/styles/tokens.scss`（与主端 `:root` 逐项同值）；
scss 内 px 按 `designWidth 750` 由 Taro 转 rpx，故尺寸取主端 **2 倍**（卡片圆角 20→40、
网格 gap 12→24、按钮高 50→100、Sheet 最大宽 480→960、关闭热区 44→88）；
组件行内样式保持**主端原值**（行内 px 不转换），两端真机视觉一致且可被护栏逐字断言。

**交互模型不变**：单态渲染（只读 `profile.goal`，其余目标态不进 DOM）、
首次登录只弹所选目标一态、改目标确认写库后自动切到新目标态；
方案页只读落库派生字段，零 `plan_summary`、零现场 `calcTarget()`。

## 二、mini 端接线

- `pages/profile/profile.tsx`：我的页新增「健康管理方案」入口（标签取 `profile?.goal`
  而非编辑草稿 `goal`，防「显示态 ≠ 生效态」）；确认层补「当前方案 / 会改变 / 不会改变」；
  `submitBody()` 保存成功后 `setPlanOpen(true)` + 「方案已更新为…」提示。
- `pages/onboarding/onboarding.tsx`：保存成功后写一次性旗标 `dbee_intro_plan`。
- `pages/index/index.tsx`：`useDidShow` 读旗标并**读后即清**，落地首页自动弹一次；
  老用户冷启动不写旗标，天然不弹。
- reLaunch 到 tabBar 页不能带 query，故用本地 Storage 而非 URL 参数。

## 三、质量门禁

| 项 | 结果 |
|---|---|
| `npm run typecheck`（主端） | 零错误 |
| mini `tsc --noEmit`（仅 `src/` 过滤） | 零错误（node_modules 内 Taro 既有噪声属基线） |
| `npm test` | **27 文件 / 1087 项全绿** |
| `tools/health-plan-consistency.test.ts` | **护栏 26 扩至 90 项全绿** |
| 护栏红验证 | 注入 3 处退化 → **5 条精准变红**，源码字节级恢复 |
| 行号快照红验证 | 还原旧值 → 1 条变红，恢复 |
| mini `build:weapp` | 编译成功（1.13m，69 文件 / 940,689 B） |
| mini 产物探针 | 19 项文案 + 6 项样式类全绿；零旧命名 / 零云库域名 |

护栏关键改进：初版「两端都包含 X」用字符串拼接，任一端退化会被另一端掩盖（假绿）；
已收紧为 `[SHEET(), MINI_SHEET()].every(...)`，红验证证明主端字号漂移能准确变红。

`four-end-consistency.test.ts` 行号快照同步：`mini/.../onboarding.tsx:88 → 89`
（新增 1 行 import，手写舍入内容未变）；主端 `174,175,538` 保持不变。

## 四、版本统一 V1.7.5

`package.json` / `package-lock.json`（2 处，已核对仅版本号两行变化）/
`android/app/build.gradle`（`versionCode 22→23`、`versionName 1.7.4→1.7.5`）/
`ios/App/App.xcodeproj/project.pbxproj`（2 处 `MARKETING_VERSION`）/
`mini/config/index.ts` 与护栏注释中的版本说明。
mini 版本由构建期读根 `package.json` 注入，无需硬编码。

## 五、Web 重发布（让线上与源码同步）

- 入口 **`index-B9kgEoIp.js`**（563,810 B，sha256 `01a1cb6853e3acc8…`）
  + `index-CX1CYz9K.css`（39,059 B，`5c28fab3705bfd7b…`）。
- `dbee-ssh.py putdir` 纯覆盖上传 19 文件 / 1911.2 KB，**零远端删除**；
  未跑 `deploy.sh` / `deploy-gateway.sh`，未动 nginx / 网关 / `LEGAL_UPDATED`。
- 生产侧实测 **9/9 端点线上与本地逐字节一致**（含法务三页）、
  **11/11 文案探针 PASS**（旧命名 0 命中、`v1.7.5` 1 命中）、
  `/.cloud/healthz → db.ok=true`、入口 js 线上/本地 sha256 一致。
- 法务三页相对上一版仅 `v1.7.4 → v1.7.5` 版本号变化，正文逐字未变（已归一化比对）。

## 六、Android 三步实证

归档：`release/D-Bee-1.7.5-vc23-dbee.cn-FORMAL-20261114.apk`
**8,254,931 B / sha256 `52b65c1a70890dd7c19783c9c63acca16c170743a8104e57156a91879fefc548`**

| # | 验证 | 结果 |
|---|---|---|
| ① | `aapt2 dump badging` | `name='cn.com.dbee.app' versionCode='23' versionName='1.7.5'`，minSdk 24 / targetSdk 36 ✅ |
| ② | `apksigner verify --print-certs` | Signer #1 MD5 **`0abe7fc5005987ed9b6eae9a45fb9dc9`**，与 App 备案一致 ✅ |
| ③ | APK 内资源探针 | 内嵌入口 `index-Bt33pCLp.js`（native 构建，非 Web 入口）；健康管理方案全套文案齐、`v1.7.5` 1 命中；零旧命名、零云库域名、零下单 CTA ✅ |

③ 补充说明：粗粒度「下单」3 命中均为支付 SDK 的「**预下单参数**」技术异常文案，
剔除后 CTA 计数为 0；「立即下单 / 去下单 / 下单购买 / 下单立减」全部 0 命中。

打包链路：`VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`
→ `npx cap sync android`（18 个 public 文件）→ `./gradlew assembleRelease --no-daemon`。
Gradle 输出里 `packageRelease UP-TO-DATE` 是 tail 截断误读，APK mtime 13:31:58、
体积与上一版 vc22 不同、内嵌入口为本次 native 产物，已实测确认为新包。

## 七、零删除与备份

全部产物目录**整体移到项目外** `C:/Users/yuty/WorkBuddy/2026-10-13-09-29-42/prebuild-20261114-1330/`：

- `shared-dist-prebuild`（旧 `packages/shared/dist`，重建前）
- `mini-dist-prebuild`（旧 `mini/dist`，重建前）
- `dist-web-prev`（Web 上一版入口 `index-CvLLl1Aj.js`）
- `dist-web-v175`（Web V1.7.5 快照）
- `android-public-prev`（旧 Android `assets/public`）
- `dist-native-v175`（native 产物快照）

打包后已 `npm run build` 恢复 Web `dist/`（含法务三页），
入口与线上 `index-B9kgEoIp.js` 逐字一致。全程无 `rm` / 无清空目录 / 无 `git clean`。

## 八、边界与未完成（不可声称已完成）

- 🔴 **iOS 壳未重打包**：源码层（主端组件 + `MARKETING_VERSION`）已覆盖，
  但 `ios/App/App/public` 需 Mac + Xcode≥26 执行 `cap sync ios`，本轮 Windows 未动。
- 🔴 **mini 体验版未上传**：代码与 `mini/dist` 产物已就绪，
  上传体验版 / 真机验收仍需用户本人在微信开发者工具完成。
- 🟠 **Android 公网分发待批准**（清单 A7），包已归档，未上传到任何渠道。
- 网关仍为旧 `llm.mjs`（服务端分功能门控未部署），本轮未碰、未跑 `deploy-gateway.sh`。
- `LEGAL_UPDATED` 未改，老用户不会重弹同意窗。

## 九、回滚

- Web：`prebuild-20261114-1330/dist-web-prev` 经 `putdir` 回传即可恢复上一版，不动数据库与网关。
- Android：不覆盖线上（本就未分发），如需旧包用 `release/D-Bee-1.7.4-vc22-…apk`。
- 代码：`git revert 6a0e936`（含 shared 真源与 mini 同构），或按文件单独回滚。
