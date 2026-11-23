# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **详版全在 `REFERENCE.md`**；本文件只留决策、铁律与指针。🔴 **≤12k 字符**（决策⑨：原 9k 于 11-22 20:26 经用户拍板提到 12k），超限归档进 REF（11-22 重建版**全文逐字**→REF「**2026-11-22 18:20 迁入**」）。状态默认保守态；**勿写死哈希与「待推 N 个」**。
> 🔴🔴 **「细节不进 MEMORY」纪律（决策⑨核心，比上限更重要）**：任何超过一行的细节（实测台账、行号表、命令输出、逐条证据、事故复盘）**第一次就直接逐字写进 `REFERENCE.md` 或当日日日志**，MEMORY 只留一行结论+指针。**禁止「先写进 MEMORY 再压缩」**——11-22 那次 13 轮压缩（12788→8975）就是反面教材。上限只是兜底闸门，不是日常工作面。
> 🔴 协作：不乱增复杂度，决策先征求同意（尤其生产变更）；同一任务只在单会话。🔴 **删文件先评估+等确认**（全授权不豁免）。

## 权威口径（勿再改动；逐字→REF「11-18 17:30 迁入」）

- **Bundle ID `cn.com.dbee.app`**（两端同值）；**版本 1.7.9**（Android vc31 / iOS build 12）。🔴 **版本号单一真相源 = 根 `package.json`**（经 `__APP_VERSION__` 注入 Web+mini）；发版须**六处统一**（package.json / android build.gradle / ios pbxproj `MARKETING_VERSION`×2 / mini config 与 four-end-consistency 注释）。
- **域名**：`d-bee.cn`=自律蜜蜂 Web（隐私政策/webhook/Universal Link/原生 endpoint）；`d-bee.com.cn`=公司官网（开放平台填它）。
- 🟢 **ICP 已下证**：`-1`=官网、`-2`=自律蜜蜂；🟢 **App 备案（11-18）`-3A`**。🔴 生效代码**任何位置不得出现 `-1`**；真相源=`packages/shared`；🔴 App 备案**仅原生壳 `isNative()` 门控渲染**；🔴 公安备案 **2026-12-06 截止**（`POLICE_BEIAN` 仍空＝合规）；🟠 小程序/算法备案审核中（硬阻断 mini 发版+虚拟支付）。🔴 **公示信息不得只放 `.env`**。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。🔴 与 web **共用 `dist/`** 且两者都**删 `dist/legal/`**（OPPO 硬要求）→ **部署 web 前必重跑 `npm run build`**；**自检以 `index.html` 引用的入口 js 为唯一真源**。
- 🔴🔴 **铁律 #13：「已完成」必附生产侧实测证据**；**本地绿 ≠ 线上绿**（隔提交→构建→部署）。取证 5 法→REF。
- 🔴🔴 **写库字段必须对齐生产库列**：改 patch 先对 `information_schema.columns`；加列后必 `NOTIFY pgrst, 'reload schema'`。🔴 用户报「服务版本不匹配」**不是前端版本问题**，是 schema cache / function 不存在（PGRST204）。

## 现状（11-23·🟢vc31 已上线 public_site·待真机·须重打 vc32；证据→`2026-11-23.md`）

