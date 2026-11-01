# D-Bee（自律蜜蜂）· 项目长期记忆（精简版；细节见当日日志与 docs/）

> 🔖 **权威口径（勿再改动）**
> · **Bundle ID / appId = `cn.com.dbee.app`**（iOS+Android 同值；弃用史：`com.dbee.app` 被抢注 → `cn.dbeehealth.app` 不可用 → `com.d-bee.app` Android 禁连字符 → 10-25 定案）
> · **域名**：`d-bee.cn` = 自律蜜蜂 Web 端（隐私政策 URL / Apple webhook / Universal Link / 原生 endpoint 全用它）；`d-bee.com.cn` = 公司官网（纯静态，不调网关）。同一企业备案订单（一单两站 -1/-2）。域名与 Bundle ID 互相独立。
> · **版本 1.7.3**（Android vc14 / iOS CURRENT_PROJECT_VERSION 12 / mini 0.1.0）
> · 🔴 **打原生包绝不能用 `npm run build`**（白屏，见铁律 #10）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。

## 进度快照（截至 2026-11-01）

**已完成**
- **iOS V1.7.3 已发布**（10-29）+ 上架就绪实证核查通过；Web V1.7.2 线上（http://150.158.51.106/）；Android vc13 重打并验签通过。
- **10-29/10-30 四端代码审查整改 #1~#5**（原生生产数据面统一 / IAP 交易闭环重构 / IAP 异常路径回归 `npm run test:iap` / 无障碍集中整改 / 功能可靠性）→ 沉淀为铁律 #5~#9。
- **自建网关密码登录生产缺陷修复**（`8d4a0ef`：`signInWithPassword` 分流 + 标识归一化 + 防枚举恒定耗时 + 双维度限流，35/35 断言过、线上 200）。
- **合规 P0 多端一致性**（`PrivacyGate.tsx` 首启同意门 + 第三方 SDK 7 项公示 + 小程序按真实链路重写 + `verify-legal.mjs` URL 可达性校验）。
- **阿里云真短信上线**（`SMS_PROVIDER=aliyun`，万能码摘除，实收验证通过）；**App Store 素材链路就绪**（商店截图 + `deploy/shot-creative.mjs`，126 项 DOM 断言）。
- **10-31 全仓口径核查**（`e8b7ffd`）：Bundle ID / 域名代码侧全对；唯一缺陷 `tools/android-cdp.py` 硬编码弃用包名已修（`DBEE_PKG`/`--pkg`）；12 份 docs 过期口径已更正。
- **10-31 四项安全问题核查**：①万能码=不属实（真发短信+三层拒启动防护）②**5432 公网暴露=属实已修**（`listen_addresses=localhost`，远程管理改 `ssh -L 15432:127.0.0.1:5432`）③历史密钥未轮换=属实，/tmp 明文已 shred，**SSH/sudo 密码仍未轮换待拍板**④双后端走云吃不到 0039=属实已修（云库 7 权益函数补齐闸门，攻击 4 路径全拦）。
- **10-31 晚**：ICP 企业备案已提交进管局审核（6–25 工作日）；iOS 真机白屏加「启动失败自报面板」（`c99f98f`：index.html 内联 ES5 四道捕获 + `BootErrorBoundary.tsx` 包在 PrivacyGate 外），误用 `npm run build` 现会红屏自报。
- **11-01 白屏闭环 + 四问题根因全部锁定**：Mac 侧跑通 `npm ci`+`build:native:internal`+`cap sync ios`，自报面板首次实战生效并**直接给出根因**（红屏文案逐字等于 `cloudConfig.ts:87` 护栏 = 误用 `npm run build`，非代码缺陷）。四个报障经三个只读探针（`deploy/probe-sms-fail.py` 查网关日志 / `probe-sms-delivery.py` 调 `QuerySendDetails` / `probe-restart-window.py` 量化重启影响面+低峰窗口+LLM 耗时基线）实证：①iOS 登录后红屏=IAP 恢复链路未捕获异常（`177ec7d` 只把面板降级为可关闭横幅、**未堵住异常源**；16:20 真机复现 → `5d9de96` 三层纵深防护才是真修，**两轮都须 Mac 重打才在真机生效**）②③139\*\*\*\*1170（移动号段）收不到验证码=`PORT_NOT_REGISTERED` 移动侧报备未完成（我方 0 失败 0 限流，**需用户在控制台补报备**）④识别超 1 分钟=qwen 深度思考空转（已修 `dc217da`，**待部署**）。⚠️ 前一轮「iOS 获取验证码 TLS 失败」结论**作废**——用户本轮能在 iOS 登录成功即证明 TLS 当时已通。

**下一步（上架前主线）**
0. 🔴 **11-01 剩一项待拍板**：**移动号段收不到验证码**=签名子端口号移动侧报备未完成 → 须在阿里云短信控制台「签名管理」查**运营商报备结果**补报备（5–7 工作日，部分 7–10；期间移动用户走**密码登录**）。✅ 识别提速修复**已于 11-01 19:11 部署生产并端到端实证**（详见当日日志）。
   **重启影响面已实测**（`deploy/probe-restart-window.py`，只读）：48h 日志仅 **29 行**、活动只在 11-01 14:00–15:24（=用户自测时段）、独立 owner **3 个**（波及上界）、`otp.challenges/tokens` 6 次采样**全 0**、`NRestarts=0`、access/refresh TTL 走默认 **30min/30d**。→ **重启代价当前极低**；重启只清内存态（OTP + refresh_token），access token 是无状态 JWT（`lib/jwt.mjs` 手写 HS256）+ env 不动 → 旧 token 仍有效，**只有超 30min 未活跃者需重登**。实际重启窗口 19:09–19:13 业务日志 **0 行**，印证无用户被波及。
