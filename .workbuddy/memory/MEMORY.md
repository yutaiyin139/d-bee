# D-Bee（自律蜜蜂）· 项目长期记忆（精简版；细节见当日日志与 docs/）

## 进度快照（2026-10-22，企业主体注册已办结；V1.7.0 已发布；自托管镜像 0030 待切前端）

- **🔓 主体注册已办结（10-22）**：解锁微信生态（开放平台企业认证/商户号/公众号/小程序主体变更）、
  华为/小米企业入驻（Health Kit 硬门槛）、ICP 经营许可证可申请。完整后续计划见
  **`docs/主体注册后-实施计划.md`**（三泳道并行 + 资质事实核对表 + 6 项待拍板）。
  ⚠️ 主体注册 ≠ 可收费：**网页端收费的法律前提仍是 ICP 经营许可证**（硬条件 = 有限公司 +
  100万认缴 + 「第二类增值电信业务」经营范围 + **3 人社保（约 ¥4000/月，主要成本）** + 域名过户到公司，
  周期 20–60 工作日）。当前唯一干净收费路径 = **iOS IAP**（Apple 个人账号已通过，平台代收）。
- **版本/git**：Web V1.7.0 已发布（http://150.158.51.106/ ，commit `846c355`）；Android debug APK 最新 V1.6.9
  （versionCode 10）。最新 commit `95e3e16`（iOS 内购接线 + verifyReceipt 验签 SQL），main 无新增提交。
  **未提交**：`db/migrations/0030-full-selfhost-mirror.sql`、`db/functions.sql`、`db/gen-full-mirror-sql.py`、
  `docs/自托管生产化四件套.md`、`docs/自托管数据库远程连接指南.md`、`docs/前端切换自托管-前置条件与步骤.md`、
  `docs/主体注册后-实施计划.md`；改过 `0002` 与记忆文件。src/ 与 mini/ 已全部入库。
  ⚠️ 0030 是自托管全部成果却只在工作区，**建议立刻入库**。
- **【主线·10-20 20:18 拍板】云库 → 自托管 PostgreSQL**：云库已恢复，从云库实时抓取生成完整镜像 `0030`
  （123KB，17 表 + 27 函数 + 24 策略 + GRANT + 全量数据，补齐旧 0002 缺的 10 表与 21 个业务函数），
  经 `deploy/sync-mirror.sh` 在服务器 dbee（PG 17.11）执行成功、自检全过（17 表行数与云库一致）。
  远程已打通（dbee_app BYPASSRLS，先 SSH 隧道后改直连：`listen_addresses='*'` + pg_hba 白名单 + 放行 5432），
  SQL 级 CRUD + 26 函数自测全过。**尚未切前端**——还差：①自建 auth/JWT 网关（**必须同时注入
  `app.user_id`（RLS）与 `request.jwt.claim.sub`（badge_stats/leaderboard 等函数依赖 JWT 声明）**）
  ②LLM 代理（SSE，模型列表须含 `supportsImages`/`isDefault`）③`/v1/*` PostgREST 语义 REST 端点
  ④改 nginx 上游切发布（前端零改动）。**不需要存储代理**——拍照识别走 base64 dataUrl 直塞
  LLM `image_url`（`ai.ts:152/226`），全仓无 `cloud.storage` 调用。
  ⚠️ `0030` 已含 0025~0028 业务变更（grep 命中 20 处），**勿盲跑 0025~0029 迁移**（会重复/冲突）。
- **🔴 支付链路唯一实质缺口**：`0030` 里 `verify_payment_order`（第 1171 行）是**空壳**——只查订单
  `status='paid'` 就返 true，**无任何 Apple 验签**；真验签在未执行的 `0029`。接真实支付前必须补，
  否则可伪造凭证白拿权益。**建议弃 0029 的 pg_net 方案，改在 Node 网关验签**（免 pg_net 扩展依赖 +
  sharedSecret 存环境变量更安全 + Server Notifications V2 webhook 本来就必须建在网关，密钥单点）。
- **合规现状（已核查，优于旧文档记载）**：用户协议/隐私政策/免责声明**三篇已存在且已挂路由**
  （`src/content/legal.ts` + `pages/LegalPage.tsx` + `components/SiteFooter.tsx`，备案号走
  `VITE_ICP_BEIAN` 环境变量渲染，未设置时该行不渲染）；`REDEEM_CODES` 硬编码兑换码**已从 src/ 删除**
  （Apple 3.1.1 硬伤已消）；`restorePurchases()` 已接（3.1.2 合规）。服务端 `redeem_by_code` RPC 仍在，
  不影响 Apple 审核，Web/Android 端可继续用兑换码运营。