- 🟢🟢 **Android vc31 已正式公开分发（11-23 11:00）**：`https://d-bee.cn/download/` 200 + 双备案号（-3A/-2）+ 中文名；APK 200/9800369 B/octet-stream/服务器+端到端 sha256 `59139461…ab81` 逐字一致；基线 `status=published`/`channel=public_site`；护栏 30 复跑 48/48 绿。🔴 真机验证仍欠账（用户从分发页安装→四端实证）。全程+事故复盘→`2026-11-23.md` 11:00。
- 🟢🟢 **收费链 B2+B3 已上生产（11-23 14:08，公网独立复测）**：0046→0047 迁移 applied（顺序/RLS/权限/回归守卫全绿，备份 `/var/backups/dbee/backup-before-0046-0047-20261123-135136.dump`）；网关 **5 文件**（新增 apppay/xpay/wechatSession + 替换 app/config）部署成功，`apppay/prepay` **404→503**、`alipay/notify` 200+failure、`gateway.env` sha 未变、服务 active、门禁 1554 绿。🔴 **B8 三键仍空＝还不能收钱**（卡 B7 支付宝资质，只有用户能办）；B9 vc32/B10/B11 真机仍待。🔴 首轮曾「假绿」＝rollback 缺 exit + notify 误套 503（坑㉓㉔，详→`2026-11-23.md` 14:08）。
- 🔴🔴 **生产状态**：0052~0055 全 applied；Web 入口 `index-CIf_RcMj.js`；四服务 `NRestarts=0`；`/legal/*` 200×3；`apple/verify` → **503 `iap_not_configured`**（＝`APPLE_*` 未配；配好后应变「参数错误」＝env 生效唯一判据）。门禁 **32 文件/1554 项**全绿。
- 🔴🔴 **vc31 零真机验证**（华为/小米/mini/werun＝铁律 #13 最优先，Runbook 已备）。交付明细（`9800369 B`/`appBeian=issued`/软著 **submitted**/`253a942` 改名 3 处含 `capacitor.config.ts:26`，已 push）→`2026-11-19.md`。
- 🔴🔴 **iOS 提审三层**（全矩阵→docs §二）：**层1 TestFlight** 分水岭＝**M0 Xcode 真伪**（`xcodebuild -showsdks|grep -i ios` 须列 iphoneos SDK + `du -sh` ≥15GB；10-24 CLT 假壳缺 `xcrun`）。**层2 提交审核**＝ASC 3 商品（`dbee_lifetime` **¥298 非 ¥328**、必须 **Non-Consumable**、🔴ID 永久不可改）+ 隐私标签 + 年龄分级 + 🔴🔴**AIGC 两项必填＝新 App 须立即提交**（非 2027-01-31 宽限档）。**层3 中国区上架收费** 3–6+ 月，最长边＝**第三方（DeepSeek/阿里云百炼）盖章合作协议**；🔴**AIGC 表2 依赖公安平台记录 → 公安备案是其前置**。
- 🔴 **iOS 产物侧仍缺 3 项**（🟢Team ID `96BW23KM2C` 11-22 已落 pbxproj:311,335；✅14 项过→docs §3.2）：`CODE_SIGN_IDENTITY="iPhone Developer"`（不能分发，待 Mac 实机验）、壳内 `public/legal/` 缺（须 Mac `build:native`+`cap sync`）、🔴**0056 运行时未经真库验证**。
- 🔴 **11-20 拍板 4 项已执行**（分发工具链+护栏 30／APK 归档清理／`@dbee/alipay`·`DbeeAlipay`·护栏 20-I；详版→`2026-11-20.md`）。**仍生效**：🔴**须重打 vc32**——走 `npm run native:sync`（**不是** `assembleRelease`：`cap sync` 把 Web 版 `dist/` 拷进 `assets/public`＝不可分发）→ 基线 → 护栏 30-A → 真机；🔴**支付宝仍不可收款**（需商户号+`ALIPAY_*`+`D_BEE_APPPAY_ENABLED`+沙箱联调，未就绪→诚实降级）；🟢`--apply` 已于 11-23 执行成功（见现状节首行）。
- 🔴🔴 **Android 健康链路三块已修**（详版→REF「11-18 17:17」「11-19 10:55」）：最易复踩＝**`aggregate()` 非 `readRecords()`**、**`@ActivityCallback` 必须 2 参**、🔴**禁 `Promise.race`**、🔴**品牌文案中性化**（华为字样＝资质驳回理由）、轮询 `live:false` 防 **45011**。
- 🔴🔴 **收费权威文档（11-19→REF §八/§九）**：🔴**「上线就绪」≠「收费就绪」不可互推**（Web 永久不收费）｜🔴生产 `config.mjs` 未升级→填 env 无效、未调 `saveSessionKey()`→mini 必失败｜🔴**D-11 未闭合**（基线水位 `"0048"` 实 **0055**→护栏 19-B 与生产相反）｜🔴seed `dbee_lifetime` 仍 32800。
- 🔴 **11-21 AIGC 研究**（→`2026-11-21.md`）：GB 45438 强制标识／GB-T 45654 安评；🔴 AI 问答＝合规敞口、隐式标识（`AIGC` 7 键）两端 0 命中待落地；✅ 显式标识已落地（`buildAigcLabeling()`）。
- 🔴 **剩余边界**：mini 导出/通知 + werun；🔴🔴构建只落 `mini/dist`、禁再建 `prebuild-*`；🔴**未 commit（11-22 实测 43 项，本机唯一副本）**。
- 🔴🔴 **四条既有铁律（全文→REF）**：①**收款**＝开关默认 false / `settling` **绝不报 error** / **发权益权威信号＝验签回调 `settle_app_payment`**。②**兑换码 0048**＝护栏**永不写明文** / **绝不调 `redeem_by_code`**（真烧码）。③**`psql`/脚本六铁律**＝变更类禁 `2>/dev/null` / 探针**不打印真实 uid** / `SUDO()` **不吞 stderr**。④**写 SQL 前必核列名**（`schema_migrations`→`version` 非 `id`）。
- 🔴 **工具坑 5–18**（逐字→REF「11-18/19/20 迁入」）：最危险＝⑫红验证必先跑**无变异对照组** ⑬变异锚点必 assert **命中恰 1** ⑭**手搭 classpath `javac` 假绿，只认真 Gradle**；⑤–⑪⑮–⑱→REF。
- 🔴🔴 **工具坑 19–21（详版→REF「2026-11-22 18:20 迁入」）**：⑲**绝不用 `io.open(path,'w')` 读改写既有文件**（`'w'` 即截断，异常留空文件）→追加用 `'a'`/Write/Edit。⑳**Write/Read/Edit 的 FS 视图 ≠ 真实 Windows FS**（`Test-Path` 实测目录不存在、`node` 空输出）→**凡「本地环境/真库验证」结论必须用 bash/PowerShell 二次确认产物存在且输出非空；工具返回成功 ≠ 真实发生**；同理 **grep 命中 ≠ 结构存在**（plist/XML 须用解析器判定）。㉑**`git checkout HEAD -- <未提交文件>` = 覆盖式删除**→**未提交的记忆/文档禁用 checkout 回退**，改用「读 REF/日日志逐字归档 + 单次 Write 重建」。㉒**Git Bash 传 POSIX 远端路径给 Windows 原生 exe（env/argv）必被 MSYS 静默转换**（`/var/www/…`→`C:/…/PortableGit/var/www/…`，SFTP 当相对路径写进 home 垃圾树；「上传 sha 绿、HTTP 验证红」＝路径分裂指纹）→哨兵前缀 `RDIR@@` + 接收端剥除并硬校验 `startswith("/")`（11-23 发布事故实证→`2026-11-23.md` 11:00）。
- 🔴🔴 **审计发现（→`2026-11-16.md`）**：`REFERENCE.md` 含 `SMS_MASTER_CODE` 真实值→**应轮换待拍板**；0046/0047 生产漂移刻意未夹带；`/var/www/d-bee` 生效远少于实有。
- 🔴 **改 `packages/shared/src` 必重跑其 build 再验门禁**（已踩三次）。