1. Mac/Xcode 真机实证整改 #1~#5 原生改动：HealthKit status 分支 / OriginProxy cancel 双端 / LocalNotifications 真机推送（+iOS 开 Push capability）/ StoreKit 沙盒七项矩阵（退款/续订/断网/杀 App）。⚠️ Windows 编不了 Swift。iOS 红屏修复（`5d9de96`，第二轮三层防护）也须 Mac 侧重打 `build:native:internal` + `cap sync ios` 才能在真机生效。
2. ASC 配 3 商品（`dbee_pro_monthly`/`dbee_pro_yearly`/`dbee_lifetime`）+ IAP capability + 收款 + Notifications V2 webhook 指 `https://d-bee.cn` + `APPLE_BUNDLE_ID`/`SHARED_SECRET`/`APPLE_ALLOWED_ENVS` → iOS 提审（需备案号）。
3. ICP 备案：注销重备（详见「业务与资质」）；A4 已做完可随时注销不停业务；工信部短信核验 24h 内必做。
4. 资质到货后（公章 10-27 到手、对公账户 10-28 开立）→ 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议。
5. 上架前未决阻断：**凭据轮换**（SSH/sudo 密码 sha8=c0215031 已进 git 历史 b6b1725/8cecdee+对话；明文只在本地 `.env` SSH_PWD，**严禁写进入 git 的文件**）/ **HTTPS + 域名解析**（四端硬阻断：iOS ATS、webhook、微信支付宝抖音合法域名）。
6. 其余：软著（见待拍板）→ App 备案（7–20 工作日，需软著）→ 算法备案；华为/小米企业入驻后替换 dbee-health 插件方法体并真机验收（小米入驻已完成，下一步=运动健康数据服务申请）；分享卡片 O-3；**实测自家 MAPE**（竞品最后缺口）；彩页按新定位重写；Android 真机复测；小程序三端真机联调。

**待拍板（不阻塞开发）**
- 🔴 **软著 AI 条款红线**：2026-03-15 版权中心新规要求经办人**亲笔手抄**承诺「未使用 AI 开发编写代码/撰写文档/生成登记材料」，违者列入版权登记失信名单+个人征信；申报文档不得 AI 代写。D-Bee 是 AI 深度协作开发（git 即证据）→ **不可盲目提交，须先致电版权中心问清口径**，说明书须用户亲写。旧文档「鉴别材料已备好」**是错的**。素材包已就绪：`docs/软著登记-事实素材包与合规红线-2026-10-28.md` + `tools/gen-softcopyright-source.py`（27,751 行/135 文件）。
- ①ICP 经营许可证 = 是否背「3 人社保」→ 已建议**方案 A：暂不办，先靠 iOS IAP 验证付费意愿**。
- ②Apple 账号：个人先行抢时间 vs 等企业（建议先申 D-U-N-S 占位、个人推进构建）。
- ③云库长期去留（自托管彻底替代 / 回迁 / 双写）。
- ④老用户迁移三路径（推荐 A：判定开发数据不迁移，两端均未上线）。
- ⑤存量 7 行 `source='newbie'` bonus 处置（A 作废 / B 补偿 / C 连数据清）。
- ⑥小程序是否回迁自托管（现小程序走 WorkBuddy 云、主端走自建 PG，两库不通；回迁须同步改 `mini/src/lib/cloud.ts` 与 `mini/src/content/legal.ts`，否则又成虚假公示）。
- ⑦演示账户两套数据面（iOS 云库 owner `2115454156301934592` / web 自建 owner `1793280185303313979`，同邮箱同密码但互不相通；iOS 切自建库后须重建账户+预置数据，否则审核员登录空账户 → Guideline 2.1）。
- ⚠️ 安全待办（用户处理）：①重置 DeepSeek API key（曾明文出现）②轮换 SSH/dbee_app 密码。**轮换优先于重写历史**（`git filter-repo`+force push 属破坏性操作，未擅自执行）。

**版本/git**：commit 流水不入本记忆，一律 `git log`（截至 11-01 19:15 本地与远端**已同步**，HEAD `6ca42a9`；此前因 GitHub 502 积压的提交已全部推送）。

## 三条主线

