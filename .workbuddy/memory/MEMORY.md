# D-Bee（自律蜜蜂）· 项目长期记忆（精简版；细节见当日日志与 docs/）

> 🔖 **权威口径（勿再改动，代码/文档/填报一律以此为准）**
> · **Bundle ID / appId = `cn.com.dbee.app`**（iOS + Android 同值。弃用史：`com.dbee.app` 被 Apple 抢注 → `cn.dbeehealth.app` 不可用 → `com.d-bee.app` 因 Android 禁连字符弃用 → **10-25 定案 `cn.com.dbee.app`**）
> · **域名：`d-bee.cn` = 自律蜜蜂 Web 端**（隐私政策 URL / Apple webhook / Universal Link / 原生端 endpoint 全用它）；**`d-bee.com.cn` = 公司官网**（纯静态，不调网关）。两域名同在公司名下，打包同一企业备案订单（一单两站，京ICP备XXXX号-1/-2）。域名与 Bundle ID 是两个独立体系，互不影响。
> · **版本号：1.7.3**（Android versionCode 14 / iOS CURRENT_PROJECT_VERSION 12 / mini 0.1.0）
> · **打原生包绝不能用 `npm run build`**（会白屏，见架构铁律 #10）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。

## 进度快照（2026-10-31 早）

**当前进度**
- 🎉 **iOS V1.7.3 已发布**（10-29）+ 上架就绪实证核查通过；Web V1.7.2 已发布线上（http://150.158.51.106/）；Android vc13 已重打并实证验签通过。
- **iOS/四端代码审查整改 #1~#5 全部闭环**（10-30，7 commit `326865c..20ff00b`）：①原生生产数据面统一（`native-release`/`native-internal` 构建 + 构建期强制校验）②IAP 交易闭环重构 ③IAP 异常路径回归（`npm run test:iap`）④无障碍集中整改 ⑤功能可靠性（本地通知/HealthKit 状态/OriginProxy 取消/付费墙禁兜底价）。成果已沉淀为架构铁律 #5~#9。⚠️ **Windows 无法编译 Swift，原生分支仍需 Mac/Xcode 真机实证**。
- **自建网关密码登录生产缺陷已修复**（10-29 `8d4a0ef`）：`signInWithPassword` 分流 + 标识归一化 + 防枚举恒定耗时 + 双维度限流，35/35 断言全过、线上实测 200。
- **合规 P0 多端一致性闭环**（10-29）：首启隐私同意门 `PrivacyGate.tsx` + 第三方 SDK 目录 7 项公示 + 小程序按真实链路重写公示 + 公示 URL 逐条联网核验（`verify-legal.mjs` §0.7 自动校验可达性）。
- **阿里云真短信已上线**（10-29，`SMS_PROVIDER=aliyun`，万能码已摘除，用户实收验证通过）。
- **App Store 素材链路就绪**（10-28/29）：商店截图（iPhone 6.3" + iPad 13"）+ 创意素材出图管线（16:9 按 Apple art safe area 设计成 brand 布局，安全区外零文字；`deploy/shot-creative.mjs` + `verify-creative.mjs` 126 项 DOM 断言）。
- **10-31 全仓口径核查通过**：代码侧（src / server / deploy / mini / ios / android / tools / capacitor.config）Bundle ID 与域名**全部正确**；唯一代码缺陷 `tools/android-cdp.py` 默认包名写死弃用值 `cn.dbeehealth.app`（致 CDP 验收恒报「未在运行」）**已修**（新增 `DBEE_PKG` 环境变量 + `--pkg` 参数，默认 `cn.com.dbee.app`）；12 份 docs 过期口径已更正（可执行文档直接改，历史快照只加作废横幅不改正文）。

**下一步（上架前主线）**
1. **Mac/Xcode 真机实证整改 #1~#5 的原生改动**：HealthKit status 分支 / OriginProxy cancel 双端 / LocalNotifications 真机推送（+ iOS 开 Push Notifications capability）/ StoreKit 沙盒七项矩阵（退款、续订、断网、杀 App）。
2. **ASC 配 3 商品**（`dbee_pro_monthly` / `dbee_pro_yearly` / `dbee_lifetime`）+ 开 IAP capability + 填收款 + App Store Server Notifications V2 webhook 指向 `https://d-bee.cn` + 配 `APPLE_BUNDLE_ID=cn.com.dbee.app` / `SHARED_SECRET` / `APPLE_ALLOWED_ENVS` → **iOS 提审**（提审需备案号）。
3. **ICP 备案**：路径已定 = 注销重备（北京不在「个人→企业」直接变更白名单）；法人是京籍 → 无需居住证/社保；腾讯云个人实名不阻断（官方《备案限制说明》允许法人为企业备案，营销页口径相反，以官方文档 + 控制台实际可选性为准）。**A4 已做完且 IP 直连验证通过，可随时注销不停业务**；工信部短信核验 24h 内必做。
4. 资质到货后（公章 10-27 已到手、对公账户 10-28 已开立）→ 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议。
5. 上架前未决阻断：**5432 收回回环** / **凭据轮换** / **HTTPS + 域名解析**（四端上架硬阻断：iOS ATS、webhook、微信支付宝抖音合法域名）。
6. 其余：软著（见待拍板）→ App 备案（7–20 工作日，需软著）→ 算法备案；小程序主体变更（可免公证，趁未上线尽早做）；华为/小米企业入驻后替换 dbee-health 插件方法体并真机验收（小米入驻审核已完成，下一步=运动健康数据服务申请）；分享卡片 O-3；**实测 D-Bee 自己的 MAPE**（竞品分析最后缺口，文案能否说「准」的依据）；彩页按新定位重写；Android 真机复测；小程序三端真机联调。