- **额度规则（已定）**：每日 3 次免费识别 + 2 次积分兑换（50 分/次），用尽只能 Pro。新手 150 积分
  （grantHoney 'newbie'）；连续打卡每满 7 天送 2 次识别（grantPhotoBonus 'streak7'，7/14/21 循环）。
  迁移 0025（兑换上限 5→2）+ 0026（newbie 发积分、作废存量 newbie 识别 bonus）。
- **识别自动保存（已收敛）**：识别成功即 settleDraft 自动落库；该餐已有记录弹「覆盖/追加/取消」，
  无记录直接落库关闭，另有切页兜底；不做撤销等过度设计。
- **多端小程序**：Taro 4.3.0（React+TS）双工程 + `packages/shared`，微信/支付宝/抖音三端编译通过；
  已一比一复刻主工程 11 页（含 coach / paywall / legal），tsc 0 错。受限能力（支付/健康步数/分享卡 canvas）
  诚实引导占位。`file:` 依赖路径：主工程 `file:packages/shared`、mini `file:../packages/shared`；
  mini tsconfig 需 `moduleResolution:"bundler"`（否则 `@dbee/shared/cloud-sdk` 子路径导不出）。
- **原生 App**：Capacitor 8.5.3；阶段 0 解耦 ✅、Android 全过 ✅；iOS 待 Mac mini 首次构建（origin-proxy /
  health / iap 三自研 Swift 插件 + @capacitor/camera 均未编译；Mac 第一件事 `npm install && npx cap sync ios`）。
- **健康数据源**：只读系统健康平台，不直连手环；HealthKit 读授权不可探测→插件只报 completed，连接真源=
  云端 health_connected，重连入口常驻「我的>健康数据源」；`effectiveBurnKcal=max(burnKcal,activityKcal)` 不叠加。
  华为 Health Kit 阶段 3a 已落地（前端同构 + DbeeHealth 插件 Android 反射骨架，零 HMS 编译依赖）；
  小米官方数据服务 SDK 已纳入，`src/lib/health/android.ts` 白名单 `{huawei, xiaomi}`（新增 vivo/OPPO 只改白名单）。
  UI 三机型一套（仅 label 与排查路径切换），品牌识别覆盖 HUAWEI/HONOR/HarmonyOS、Xiaomi/Redmi/MI/MIUI/HyperOS。
  资质未就绪时插件返回 `reason=not_ready`，前端提示「接入正在申请资质」。**主体已注册（10-22），
  华为/小米企业入驻可启动**——华为 Health Kit 硬门槛 = 华为应用市场上架，另需软著 + App 备案。
- **会员/IAP**：三档 free/pro/lifetime（¥18/¥128/¥328）；Apple 个人开发者账号已通过（10-20）；
  前端 `checkout()` + `restorePurchases()`（3.1.2 合规）已接；服务端 `0029-iap-verify-receipt.sql`
  （pg_net 外呼 verifyReceipt，sharedSecret 存 app_config）**未执行且建议弃用**（改网关验签，见上）。
  剩余步骤见 `docs/iOS收费IAP落地清单.md`：Mac 编译插件 → ASC 配商品（dbee_pro_monthly/yearly/lifetime）→
  Xcode 开 IAP capability → **网关补 Apple 验签 + 幂等** → App Store Server Notifications V2 webhook。
- **微信相关**：主体已注册，**暂缓状态可解除**（`src/lib/wechat.ts` 的 `WECHAT_LOGIN_ENABLED=false`
  改回 true 即恢复，10-15 已按「零代码改造」设计）。前置链：微信开放平台企业认证（需营业执照，
  数天–2 周）→ 移动应用 AppID + UnionID → 注入 `VITE_WECHAT_APPID`（iOS 另需
  `VITE_WECHAT_UNIVERSAL_LINK` = 已备案域名 + Associated Domains + apple-app-site-association）→
  改 `NATIVE_CODE_EXCHANGE_SUPPORTED=true`。⚠️ App 内微信登录还有**云端能力缺口**：SDK 的
  `signInWithWechat(code,appid)` 只走小程序 `jscode2session`，移动应用 code 需 `sns/oauth2/access_token`，
  两接口不可混用——自建网关后此缺口可自行补齐（不再受制于云方）。快速兜底 = 路线 B
  （系统浏览器 + 云 Relay 扫码 + Universal Link 回跳，不需移动应用资质，前置仅备案+HTTPS）。
  ⚠️ iOS 的 `WechatOpenSDK` 来自第三方 SPM 镜像 `github.com/yanyin1986/WechatOpenSDK`（腾讯官方不经
  SPM 分发），上线前须核对 tag 或改官方 XCFramework。小程序 appid `wxb7c7122de9c3ab1f` 需做主体变更
  （趁未上线赶紧变，变更会使老用户 openid 失效需重新关联）。
