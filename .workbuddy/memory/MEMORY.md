# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **全部详版在 `REFERENCE.md`**。本文件只留决策、铁律结论与指针。
> 🔴 **体积 ≤9k 字符**（非字节）；超限旧版归档进 `REFERENCE.md`。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增复杂度，决策先征求同意（尤其生产变更）；同一任务只在单会话。🔴 **删文件先评估+等确认**（全授权不豁免，详版 → REFERENCE）。

## 权威口径（勿再改动；详版 → REFERENCE.md）

- **Bundle ID = `cn.com.dbee.app`**（iOS/Android 同值）；**版本 1.7.8**（Android vc26 / iOS `CURRENT_PROJECT_VERSION` 12）。🔴 **版本号单一真相源 = 根 `package.json` 的 `version`**，经 `__APP_VERSION__` 注入 Web 与 mini（mini/package.json 的 0.1.0 是包自身版本）；发版须**六处统一**（package.json / android build.gradle 的 versionCode+versionName / ios pbxproj 的 `MARKETING_VERSION`×2 / mini config 与 four-end-consistency 注释）。原文 → REF §六。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web（隐私政策 / Apple webhook / Universal Link / 原生 endpoint）；`d-bee.com.cn` = 公司官网。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码任何位置**不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；`POLICE_BEIAN` 仍空（不渲染＝合规），下证后回填（**2026-12-06 前**）。🔴 **公开公示信息不得只放 `.env`**（备案号/主体名/资质号）：被 gitignore → 换机器/CI 静默产出无备案号页面。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。🔴 二者与 web **共用 `dist/`**，且 native / `build:web` 都会**删掉 `dist/legal/`**（隐私政策静态页零 JS 可爬＝OPPO 硬要求）→ **部署 web 前必须重跑 `npm run build`** 并比对入口 js 文件名。**产物自检以 `index.html` 引用的入口 js 为唯一真源**（干净构建本就有 2 个 `index-*.js`）。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法见 REFERENCE.md。
- 🔴🔴 **写库字段必须对齐生产库列**：`updateMealGrams` 曾写 `meal_entries.updated_at`（0030 漏列）→ `PGRST204 schema cache` → 前端误翻「服务版本不匹配」，四端编辑份量全崩（11-14 实证）。改 patch 先对 `information_schema.columns`；加列后必 `NOTIFY pgrst, 'reload schema'`。🔴 用户报「服务版本不匹配」**不是前端版本问题**，是 schema cache / function 不存在。

## 现状（11-16 21:05 · 0052 闸门全链路上线 + 三层只读复验全绿；V1.7.8/vc26；证据 → `2026-11-16.md` E–N；17:59 旧版逐字 → REF「11-16 21:05 迁入」）