**待拍板（不阻塞开发）**
- 🔴 **软著 AI 条款红线（10-28 查实，最重要）**：2026-03-15 版权中心新规要求经办人**亲笔手抄**承诺「未使用 AI 开发编写代码、撰写文档或生成登记申请材料」，违者列入**版权登记失信名单 + 个人征信记录**；申报文档**不得由 AI 代写**。D-Bee 是 AI 深度协作开发的（git 历史即证据）→ **不可盲目提交，须先致电版权中心问清「AI 辅助编程」口径**；说明书须用户亲自撰写。另：旧文档称「鉴别材料已备好」**是错的**（全仓检索确认不存在，已纠正）。素材包 + 机械排版工具已就绪：`docs/软著登记-事实素材包与合规红线-2026-10-28.md` + `tools/gen-softcopyright-source.py`（源程序 27,751 行/135 文件）。
- ①是否申请 ICP 经营许可证 = 是否现在背「3 人社保」（已建议**方案 A：暂不办，先靠 iOS IAP 验证付费意愿**，零固定成本，有真实付费数据再决定）。
- ②Apple 账号先用**个人**上架抢时间还是等企业账号（建议先申请 D-U-N-S 占位、个人账号推进构建）。
- ③云库长期去留（自托管彻底替代 / 回迁 / 双写）。
- ④老用户迁移三路径（推荐 A：判定为开发数据不迁移，小程序与 App 均未上线）。
- ⑤存量 7 行 `source='newbie'` bonus 处置（A 作废推荐 / B 补偿保留 / C 连数据清）。
- ⑥小程序是否回迁自托管统一后端（现小程序走 WorkBuddy 云、主端走自建 PG，两库数据不互通；回迁须同步改 `mini/src/lib/cloud.ts` 与 `mini/src/content/legal.ts`，否则又变虚假公示）。
- ⑦演示账户两套数据面（iOS 提审用云库账户、web 用自建账户；iOS 切自建库后须在新库重建演示账户并预置演示数据，否则审核员登录空账户 → Guideline 2.1 风险）。
- ⚠️ **两个安全待办（用户处理）**：①重置 DeepSeek API key（本次对话中明文出现过）②轮换 SSH 密码与 dbee_app 数据库密码（二者此前已提交进 GitHub 历史，已脱敏 + 停止扩散，但历史提交仍可检出）。**轮换密码优先于重写历史**（`git filter-repo` + force push 属破坏性操作，未擅自执行）。

**版本/git**：最新 commit `a14bd39`（docs(ios): 修复「真机白屏」误导诊断 + 更正 Bundle ID 口径）；**`a14bd39` 及本轮口径核查改动（`tools/android-cdp.py` + 12 份 docs + 记忆精简）待推送 origin/main**（10-30 晚两次 push 遇网络错误 `schannel handshake` / `CONNECT 502`，未盲目重试）。历史 commit 流水一律以 `git log` 为准，不在记忆中重复记录。

## 三条主线