## 下一步 / 待拍板（逐字→REF「11-18 17:30 迁入」）

- 🔴 **分端下一步**：iOS＝M0 判 Xcode → M1–M11 出 TestFlight → S1–S7 配 `APPLE_*` **三键**；Android＝真机验 vc31（最优先）→HC-0 矩阵→华为线软著→AppGallery→Health Kit（D-1）；HarmonyOS NEXT 装不了 APK＝永久锁。**只有用户本人能做**（软著/Mac 证书/mini 发版/公安备案回填/ASC 3 商品 🔴ID 不可改/支付资质/AIGC 三件套）。
- 🟠 **待拍板**：D-1~D-13（→REF §九，🔴D-3 最重要；**D-5/D-6/D-7 未拍**）+ **11-22 新增 12 项**（→docs §六：AIGC 三件套/公安备案/M0/0056 生产应用/commit 43 项/docker 死代码三选一 等）。未进文档：隐私政策 §五+`LEGAL_UPDATED`、mini 同意窗载体、护栏 A9/A10。
- 🔴 **11-12 两条（→REF「11-19 10:55 迁入」）**：①16px 在 `styles.css:83`，Web/Android/mini ✅ **iOS ❌**（待 Mac 重打）②对标薄荷 §1.2+**PCM #3 立项**（🔴 仅 REF 有，勿删）。
- ⚠️ **已决不再讨论**：云库回迁自托管（**停用实例**不可逆）/ 老用户不迁移 / 存量 newbie bonus / App 名=`自律蜜蜂` / 凭据不打进终端 / mini 微信虚拟支付 / Android 微信+支付宝 APP 支付 / Web 暂不收费、ICP 经营许可证不办 / **不做**渠道首月半价。
- 三条主线：**开发**；**备份两层**（cron 03:30 `pg_dump -Fc`+异地，真实健康数据**严禁 git add**）；**运营**（每周提醒）。

