# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **细节全在 `REFERENCE.md`**（关键坑 / 部署侧坑 / 数据面 / 业务资质 / 过审合规 / 工作方式 / 铁律详版 / 11-06 二次清理迁出的全文）。本文件只留「决策与铁律」。
> 🔴 **体积 ≤9KB**（超限注入被截断）：11-06 上午版 16.7KB 名不副实，深夜二次清理已达标。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增加复杂度，**做任何决策前先征求用户同意**（尤其生产变更）；同一任务只在一个会话执行。

## 权威口径（勿再改动；详版 → REFERENCE.md）

- **Bundle ID = `cn.com.dbee.app`**（iOS+Android 同值）；**版本 1.7.3**（Android vc14 / iOS build 12 / mini 0.1.0）。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web（隐私政策 / Apple webhook / Universal Link / 原生 endpoint）；`d-bee.com.cn` = 公司官网静态页。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码任何位置**不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；`VITE_ICP_BEIAN` 仅紧急覆盖口。`POLICE_BEIAN` 仍空（不渲染＝合规）；公安联网备案**用户 11-07 已启动**，拿到号后回填（法定 **2026-12-06 前**）。
- 🔴 **公开公示信息不得只放 `.env`**（备案号/主体名/资质号）：被 gitignore → 换机器/CI 会静默产出无备案号页面。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。
- 🔴 **产物自检以 `index.html` 引用的入口 js 为唯一真源**：干净构建本就有 2 个 `index-*.js`，「>1 个＝残留」是错误判据。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**（11-06 一晚抓到 4 处「本地全绿 + 生产未生效」）。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法见 REFERENCE.md。
- 📄 **隐私政策静态页**：`npm run build` 自动生成 `dist/legal/`（零 JS 可爬，OPPO 硬要求）；`build:native*` 不生成；**别用 `build:web`**（会删掉 `dist/legal/`）。法律文案 `**强调**` 静态页须先 `esc()` 再 bold。

## 现状（2026-11-06 深夜 · 生产实测定稿；11-07 批复见当日日志）

- ✅ **WEB 完全上线**：`https://d-bee.cn/` 200；入口 js `index-677ckuM3.js`（11-07 A-5 重新构建部署）与本地 `dist/` 逐字一致；`verify-legal` + `verify-live` 双 PASS；三法务页 200；`-2` 双向校验通过、`Google Play` 失实句 0 处；308 配置 2 行 / 301 为 0；证书到期 **2027-02-04**。
- ✅ **数据面 = 自建 PostgreSQL `dbee`**（`healthz` 实证）；迁移 **0045**；IAP 表在；四服务 active；备份走 `pg_dump -Fc`。
- ✅ **审核演示账户在自建库可用**：`dbeesupport@163.com` / `888888` → `signin` 实测 **200 + access_token**（错误账户 401）→ iOS 2.1 拒审风险解除。
- ✅ **云库已非生产写入源**：web 取 `window.location.origin`、兜底 `d-bee.cn`；iOS 壳内为 native-release 形态（断言 `=== d-bee.cn`）。
- 🔴 **但云库尚未「彻底释放」**：唯一真实生产依赖 = **mini**（`backend.ts` 默认 `cloud`）；`login-wechat` 路由实测 **404 未部署**（网关进程停在 11-02 旧代码）、`WECHAT_*` env 全缺。**用户 11-06 指示：mini 备案管局审核中，暂放，不执行任何 mini 变更。**
- 🔴 **网关「模式=开发」**（`DBEE_PROD` 未设）→ CORS 放行 localhost。不能贸然设 1（要求白名单且打断本地开发回退）；须先给本地开发换出路再收紧。
- 🟠 尾巴（不阻塞 web）：安全响应头、certbot renew 后复核 308（脚本已可重入）、网关 `APPLE_*` env。**11-07 状态**：公安备案 / 算法备案已启动、短信已可用；凭据轮换按用户批复「凭证不打进终端」**未执行**（是否轮换待确认）。
- 工程基线：`npm test` = **11 文件 / 229 项全绿**（跑完核对 `Test Files` 数 == 文件数）；跨端护栏 **9 道**（新增护栏 9 账号删除 10 项），改跨端逻辑前必跑。同步态查 `git status -sb`。

## 下一步（用户 11-06 方向：iOS 为主，mini 暂放；11-07 批复已并入）