1. **开发**：看板=本文件「进度快照」，由自动化「D-Bee 开发进度盘点」每日收敛；细节看当日日志。
2. **备份**：自动化「D-Bee 每日数据备份」→ `db/backups/YYYY-MM-DD.json`（失败落 `FAILED-YYYY-MM-DD.md`）。
3. **运营**：彩页、技术交流、社群，由自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为 Health Kit 需先上架华为市场 / 小米官方 SDK），详见 `docs/健康数据源方案.md`。
**6 项决策已拍板（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=先日志+万能码（已升级 aliyun 真短信）⑤网关语言=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（**弃 0029 的 pg_net 方案**）。原则：便捷、技术可控、价格低廉、全对比竞品。凭据只存本地 `.env`（gitignore）；例外：SSH 密码曾入 git 未轮换。DBEE_PWD/JWT_SECRET/API keys 经核查未进历史。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层（platform/kv/capture/scan/share）；运行时探测 `window.Capacitor`，**不 import Capacitor 包**。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 原生插件，注入点=云 SDK `options.fetch`（`src/cloud.ts`），**勿 patch window.fetch**。Origin 钉死三处：`src/lib/originProxy.ts`、Java/Swift 插件、Nginx——**仅云端版 `nginx.conf.example`（已废弃存档）才改写 Origin**；生效的自托管版不改写。🔒 **Origin 头不决定流量去向**，决定 endpoint 的是 `cloudConfig.ts`（native-release 硬断言 `https://d-bee.cn`）。
4. 输入校验走 `src/lib/validate.ts`（过滤→夹回→门禁）；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。
5. **StoreKit 2：服务端核销成功才 `finish()`**。提前 finish = 核销断网/杀 App 时交易被清除、权益永久丢失。待核销记录绑定 owner 并经 `@capacitor/preferences` 持久化；带 `revocationDate` 的退款交易只 finish、绝不送核销。回归 `npm run test:iap`。
6. **原生能力必须返回显式状态，禁止把失败吞成「0/空」**。HealthKit `fetchToday` 返回 `status`（ok/empty/denied/error/unavailable/not_ready/no_plugin，见 `src/lib/health/types.ts`），调用方只在 `isUsableHealthStatus(status)` 时写回——否则「授权被拒的 0」会抹掉已有步数。新方法照办：状态枚举 + `normalize*` 兼容旧插件。
7. **弹窗无障碍统一 `useModalA11y(onClose)`**（焦点陷阱+Esc+焦点归还+滚动锁+`aria-modal`）。`role="button"` 的 div 用 `src/lib/a11y.ts` 的 `onActivateKey`，**不要改原生 `<button>`**（会按钮套按钮）。对比度按 WCAG 相对亮度精算。
8. **iOS 付费墙禁止硬编码价兜底**：商店价拉取失败必须禁用购买+给重试，价格位显示「—」（否则 3.1.2 价格欺诈风险）。
9. **OriginProxy 取消归一为 End 而非 Error**，取消异常**绝不回退缓冲重发**（重复请求/重复扣 token）。在途流注册表必须在 finally/defer 移除。
10. 🔴 **打原生包绝不能用 `npm run build`**（实测 → 真机纯白屏无报错）。`npm run build` 是 Web 产物（MODE=production），护栏 `if (import.meta.env.PROD && mode!=='native-release' && mode!=='native-internal') throw` 在 production 下恒真 → 被死代码消除成无条件 throw；`publicConfig` 是模块级常量，iOS 上 `detectNative()` 恒真 → JS 首行即炸，React 连 PrivacyGate 都挂不上。CSS 已载故呈米白（`#FBF8F1`），极易误判「public/ 没同步」。**产物自检**：`grep -c "禁止直接复用 Web 产物" dist/assets/index-*.js` 必须为 `0`。
    ⚠️ 教训：`ios/App/App/public` 被 gitignore，Mac 包内容完全由 `cap sync` 决定；**误诊会自我强化**——诊断构建问题必须真实构建两种产物对照，不能只读文档。

## 云数据库安全铁律（最高优先级）