- 🔴🔴 **当前生产状态（非发版）**：**0052 applied**（14:30:21；`llm_gate` SECDEF+`search_path=public`，ACL 仅 `postgres`/`dbee_app`）；**网关手术式部署**（`deploy/apply-llm-feature-walls.py`：换 `llm.mjs` + `app.mjs` 插 4 条 `features/*` 路由）；**Web 入口 `index-CsL-COWf.js`**；🔴 **APK `…-20261116-llmgate.apk`（vc26、入口 `index-DKoWPSKJ.js`）仅归档不分发**（`not_published` + 备案阻断）。门禁 **30 文件 / 1333 项** EXIT=0。
- 🔴🔴 **21:05 三层只读复验全绿（零写入生产；详版 → `2026-11-16.md` N）**：四服务全 **`NRestarts=0`**/**OOM 0**/3 天 error **0 条**/网关·PG·postgrest **只监听回环**/🔴 **systemd 单元与 nginx 站点配置 mtime 全早于部署日＝未触碰**/回滚点在位/证书至 **2027-02-04**。代码层 `app.mjs` vs 部署前备份 **删 0 增 7**/`gateway.env` **未变**/22-C 实证（`dbee-feature` **0**）/`nginx -t` **successful**。公网 **19/19 逐字节一致**（含 `legal/` 三页）/🔴 **路由三层语义**：非法参数 **400**／无 token **401**（四条全中）／**伪造 JWT 亦 401**／未注册 **404**。
- 🔴 **工具坑第 5 条**：`node --check` **从 stdin 读时对非法代码也返回 RC=0**（实测假绿）→ 必须取回**文件**再校验；ESM 可解析性改「静态提取 import 集合 vs lib 实存」法。
- 🔴🔴 **发现⑦⑧**：⑦`/var/www/d-bee` 实有 **139 文件**、生效仅 19（历史 chunk 累积，`immutable`+哈希名**不影响正确性**；清理＝删除须先确认）。⑧用 `.env` **真实值**反查待提交清单：`deploy/gateway/.secrets.local` 含 LLM key 但被 `*.local` 忽略、**从未提交**；🔴 `REFERENCE.md:788` 含 `SMS_MASTER_CODE` 真实值＝**既存于 HEAD**（`ba831c4`）非本次新增 → public 仓库应轮换，**登记待拍板，未擅自改写历史**。
- 🔴🔴 **发现③④①（详版 → `2026-11-16.md` H/I/K）**：③`apk-distribution.baseline.json` **自称护栏、全仓引用 0 处** → 可改 `published` 而门禁全绿；已加 `knownGap_guardrailNotWired`，🔴 **未擅自新增测试**。④**11-15 包与新网关不兼容、禁止分发** —— 仍带 `dbee-feature`、无 `llm/features/` → 装此包者复盘/计划/教练被重写为 `FOOD_SYSTEM`（**静默错位不报错**）；已移入 `supersededApks[]` 留证。①**0046/0047 生产漂移，刻意未夹带**：生产 `lib/` 缺 `xpay/apppay/wechatSession.mjs`、库无 0046/0047 → **收款链路生产未落地**。
- 🔴 **剩余边界**：mini 导出与通知说明**零真机实证**；mini 体验版须本人上传 **`prebuild-20261115-2230/mini-dist-v178`**（🔴 `mini/dist` 仍旧包 v1.7.7）；Android 公网分发待批准（A7）；模板 ID 回填后须补服务端 `subscribeMessage.send`。
- 🔴🔴 **四条既有铁律（全文已验在 REF）**：①**收款**（§五+11-08/09）＝开关默认 false / `settling` **绝不报 error** / **发权益权威信号＝验签回调 `settle_app_payment`**。②**兑换码 0048**（「2026-11-10 晚」）＝护栏**永不写明文** / **绝不调 `redeem_by_code`**（真烧码）。③**`psql`/脚本六铁律**＝变更类禁 `2>/dev/null` / 探针**不打印真实 uid** / `SUDO()` **不吞 stderr**。④🔴 **写 SQL 前必核 `information_schema.columns` 列名**（`schema_migrations`→`version` 非 `id`、`ai_usage`→`usage_date` 非 `day`）。
- ✅✅ **云库废弃**：四端数据面全自建 PG、数据放弃迁移；释放差 2 步（用户本人）：①重传 mini+重设体验版 ②停用实例（不可逆）；实例**仍在线**。
- 🟠 **备案链**：域名/ICP ✅；App/小程序/算法/公安备案均管局审核中（前两项硬阻断 Android 上架、mini 发版+虚拟支付）；`applicationLabel` 仍 `D-Bee`，上商店前须改「自律蜜蜂」。
- 🔴 **11-16 pull `8f6b981`**：**`health_vendor`「暂编号 0052」作废 → 须顺延 `0053`**；🔴 **pull 涉 `packages/shared/src` 必重跑其 build 再验门禁**（`dist` 陈旧 = 护栏读 src 假绿，第三次踩）。

## 下一步 / 待拍板（详版 → REFERENCE.md）

- 📚 **git 已闭环**：11-15 三次 push 成功；11-16 pull `8f6b981`（零冲突）。11-14 的 P0 / P1.4-1.6 / 21:50 透明化 / P1.7 均已入库随 V1.7.6~V1.7.8 发版 → REF「11-15 23:08 迁入」§四。
- 🔴 **主线 = iOS 上线**（权威 `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`）：正式上架卡软著(30–60 工作日)/App 备案(7–20)/Mac 签名；最大交付 = **TestFlight 内部测试**（需 Mac+Team+重打包）。ASC 填报面几乎空白；Apple 硬闸门 Xcode 26 + iOS 26 SDK、新年龄分级问卷必答。🔴 壳内停在 11-04，apppay + A-5 真删号 + 16px 修复待重打包。
- 🔴 **只有用户本人能做**：软著 AI 条款、Mac 选 `DEVELOPMENT_TEAM`、证书入 `signing/`、mini 发版、云库停用、公安备案回填、ASC 填报、算法备案收尾、**支付资质申请**（微信移动应用 + 商户号 APP 支付 + 支付宝企业应用）。
- 🟠 **待拍板**：**0046/0047 生产漂移处置**（收款链路未上生产，补则走手术式脚本 + 开关默认 false）、**是否补 `tools/apk-distribution.test.ts`** 闭合发现③护栏缺口（须先红验证）、隐私政策 §五 + `LEGAL_UPDATED`、mini 同意窗重确认载体、凭据轮换、网关模式收紧、护栏 A9/A10、Apple 个人 vs 备案企业主体、仓库是否转 private。
- 🔴 **11-12 两条（详版 → REF「11-12 上午/13:40/14:22」+ 两份 `docs/*-2026-11-12.md`）**：①**三端晃动 / 四端分享**：16px 在 `styles.css:83`，Web/Android/mini ✅ **iOS ❌**；iOS 分享修复（base64 误塞 `url` → 改 Filesystem 写 Cache + `files`）待 Mac 重打包；`100vw`/`100dvh` 未动。②**对标薄荷 / 备案等待期**：§1.2 复核 + **PCM #3 立项**（🔴 REF 无此 token，勿删）；Wave 4.1 图片指纹违隐私政策须删。
- ✅ **发现⑤⑥已处置（详版 → `2026-11-16.md` L/O）**：`.gitignore` 已追加 `/Temp/`、`/dist-stale-*/`（仅加规则零删除，构建产物原地保留）；`apk-distribution.baseline.json` 已入库（用户跳过选项 → 按推荐执行）。
- ⚠️ **已决不再讨论**：云库回迁自托管 / 老用户不迁移 / 存量 newbie bonus / 演示数据两套面 / App 名称=`自律蜜蜂` / 凭据不打进终端 / **mini 微信虚拟支付** / **Android 微信+支付宝 APP 支付** / **Web 暂不收费、ICP 经营许可证不办** / **不做渠道首月半价**（11-11 已回退）。
- 三条主线：**开发**（看板=本文件「现状」，自动化每日收敛）；**备份两层**（cron 03:30 `pg_dump -Fc` + 异地副本，含真实健康数据**严禁 git add**）；**运营**（每周提醒）。

