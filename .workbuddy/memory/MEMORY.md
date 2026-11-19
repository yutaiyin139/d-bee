# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **全部详版在 `REFERENCE.md`**；本文件只留决策、铁律结论与指针。🔴 **体积 ≤9k 字符**（非字节），超限旧版归档进 REF。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增复杂度，决策先征求同意（尤其生产变更）；同一任务只在单会话。🔴 **删文件先评估+等确认**（全授权不豁免，详版 → REF）。

## 权威口径（勿再改动；逐字原文 → REF「11-18 17:30 迁入」）

- **Bundle ID `cn.com.dbee.app`**（两端同值）；**版本 1.7.9**（Android vc30 / iOS build 12）。🔴 **版本号单一真相源 = 根 `package.json`**，经 `__APP_VERSION__` 注入 Web+mini；发版须**六处统一**（package.json / android build.gradle / ios pbxproj `MARKETING_VERSION`×2 / mini config 与 four-end-consistency 注释）。
- **域名**：`d-bee.cn`=自律蜜蜂 Web（隐私政策/Apple webhook/Universal Link/原生 endpoint）；`d-bee.com.cn`=公司官网。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码**任何位置不得出现 `-1`**。真相源=`packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；🟢 **App 备案已下证（11-18）`-3A`**：真相源 `APP_ICP_BEIAN`，🔴 **仅原生壳 `isNative()` 门控渲染**（Web 渲染＝verify-legal FAIL；verify-legal 正则已放宽支持字母后缀）；`POLICE_BEIAN` 仍空（不渲染＝合规），**2026-12-06 前**回填。🔴 **公示信息不得只放 `.env`**（被 gitignore → 静默产出无备案号页面）。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。🔴 与 web **共用 `dist/`**，native/`build:web` 都会**删 `dist/legal/`**（隐私政策零 JS 可爬＝OPPO 硬要求）→ **部署 web 前必重跑 `npm run build`** 并比对入口 js 名；**自检以 `index.html` 引用的入口 js 为唯一真源**。
- 🔴🔴 **铁律 #13：「已完成」必附生产侧实测证据**。**本地绿 ≠ 线上绿**（中间隔提交→构建→部署）。取证 5 法 → REF。
- 🔴🔴 **写库字段必须对齐生产库列**：改 patch 先对 `information_schema.columns`；加列后必 `NOTIFY pgrst, 'reload schema'`。🔴 用户报「服务版本不匹配」**不是前端版本问题**，是 schema cache / function 不存在（`updateMealGrams` 写 `meal_entries.updated_at` → PGRST204 → 四端编辑份量全崩，11-14 实证）。

## 现状（11-19·V1.7.9 + 华为修复 + 备案 + 四端审计 + 收费文档·vc30 待真机；证据→`2026-11-19.md`）

- 🔴🔴 **生产状态**：**0052~0055 全 applied**（34 一致）；网关手术式部署（`apply-llm-feature-walls.py`）；**Web 入口 `index-CIf_RcMj.js`**（生产实测全绿）；四服务 `NRestarts=0`。门禁基线 **31 文件/1473 项**。
- 🔴🔴 **华为 P40「连接」无反应＝4 层根因已修（逐字 → REF「11-19 10:55 迁入」+`2026-11-19.md`§一）**：①无 GMS→HC 不可用 ②`canSync:true` 假信号→华为/小米改 `false`、荣耀拆出 ③`.notice` 透明字补背景 ④按钮无视 canSync→文案分叉；`connectHealth()` 进原生前拦截。🔴**品牌文案中性化**（华为字样＝资质驳回理由）。HC-3 `createPermissionIntentAsync` 分步超时+回调必发。护栏 HW-1 红后绿+selftest 18/18。
- 🔴🔴 **vc30 交付**（指纹/实证逐字 → 基线 `apk` 段 + `_verify_2026_11_19`、REF「13:40 迁入」、`2026-11-19.md` §二）：`appBeian=issued`；🔴🔴**零真机验证**（华为反馈可见/小米不闪退/备案号仅原生壳渲染）；🔴**未 commit**。Web 入口 `index-jon9Bmrs.js`。
- 🔴🔴 **Android HC-1/2/3 已落地（逐字 → REF「11-18 17:17 迁入」+「11-19 10:55 迁入」）**：minSdk 26/Kotlin 2.3.0/HC 1.1.0；**`aggregate()` 非 `readRecords()`**；**vc28 修闪退＝`@ActivityCallback` 必须 2 参**；HC-3「读数永驻」＝原生 `withStageTimeout` 6s < 前端 8s（🔴**禁 `Promise.race`**）。vc29 已被 vc30 取代。
- 🔴🔴 **微信运动 WX-1+WX-6 已落地（详版 → `2026-11-18.md` + REF）**：0053 生产应用；网关 9 闸门全绿；WX-6＝静默同步双闸+**轮询 `live:false`**（防 jscode2session **45011**）+`useDidShow` 实时刷。🔴**登录路径刻意不调 refreshHealth**；🔴**整搬 `app.mjs`＝全站宕机**→三文件同批。
- 🟢 **四端健康绑定审计已修（11-19，逐字 → `2026-11-19.md` §六 + REF「02:35 迁入」）**：mini 修 4 处＝denied 误指 iOS 路径→「权限管理」；empty 谎称「会自动读取」→「同步微信运动」出口；补写/清 `health_connected_at`；`Profile` 补声明。不修＝弹层按钮只对 `available` 渲染（D-5）；`not_ready` 死分支保留（D-7）；apple tip 矛盾（D-6）。护栏 **WX-5 六断言**红验证全过；tsc src 0 错。🔴 werun 真机 0 实证。
- 🔴🔴 **两份收费权威文档（11-19，详版 → `2026-11-19.md` §八/§九；逐字 → REF「13:40 迁入」）**：①全景＝四端唯一路线图，**取代 11-17 版 §2.2/§3/§4.3/§4.6**；②Android 专项＝执行级清单。🔴**「上线就绪」≠「收费就绪」不可互推**（Web 已上线永久不收费）｜iOS🟠40%>mini/Android🔴0%｜🔴生产 `config.mjs` 未升级→填 env 无效、未调 `saveSessionKey()`→mini 必失败｜🔴整搬 `auth.mjs` 覆盖 werun 4 锚点→微信运动断裂｜🔴基线假事实（水位 `"0048"` 实 **0055**）→护栏 19-B 与生产相反（D-11）｜18 个 `*-selftest.mjs` 门禁覆盖＝0｜纯规划零变更。
- 🔴🔴 **Android 实测校正（详版 → §九）**：上线🟠75%（备案 `-3A`→🟢**自建分发页现在能走、软著只卡商店**）/收费🔴0%；渠道待拍板（**A7**）。🔴**归档 APK 38 非 33**→禁分发 37｜🔴改名须 **3 处**（含 `capacitor.config.ts:26` `appName`，不改被 `cap sync` 写回）｜🔴`.env.example` 缺 `VITE_ALIPAY_APPID` 等 3 键→**支付宝静默失效、构建 exit 0 零警告**｜🟢工具链三件套不存在但基线已登记；伪缺口已排除（`PUBLIC_BASE_URL` 有默认值 / 支付宝插件缺失＝诚实降级）｜🔴`0030:1294` seed `dbee_lifetime` 仍 32800｜**D-13 新**＝支付宝插件 A/B（B＝**首发只上微信**，渠道探测独立→不会变假按钮）。
- 🔴 **剩余边界**：mini 导出/通知 + werun + **华为/小米健康链路零真机实证**（铁律 #13）；🔴🔴构建只落 `mini/dist`、禁再建 `prebuild-*`、1.7.7 旧包不可上传；模板 ID 回填后补 `subscribeMessage.send`；四端绑定代码侧已对齐（WX-5 钉死）。
- 🔴🔴 **四条既有铁律（全文 → REF）**：①**收款**＝开关默认 false / `settling` **绝不报 error** / **发权益权威信号＝验签回调 `settle_app_payment`**。②**兑换码 0048**＝护栏**永不写明文** / **绝不调 `redeem_by_code`**（真烧码）。③**`psql`/脚本六铁律**＝变更类禁 `2>/dev/null` / 探针**不打印真实 uid** / `SUDO()` **不吞 stderr**。④**写 SQL 前必核列名**（`schema_migrations`→`version` 非 `id`）。
- 🔴 **工具坑 5–11（逐字 → REF「11-18 17:30 迁入」+「11-19 10:55 迁入」）**：⑤`node --check` 读 stdin 假绿 ⑥Edit `old_string` 尾带 `\n` 合并 bullet ⑦宽泛 `grep -i proxy` 泄漏 Bearer ⑧`catch {}` 吞异常 ⑨中文进程名禁 ASCII grep、`/tmp`→用 `$TEMP` ⑩Taro 与开发者工具互写 `mini/dist`→构建前必关工具 ⑪标识符互为前缀→子串断言必假阳/假阴（用 `\b`）。
- 🔴🔴 **审计发现（详版 → `2026-11-16.md`）**：①`/var/www/d-bee` 实有 139 文件、生效仅 19 ②`REFERENCE.md` 含 `SMS_MASTER_CODE` 真实值→**应轮换待拍板** ③`apk-distribution.baseline.json` 全仓引用 0 处（knownGap，D-10）④**0046/0047 生产漂移刻意未夹带**。
- ✅✅ **云库废弃**：数据面全自建 PG；释放差 2 步（用户本人）＝重传 mini+重设体验版、停用实例（不可逆）。
- 🟠 **备案链**：域名/ICP ✅、**App 备案 ✅（11-18 `-3A`）**；小程序/算法备案审核中（mini 发版+虚拟支付被硬阻断）；公安备案 **2026-12-06 截止**；`applicationLabel` 仍 `D-Bee`（改名→重打 vc31）。
- 🔴 **改 `packages/shared/src` 必重跑其 build 再验门禁**（已踩三次）。

## 下一步 / 待拍板（逐字原文 → REF「11-18 17:30 迁入」）

- 🔴 **主线与分端下一步 → 文档 §三**：iOS 上架卡软著/Mac 签名（最大交付＝TestFlight；ASC 几乎空白；🔴壳停 11-04，apppay+A-5 真删号+16px 待重打）；Android＝真机验 vc30（最优先）→HC-0 矩阵→华为线软著→AppGallery→Health Kit（D-1 自检）；HarmonyOS NEXT 装不了 APK＝永久锁。**只有用户本人能做 → 文档 §七**（软著/Mac `DEVELOPMENT_TEAM` 当前 **0 命中**/证书/mini 发版/公安回填/ASC 3 商品 🔴ID 不可改/三项支付资质）。
- 🟠 **待拍板 D-1~D-12 全表 → 文档 §六**（🔴D-3＝最重要）。未进文档的：隐私政策 §五+`LEGAL_UPDATED`、mini 同意窗载体、护栏 A9/A10、Apple 个人 vs 企业、`prebuild-*`（78MB）清理、**D-5/D-6/D-7**（详版 → REF「02:35 迁入」）。
- 🔴 **11-12 两条（逐字 → REF「11-19 10:55 迁入」+两份 `docs/*-2026-11-12.md`）**：①三端晃动/四端分享：16px 在 `styles.css:83`，Web/Android/mini ✅ **iOS ❌**，iOS 分享修复待 Mac 重打，`100vw`/`100dvh` 未动 ②对标薄荷/备案等待期：§1.2 复核+**PCM #3 立项**（🔴 仅 REF 有，勿删）；Wave 4.1 图片指纹违隐私须删。
- ⚠️ **已决不再讨论**：云库回迁自托管 / 老用户不迁移 / 存量 newbie bonus / 演示数据两套面 / App 名称=`自律蜜蜂` / 凭据不打进终端 / mini 微信虚拟支付 / Android 微信+支付宝 APP 支付 / Web 暂不收费、ICP 经营许可证不办 / **不做**渠道首月半价（11-11 已回退）。
- 三条主线：**开发**（看板＝本文件「现状」，自动化每日收敛）；**备份两层**（cron 03:30 `pg_dump -Fc`+异地副本，含真实健康数据**严禁 git add**）；**运营**（每周提醒）。

## 已定技术路线（勿再讨论；全文 → REF）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26 / **AGP 8.13.0 + Gradle 8.14.3 + Kotlin 2.3.0 + minSdk 26**。健康数据源只读系统平台（iOS HealthKit / **Android HC 优先 → 厂商 SDK 兜底**；华为需先上架华为市场、小米官方 SDK、微信运动走网关）。
**决策（10-22 起）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）⑦收款路由见「已决不再讨论」。🔴 **凭据只存本地 `.env`**。

## 架构铁律（12 条全文 → REF:840）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch；⑩原生包禁用 `npm run build`；⑧iOS 付费墙禁硬编码价兜底；⑪`addListenerNative` 三路设防。

## 云数据库安全铁律（最高优先级；逐字 → REF「11-18 17:30 迁入」）

- 发权益函数必须 **SECURITY DEFINER + 入参白名单**；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。0047 沿用此范式。
- **0039 闸门**：权益函数只改自建 migrations 单库；🔴 云库废弃后**不再双库同步**（`db/cloud-patch-0039/`、`tools/split-*-for-cloud.py`、`deploy/probe-0039-parity.sh` 仅存档勿执行）。nginx 唯一生效模板=`nginx.selfhost.conf.example`，改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`；`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**（`app_users` FORCE RLS + 无 DELETE）；0045 范式=不带 owner_id、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon`+`GRANT authenticated`；删号后前端禁调 `saveProfile()`；新增含 `owner_id` 的表须同步 0045 `v_tables`（护栏 9 拦）。

## 部署最高危（全量 → REF「部署侧坑」；逐字 → REF「11-18 17:30 迁入」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（最新范式=`deploy/apply-llm-feature-walls.py`：13 道断言+自动回滚）；**只读/备份也绝不跑它**。手术式铁律：前后断言 `gateway.env` sha256 不变；**绝不整搬本地 `app.mjs`**（ESM 顶层即崩＝全站宕机），只对现网副本按唯一锚点插入；重启前必做 **ESM 预检**。
- 🔴🔴 **「状态谎报」比失败更危险**：bash heredoc 内不得把 Python 常量名当 shell 变量（`set -u` 崩在赋值行→回滚不执行却打印「已回滚」）。**报了回滚就必须真回滚过**，收敛到一个函数。
- 🔴 视觉链路 `BASE_URL`/`MODEL`/`API_KEY` 须**成对更换**且同步 `gateway.env.template`+`.secrets.local`（否则静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口**→立即验证会「假红」，修法 `sleep 8`+重试 3 次、脚本必须可重入。验收三坑（`gateway.env` 0640 需 `sudo -n` / 临时账号须 `trap cleanup EXIT` / Windows 禁 `wsl.exe`）。

## 环境备忘（全节逐字 → REF「11-18 17:30 迁入」）

- **连接/路径（逐字 → REF）**：SSH `150.158.51.106`、`USER=ubuntu`+`SSH_PWD`（`DBEE_USER=dbee_app` 认证失败）；验收打 `https://d-bee.cn/` **别打 IP**；APK 归档 `release/`；`db/backups/offsite/*.dump` 含真实健康数据**严禁 git add**；push 遇 `schannel`→单次 `-c http.sslBackend=openssl`；遇 `502`/`Empty reply`/HTTP 000＝**代理故障别反复重试**。
- **两条唯一权威**：数值口径 `src/lib/numfmt.ts`（禁自写 `toFixed`）；nginx **只反代 `/.cloud/` 与 `/auth/`** → 其余 POST 返 **405，405 不能判路由存在**。
- **防假绿**：vitest 强制串行，跑完核对 `Test Files` 数 == `ls tools/*.test.ts`；mini 类型检查单独跑（`@tarojs/**` 是既有噪音）；禁硬编码日期（同源取 `todayKey()`）；**小程序验收以体验版为准**；MAPE 达标≠无需处理。护栏断言四铁律＝①一 `it()` 一断言②匹配「实际使用」③`stripComments()` 后做④两端同源须 `every()`；新增/放宽**必红验证**。
- **产物判读（逐字 → REF）**：mini 中文 `\uXXXX`（`unicode_escape`，勿 `latin1`）/Web UTF-8；`VITE_*` grep 命中≠生效（`define` 才被 terser 折叠）；裸串子串碰撞→用完整 CTA 短语；数据面追 `resolveEndpoint`。