> 🔴 **权威梳理 = `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`**（11-07 重新实测 + Apple 官方政策检索；11-06 版与 11-03 版均已加状态横幅，只作历史快照）。
> ✅ **11-07 阶段 A 全部完成（含 A-5）**：A-2 逐字段 ASC 答案 = `docs/ASC表单填报答案-2026-11-07.md`；A-3 死链 + A-4 长名已修；**A-5「1 改」→ 0045 SECDEF RPC 真删号，生产实测 21 项全绿、零网关改动**；`typecheck` + `npm test` 11 文件 **229 项**全绿。**A 完成 ≠ 能上架**（仍卡 Mac + 资质链）。
> **11-07 修正**：「工程侧 100% 就绪」只对**代码/服务端**成立；**ASC 表单填报面**（App Privacy 营养标签 / 新年龄分级问卷 / 审核信息 / 商品审核信息 / 订阅披露两处链接 / 截图上传）几乎空白 → 提审必填。
> 🆕 **Apple 硬闸门**：2026-04-28 起上传必须 **Xcode 26 + iOS 26 SDK**（已生效）；2026-01-31 起**新年龄分级问卷必答**（AI 助手 + 健康主题影响分级，别预设 4+）；App Privacy 未填阻塞提交；第三方 SDK 隐私清单签名缺 → `ITMS-91053`。
> ✅ **两处会致拒审的缺口都已修复**：① 账号删除 5.1.1(v) 降级实现 → **0045 `delete_own_account` SECDEF RPC 真删号**（11-07 下午生产实测）；② 填报包三条法务 URL 的 IP 深链 404 → 统一为 `https://d-bee.cn/legal/{privacy,terms,disclaimer}/`（带尾斜杠、实测 200）+ 校验脚本防回归护栏。
> 🆕 壳内产物还含 `Google Play` 失实句 **1 命中**；`PrivacyInfo.xcprivacy` 已在、商店截图 iPhone5/iPad5 + 3 张 IAP 审核截图实测齐；TestFlight 内部即时、外部需 Beta App Review。
> 📌 今天结论：**中国区正式上架不可能**（软著 30–60 工作日、App 备案 7–20 工作日、Mac 签名）；最大交付物 = **TestFlight 内部测试**（需 Mac + Xcode≥26 + Team + 重打包）。

0. 🔴 **只有用户本人能做**：①软著 AI 条款口径（**11-07 已致电**版权中心，结论待回填；30–60 工作日最长边）②~~拍板 App 名称~~ ✅ **11-07 已定案 `自律蜜蜂`**（方案 B）③Mac 上 Xcode 选 `DEVELOPMENT_TEAM`（仍待做，解锁 TestFlight + App 备案指纹 + 重打包）。
1. **Mac 链**：`build:native` → `npx cap sync ios`（🔴 壳内产物停在 11-04，缺备案号与最新法务，必须重打）→ 编 3 个 Swift 插件 → Archive/Upload → **TestFlight**（不依赖备案号）。
2. **服务端链**：ASC 建 App + 3 商品（¥18/¥128/¥298，月年同订阅组）+ 付费协议 + 共享密钥 → 手术式脚本配 `APPLE_*` → webhook 指 `https://d-bee.cn` → 沙盒购买测试。
3. **资质链**：软著 → App 备案（需 Mac 签名取 SHA-256/公钥）→ ASC 填号（MIIT 强校验）→ 中国区提审。
4. ✅ **11-07 执行链**：A3/A4（默认端点改 `https://d-bee.cn`、旧清单横幅 +14/-0）→ 阶段 A（ASC 填报答案、修 3 处活跃正文 + 5 份历史横幅、URL 护栏红验证）→ **A-5「1 改」（0045 迁移 + 前端 + web 部署，生产实测 21 项全绿、护栏 9 红验证 4/4）**；各阶段 `npm test` 全绿（基线 219 → **229**）。🟠 剩余：公安备案回填（12-06 前）、凭据轮换、安全响应头、**隐私政策 §五 + `LEGAL_UPDATED` 是否刷新（产品决策）**。
5. 🟠 **常规部署今后应设 `DBEE_DOMAIN=d-bee.cn`**（原「不要设」的理由已全消失）；Android 正式包已可实测，分发前 `versionCode` 须 14→15。
6. ✅ 算法备案 11-07 已启动（2–3 月并行，不阻塞首发）；华为/小米入驻后替换 dbee-health 方法体；安全响应头需拍板；Android 真机复测；彩页重写。

## 待拍板（全文 → REFERENCE.md「待拍板·详版」）

- 🔴 **软著 AI 条款红线**：白皮书 + 完整申请材料清单已产出，**待用户过目后才 commit**；11-07 已致电版权中心问口径，结论待回填。
- ✅ **App 名称已定案 `自律蜜蜂`**（方案 B，11-07）；✅ 11-07 阶段 A 已统一（活跃填报位改正文、历史快照只加横幅，清单见 REFERENCE.md⑧）；🔴 P1-D 核销时序坑；🔴 mini 上线前 4 项 + request 合法域名主体（**暂放，备案通过后接续**）。
- 🟠 护栏 A9 手写舍入债 / A10 mini 体重变化；🟠 一致性第三类「功能覆盖差异 ≠ 分叉」（分叉必须修，覆盖差异必须产品决策，定性须查全端）；🟠 Apple 个人主体 vs 备案企业主体（D-U-N-S → 迁移组织）。
- ⚠️ 已决不再讨论：ICP 经营许可暂不办 / 云库去留=回迁自托管 / 老用户不迁移数据 / 存量 7 行 newbie bonus / 演示数据两套面互不相通 / **App 名称=`自律蜜蜂`（方案 B，11-07）** / 凭据不打进终端。

## 三条主线