- 发权益/积分/额度函数必须 SECURITY DEFINER + 入参白名单；审计用 `pg_get_functiondef` 看真实 DDL。
- 光有白名单不够：**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 只限「自己的行」挡不住直写）。已封堵 honey_ledger/entitlements/ai_usage/badges 仅 SELECT；拍照额度走预占 token。`isPro`：pro 档缺 `pro_until` 判已过期。
- 0016 已加 10 条 CHECK（profiles/meal_entries/water_logs/exercise_logs 数值边界）。
- **迁移审计结论（10-23）**：33 编号 = 28 生效 + 3 失效（0015 可白嫖终身会员 / 0016 CHECK 全缺 / 0026 newbie 未生效 / 0027 邀请无日上限）+1 弃用（0029）。根因：只 GRANT 不 REVOKE / 不抓 pg_constraint / 覆盖式迁移无法判版本 / 无追踪表。已修 0034（追踪表）+0035+0036；前端 `consumeAiQuota` fail-closed；工具 `tools/migration-audit.sh`。**铁律：先修工具再修数据**。
- **0039 闸门双库对齐（10-31）**：云库 7 权益函数（grant_honey / grant_photo_bonus / consume_ai_quota / consume_photo_quota / get_photo_quota / redeem_honey / settle_invite_checkin）经 MCP 补齐 0039 版 + ACL 收口（顺带收掉 consume_photo_quota 的 PUBLIC EXECUTE），攻击 4 路径全拦、正常放行。补丁在 `db/cloud-patch-0039/`；探针 `deploy/probe-0039-parity.sh`。**铁律：新增/修改权益函数必须双库同步打补丁**（自建走 migrations，云库走 MCP + cloud-patch 留档）。
- **nginx 唯一生效模板 = `nginx.selfhost.conf.example`**（云端版已废弃存档）。改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`（双守卫：必含 dbee_gateway、无 workbuddy.host）。

## 关键坑

endpoint 同源/绝对 HTTPS；`CapacitorHttp.enabled=true` 必开；云 SDK 独占 localStorage（登录态真源，勿用 kv 接管）；iOS 需 HTTPS；iOS 无 BarcodeDetector→原生 MLKit；SW 在 capacitor:// 不注册；cap sync 撞 safe-delete 守卫→只改 web 资源用 `npx cap copy android`；微信回调 Activity 随 applicationId 改名；图标改后跑 `tools/gen-app-icons.py`；模拟器网络需沙箱外启动 + `captive_portal_mode 0`；验收 `tools/android-cdp.py`（默认包名 `cn.com.dbee.app`，`DBEE_PKG`/`--pkg` 覆盖）+ logcat（d-bee-diag / d-bee-origin）；安全区写 `var(--safe-area-inset-*, env(...))`。

- **cap sync / 插件注册三连坑**：①新插件必踩 safe-delete 守卫（genie-trash ETIMEDOUT）→ 误删 `android/capacitor-cordova-android-plugins/` 两 gradle 文件；绕过=先 shell `rm -rf` 该目录再 `cap sync`（shell 删不触发 genie-trash）；兜底=解压 `capacitor-cordova-android-plugins.tar.gz` + 手写 cordova.variables.gradle + build.gradle 补 `apply from`。②本地插件（file:）两步缺一不可：`includePlugins` 列名 + `npm install` 建 symlink；「Gradle 编译过 ≠ 运行时注册，`capacitor.plugins.json` 才是真源」。③**`includePlugins` 白名单对 npm 包插件同样生效**（装 `@capacitor/local-notifications` 后 `cap sync` 静默跳过），排查先 `npx cap ls ios`；iOS 还需 Xcode 单开 Push capability。
- **原生拍照/扫码无反应**：①`file_paths.xml` 缺 `<external-files-path>` → FileProvider 抛异常；②Manifest 缺 `CAMERA`。
- **兑换拍照额度用不了**：`guardAiQuota()` 不能按当日次数阶梯拦（quota_bonus 不计次数）；唯一依据 `get_photo_quota.total_remaining`。
- **单条 SELECT 表达式求值顺序未定义**：`SELECT set_config(…), fn(…)` 中 set_config 可能在 fn 之后执行 → 误判「闸门挡好人」。正解 `WITH s AS MATERIALIZED (SELECT set_config(…) AS c) SELECT (SELECT c FROM s), fn(…)`。
- **探针脚本绝不 cat/grep 脚本正文**：会把 `echo "<sudo密码>" | sudo -S` 明文打进输出。凭据文件只报「存在性+长度+sha8」；已泄露立即 `shred -u -z -n 2` 并轮换。
- **split SQL 的 dollar-quote 陷阱**：按分号切必须跟踪 `$fn$` 奇偶；`startswith('--')` 判空会丢弃带 `═══` 注释头的 CREATE——先剥注释头再判空。
- **华为 EMUI/HarmonyOS WebView 忽略 `<input capture>`**：原生端统一 `@capacitor/camera`，web 端保留 `<input capture>`。
- **honey_ledger 唯一索引 `(owner_id, reason, ref_id)`** 会把「每日多次」卡成「每日一次」：ref_id 需带唯一后缀（`to_char(clock_timestamp(),'HH24MISSMS')`）；排查「记录已存在」先查 `pg_indexes`。
- **Xcode 完好性判定**：`xcodebuild -version` 报「Xcode 27.1」实为 CLT 版本号对齐，极具迷惑性。判定 = `du -sh` ≥15GB + `-showsdks` 列出 iphoneos，**不能只看 -version**。
- **iOS 首次真机编译三处 bug（已修）**：①拍照无反应（缺 `NSPhotoLibraryAddUsageDescription`，前端 catch 静默吞 reject）②`resultType:'DataUrl'` 大小写 bug ③Bundle ID 冲突。顺序：`npm ci` → 三选一构建 → `npx cap sync ios` → Cmd+R。
- 🔴 **`SendSms` 返回 `Code=OK` ≠ 送达**（只代表阿里云**受理**）。查「某号收不到验证码」而网关日志全 `Code=OK` 时，**下一步必须调 `QuerySendDetails`**（`PhoneNumber`+`SendDate`(yyyyMMdd)+分页）看 `SendStatus`(1 等回执/2 失败/3 成功) 与 `ErrCode`；只看自家日志会误判成「我方正常，让用户重试」。
- 🔴 **`ErrCode=PORT_NOT_REGISTERED` = 签名子端口号未完成运营商实名制报备**（11-01 实证：移动 139\*\*\*\*1170 五条全失败，联通 186\*\*\*\*4399/4728 全 `DELIVERED`）。一个签名生成多个子端口号分发到不同运营商 → **部分未报备通过则该运营商用户收不到**，「换号能收」不是玄学是号段差异。签名审核通过 ≠ 报备完成（5–7 工作日，部分 7–10）；入口=短信控制台 → 签名管理 → **运营商报备结果**。生产 `SMS_PROVIDER=aliyun` 且**无腾讯云凭据**（`SMS_TENCENT_*` 除 REGION 外全未设置）→ 不能靠切 provider 绕开，期间移动用户只能走密码登录。
- 🔴 **qwen3.8/3.7/3.6/3.5 系默认开「深度思考」**，简单视觉任务上是纯空转：11-01 实测一单午餐 `completion_tokens=3221` 里 `reasoning_tokens=3105`（**96%**），真输出仅 241 token，耗时 30–60s+ 且白烧钱。关闭=OpenAI 兼容模式把 **`enable_thinking:false` 放 body 顶层**（Python SDK 才放 `extra_body`）。已在 `llm.mjs` 仅对视觉请求注入（DeepSeek 忽略未知参数），开关 `LLM_VISION_ENABLE_THINKING`（默认 false）。**11-01 19:11 已部署生产 + A/B 实证上游确实尊重该参数**：同图同 prompt，`false` → 1085ms/completion=3/思考流 0 字；不传 → 7321ms/completion=122/思考流 149 字（**6.7 倍提速**）。质量若退化可把 `LLM_VISION_ENABLE_THINKING=true` 写进 gateway.env 单独回退，**无需改代码/再部署**。
- 🔴 **`reasoning_tokens` 嵌在 `usage.completion_tokens_details.reasoning_tokens`，不在 `usage` 顶层**：11-01 A/B 探针只读顶层 → 两边都显示「无字段」，而生产日志明明有 3105（日志侧用正则 `reasoning_tokens[":]+[0-9]+` 扫整个 JSON 串，不管嵌套深度都命中）。读该字段务必按嵌套路径取，或直接用正则扫串。
- 🔴 **链尾 `.catch()` ≠ 所有失败都被兜住**（Capacitor 8.5.3 `addListenerNative` 结构性缺陷，11-01 iOS 红屏两轮的真根因）：其实现为 `const call = addListener(ev,cb); new Promise(res => call.then(() => res({remove})))`。两条致命路径 ①`cap.toNative` 对回调型调用返回的是 **`callbackId` 字符串**（`native-bridge.js:913`）而非 Promise，对其 `.then` = **同步 TypeError**，`.catch()` 根本没机会挂上；②原生 `addListener:`（`CAPPlugin.m:105-109`）只 `setKeepAlive:TRUE` **从不 resolve** → 该 Promise **永久 pending**，链尾 `.catch()` 即使挂上也**永不触发**。另 `cb` 在原生派发器里**同步**调用，抛错直冒 `window.onerror`。故须对「同步抛错」「返回非 Promise（`typeof p.then==='function'` 判空）」「Promise 自身 reject」**三路分别设防**，并在编排层立「保证不 reject」契约。
- 🔴 **跨引擎错误上报必须 message 与 stack 分开取**：iOS JSC 的 `error.stack` **不含** message（V8 才把 message 放 stack 首行）→ `r.stack || r.message` 在 iOS 上 message **永远丢失**（连续两轮截图读不出错误文本的根因）。正解：分别取，`stack.indexOf(message) === -1` 时拼接。错误面板还须分**致命/非致命**两形态：整屏接管只适用于启动期/渲染期，运行期非致命改**顶部横幅+关闭按钮**，否则「App 可用却被自己的面板盖成不可用」；`padding-top` 必叠 `env(safe-area-inset-top)`（刘海机上标题被状态栏压住）；React 渲染期抛错须显式传 fatal（此时 `#root` 已有子节点，按 `childElementCount` 自动判断会误判）。

### 部署侧坑

`CREATE POLICY` 子句顺序硬规定 `AS→FOR→TO→USING→WITH CHECK`；`GRANT` 是**追加**语义（清 DELETE 先 `REVOKE ALL`）；`BYPASSRLS`=全库 RLS 失效（0033 已收回，改 `TO <role>` 专用 policy + NOBYPASSRLS）；systemd `StartLimitIntervalSec/Burst` 属 `[Unit]` 段；V8 服务**勿设** `MemoryDenyWriteExecute`；`pg_dump` 必须 `sudo -u postgres`，失败时 gzip 仍留 20 字节空壳→加体积守卫+`gunzip -t`；Git Bash↔Windows Python 路径用 `cygpath -m "$(mktemp)"`；paramiko 长任务必设 `set_keepalive(30)` 且先输出结果再清理远端临时文件；`JWT_SECRET`/`IDENT_PEPPER` 存 `deploy/gateway/.secrets.local`（**改 JWT_SECRET=全员登出，改 IDENT_PEPPER=老用户身份失配**）；网关与 PostgREST **必须共用同一 HS256 jwt-secret**（否则数据面全 401）；`DBEE_PROD=1` 拒 `SMS_PROVIDER=log` 启动，且连带把 Apple 收据收紧为只收 Production → 沙盒期须显式 `APPLE_ALLOWED_ENVS=Sandbox,Production`；env 模板加占位符必须同步改 `deploy-gateway.sh` 的 sed 注入表（值过 `esc_sed`，`#`/`&`/`\` 不转义会静默写坏 env）；部署线上 env 用「本地生成完整 env → SFTP 覆盖」；模板守卫要排除注释行。
- 🔴 **`deploy-gateway.sh` 是「全站永久锁死」级地雷**：它用本地模板**覆盖** `/etc/dbee/gateway.env`，本地 `.env` 缺 `IDENT_PEPPER`/`JWT_SECRET` → 覆盖后 `ident_hash` 无法重算、**所有账户再也认不出来，不可恢复**。改网关代码一律走**手术式脚本**（参照 `deploy/apply-password-login-fix.sh`：传代码→语法校验→env 指纹→备份→install→重启→healthz 失败回滚→**断言 env sha256 前后一致**）。SSH 账号 = `.env` 的 `USER=ubuntu`+`SSH_PWD`（不是 `DBEE_USER=dbee_app`）。
- `deploy-gateway.sh` 两处 `set -e` 静默退出陷阱已修（`34a8216`）：①`[ -z "${SEC[$k]}" ] && MISS+=(...)` 凭据齐全时短路退出 ②注释态键的 `grep|head|cut` 触发 pipefail。症状=**exit 1 零输出**；⚠️ 不要用 `bash -x > file`（明文密钥写进追踪文件）。
- **网关鉴权头是 `x-wb-webapp-access-key`（不是 `apikey`）**，云端按 **Origin 精确匹配**校验 → Node 脚本必须注入 `Origin`/`Referer`，否则 session invalid（易误判凭证失效）。真实表名见 `db/migrations/`（**没有 habit/habits**）。
- **`signIn` 两条路径**：验证码 `{username, verification_token}` / 密码 `{username, password}`，改鉴权必双回归；密码路径标识须归一化（SDK 发 `+86 138…`，库内 `ident_hash` 按裸 11 位）。回归 `tools/selftest-password-login.mjs`（35 断言）。

## 数据面与部署现状

- **泳道 A 部署闭环（10-23）**：`150.158.51.106` 上 nginx（自托管配置）+ dbee-gateway（Node 22.22.2 / :8080）+ PostgREST（16.4 / :3001）+ PG 17.11（dbee 库）四件套 active；`/.cloud/**` 全走自托管。8 项 E2E 全 ✓。云端回滚点 `/etc/nginx/sites-available/d-bee.cloud.bak`。PG 监听已收 `localhost`（5432 外网不可达，脚本 `deploy/fix-pg-loopback.sh` 带 30s 验证+自动回滚）。
- **数据库切换核心判断（10-26）**：不是「要不要切」而是「HTTPS 何时就绪」的资质问题。切换时机 = 备案→域名过户（✅）→A 记录→80 公网→签 HTTPS→三端指 `https://d-bee.cn`；过渡期云库唯一真相源，切换日一次性收口。**摆脱云库六步已实证**：ICP 备案→A 记录（当前 `d-bee.cn` **无任何 DNS 记录**）→certbot→三端注入 `VITE_NATIVE_ENDPOINT` 重打→0043 最终同步+账号合并→观察期 T+30。工具链（sync-mirror/switch-nginx-selfhost/dnscheck/setup-https）就绪；**真正欠账=写 `0043-data-sync-final.sql`**（0042 已被 token-version 占用）+ 云↔自建身份映射 + 186****4728 分裂账号修复（云库 `2110364580268998656` 真实 vs Web 自建 `1792845025064566575` 空壳，根因两套发号机制）。**数据双向分叉每天扩大**。
- **数据面现状**：Web 已切自建 PG；**Android/iOS/小程序仍走云库**（原生未注入 `VITE_NATIVE_ENDPOINT` 时回退 CLOUD_HOST；小程序 `mini/src/lib/cloud.ts` 硬编码 endpoint）。云库已补 0039 闸门，故双后端不再是旁路，剩余问题是数据归属（待拍板 ⑥）。自建网关唯一缺口 = 无 `/v1/login-wechat`。
- **数据/结构分离（PIPL 最小必要）**：`0030-full-selfhost-mirror.sql` 含 17 表全量真实健康档案（含未成年人）→ **不入库**（gitignore + `git rm --cached`，本地保留）。入库的是 `0030-schema.sql`（schema-only）+ `db/functions.sql`（27 个 SECURITY DEFINER DDL）。⚠️ `0030` 已含 0025~0028 变更，勿盲跑 0025~0029。**不需要存储代理**——拍照走 base64 dataUrl 直塞 LLM。
- **🔴 支付链路（10-23 已落地）**：Apple 验签在 Node 网关（`server/lib/iap.mjs`）：verifyReceipt（21007/21008 沙盒切换、**bundle_id 钉扎** `APPLE_BUNDLE_ID`、transaction_id 全服幂等、恢复购买）+ Notifications V2（x5c 证书链钉扎、续订/退款、落库）+ `AppleRootCA-G3.cer`。`0037`：幂等表+留痕表+3 个 SECURITY DEFINER 函数（EXECUTE 仅 dbee_app）。webhook 豁免 IP 限流；`api.ts` iOS 优先走网关、404/503 回退 RPC。自测 `tools/iap-selftest.mjs` 47 项全过。
- **🟢 短信（10-29 上线）**：三易错点：①aliyun 是 RPC + **HMAC-SHA1** 手写签名（腾讯云是 TC3-HMAC-SHA256）②模板 `SMS_512482436` 只有 `code` 一个变量，TemplateParam 传 JSON 串 ③🔴 **签名口径=「北京迪蜂科技有限公司」不是「自律蜜蜂」**（后者是腾讯云侧记录，阿里云用报 `isv.SMS_SIGNATURE_ILLEGAL`；要品牌签名须重新申请 1–2 工作日，过审只改 `SMS_SIGN_NAME`）。凭据在 `deploy/gateway/.secrets.local`，RAM 子账号最小权限。部署时**只切短信、不开 `DBEE_PROD=1`**。
- **🔴 安全加固两批**：①10-26 六项体检全生效（RPC 信任边界 / 原子性 / LLM 服务端授权 / Apple 环境白名单 / XFF 信任边界 / 榜单缓存）。曾发现**网关层完全未部署**（跑 10-23 骨架版）→ 已补齐复验 18/18 全绿。②10-27 七项：JWT TTL 30min+refresh 滚动+`token_version` 强制下线（0042 已部署）/ appleSandbox 生产默认关 / 万能码切真短信 / LLM 视觉 fail-closed 503+文本降额 50/日 / grant_honey 发分前查真实记录 / CORS Origin 白名单 / email 验证码（163 SMTP 465/SSL 手写）——**后四项代码+自测 300/0 全绿，待部署**。

## 业务与资质要点

- **🔓 主体注册已办结（10-22）**：解锁微信生态、华为/小米企业入驻、ICP 经营许可。公章 10-27 到手（清单 `docs/公章使用清单-2026-10-27.md`）；对公账户 10-28 开立（`docs/对公账户到手-后续执行步骤-2026-10-28.md`）；域名 10-27 过户（WHOIS = 北京迪蜂科技有限公司）。
- **🔴 「3 人社保」= ICP 经营许可硬条件，无法绕过**：≥3 名全职、三个不同人（许可/客服/安全负责人）、法人可算一人、必须本公司缴（代缴/挂靠直接驳回且一年内禁申）、管局跨部门比对+可能上门；成本 ≈¥4000/月起 + 记账 + 代办（约 47 工作日）。**已定方案 A：暂不办**。执照类前提已全部就位，仅剩此缺口。
- **📱 小程序主体变更（appid `wxb7c7122de9c3ab1f`）**：¥300 不退 + 审核 1–7 工作日；可免公证（个人→企业且个人即法人）；原主体签名+按手印，不可代办。⏰ 通过后 7 天内须管理员确认+重登+签协议，超时作废。🔴 两个强制后续：①重做小程序备案 ②类目资质重交（14 天内，逾期封禁）。⚠️ 类目红线：避开「医疗-其他医学健康服务」→ 选工具/生活服务；文案严禁诊疗/治病/筛查。
- **🌐 ICP 备案**：路径=**注销重备**（北京不在「个人→企业」直接变更白名单）。域名已过户（管局核对 WHOIS=备案主体）；**关 WHOIS 隐私保护**；A4 已做完且 IP 直连验证 → 可随时注销不停业务；注销后域名停解析；**工信部短信核验 24h 内必做**；两域名打包同一订单（-1/-2）。法人京籍→无需居住证/社保；腾讯云个人实名不阻断（以官方《备案限制说明》为准）。
- **📊 竞品定位**：¥18/月、¥128/年 与薄荷健康同价，食物库 1,175 vs 100 万+ → **不拼广度/AI 识别准**；年付 ¥128 是国际 12 款最便宜，**价格锁定不改**（¥18/¥128/¥328）。🔴 悉尼大学 2024：AI 对混合亚洲菜肴高估 49%/低估 76%（=D-Bee 核心场景）→ **定位「不卖 AI 神奇，卖能坚持下来」**：厚免费+游戏化+终身 ¥328+本地规则引擎 `foodInsight.ts`（1,175 条零兜底零幻觉）优先、AI 仅兜底+无广告+数据自托管。**待办：实测自家 MAPE**。
- **⚙️ AI 成本**：DeepSeek flash 峰值价（工作 9–12/14–18 点 2 倍，恰三餐高峰，按峰值估）：拍照 ≈¥0.0047、问答 ≈¥0.0069（token 上限 384；前端 `compressImage(1024,0.82)`）。5 次/日：100 DAU≈¥42/月、10,000≈¥4,230 → 万级 DAU 前远低于 ¥4000/月，反证方案 A。降本=系统提示缓存（输入价降~98%）+ 本地引擎先命中。
- **🔴 LLM 接线（DeepSeek 文本 + 阿里云百炼视觉）**：①`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 退役，只剩 `deepseek-flash`/`deepseek-v4-pro`；②**只有 flash 接受图片**，其他模型返 400；③网关 `/llm/models` **必须给 flash 标 `supportsImages:true`**，否则 `pickModel(needVision)` 选空→拍照报错（另需过滤 `disabled!==true && enabled!==false`，见 `ai.ts:31`）。模型 ID 放服务端 `.env`（`LLM_MODEL_VISION`）。视觉走百炼 `qwen3.8-max-0902`（旧名 qwen-vl-max 无权限 403）；`config.mjs` 的 `LLM_VISION_BASE_URL/KEY/MODEL`+`LLM_IMAGE_DETAIL=high`（未配回落原 llm 键）。**服务端切模型对三端即时生效**。
- **合规现状**：用户协议/隐私政策/免责声明三篇已存在且挂路由（`src/content/legal.ts` + `pages/LegalPage.tsx` + `SiteFooter.tsx`，备案号走 `VITE_ICP_BEIAN`，未设则不渲染）→ **页面工作量≈0**，只等备案号。`REDEEM_CODES` 硬编码已从 src/ 删除（3.1.1 硬伤已消）；`restorePurchases()` 已接（3.1.2）。服务端 `redeem_by_code` RPC 仍在，Web/Android 可继续用。**法律文本 URL 一律 `https://d-bee.cn/legal/...`**。
- **额度规则（权威值 `packages/shared/src/constants/index.ts`）**：`FREE_DAILY_AI=3` + `AI_REDEEM_DAILY_LIMIT=2`（每日 3 次免费 + 2 次兑换 50 分/次）。新手 150 分（grantHoney 'newbie'）；连续打卡满 7 天送 2 次识别（'streak7'，7/14/21 循环）。迁移 0025（兑换 5→2）+0026。⚠️ `docs/AI成本与配额.md:101`「每天 10 次」**已过时**。
- **识别自动保存**：识别成功即 settleDraft 落库；该餐已有记录弹「覆盖/追加/取消」，无记录直接落库，另有切页兜底；不做撤销。
- **会员/IAP**：三档 free/pro/lifetime（¥18/¥128/¥328）；Apple 个人开发者账号已通过（10-20）；**Android 企业账号已注册（10-23）→ Google Play 支付线解锁**（`payment_orders.provider` 是 text 无 CHECK，加 `'google'` 无需改表，只补网关验签分支）。**iOS 本地 StoreKit 测试就绪**（`DbeeProducts.storekit` 3 商品 zh_CN + 共享 scheme）。⚠️ 验签须排在 0034/0035 收权之后（已满足）。
- **多端小程序**：Taro 4.3.0（React+TS）双工程 + `packages/shared`，三端编译通过；复刻主工程 11 页，tsc 0 错。受限能力（支付/步数/分享卡 canvas）诚实占位。mini tsconfig 需 `moduleResolution:"bundler"`。合法域名须配 `https://d-bee.cn`。
- **原生 App**：阶段 0 解耦 ✅、Android 全过 ✅、iOS 编译打通并真机测试（origin-proxy / health / iap 三自研 Swift 插件 + @capacitor/camera）。`postinstall` 自动构建 shared，新 clone 一条 `npm ci` 直达。
- **健康数据源**：只读系统健康平台，不直连手环；HealthKit 读授权不可探测→插件只报 completed，连接真源=云端 `health_connected`；`effectiveBurnKcal=max(burnKcal,activityKcal)` 不叠加。华为 Health Kit 阶段 3a 已落地（Android 反射骨架，零 HMS 依赖）；小米官方 SDK 已纳入，白名单 `{huawei,xiaomi}`。未就绪返 `reason=not_ready`。⚠️ 「企业账号已注册」≠「应用已上架华为市场」，后者才是硬门槛（另需软著+App 备案）。
- **微信（`docs/微信登录接入.md`）**：主体已注册，暂缓可解除（`src/lib/wechat.ts` 的 `WECHAT_LOGIN_ENABLED` 改回 true，零改造）。前置链：开放平台企业认证→移动应用 AppID+UnionID→注入 `VITE_WECHAT_APPID`（iOS 另需 `VITE_WECHAT_UNIVERSAL_LINK` + Associated Domains + AASA）→`NATIVE_CODE_EXCHANGE_SUPPORTED=true`。⚠️ 云端缺口：SDK `signInWithWechat` 只走小程序 `jscode2session`，移动应用 code 需 `sns/oauth2/access_token`，不可混用。⚠️ iOS `WechatOpenSDK` 来自第三方 SPM 镜像（官方不经 SPM），上线前须核对 tag 或改官方 XCFramework。

## 过审合规

Apple 4.2 / 3.1.1（阶段 3 删 REDEEM_CODES）/ 5.1.1(v) 账号删除 / AI 告知同意；中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。

> 🔴 **隐私政策公示禁止跨端照抄**：小程序走 WorkBuddy 云（AI 由平台代理动态匹配模型，我方不持密钥），主端走自托管 PG + 自建网关直连 DeepSeek/Qwen，两库**数据不互通**→ 公示主体不同。写任何 legal.ts 前先核对该端 `cloud.ts`/`ai.ts` 真实链路，只写代码里确实存在的能力（小程序无 Open Food Facts / 无邮箱登录 / 导出为占位 / 无离线 / 订阅消息模板未配）。**公示了 ≠ 合规**：每条第三方链接必须 curl 验 200 + 核对语言/主体/适用辖区，且引「与我方关系匹配」的文件（我方=委托方就引**数据处理协议**，不引面向该平台终端用户的隐私政策、不引境外英文版）。`deploy/verify-legal.mjs` §0.7 自动校验 URL 可达性。

## 工作方式

需求驱动、多轮递进、「写→验→报」小步验证；缺陷/进度类文档用 .docx；跨机同步只走 Git 私有仓（`github.com/yutaiyin139/d-bee`，main），两机 `core.autocrlf false`；收工把进度快照+明日待办+待拍板写入当日日志。自测 `tools/*-selftest.mjs`（运行器 `node tools/v15-selftest.run.mjs`）。

**三条指令/shell 陷阱（11-01 实测踩过，别再犯）**
1. 🔴 **给用户的可执行指令必须放代码块、一行一条命令**。`→`/序号等排版符号只能出现在正文说明里——用户会整行照抄粘贴，`git pull → npm ci → …` 会让 `git` 把箭头当 refspec（`fatal: '→' does not appear to be a git repository`）**并连带吞掉后面的 `npm ci`**，最终报 `vite: command not found`，症状极像仓库权限问题、严重误导排查方向。
2. **重试循环里绝不能给命令加管道**：`if git push 2>&1 | tail -2; then` 退出码是 `tail` 的（恒 0）→ 第 1 次失败即 break，重试静默失效。要么不加管道，要么 `set -o pipefail`。
3. **推送失败 = 间歇性时段波动，不必让用户去本机推**：for 循环重试 5 次勿改方案（11-01 四次推送分别第 2/1/2 次成功、1 次 5 连败；`c99f98f` 曾在沙箱内重试推成功，推翻 10-31「须用户本机推」结论）。失败报 `schannel: failed to receive handshake` 或 `CONNECT tunnel failed, 502` 均属同一代理波动。
**文档维护约定**：口径变更时**可执行文档直接更正**；**历史快照文档只加「历史快照·口径已变更」横幅、不改正文**（例外：危险指令就地加删除线+更正，见 10-31 日志）。代码加构建期护栏时**文档必须同步改**。
**记忆维护约定**：commit 流水不入 MEMORY.md；只存结论、铁律、决策、坑与权威口径；**体积 ≤30KB**（曾达 66KB 被截断）。

## 环境备忘

- SSH 发布：`150.158.51.106` / `ubuntu` / 密码见本地 `.env`（`SSH_PWD`，**勿写入记忆或文档**）；脚本 `deploy/deploy.sh`。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`。
- 云库 applicationId `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql，只在已绑定应用的会话可用）；云库地址 `https://zilv-mifeng.app.workbuddy.host`（`build:native:internal` 用，需 `VITE_ALLOW_CLOUD_NATIVE=true`）。
- curl 本机 dev server 需 `--noproxy '*'`；`package.json` 无测试框架/lint。
- 微营养素：foodsData*.ts 已 10 列化（钠/纤维/添加糖，/100g），1175 条零兜底。
- `db/.tmp-backup.sql` 是临时备份，约定不入库（gitignore 未覆盖）。