## 已定技术路线（勿再讨论；全文 → REF）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**决策（10-22 起）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）⑦收款路由见「已决不再讨论」。🔴 **凭据只存本地 `.env`**。

## 架构铁律（12 条全文 → REFERENCE.md）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch；⑩原生包禁用 `npm run build`；⑧iOS 付费墙禁硬编码价兜底；⑪`addListenerNative` 三路设防。其余 ①②④⑥⑦⑨⑫ 全文逐字 → REFERENCE:840。

## 云数据库安全铁律（最高优先级；全文 → REF）

- 发权益函数必须 **SECURITY DEFINER + 入参白名单**；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。🔴 **0047 沿用此范式**。
- **0039 闸门**：权益函数只改自建 migrations 单库；🔴 云库废弃后**不再双库同步**（`db/cloud-patch-0039/`、`tools/split-*-for-cloud.py`、`deploy/probe-0039-parity.sh` 仅历史存档，勿再执行）。nginx 唯一生效模板=`nginx.selfhost.conf.example`，改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**（`app_users` FORCE RLS + 无 DELETE）；0045 范式 = 不带 owner_id、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon`+`GRANT authenticated`。删号后前端禁调 `saveProfile()`；新增含 `owner_id` 的表须同步 0045 `v_tables`（护栏 9 拦）。

## 部署最高危（全量 → REF「部署侧坑」；11-16 手术式范式详版 → `2026-11-16.md` E-补）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（**最新范式 = `deploy/apply-llm-feature-walls.py`**：13 道断言 + 自动回滚）；**只读/备份也绝不跑它**。🔴 手术式铁律：前后断言 `gateway.env` sha256 不变；**绝不整搬本地 `app.mjs`**（import 生产缺失的 `xpay/apppay.mjs` → ESM 顶层即崩 = 全站宕机），只对现网副本按唯一锚点插入；重启前必做 **ESM 预检**（补齐生产 `.mjs`+`package.json`+软链，只 import `app.mjs`）。
- 🔴🔴 **「状态谎报」比失败更危险**：bash heredoc 内不得把 Python 常量名当 shell 变量（`set -u` 崩在赋值行 → 回滚分支不执行、兜底文案却打印「已回滚」）。纪律：**报了回滚就必须真回滚过**，回滚收敛到一个函数。
- 🔴 视觉链路 `BASE_URL`/`MODEL`/`API_KEY` 须**成对更换**且同步 `gateway.env.template`+`.secrets.local`（否则静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口** → 立即验证会「假红」。修法 `sleep 8` + 重试 3 次；脚本必须可重入。🔴 验收三坑（`gateway.env` 0640 需 `sudo -n` / 临时账号须 `trap cleanup EXIT` / Windows 禁 `wsl.exe`）。

## 环境备忘（全节逐字 → REF「环境备忘·详版」；只留触发线索）

- **连接/路径**：SSH `150.158.51.106`、`USER=ubuntu`+`SSH_PWD`（`.env` 的 `DBEE_USER=dbee_app` 认证失败）；验收打 `https://d-bee.cn/` **别打 IP**；APK 归档 `release/`；`db/backups/offsite/*.dump` 含真实健康数据 **严禁 git add**；push 遇 `schannel` → 单次 `-c http.sslBackend=openssl`。
- **两条唯一权威**：数值口径 `src/lib/numfmt.ts`（禁自写 `toFixed`）；nginx **只反代 `/.cloud/` 与 `/auth/`** → 其余 POST 返 **405，405 不能判路由存在**。
- **防假绿**：vitest 强制串行，跑完核对 `Test Files` 数 == `ls tools/*.test.ts`；mini 类型检查单独跑；禁硬编码日期（同源取 `todayKey()`）；**小程序验收以体验版为准**；MAPE 达标 ≠ 无需处理（四指标并报）。护栏断言三铁律＝①一 `it()` 一断言 ②匹配「实际使用」③在 `stripComments()` 后做；新增/放宽**必红验证**且确认注入真生效；「两端都包含 X」须 `every()`。
- **产物判读**：①中文形态分工具链（mini=`\uXXXX`→`unicode_escape`，勿 `latin1`；Web=UTF-8 直存）②`VITE_*` grep 命中≠生效，`define` 布尔才被 terser 折叠 ③裸串 grep 会子串碰撞（「下单」命中「预下单」）→用完整 CTA 短语；判数据面追「哪个常量被 `resolveEndpoint` 返回」。