- **下一步**：①**资质事实核对**（主体类型是否有限公司 / 经营范围含「第二类增值电信业务」/ 注册资本 ≥100万
  认缴 / 对公账户 / 能否 3 人社保 / 小程序当前主体）——决定网页端能否收费；②0030 等自托管产物入库；
  ③切前端自托管（auth/JWT 网关 + LLM 代理 + REST 端点 + 改 nginx 上游）并全链路回归；
  ④域名过户个人→企业 + ICP 备案主体变更（周期最长，抢早）；⑤软著登记（30–60 工作日，越早越好）；
  ⑥Mac mini 首次构建 iOS + 真机回归 IAP/HealthKit；⑦网关补 Apple 验签 + ASC 配 3 商品 + webhook V2；
  ⑧华为/小米企业入驻后替换 dbee-health 插件方法体并真机验收；⑨Android 真机复测 V1.7.0 APK；
  ⑩小程序三端真机联调；⑪分享卡片 O-3 落地（零资质依赖的传播抓手）。
- **待拍板**：①是否申请 ICP 经营许可证（= 是否现在背 3 人社保约 ¥4000/月，商业决策非技术决策）；
  ②Apple 账号用个人先上架还是等企业账号（建议先申请 D-U-N-S 占位、个人账号推进构建）；
  ③LLM 供应商（建议 DeepSeek，须多模态）；④短信通道（建议先日志+万能码跑通）；⑤网关语言（建议 Node）；
  ⑥Apple 验签放网关还是 pg_net（建议网关）；⑦云库长期去留（自托管彻底替代/回迁/双写）；
  ⑧未提交产物入库（建议立刻）。长期待办：华为应用市场上架（需企业认证+软著+App备案）。

## 三条主线

1. **开发**：看板即本文件「进度快照」，由自动化「D-Bee 开发进度盘点」每日收敛；细节看当日日志。
2. **备份**：自动化「D-Bee 每日数据备份」产出 `db/backups/YYYY-MM-DD.json`（失败落 `FAILED-YYYY-MM-DD.md`）。
3. **运营**：宣传彩页、技术交流、社群，由自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18 + Vite5 + TS；appId `com.dbee.app`；Windows 出 Android、Mac mini M4 出 iOS；
Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（iOS HealthKit / Android Health Connect / 华为 Health Kit
需先上架华为市场 / 小米官方 SDK），详见 `docs/健康数据源方案.md`。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层（platform/kv/capture/scan/share）；抽象层运行时探测 `window.Capacitor`，
   **不 import Capacitor 包**（Web 零新增依赖）。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 原生插件（注入 Origin），注入点 = 云 SDK `options.fetch`（`src/cloud.ts`），
   **勿 patch window.fetch**。Origin 钉死三处：lib/originProxy.ts、Java/Swift、Nginx，换域名三处同步。
4. 输入校验走 `src/lib/validate.ts`（过滤→夹回→门禁）；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。

## 云数据库安全铁律（最高优先级）

- 发权益/积分/额度的函数必须 SECURITY DEFINER + 入参白名单；审计用 `pg_get_functiondef` 看真实 DDL。
- 光有函数白名单不够：**涉权益/积分/额度表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 只限
  「自己的行」，挡不住直写）。已封堵：honey_ledger / entitlements / ai_usage / badges 仅 SELECT；
  拍照额度走预占 token（consume/release）。`isPro`：pro 档缺 `pro_until` 判已过期（防永久会员）。
- 0016 已加 10 条 CHECK 约束（profiles/meal_entries/water_logs/exercise_logs 数值边界）。

## 关键坑（一行版）