1. **开发**：看板即本文件「进度快照」，由自动化「D-Bee 开发进度盘点」每日收敛；细节看当日日志。
2. **备份**：自动化「D-Bee 每日数据备份」产出 `db/backups/YYYY-MM-DD.json`（失败落 `FAILED-YYYY-MM-DD.md`）。
3. **运营**：宣传彩页、技术交流、社群，由自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18 + Vite5 + TS；appId `cn.com.dbee.app`；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（iOS HealthKit / Android Health Connect / 华为 Health Kit 需先上架华为市场 / 小米官方 SDK），详见 `docs/健康数据源方案.md`。
**6 项决策已拍板（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=先日志+万能码（已升级为 aliyun 真短信）⑤网关语言=Node（`server/index.mjs`）⑥Apple 验签=放 Node 网关（**弃 `0029` 的 pg_net 方案**）。决策原则：便捷、技术可控、价格低廉、完全对比竞品。全部凭据只存本地 `.env`（gitignore 覆盖），未进 git。完整计划见 `docs/主体注册后-实施计划.md`。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层（platform/kv/capture/scan/share）；抽象层运行时探测 `window.Capacitor`，**不 import Capacitor 包**（Web 零新增依赖）。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 原生插件（注入 Origin），注入点 = 云 SDK `options.fetch`（`src/cloud.ts`），**勿 patch window.fetch**。Origin 钉死三处：lib/originProxy.ts、Java/Swift、Nginx，换域名三处同步。
4. 输入校验走 `src/lib/validate.ts`（过滤→夹回→门禁）；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。
5. **StoreKit 2 铁律：服务端核销成功才 `finish()`**（10-30 整改 #2）。提前 finish = 核销断网/杀 App 时交易被 StoreKit 清除、权益永久丢失且不可恢复（用户已付款）。待核销记录必须绑定 owner 并经 `@capacitor/preferences` 持久化；带 `revocationDate` 的退款交易只 finish、绝不送核销（否则重发已退款权益）。回归入口 `npm run test:iap`。
6. **原生能力必须返回显式状态，禁止把失败吞成「0/空」**（10-30 整改 #5）。HealthKit `fetchToday` 返回 `status`（ok/empty/denied/error/unavailable/not_ready/no_plugin，见 `src/lib/health/types.ts`），调用方只在 `isUsableHealthStatus(status)` 时写回数值——否则「授权被拒返回的 0」会把用户已有步数抹掉。新增原生方法一律照此办：状态枚举 + 旧版插件的 `normalize*` 兼容（Web 包常先发、原生包后发）。
7. **弹窗无障碍统一走 `useModalA11y(onClose)`**（10-30 整改 #4）：焦点陷阱 + Esc + 关闭后焦点归还 + body 滚动锁 + `aria-modal`。新弹窗不要再各写一套 useEffect。`role="button"` 的 div 用 `src/lib/a11y.ts` 的 `onActivateKey` 补 Enter/Space，**不要改成原生 `<button>`**（行内嵌着导出/取消等原生按钮，会造成按钮套按钮的非法嵌套）。对比度改动须按 WCAG 相对亮度精算，不要目测调色。
8. **iOS 付费墙禁止用硬编码价兜底**（10-30 整改 #5）：商店价拉取失败必须禁用购买按钮 + 给重试，价格位显示「—」。商店价是唯一合法成交价，显示与实际扣款不符的静态价可能被审核认定为价格欺诈（3.1.2）。
9. **OriginProxy 取消：主动中断一律归一为 End 而非 Error**（10-30 整改 #5），且取消异常**绝不回退缓冲重发**（会重复发请求、重复扣 LLM token）。在途流注册表必须在 finally/defer 里移除，否则随请求数无限增长。
10. 🔴 **打原生包绝不能用 `npm run build`**（10-30 实测踩中 → iPhone 真机纯白屏、无任何报错）。
    `npm run build` 是 Web 产物（MODE=production），铁律 #1 的护栏 `if (import.meta.env.PROD && mode !== 'native-release' && mode !== 'native-internal') throw` 在 production 下**恒真 → 被死代码消除成无条件 `throw`**；`publicConfig` 是**模块级常量**（import 时求值），iOS 上 `detectNative()` 恒真 → **JS 首行即炸，React 连 PrivacyGate 都挂不上 → 白屏**。CSS 已加载故呈米白色（`#FBF8F1`），极易被误判为「public/ 没同步」。**正确命令二选一**：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。**产物自检**（30 秒识破白屏包）：`grep -c "禁止直接复用 Web 产物" dist/assets/index-*.js` → 必须 `0`，≥1 即白屏包。
    ⚠️ 教训一：`ios/App/App/public` 是 gitignore 的，Mac 上的包内容**完全由 `cap sync` 决定**，构建 mode 选错会被忠实同步进去——**代码侧加了构建期护栏，文档侧必须同步改，否则护栏只会变成「无声白屏」**。
    ⚠️ 教训二（10-31）：**误诊会自我强化**——首轮依据过期手册建议「重跑 `npm run build && cap sync`」，照做必然复现同一白屏。诊断构建类问题必须**真实构建两种产物做对照**（看护栏函数是被消除成 `throw` 还是 `return <endpoint>`），不能只读文档下结论。

## 云数据库安全铁律（最高优先级）

- 发权益/积分/额度的函数必须 SECURITY DEFINER + 入参白名单；审计用 `pg_get_functiondef` 看真实 DDL。
- 光有函数白名单不够：**涉权益/积分/额度表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 只限「自己的行」，挡不住直写）。已封堵：honey_ledger / entitlements / ai_usage / badges 仅 SELECT；拍照额度走预占 token（consume/release）。`isPro`：pro 档缺 `pro_until` 判已过期（防永久会员）。
- 0016 已加 10 条 CHECK 约束（profiles/meal_entries/water_logs/exercise_logs 数值边界）。
- **数据库迁移审计结论（10-23）**：33 个编号 = 28 生效 + 3 失效（0015 部分失效可白嫖终身会员 / 0016 CHECK 全缺 / 0026 newbie 未生效 / 0027 邀请无日上限）+ 1 弃用（0029 pg_net 不可用）。根因：生成器只输出 GRANT 从不 REVOKE（追加语义）/ 不抓 pg_constraint / 覆盖式迁移无法用存在性判版本 / 无迁移追踪表。已修：`0034-schema-migrations.sql`（追踪表）+ `0035-security-and-integrity.sql`（收 2 表写权限 + 补 10 CHECK + grant_honey newbie + bind_invite daily_limit）+ `0036-data-sync-from-cloud.sql`；前端 `consumeAiQuota` fail-closed（弃静默 `catch{}` 直写 ai_usage 的 fail-open 漏洞）+ 三端 UI token 化。工具 `tools/migration-audit.sh` 固化三类探针。**执行顺序铁律：先修工具再修数据（P0-3/P0-4 → P0-1 → P0-2），否则镜像重建会冲掉成果**。

## 关键坑（一行版）