1. **开发**：看板=本文件「现状」，自动化「D-Bee 开发进度盘点」每日收敛。
2. **备份（两层）**：服务器 cron 03:30 `pg_dump -Fc` + 本地异地副本 `deploy/pull-latest-backup.py`（含真实健康数据，**严禁 git add**）。**旧云库 JSON 备份自 11-05 废弃**。
3. **运营**：彩页、技术交流、社群，自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**6 项决策（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）。凭据只存本地 `.env`。

## 架构铁律（12 条全文 → REFERENCE.md「架构铁律 12 条·全文」）

最易踩的三条：⑤**StoreKit 2 服务端核销成功才 `finish()`**（退款只 finish 不核销）；⑩原生包禁用 `npm run build`；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch。
其余：①平台差异只走 `src/lib/`、运行时探测 `window.Capacitor` ②`cloudConfig.ts` 零项目内依赖 ④校验 `validate.ts`/文案 `errmsg.ts` ⑥原生能力返回显式状态、禁吞成 0/空 ⑦弹窗无障碍 `useModalA11y`/`onActivateKey` ⑧iOS 付费墙禁硬编码价兜底 ⑨OriginProxy 取消归一为 End、绝不回退缓冲重发 ⑪Capacitor `addListenerNative` 三路设防 ⑫跨引擎 message 与 stack 分开取 + 安全区 `env(safe-area-inset-top)`。

## 云数据库安全铁律（最高优先级）

- 发权益函数必须 SECURITY DEFINER + 入参白名单；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。
- **0039 闸门双库对齐**：新增/修改权益函数须双库同步打补丁（自建 migrations / 云库 MCP + `db/cloud-patch-0039/`；探针 `deploy/probe-0039-parity.sh`）。
- nginx 唯一生效模板=`nginx.selfhost.conf.example`；改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。
- 单条 SELECT 求值顺序未定义：`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**：`app_users` FORCE RLS + `dbee_app` 无 DELETE，只有属主 postgres 能删。0045 范式 = 不带 owner_id 参数、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon` + `GRANT authenticated`；生产网关跑旧代码也能用 → 零 restart/reload、避开地雷。**详版 REFERENCE「0045」**。
- 🔴 删号后前端禁调 `saveProfile()`（会重建 `profiles`）；新增含 `owner_id` 的表须同步 0045 `v_tables`（护栏 9 拦）。

## 部署最高危（全量见 REFERENCE.md「部署侧坑」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（参照 `deploy/apply-vision-key-update.py`）；**只读/备份操作也绝不跑它**。
- 🔴 SSH=`USER=ubuntu`+`SSH_PWD`；`.env` 的 `DBEE_USER=dbee_app` **实测认证失败**（过时值）。视觉链路 `BASE_URL`/`MODEL`/`API_KEY` **必须成对更换**且同步 `gateway.env.template`+`.secrets.local`（否则下次部署静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口**：返回时旧 worker 仍持旧配置处理已接手连接 → 紧跟着验证会拿到旧行为 = **假红**。修法：`sleep 8` + 验证项重试 3 次；补丁脚本必须可重入。任何「reload + 立即断言」脚本都有此坑。
- 🔴 **服务器端验收脚本三坑**（0045 实测，详版 REFERENCE）：`/etc/dbee/gateway.env` 0640 → node 要 `sudo -n` 但重定向属主仍普通用户；造临时账号后必须 `trap cleanup EXIT`；Windows 调 `bash` 会拉起被禁的 `wsl.exe` → 静态部署改纯 SFTP（不执行远程命令、无需 reload）。

## 环境备忘（详版 → REFERENCE.md「环境备忘·详版」）

- SSH `150.158.51.106`（🔴 `SSH_PWD` 明文**勿入记忆/文档**）；**验收一律打 `https://d-bee.cn/`，别打 IP**（IP http 已由 200 变 404）。
- APK 归档 `release/`（**绝不放在 `android/app/build/outputs/apk/release/` 内**，Gradle 会清理掉）；Web 归档 `backups/`；异地备份 `db/backups/offsite/*.dump` 含真实健康数据，严禁 git add / 移出项目。旧云库 `https://zilv-mifeng.app.workbuddy.host` 已非生产源。
- 🔴 **nginx 只反代 `/.cloud/` 与 `/auth/`**，其余 POST 落静态层返回 **405** → **不能用 405 判断网关路由是否存在**；判路由要打正确前缀并用「对照已存在路由返回 401」区分。
- 🔴🔴 **测试 = vitest**（`npm test` = `vitest run tools/`），`vite.config.ts` 强制串行（并行会静默丢文件＝假绿）；跑完必核对文件数。**mini 类型检查须单独跑**；**构建期护栏必须写在构建配置里**（webpack 不执行被打包模块顶层代码）。
- 🔴 **MAPE 达标 ≠ 无需处理**：四指标并报，实测需真机+样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字。
- 🔴🔴 **护栏断言三条铁律**：①一个 `it()` 只放一条断言 ②存在性断言匹配「实际使用」非「标识符出现」 ③断言须在 `stripComments()` 后的代码上做。快照式基线放宽后 + 新增护栏**必须做红验证**。
- 🔴 **产物里 grep 中文必假阴性**（转义 `\uXXXX`），日期正则要容 `\s*`；判断数据面必须追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论。