## 已定技术路线（勿再讨论；全文→REF）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26 / **AGP 8.13.0 + Gradle 8.14.3 + Kotlin 2.2.20 + minSdk 26**（🔴 单一真源 `android/variables.gradle:28`）。健康数据源只读系统平台（HealthKit / Android HC→厂商 SDK 兜底）。
**决策（10-22 起）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）⑦收款路由见「已决不再讨论」。🔴 **凭据只存本地 `.env`**。
🔴 **⑧架构体系不使用 Docker（11-22 用户裁定，架构级非权宜；详版→`2026-11-22.md` 17:45 + docs §一）**：本就无 Dockerfile/compose/CI，生产 PG 17.11 = ubuntu **apt 原生**、网关裸 Node+nginx。**禁止**为「起个 PG 验证」引入容器（`wsl.exe` 在安全策略黑名单 → Docker Desktop 不可用）。**DB 迁移真库验证唯一正解 = 生产 PG `BEGIN…ROLLBACK` 单事务探针**（`tools/server-apply-0056.sh` + 驱动 `tools/apply-apple-txn-anonymize-prod.py`，带 `--check` 只读预检）：一行不落库、`TEST-0056-` 前缀合成数据 + `trap` 兜底 + 备份验 TOC≥100。`tools/local-pg-selftest{,-0056}.sh`＝**架构性死代码**，🔴**待用户三选一处置，我未擅自删**。
🔴 **⑨记忆上限 9k→12k（11-22 20:26 用户拍板「方案 A」）**：本文件 ≤**12000** 字符；核心纪律（细节第一次就逐字进 REF/日日志、禁「先写后压」）见**本文件头部纪律段**，不在此重复。会话指针文件仍 ≤3000（系统预算，不可改）。

## 架构铁律（12 条全文→REF:840）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch；⑩原生包禁用 `npm run build`；⑧iOS 付费墙禁硬编码价兜底；⑪`addListenerNative` 三路设防。

## 云数据库安全铁律（最高优先级；逐字→REF「11-18 17:30 迁入」）