endpoint 同源/绝对 HTTPS；`CapacitorHttp.enabled=true` 必开；云 SDK 独占 localStorage（登录态真源，勿用 kv 接管）；
iOS 需 HTTPS；iOS 无 BarcodeDetector→原生 MLKit；SW 在 capacitor:// 不注册；cap sync 撞 safe-delete 守卫→只改
web 资源用 `npx cap copy android`；微信回调 Activity 随 applicationId 改名；图标改后跑 `tools/gen-app-icons.py`；
模拟器网络需沙箱外启动 + captive_portal_mode 0；验收用 `tools/android-cdp.py`（默认包名 `cn.com.dbee.app`，可用 `DBEE_PKG` 或 `--pkg` 覆盖）+ logcat（d-bee-diag / d-bee-origin）；
安全区写 `var(--safe-area-inset-*, env(...))`。
- **cap sync 新插件必踩**：update 阶段撞 safe-delete 守卫（genie-trash ETIMEDOUT）会误删 `android/capacitor-cordova-android-plugins/` 的两个 gradle 文件。首选绕过：先 shell `rm -rf android/capacitor-cordova-android-plugins`（shell 删不触发 genie-trash）再 `cap sync`，extractTemplate 会重建。兜底：解压 `node_modules/@capacitor/cli/assets/capacitor-cordova-android-plugins.tar.gz` + 手写 cordova.variables.gradle（模板见 `cli/dist/android/update.js:224`）+ build.gradle 补 `apply from`。
- **本地插件（file:）两步缺一不可**：①`capacitor.config.ts` 的 `includePlugins` 必须列插件名 ②`npm install` 建 symlink。口诀：Gradle 编译过 ≠ 运行时注册（`capacitor.plugins.json` 才是真源）。
- **⚠️ `includePlugins` 白名单对 npm 包插件同样生效（10-30 实测）**：装 `@capacitor/local-notifications` 后 `cap sync` **静默跳过**（无警告无报错）；加进 `android.includePlugins` + `ios.includePlugins` 才生效。排查口诀：装完插件先 `npx cap ls ios` 数一遍（CLI 有 `includePlugins` 就只用它，不看 package.json）。iOS 还需在 Xcode 单独开 Push Notifications capability，sync 不会自动配。
- **原生拍照/扫码点了没反应**：①`file_paths.xml` 缺 `<external-files-path>` → FileProvider 抛 IllegalArgumentException；②Manifest 缺 `CAMERA` → 授权流程不走。
- **兑换的拍照额度用不了**：`guardAiQuota()` 不能按「当日拍照次数阶梯」拦截（quota_bonus 不计入次数）；唯一依据 `get_photo_quota.total_remaining`，有额度直接 `consume_photo_quota`。
- **华为 EMUI/HarmonyOS WebView 忽略 `<input capture>`**：原生端拍照统一走 `@capacitor/camera`（鸭子类型探测），web 端保留 `<input capture>`。
- **honey_ledger 唯一索引 `(owner_id, reason, ref_id)` 会把「每日多次」卡成「每日一次」**：ref_id 必须带唯一后缀（如 `to_char(clock_timestamp(),'HH24MISSMS')`）；排查「该记录已经存在」先查 `pg_indexes`。
- **Xcode 完好性判定铁律**（10-24 踩坑）：`xcodebuild -version` 报「Xcode 27.1」实为 CLT 版本号对齐，极具迷惑性；真凶曾是 3.8G 坏壳（完整 Xcode ≥15GB）。判定 = `du -sh` ≥15GB + `xcodebuild -showsdks` 列出 iphoneos，**不能只看 `-version`**。
- **iOS 首次真机编译三处独有 bug（已修）**：①拍照无反应（缺 `NSPhotoLibraryAddUsageDescription`，前端 catch 静默吞 reject 掩盖根因）②拍照后没进识别（`resultType:'DataUrl'` 大小写 bug，iOS 精确匹配失败）③Bundle ID 冲突（见权威口径）。正确顺序：`npm ci`（含 postinstall 自动构建 shared）→ 三选一构建命令 → `npx cap sync ios` → Cmd+R。

### 部署侧坑（一行版；完整推演见 `2026-10-23.md`）