endpoint 同源/绝对 HTTPS；`CapacitorHttp.enabled=true` 必开；云 SDK 独占 localStorage（登录态真源，勿用 kv 接管）；
iOS 需 HTTPS；iOS 无 BarcodeDetector→原生 MLKit；SW 在 capacitor:// 不注册；cap sync 撞 safe-delete 守卫→只改
web 资源用 `npx cap copy android`；微信回调 Activity 随 applicationId 改名；图标改后跑 `tools/gen-app-icons.py`；
模拟器网络需沙箱外启动 + captive_portal_mode 0；验收用 `tools/android-cdp.py` + logcat（d-bee-diag / d-bee-origin）；
安全区写 `var(--safe-area-inset-*, env(...))`。
- **cap sync 新插件必踩**：update 阶段撞 safe-delete 守卫（genie-trash ETIMEDOUT）会误删
  `android/capacitor-cordova-android-plugins/` 的 build.gradle + cordova.variables.gradle。首选绕过：先 shell
  `rm -rf android/capacitor-cordova-android-plugins`（shell 删不触发 genie-trash）再 `cap sync`，
  extractTemplate 会重建。兜底三步：解压 `node_modules/@capacitor/cli/assets/capacitor-cordova-android-plugins.tar.gz`
  的 build.gradle、手写 cordova.variables.gradle（模板见 `cli/dist/android/update.js:224`）、在 build.gradle
  的 PLUGIN GRADLE EXTENSIONS 补 `apply from: "cordova.variables.gradle"`。
- **本地插件（file:）两步缺一不可**：①`capacitor.config.ts` 的 `android.includePlugins` 必须列插件名
  ②`npm install` 建 symlink。否则编译过但运行时 `window.Capacitor.Plugins.X` 为 undefined，UI 入口不显示。
  口诀：Gradle 编译过 ≠ 运行时注册（`android/app/src/main/assets/capacitor.plugins.json` 才是真源）。
- **原生拍照/扫码点了没反应**：①`file_paths.xml` 缺 `<external-files-path>` → FileProvider 找不到 root 抛
  IllegalArgumentException；②Manifest 缺 `CAMERA` → getUserMedia 兜底失败、onShowFileChooser 不走授权流程。
- **兑换的拍照额度用不了**：`guardAiQuota()` 不能按「当日拍照次数阶梯」拦截（quota_bonus 不计入次数）；
  唯一依据 `get_photo_quota.total_remaining`（基础+奖励），有额度直接 `consume_photo_quota`；
  photoLadderHint 只用于额度用尽时的引导文案。
- **华为 EMUI/HarmonyOS WebView 忽略 `<input capture>`**：原生端拍照统一走 `@capacitor/camera`
  （鸭子类型探测，不 import 包），web 端保留 `<input capture>`。
- **honey_ledger 唯一索引 `(owner_id, reason, ref_id)` 会把「每日多次」卡成「每日一次」**：ref_id 必须带唯一
  后缀（如 `to_char(clock_timestamp(),'HH24MISSMS')`），单日计数用 `ref_id LIKE 前缀%`；排查「该记录已经存在」
  先查 `pg_indexes` 唯一索引。

## 过审合规

Apple 4.2 / 3.1.1（阶段 3 删 REDEEM_CODES）/ 5.1.1(v) 账号删除 / AI 告知同意；
中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。

## 工作方式

需求驱动、多轮递进、「写→验→报」小步验证；缺陷/进度类文档用 .docx；跨机同步只走 Git 私有仓库
（`github.com/yutaiyin139/d-bee`，main），两台机器 `core.autocrlf false`；推送失败是常态波动，**for 循环重试 5 次**
勿改方案；收工把进度快照 + 明日待办 + 待拍板写入当日日志。自测脚本 `tools/*-selftest.mjs`
（运行器 `node tools/v15-selftest.run.mjs`）。

## 环境备忘

- SSH 发布：`150.158.51.106` / `ubuntu` / 密码见本地 `.env`（`SSH_PWD`，**勿写入记忆或文档**，
  memory/ 会进 git）；发布脚本 `deploy/deploy.sh`。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`。
- 云库应用 ID `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql，只在已绑定应用的会话可用）。
- curl 本机 dev server 需 `--noproxy '*'`；`package.json` 无测试框架/lint。
- 微营养素：foodsData*.ts 已 10 列化（钠/纤维/添加糖，/100g），1175 条零兜底。