- 发权益函数必须 **SECURITY DEFINER + 入参白名单**；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。
- **0039 闸门**：权益函数只改自建 migrations 单库；🔴 云库废弃后**不再双库同步**（`db/cloud-patch-0039/` 等仅存档勿执行）。nginx 唯一生效模板=`nginx.selfhost.conf.example`，改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`；`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**（`app_users` FORCE RLS + 无 DELETE）；0045 范式＝不带 owner_id、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon`+`GRANT authenticated`；删号后前端禁调 `saveProfile()`；新增含 `owner_id` 的表须同步 `v_tables`。🔴 **0056 后 `apple_transactions` 从 `v_tables` 移除**（16 张）→ 删号改匿名化保留幂等键（`owner_id='anon:'||md5(v_owner)`），`settle_apple_purchase` webhook 反查须带 `NOT LIKE 'anon:%'`。

## 部署最高危（全量→REF「部署侧坑」；逐字→REF「11-18 17:30 迁入」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）；**只读/备份也绝不跑它**。改网关一律走手术式脚本（`deploy/apply-llm-feature-walls.py`：13 道断言+自动回滚；Apple env 用 `deploy/apply-apple-iap-env.py`：默认 dry-run、须 `--apply`）。手术式铁律：前后断言 `gateway.env` sha256 不变；**绝不整搬本地 `app.mjs`**（ESM 顶层即崩＝全站宕机）；重启前必做 **ESM 预检**。
- 🔴🔴 **`APPLE_*` 只配三键**（`APPLE_BUNDLE_ID`/`APPLE_SHARED_SECRET`/`APPLE_ALLOWED_ENVS=Sandbox,Production`）：🔴**绝不配 `APPLE_SANDBOX=1`**（`config.mjs:506-508`→`:383-385` `throw` → **网关根本起不来**，非 warning）；🔴**`APPLE_WEBHOOK_SECRET` 是死键**（零消费点；webhook 安全全靠 JWS x5c 证书链 `iap.mjs`）。
- 🔴🔴 **「状态谎报」比失败更危险**：bash heredoc 内不得把 Python 常量名当 shell 变量（`set -u` 崩在赋值行→回滚不执行却打印「已回滚」）。**报了回滚就必须真回滚过**。
- 🔴 视觉链路 `BASE_URL`/`MODEL`/`API_KEY` 须**成对更换**且同步 `gateway.env.template`+`.secrets.local`（否则静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口**→立即验证会「假红」，修法 `sleep 8`+重试 3 次、脚本必须可重入。验收三坑（`gateway.env` 0640 需 `sudo -n` / 临时账号须 `trap cleanup EXIT` / Windows 禁 `wsl.exe`）。

## 环境备忘（全节逐字→REF「11-18 17:30 迁入」）

- **连接/路径**：SSH `150.158.51.106`、`USER=ubuntu`+`SSH_PWD`；验收打 `https://d-bee.cn/` **别打 IP**；`db/backups/offsite/*.dump` 含真实健康数据**严禁 git add**；push 遇 `schannel`→单次 `-c http.sslBackend=openssl`；遇 `502`/`CONNECT tunnel failed`/HTTP 000＝**代理故障别改 git 配置绕**。
- **两条唯一权威**：数值口径 `src/lib/numfmt.ts`（禁自写 `toFixed`）；nginx **只反代 `/.cloud/` 与 `/auth/`** → 其余 POST 返 **405，405 不能判路由存在**。
- **防假绿**：vitest 强制串行，跑完核对 `Test Files` 数 == `ls tools/*.test.ts`；mini 类型检查单独跑；禁硬编码日期（取 `todayKey()`）；**小程序验收以体验版为准**。护栏断言四铁律＝①一 `it()` 一断言②匹配「实际使用」③`stripComments()` 后做④两端同源须 `every()`；新增/放宽**必红验证**。
- **产物判读**：mini 中文 `\uXXXX`（`unicode_escape`，勿 `latin1`）/Web UTF-8；`VITE_*` grep 命中≠生效；裸串碰撞→用完整 CTA 短语；数据面追 `resolveEndpoint`。