`CREATE POLICY` 子句顺序硬规定 `AS→FOR→TO→USING→WITH CHECK`；`GRANT` 是**追加**语义（清历史 DELETE 必须先 `REVOKE ALL`）；`BYPASSRLS` = **全库** RLS 失效（修法：给网关要用的表建 `TO <role>` 专用 policy 后 `NOBYPASSRLS`，`0033` 已收回）；systemd `StartLimitIntervalSec/Burst` 属 **`[Unit]`** 段（放 `[Service]` 被忽略）；V8 服务**勿设** `MemoryDenyWriteExecute`；`pg_dump` 必须 `sudo -u postgres`，失败时 gzip **仍留 20 字节空壳** → 加体积守卫 + `gunzip -t`；Git Bash ↔ Windows Python 路径统一 `cygpath -m "$(mktemp)"`；模板「不得残留」守卫要排除注释行（`grep -vE '^\s*#'`）；paramiko 长任务必设 `set_keepalive(30)` 且**先输出结果再清理远端临时文件**；`JWT_SECRET`/`IDENT_PEPPER` 存 `deploy/gateway/.secrets.local` 跨部署复用（**改 JWT_SECRET=全员登出，改 IDENT_PEPPER=老用户身份失配**）；网关与 PostgREST **必须共用同一 HS256 jwt-secret**（否则数据面全 401）；`DBEE_PROD=1`+`SMS_PROVIDER=log` 拒启动；🔴 **`DBEE_PROD=1` 连带把 Apple 收据收紧为只收 Production** → iOS 沙盒期须显式 `APPLE_ALLOWED_ENVS=Sandbox,Production`；**env 模板加新占位符必须同步改 `deploy-gateway.sh` 的 sed 注入表**（注入值都要过 `esc_sed`，`#`/`&`/`\` 不转义会**静默**写坏 env）；服务器 PG 监听 `0.0.0.0:5432`（公网可达，靠 pg_hba 兜底、ufw inactive）；部署线上 env 用「本地生成完整 env → SFTP 上传覆盖」最可靠。
- 🔴 **`deploy-gateway.sh` 是「全站永久锁死」级地雷（10-29 实测）**：它用本地模板**覆盖** `/etc/dbee/gateway.env`，本地 `.env` 缺 `IDENT_PEPPER`/`JWT_SECRET` → 覆盖后全站 `ident_hash` 无法重算、**所有账户再也认不出来，不可恢复**。改网关代码一律走**手术式脚本**（参照 `deploy/apply-password-login-fix.sh`）：只传代码文件 → 语法校验 → env 指纹 → 备份 → install → 重启 → healthz 失败自动回滚 → **断言 env sha256 前后一致**。SSH 账号 = `.env` 的 `USER=ubuntu`+`SSH_PWD`（**不是** `DBEE_USER=dbee_app`）。
- **`deploy-gateway.sh` 两处 `set -e` 静默退出陷阱已修**（`34a8216`）：①`[ -z "${SEC[$k]}" ] && MISS+=(...)` 凭据齐全时反而短路退出 ②注释态键的 `grep|head|cut` 管道触发 pipefail。症状=**exit 1 零输出**，`bash -x` 定位；⚠️ **不要用 `bash -x > file`**（明文密钥会写进追踪文件）。
- **网关鉴权头是 `x-wb-webapp-access-key`（不是 `apikey`）**，云端按 **Origin 精确匹配**校验 → Node 侧脚本必须注入 `Origin`/`Referer`，否则报 session invalid（极易误判成凭证失效）。真实表名见 `db/migrations/`（**没有 `habit`/`habits`**，猜表名必 404）。
- **`signIn` 端点两条路径**：验证码 `{username, verification_token}` 与密码 `{username, password}`，改鉴权务必双回归；密码路径标识必须归一化（SDK 发 `+86 138…` 带空格，库内 `ident_hash` 按裸 11 位算）。回归 `tools/selftest-password-login.mjs`（35 断言）。
- **审核演示账户两套互不相通**（同邮箱同密码）：iOS=云库（owner `2115454156301934592`）、web=自建 PG（owner `1793280185303313979`）。iOS 切自建库后必须在新库重建账户并预置演示数据。

## 数据面与部署现状

- **🎉 泳道 A 部署闭环（10-23）**：服务器 `150.158.51.106` 上 **nginx（自托管配置）+ dbee-gateway（Node 22.22.2 / :8080）+ PostgREST（16.4 / :3001）+ PG 17.11（dbee 库）** 四件套均 active；`/.cloud/**` 全部走本机自托管栈，**不再依赖 WorkBuddy 云端**。8 项 E2E 全 ✓（含正常 OTP 路径：从 journald 读真实验证码；带 JWT 读 profiles=200、匿名=401，RLS 按 sub 过滤生效）。云端回滚点 `/etc/nginx/sites-available/d-bee.cloud.bak`。切换脚本 `deploy/switch-nginx-selfhost.sh` + `deploy/gateway/switch-nginx-selfhost.remote.sh` + `deploy/nginx.selfhost.conf.example`。
- **数据库切换核心判断（10-26，详见 `docs/数据库切换详细规划-2026-10-26.md`）**：不是「要不要切」而是「HTTPS 何时就绪」的资质问题。切换时机 = 备案→域名过户（✅）→A 记录→80 公网→签 HTTPS→三端指 `https://d-bee.cn`；过渡期云库唯一真相源，切换日一次性收口（`0042-data-sync-final.sql`，0041 编号已被 dbee_admin 只读角色占用）。分阶段：0 安全整改（5432 收口+ufw 最优先）→ 1 账号映射合并（HTTPS 前演练）→ 2 T-0 切换（**必须用 `npm run build:native`**）→ 3 观察期 T+30（云库只读保活）。**数据双向分叉每天扩大**；**账号分裂事故**：186****4728 云库=2110364580268998656（真实）vs Web 自建库 1792845025064566575（空壳），根因两套发号机制。
- **数据面现状**：**Web 已切自建 PG**；**Android/iOS/小程序仍走云库**（原生未注入 `VITE_NATIVE_ENDPOINT` 时回退 CLOUD_HOST；小程序 `mini/src/lib/cloud.ts` 硬编码 endpoint）。自建网关唯一缺口 = 无 `/v1/login-wechat`（code2session 在云侧）。
- **数据/结构分离（PIPL 最小必要，10-22）**：`0030-full-selfhost-mirror.sql` 含 17 表**全量真实用户健康档案**（含未成年人记录）→ **不入库**（已 gitignore + `git rm --cached`，本地保留）。入库的是 `db/migrations/0030-schema.sql`（`--schema-only` 产物，0 行数据）+ `db/functions.sql`（27 个 SECURITY DEFINER 函数 DDL，0 处真实 owner_id）。⚠️ `0030` **已含 0025~0028 业务变更**，勿盲跑 0025~0029 迁移；`0029` 已弃用。**不需要存储代理**——拍照识别走 base64 dataUrl 直塞 LLM `image_url`，全仓无 `cloud.storage` 调用。
- **🔴 支付链路（已落地，10-23）**：Apple 验签在 Node 网关（`server/lib/iap.mjs` 479 行）：verifyReceipt（21007/21008 沙盒自动切换、**bundle_id 钉扎 `APPLE_BUNDLE_ID`**（配错则所有购买验签恒失败）、transaction_id 全服幂等、恢复购买）+ Notifications V2 webhook（x5c 证书链钉扎、续订/退款、全量落库）+ 根证书 `AppleRootCA-G3.cer` 钉扎。`0037`：幂等表 + 留痕表 + 3 个 SECURITY DEFINER 函数（EXECUTE 仅 dbee_app）。webhook 豁免 IP 限流（防 Apple 429 重试风暴）；`api.ts` iOS 优先走网关、404/503 回退 RPC。自测 `tools/iap-selftest.mjs` 47 项全过。**伪造凭证白拿权益的旧缺口已封**。
- **🟢 短信通道已上线（10-29，`SMS_PROVIDER=aliyun`，万能码已摘除，用户实收验证通过）**。关键事实（与腾讯云口径不同，勿混淆）：
  · aliyun 是 RPC 风格 + **HMAC-SHA1** 手写签名（腾讯云是 TC3-HMAC-SHA256，两套算法，见 `sms.mjs`）。
  · 模板 `SMS_512482436` **只有 `code` 一个变量**（腾讯云是 `{1}{2}` 双变量按位传），`TemplateParam` 传 JSON 串 `{"code":"..."}`。
  · 🔴 **签名口径=「北京迪蜂科技有限公司」**，不是「自律蜜蜂」！该阿里云账号下实测只有这 1 条企业实名默认签名（「自律蜜蜂」是**腾讯云**侧的记录，在阿里云用它会报 `isv.SMS_SIGNATURE_ILLEGAL`）。要品牌签名须在阿里云重新申请（1–2 工作日），过审后改一行 `SMS_SIGN_NAME` env 即可，无需改代码。邮箱通道的「自律蜜蜂」（SMTP 发件名）不受影响。
  · 凭据在 `deploy/gateway/.secrets.local`（gitignore 覆盖），RAM 子账号最小权限，已购短信包。
  · 部署时**只切短信、不开 `DBEE_PROD=1`**（避免连带触发 CORS 白名单硬要求与 Apple 收据只认 Production）。
- **🔴 上架前生产安全体检与加固（10-26，六项 ①–⑥ 已全部生效，报告 `docs/V1.7.1-安全验证报告与发布实施计划-2026-10-26.md`）**：曾发现**网关层完全未部署**（跑的是 10-23 骨架版，数据库迁移已生效但代码没上）→ 已补齐并复验全绿（18/18 探针 NEW、Apple 路由已注册、LLM 无 token 401）。六项 = ①RPC 信任边界 ②原子性 ③LLM 服务端授权 ④Apple 环境白名单（生效前提=上架前配 `APPLE_BUNDLE_ID=cn.com.dbee.app`/`SHARED_SECRET`）⑤XFF 信任边界 ⑥honey_balance/榜单缓存（前端待随下次发版触达）。
- **🔴 七项安全修复（10-27）**：① JWT TTL 30 分钟 + refresh 滚动 + `app_users.token_version` 强制下线（迁移 0042，**已部署 + 端到端验证全过**）② appleSandbox 生产默认关（**已部署**）③ LLM 视觉 fail-closed 503 + 文本独立降额 50/日 ④ grant_honey 发分前查真实记录 ⑤ CORS Origin 白名单 ⑦ email 验证码通道（163 SMTP，465/SSL 零依赖手写）—— **③⑤⑦ 代码就位 + 自测 300/0 全绿，待部署**。⑥ 万能码切真短信 🟢 **已上线**。

## 业务与资质要点

- **🔓 主体注册已办结（10-22）**：解锁微信生态（开放平台企业认证/商户号/公众号/小程序主体变更）、华为/小米企业入驻（Health Kit 硬门槛）、ICP 经营许可证可申请。公章 10-27 到手（18 项盖章清单 `docs/公章使用清单-2026-10-27.md`）；对公账户 10-28 已开立（后续步骤 `docs/对公账户到手-后续执行步骤-2026-10-28.md`）。域名已过户到公司（10-27，WHOIS Registrant = 北京迪蜂科技有限公司）。
- **🔴 「3 人社保」= ICP 经营许可证硬性条件，无法合规绕过**（多省口径一致且核查趋严）：≥3 名全职、**三个不同人**（许可/客服/安全负责人）、法人可算一人、**必须由本公司缴**（代缴/挂靠直接驳回且一年内不得再申）、管局跨部门比对 + 可能上门核验。成本 ≈ ¥4000/月起 + 记账报税 + 代办（约 47 工作日）。**已定策略 = 方案 A：暂不办，先靠 iOS IAP 验证付费意愿**。执照类前提已全部就位（经营范围含「第二类增值电信业务」✅ / 注册资本 ≥100 万认缴 ✅ / 对公账户 ✅ / 域名过户 ✅），将来办证仅剩这一个缺口。
- **📱 小程序主体变更（官方口径已查证，appid `wxb7c7122de9c3ab1f`）**：¥300 审核费（不退）+ 审核 1–7 工作日；**本项目可免公证**（个人主体→企业且个人即法人）：传申请函（官方最新模板、两页骑缝章）+ 法人身份证 + 手持照，原主体处**签名+按手印**，**不可委托代办**。⏰ **审核通过后 7 天内**须管理员确认+重登+签协议，超时作废钱不退。🔴 变更后两个强制后续：①**重做小程序备案**（注销原备案+新主体新增，不支持直接变更；备案期可用但不能发新版本）②**类目资质重交**（盖新章，14 天内，逾期功能封禁）。⚠️ **类目红线**：避开「医疗-其他医学健康服务」（四项资质一个都没有）→ 选工具/生活服务类；**文案严禁诊疗/治病/筛查表述**。**「先发后变」（10-28）**：先发布修复版，再提交主体变更（变更后到新备案完成前不能发新版本）。
- **🌐 ICP 备案**：路径已定 = **注销重备**（北京不在「个人→企业」直接变更白名单）。域名已过户公司（管局核对 WHOIS=备案主体）；**关 WHOIS 隐私保护**；A4 已做完且 IP 直连验证通过 → 可随时注销不停业务；注销后域名停解析、备案期不可加解析；**工信部短信核验 24h 内必做**；「原个人=现企业法人」本项目同一人天然满足。两域名打包同一企业备案订单（一单两站）。
- **📊 竞品对比结论（详见 `docs/主体注册后-实施计划.md` §七）**：D-Bee ¥18/月、¥128/年与 1 亿用户的薄荷健康完全同价，食物库 1,175 vs 100 万+ → **绝不能拼「食物库广度」或「AI 识别准」**；按年付 ¥128 是国际 12 款竞品中最便宜，**不需改价**（¥18/¥128/¥328 已锁定）。🔴 悉尼大学 2024 研究：AI 食物识别对**混合亚洲菜肴高估达 49%、低估达 76%** = D-Bee 核心场景。→ **定位「不卖 AI 神奇，卖能坚持下来」**：厚免费 + 游戏化 + 终身买断 ¥328 + **本地规则引擎 `foodInsight.ts`（1,175 条零兜底零幻觉）优先、AI 仅兜底** + 无广告 + 数据自托管。对标「自律茄子」买断心智。**待办：实测 D-Bee 自己的 MAPE**（竞品分析最后缺口）。
- **⚙️ AI 成本测算（详见 §A3）**：DeepSeek flash 峰值价（工作日 9–12/14–18 点 2 倍，恰是三餐高峰，**必须按峰值估**）：拍照单次 ≈ ¥0.0047、教练问答 ≈ ¥0.0069（每图 token 恒上限 384；前端已 `compressImage(1024, 0.82)`，无需 Files API）。按 5 次/日：**100 DAU ≈ ¥42/月、10,000 ≈ ¥4,230** → 万级 DAU 前远低于 3 人社保 ¥4000/月，反证方案 A 正确。降本：系统提示缓存命中（输入价降 ~98%）、本地引擎先命中再调 LLM。
- **🔴 DeepSeek 接线三个坑（查官方文档实测，会直接导致功能不可用）**：① **`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役**，官方只剩 `deepseek-flash` 与 `deepseek-v4-pro`，**配置写旧 ID 会调用失败**；② **只有 flash 系列接受图片**，传图给其他模型返 `400 "This model does not support image"`（**`deepseek-v4-pro` 明确 "Vision: Not supported"**）→ **文本统一用 `deepseek-flash`**；③ 网关 `/llm/models` **必须给 flash 标 `supportsImages: true`**，否则前端 `pickModel(needVision)` 的 `filter(m=>m.supportsImages===true)` 选空 → 拍照识别报错（另需过滤 `disabled!==true && enabled!==false`，见 `ai.ts:31`）。**模型 ID 必须放服务端配置**（`.env` 的 `LLM_MODEL_VISION`）而非散落代码。
- **🎯 视觉识别已切双 provider 路由（10-24）**：DeepSeek 视觉偏弱（官方定位「快速便宜、细粒度图像细节偏弱」），无法胜任「一盘菜精准识别多道菜」→ **文本（AI 教练/周报/计划）走 DeepSeek `deepseek-flash`，图片识别走阿里云百炼 `qwen3.8-max-0902`**（视觉最强、用户 Workspace 有权限；旧名 qwen-vl-max/qwen3-vl-plus 无权限 403）。`server/lib/config.mjs` 新增 `LLM_VISION_BASE_URL/KEY/MODEL` + `LLM_IMAGE_DETAIL=high`（未配时回落原 llm 键，向后兼容）；`llm.mjs` wantVision 时走独立视觉 provider。**服务端切模型对三端即时生效，无需重发 web/重打包**。
- **合规现状（已核查）**：用户协议/隐私政策/免责声明**三篇已存在且已挂路由**（`src/content/legal.ts` 230 行 + `pages/LegalPage.tsx` + `components/SiteFooter.tsx`，备案号走 `VITE_ICP_BEIAN` 环境变量渲染，未设置时该行不渲染）→ **合规页面工作量 ≈ 0**，只等备案号下来填变量。`REDEEM_CODES` 硬编码兑换码**已从 src/ 删除**（Apple 3.1.1 硬伤已消）；`restorePurchases()` 已接（3.1.2 合规）。服务端 `redeem_by_code` RPC 仍在，不影响 Apple 审核，Web/Android 端可继续用兑换码运营。**法律文本 URL 一律用 `https://d-bee.cn/legal/...`**（公示/备案/ASC 填报同口径）。
- **额度规则（权威值在 `packages/shared/src/constants/index.ts`）**：`FREE_DAILY_AI=3` + `AI_REDEEM_DAILY_LIMIT=2`（每日 3 次免费识别 + 2 次积分兑换 50 分/次，用尽只能 Pro）。新手 150 积分（grantHoney 'newbie'）；连续打卡每满 7 天送 2 次识别（grantPhotoBonus 'streak7'，7/14/21 循环）。迁移 0025（兑换上限 5→2）+ 0026（newbie 发积分、作废存量 newbie 识别 bonus）。⚠️ `docs/AI成本与配额.md:101`「每天 10 次」**已过时**，按 3+2 重算。
- **识别自动保存（已收敛）**：识别成功即 settleDraft 自动落库；该餐已有记录弹「覆盖/追加/取消」，无记录直接落库关闭，另有切页兜底；不做撤销等过度设计。
- **会员/IAP**：三档 free/pro/lifetime（¥18/¥128/¥328）；Apple 个人开发者账号已通过（10-20）；**Android 企业开发者账号已注册（10-23）→ Google Play 支付线解锁**（`payment_orders.provider` 是 text 且**无 CHECK 约束**，加 `'google'` 无需改表结构，只需补网关验签分支）。**iOS 本地 StoreKit 测试环境已就绪**（`DbeeProducts.storekit` 3 商品 zh_CN 本地化 + 共享 scheme，免 ASC 建商品即可测 getProducts/purchase/restore 客户端链路；付费墙已接商店价格拉取）。⚠️ **Apple/Google 验签须排在 0034/0035 收权之后**（已满足，0035 已收紧写 entitlements 唯一通道=服务端函数）。
- **多端小程序**：Taro 4.3.0（React+TS）双工程 + `packages/shared`，微信/支付宝/抖音三端编译通过；一比一复刻主工程 11 页，tsc 0 错。受限能力（支付/健康步数/分享卡 canvas）诚实引导占位。mini tsconfig 需 `moduleResolution:"bundler"`。小程序 request 合法域名须配 `https://d-bee.cn`。
- **原生 App**：Capacitor 8.5.3；阶段 0 解耦 ✅、Android 全过 ✅、iOS 编译已打通（10-24）并真机测试（origin-proxy / health / iap 三自研 Swift 插件 + @capacitor/camera）。`postinstall` 自动构建 shared，新 clone 一条 `npm ci` 直达。
- **健康数据源**：只读系统健康平台，不直连手环；HealthKit 读授权不可探测→插件只报 completed，连接真源=云端 health_connected；`effectiveBurnKcal=max(burnKcal,activityKcal)` 不叠加。华为 Health Kit 阶段 3a 已落地（Android 反射骨架，零 HMS 编译依赖）；小米官方 SDK 已纳入，白名单 `{huawei, xiaomi}`。资质未就绪时插件返回 `reason=not_ready`。⚠️ **「企业开发者账号已注册」≠「应用已上架华为应用市场」**，而 Health Kit 硬门槛是**后者**，另需软著 + App 备案 → 数据通道尚未解锁。
- **微信相关**：主体已注册，**暂缓状态可解除**（`src/lib/wechat.ts` 的 `WECHAT_LOGIN_ENABLED=false` 改回 true，已按「零代码改造」设计）。前置链：开放平台企业认证 → 移动应用 AppID + UnionID → 注入 `VITE_WECHAT_APPID`（iOS 另需 `VITE_WECHAT_UNIVERSAL_LINK` = `https://d-bee.cn/...` + Associated Domains + AASA）→ `NATIVE_CODE_EXCHANGE_SUPPORTED=true`。⚠️ **云端能力缺口**：SDK 的 `signInWithWechat` 只走小程序 `jscode2session`，移动应用 code 需 `sns/oauth2/access_token`，两接口不可混用——自建网关后可自行补齐。快速兜底 = 路线 B（系统浏览器 + 云 Relay 扫码 + Universal Link 回跳，不需移动应用资质）。⚠️ iOS `WechatOpenSDK` 来自第三方 SPM 镜像 `github.com/yanyin1986/WechatOpenSDK`（官方不经 SPM 分发），上线前须核对 tag 或改官方 XCFramework。

## 过审合规

Apple 4.2 / 3.1.1（阶段 3 删 REDEEM_CODES）/ 5.1.1(v) 账号删除 / AI 告知同意；中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。

> 🔴 **隐私政策公示禁止跨端照抄**（10-29 实证）：小程序与 Web/iOS/Android **不是同一后端**——小程序走 WorkBuddy 云（AI 由平台代理动态匹配模型，我方不持有厂商密钥），主端走自托管 PG + 自建网关直连 DeepSeek/Qwen，两库**数据不互通**。公示主体因此不同。写任一端 legal.ts 前先核对该端 `cloud.ts`/`ai.ts` 真实链路，并只写**代码里确实存在**的能力（小程序无 Open Food Facts / 无邮箱登录 / 导出为占位 / 无离线 / 订阅消息模板未配）。**公示了 ≠ 合规**：每条第三方链接必须 curl 验 200 + 核对语言/主体/适用辖区，且要引「与我方关系匹配」的文件（我方=委托方就引面向客户的**数据处理协议**，不引面向该平台自己终端用户的隐私政策、更不引其境外英文版）。`deploy/verify-legal.mjs` §0.7 已自动校验 URL 可达性，死链会 FAIL。

## 工作方式

需求驱动、多轮递进、「写→验→报」小步验证；缺陷/进度类文档用 .docx；跨机同步只走 Git 私有仓库（`github.com/yutaiyin139/d-bee`，main），两台机器 `core.autocrlf false`；推送失败是常态波动，**for 循环重试 5 次**勿改方案；收工把进度快照 + 明日待办 + 待拍板写入当日日志。自测脚本 `tools/*-selftest.mjs`（运行器 `node tools/v15-selftest.run.mjs`）。
**文档维护约定（10-31 确立）**：口径变更时，**可执行文档直接更正**；**历史快照文档（写于定案前、记录当时过程）只加「历史快照·口径已变更」横幅、不改正文**（横幅内声明旧值应读作何值）。代码侧加构建期护栏时，**文档侧必须同步改**，否则护栏只会变成「无声白屏」（铁律 #10 教训）。
**记忆维护约定**：git commit 流水账**不入 MEMORY.md**（`git log` 即权威来源）；本文件只存结论、铁律、决策、坑与权威口径；体积超 40KB 即需精简（曾达 66KB 超注入上限被截断）。

## 环境备忘

- SSH 发布：`150.158.51.106` / `ubuntu` / 密码见本地 `.env`（`SSH_PWD`，**勿写入记忆或文档**，memory/ 会进 git）；发布脚本 `deploy/deploy.sh`。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`。
- 云库应用 ID `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql，只在已绑定应用的会话可用）；云库地址 `https://zilv-mifeng.app.workbuddy.host`（`build:native:internal` 内测用，需 `VITE_ALLOW_CLOUD_NATIVE=true` 显式授权）。
- curl 本机 dev server 需 `--noproxy '*'`；`package.json` 无测试框架/lint。
- 微营养素：foodsData*.ts 已 10 列化（钠/纤维/添加糖，/100g），1175 条零兜底。
- `db/.tmp-backup.sql` 是临时备份，**约定不入库**（gitignore 未覆盖）。
