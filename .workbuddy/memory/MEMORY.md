# D-Bee（自律蜜蜂）· 项目长期记忆（精简版，细节看当日日志与 docs/）

## 进度快照（2026-10-18）

- **Web V1.6.2 已发布**（http://150.158.51.106/ ，主包 `index-BMiTa5Bb.js`，commit `d96d9d4`）。
- **主线：PWA → 原生 App**（Capacitor 8.5.3）。阶段 0 解耦 ✅；Android 全过 ✅；
  iOS 待 Mac mini 首次构建（origin-proxy/health/iap 三个 Swift 插件从未编译，Mac 侧第一件事）。
- **健康数据源**：只读系统健康平台（iOS HealthKit / Android 阶段2 Health Connect），不直连手环；
  HealthKit 读授权不可探测→插件只报 completed，连接真源=云端 health_connected；
  运动消耗 `effectiveBurnKcal=max(burnKcal,activityKcal)` 不叠加（防重复计）。
- **会员三档** free/pro/lifetime（¥18/¥128/¥328）；IAP 骨架就绪但真实支付未启用
  （verifyReceipt 未接，等 Apple 开发者账号），当前仅兑换码解锁。
- 微信相关整体暂缓（营业执照办理中）。
- **下一步**：Mac mini 首次构建 iOS（编译 origin-proxy/health/iap 三 Swift 插件）+
  真机回归「IAP 拉商品→购买→核销」与「HealthKit 授权→读步数→计活动消耗」两链路。
- **待拍板决策**：无新阻塞项；长期待办 = Apple 开发者账号（启用真实 IAP）、营业执照（重启微信）。

## 三条主线（开发 / 备份 / 运营）

1. **开发**：进度看板在本文件「进度快照」，由自动化「D-Bee 开发进度盘点」每日收敛；
   细节看当日日志 `.workbuddy/memory/YYYY-MM-DD.md`。
2. **备份**：自动化「D-Bee 每日数据备份」每日产出 `db/backups/YYYY-MM-DD.json`。
3. **运营**：宣传彩页、技术交流、社群运营等，由自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；appId `com.dbee.app`；
Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。
健康数据源：**只读系统健康平台，不直连手环**（iOS HealthKit / Android 阶段2 Health
Connect / 华为阶段3 需企业资质）；HealthKit 读授权不可探测——Swift 插件只报
`completed`（流程走完），连接真源=云端 health_connected，重连入口在「我的>健康
数据源」常驻；详见 docs/健康数据源方案.md。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层（platform/kv/capture/scan/share），
   抽象层运行时探测 `window.Capacitor`，**不 import Capacitor 包**（Web 零新增依赖）。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走自建 `OriginProxy` 原生插件转发（注入 Origin），注入点用
   云 SDK `options.fetch`（`src/cloud.ts`），**勿 patch window.fetch**。
   Origin 钉死三处：lib/originProxy.ts、Java/Swift 侧、Nginx，换域名三处同步。
4. 前端输入校验走 `src/lib/validate.ts`（三层：过滤→夹回→门禁）；
   错误文案统一走 `src/lib/errmsg.ts`（`zh()`/`errText()`），勿再裸透传英文报错。

## 云数据库安全铁律（最高优先级）

- 发权益/积分/额度的函数必须 SECURITY DEFINER + 入参白名单；审计要用
  `pg_get_functiondef` 看真实 DDL，勿信 schema.sql 注释。
- 光有函数白名单不够：**涉权益/积分/额度的表必须 REVOKE authenticated 的
  INSERT/UPDATE/DELETE，只经函数写**（默认 RLS 只能限"自己的行"，挡不住直写）。
- 已封堵：honey_ledger/entitlements/ai_usage/badges 仅 SELECT；拍照额度走
  预占 token（consume/release）。`isPro`：pro 档缺 pro_until 判已过期（防永久会员漏洞）。
- 0016 已加 10 条 CHECK 约束（profiles/meal_entries/water_logs/exercise_logs 数值边界）。

## 关键坑（一行版）

endpoint 同源/绝对 HTTPS；CapacitorHttp.enabled=true 必开；云 SDK 独占 localStorage
（登录态真源，勿用 kv 接管）；iOS 需 HTTPS；iOS 无 BarcodeDetector→原生换 MLKit；
SW 在 capacitor:// 不注册；原生登录阻塞=OriginProxy 已解；cap sync 撞 safe-delete 守卫
→ 只改 web 资源用 `npx cap copy android`；微信回调 Activity 随 applicationId 改名；
图标改后跑 `tools/gen-app-icons.py`；模拟器网络需沙箱外启动+captive_portal_mode 0；
验收用 `tools/android-cdp.py` + logcat（d-bee-diag / d-bee-origin）；安全区写
`var(--safe-area-inset-*, env(...))` 三端通吃。

## 过审合规

Apple 4.2 / 3.1.1（阶段3删 REDEEM_CODES 兑换码通道）/ 5.1.1(v) 账号删除 /
AI 告知同意；中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。

## 工作方式

需求驱动、多轮递进、「写→验→报」小步验证；缺陷/进度类文档用 .docx；
跨机同步只走 Git 私有仓库（`github.com/yutaiyin139/d-bee`，main），
两台机器都 `core.autocrlf false`；推送失败是常态波动，**for 循环重试 5 次**勿改方案；
收工时把进度快照+明日待办+待拍板决策写入当日日志。
自测脚本在 `tools/*-selftest.mjs`（v15 版用 esbuild 打包真实 TS 模块后断言，
运行器 `node tools/v15-selftest.run.mjs`）。

## 环境备忘

- **SSH 发布凭据**：`150.158.51.106` / `ubuntu` / `Yuty@20021221`（deploy/deploy.sh）。
- APK 归档 `dist-release/`（gitignore，不入库）；Web 归档 `backups/`。
- 云数据库应用 ID `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql）。
- curl 本机 dev server 需 `--noproxy '*'`；`package.json` 无测试框架/lint。
- 微营养素：foodsData*.ts 已 10 列化（钠/纤维/添加糖，/100g），1175 条零兜底。
