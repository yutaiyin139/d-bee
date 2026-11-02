# D-Bee（自律蜜蜂）· 项目长期记忆（核心版；细节读同目录 REFERENCE.md 与当日日志）

> 🔖 **权威口径（勿再改动）**
> · **Bundle ID / appId = `cn.com.dbee.app`**（iOS+Android 同值）
> · **域名**：`d-bee.cn` = 自律蜜蜂 Web 端（隐私政策 URL / Apple webhook / Universal Link / 原生 endpoint 全用它）；`d-bee.com.cn` = 公司官网（纯静态）。同一企业备案订单（一单两站 -1/-2）。
> · **版本 1.7.3**（Android vc14 / iOS CURRENT_PROJECT_VERSION 12 / mini 0.1.0）
> · 🔴 **打原生包绝不能用 `npm run build`**（白屏，铁律 #10）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。
> · 🔴 **产物自检必须以 `index.html` 引用的入口 js 为唯一真源**（铁律 #11）：`ENTRY=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)`，再查 `dist/$ENTRY`。**干净构建本就有 2 个 `index-*.js`**（另一个是入口动态 import 的 chunk，hash 稳定），「>1 个 = 构建残留」是错误判据，会误判合法构建。同理 `describe()` 只在 `index.html` 内联脚本里，assets 中零命中。
> · 📄 **隐私政策静态页**：`npm run build` 会自动跑 `tools/gen-legal-static.mjs` → `dist/legal/{terms,privacy,disclaimer}/index.html`（零 JS 可爬，OPPO 硬要求）。单一真源 = `src/content/legal.ts`；`build:native*` 不生成（原生端不需要）。上线时 `dist/legal/` 须一并部署；nginx 无需改（`try_files $uri $uri/` 的 `$uri/` 命中目录 index）。备案号走 `VITE_ICP_BEIAN`，未传即整块不渲染。

## 进度快照（截至 2026-11-02 上午）

**已完成**：iOS V1.7.3 已发布+上架就绪核查通过；Web V1.7.2 线上（http://150.158.51.106/）；Android vc13 重打验签通过；四端审查整改 #1~#5（→铁律 #5~#9）；密码登录缺陷修复（`8d4a0ef`）；合规 P0 多端一致性；阿里云真短信上线；App Store 截图链路就绪；10-31 全仓口径核查+安全四项（5432 已修 localhost、云库 0039 闸门补齐；SSH/sudo 密码未轮换）；ICP 企业备案已进管局（10-31）；11-01 白屏闭环（根因=误用 `npm run build`，自报面板实证；真修 `5d9de96` 须 Mac 重打）；识别提速 `dc217da` 已部署实证（6.7 倍）。重启影响面实测极低（JWT 30min TTL，重启只清内存态）。

**下一步（上架前主线）**
0. 🔴 移动号段收不到验证码=`PORT_NOT_REGISTERED` → 用户在阿里云控制台「签名管理→运营商报备结果」补报备（5–7 工作日）；期间移动用户走密码登录。
1. Mac/Xcode 真机实证整改 #1~#5 + 红屏修复 `5d9de96`（Windows 编不了 Swift）。
2. ASC 配 3 商品（`dbee_pro_monthly/yearly/lifetime`）+ IAP capability + webhook 指 `https://d-bee.cn` + `APPLE_BUNDLE_ID`/`SHARED_SECRET`/`APPLE_ALLOWED_ENVS` → iOS 提审（需备案号）。
3. ICP 备案注销重备推进（工信部短信核验 24h 内必做）。
4. 资质到货后 → 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议。
5. 上架前未决阻断：**凭据轮换**（SSH 密码已进 git 历史；明文只在本地 `.env`，严禁写入 git）/ **HTTPS + 域名解析**（四端硬阻断）。
6. 其余：软著→App 备案→算法备案；华为/小米企业入驻后替换 dbee-health 插件方法体；分享卡片 O-3；实测自家 MAPE；彩页重写；Android 真机复测；小程序三端联调。

**待拍板（不阻塞开发）**
- 🔴 **软著 AI 条款红线**：版权中心要求经办人亲笔手抄承诺「未使用 AI 开发」，申报文档不得 AI 代写 → **不可盲目提交，须先致电版权中心问口径**，说明书须用户亲写。素材包：`docs/软著登记-事实素材包与合规红线-2026-10-28.md` + `tools/gen-softcopyright-source.py`。
- ①ICP 经营许可证（3 人社保）→ 方案 A：暂不办。②Apple 账号：先申 D-U-N-S、个人推进。③云库去留。④老用户迁移（推荐 A：开发数据不迁移）。⑤存量 7 行 newbie bonus 处置。⑥小程序是否回迁自托管（须同步改 `mini/src/lib/cloud.ts`+`legal.ts`）。⑦演示账户两套数据面（iOS 云库 owner `2115454156301934592` / web 自建 `1793280185303313979` 互不相通；iOS 切自建库须重建账户+预置数据，否则 Guideline 2.1）。
- ⚠️ 安全待办（用户处理）：①重置 DeepSeek API key ②轮换 SSH/dbee_app 密码（轮换优先于重写 git 历史）。

**版本/git**：commit 流水不入记忆，一律 `git log`（11-01 22:23 起本地远端同步，HEAD `6cbe6c8`）。

## 三条主线

1. **开发**：看板=本文件「进度快照」，自动化「D-Bee 开发进度盘点」每日收敛。
2. **备份**：自动化「D-Bee 每日数据备份」→ `db/backups/YYYY-MM-DD.json`（失败落 `FAILED-*.md`）。
3. **运营**：彩页、技术交流、社群，自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**6 项决策（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）。凭据只存本地 `.env`。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层；运行时探测 `window.Capacitor`，不 import Capacitor 包。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 注入云 SDK `options.fetch`，勿 patch window.fetch；endpoint 由 `cloudConfig.ts` 决定（native-release 硬断言 `https://d-bee.cn`）；仅废弃云端版 nginx 才改写 Origin。
4. 输入校验走 `src/lib/validate.ts`；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。
5. **StoreKit 2：服务端核销成功才 `finish()`**；退款交易只 finish 不送核销。回归 `npm run test:iap`。
6. **原生能力必须返回显式状态，禁止吞成 0/空**；HealthKit 只在 `isUsableHealthStatus(status)` 时写回。
7. 弹窗无障碍统一 `useModalA11y(onClose)`；`role="button"` div 用 `src/lib/a11y.ts` 的 `onActivateKey`，不改原生 `<button>`。
8. iOS 付费墙禁止硬编码价兜底：拉价失败禁用购买+重试，价格位显示「—」。
9. OriginProxy 取消归一为 End 非 Error，取消绝不回退缓冲重发；在途流注册表 finally 移除。
10. 🔴 **原生包禁用 `npm run build`**：护栏被死代码消除成无条件 throw → JS 首行炸、CSS 已载呈米白极易误判。自检 `grep -c "禁止直接复用 Web 产物" dist/assets/index-*.js` 必须为 0；诊断构建问题必须真实构建两种产物对照。
11. 🔴 Capacitor 8.5.3 `addListenerNative` 链尾 `.catch()` 兜不住全部失败（callbackId 非 Promise / 原生 addListener 永不 resolve / cb 同步抛错）→ 三路分别设防。
12. 🔴 跨引擎错误上报 message 与 stack 分开取（iOS JSC stack 不含 message）；错误面板分致命/非致命两形态；`padding-top` 叠 `env(safe-area-inset-top)`。

## 云数据库安全铁律（最高优先级）

- 发权益函数必须 SECURITY DEFINER + 入参白名单；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。
- 迁移审计（10-23）：33 编号=28 生效+3 失效+1 弃用；已修 0034~0036；工具 `tools/migration-audit.sh`；**先修工具再修数据**。
- **0039 闸门双库对齐**：**新增/修改权益函数必须双库同步打补丁**（自建走 migrations，云库走 MCP + `db/cloud-patch-0039/` 留档；探针 `deploy/probe-0039-parity.sh`）。
- nginx 唯一生效模板=`nginx.selfhost.conf.example`；改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。
- 单条 SELECT 求值顺序未定义：`set_config` 混函数须 `WITH s AS MATERIALIZED`。

## 关键坑（一行版；详版见 REFERENCE.md）

- endpoint 同源/绝对 HTTPS；`CapacitorHttp.enabled=true` 必开；云 SDK 独占 localStorage；iOS 无 BarcodeDetector→原生 MLKit；SW 在 capacitor:// 不注册；只改 web 资源用 `npx cap copy android`；图标改后跑 `tools/gen-app-icons.py`；验收 `tools/android-cdp.py`（默认包名 `cn.com.dbee.app`）；安全区写 `var(--safe-area-inset-*, env(...))`。
- cap sync safe-delete 守卫误删插件 gradle → 先 shell `rm -rf` 再 sync；本地插件两步缺一不可（includePlugins+npm install）；`capacitor.plugins.json` 才是真源；iOS 需 Xcode 单开 Push capability。
- 原生拍照无反应：`file_paths.xml` 缺 `<external-files-path>` 或 Manifest 缺 `CAMERA`；华为 WebView 忽略 `<input capture>`→原生统一 `@capacitor/camera`。
- 兑换拍照额度唯一依据 `get_photo_quota.total_remaining`。
- 探针脚本绝不 cat/grep 正文（会打明文密码）；泄露立即 shred 并轮换。
- honey_ledger 唯一索引 ref_id 需带 `HH24MISSMS` 后缀才允许每日多次。
- Xcode 完好性判定=`du -sh` ≥15GB + `-showsdks` 有 iphoneos（`-version` 显示 27.1 是 CLT 版本号，骗人）。
- 🔴 `SendSms` Code=OK ≠ 送达，必须调 `QuerySendDetails` 看 SendStatus/ErrCode；`PORT_NOT_REGISTERED`=签名子端口未完成运营商报备（号段差异非玄学；签名审核通过≠报备完成；生产无腾讯云凭据不能切 provider）。
- 🔴 qwen 系默认开深度思考，视觉任务纯空转：`enable_thinking:false` 放 body 顶层（`llm.mjs` 已注入，开关 `LLM_VISION_ENABLE_THINKING`，回退只改 env）。
- 🔴 `reasoning_tokens` 嵌在 `usage.completion_tokens_details`，不在顶层；日志侧用正则扫串。

### 部署侧坑

- `CREATE POLICY` 顺序 `AS→FOR→TO→USING→WITH CHECK`；GRANT 追加语义；BYPASSRLS 已收回（0033）；`pg_dump` 必须 `sudo -u postgres` + 体积守卫；`JWT_SECRET`/`IDENT_PEPPER` 存 `deploy/gateway/.secrets.local`（改 JWT_SECRET=全员登出，改 IDENT_PEPPER=身份失配）；网关与 PostgREST 共用同一 HS256 secret；`DBEE_PROD=1` 拒 `SMS_PROVIDER=log` 且收紧 Apple 收据（沙盒期须 `APPLE_ALLOWED_ENVS=Sandbox,Production`）。
- 🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（覆盖 gateway.env，缺 IDENT_PEPPER 则账户不可恢复）→ 改网关一律走手术式脚本（参照 `deploy/apply-password-login-fix.sh`，断言 env sha256 前后一致）。SSH 账号=`.env` 的 `USER=ubuntu`+`SSH_PWD`。
- 网关鉴权头=`x-wb-webapp-access-key`，按 Origin 精确匹配 → Node 脚本须注入 Origin/Referer。真实表名见 `db/migrations/`（没有 habit/habits）。
- `signIn` 两条路径（验证码/密码）改鉴权必双回归；密码路径标识须归一化（裸 11 位）。

## 数据面与部署现状（详版见 REFERENCE.md）

- **泳道 A（10-23 闭环）**：`150.158.51.106` nginx + dbee-gateway（:8080）+ PostgREST（:3001）+ PG 17.11；`/.cloud/**` 全走自托管；PG 监听已收 localhost。
- Web 已切自建 PG；Android/iOS/小程序仍走云库；自建网关唯一缺口=无 `/v1/login-wechat`。切换时机=备案→A 记录→HTTPS→三端指 `https://d-bee.cn`；**欠账=`0043-data-sync-final.sql`** + 身份映射 + 186****4728 分裂账号修复。
- PIPL：`0030-full-selfhost-mirror.sql` 含真实健康档案**不入库**（gitignore）；0030 已含 0025~0028 变更，勿盲跑 0025~0029。
- 支付链路：Apple 验签在 Node 网关（`server/lib/iap.mjs`）+ Notifications V2 + `0037` 三函数；自测 `tools/iap-selftest.mjs` 47 项。
- 短信：aliyun RPC + HMAC-SHA1 手写签名；🔴 签名口径=「北京迪蜂科技有限公司」不是「自律蜜蜂」；凭据在 `.secrets.local`。
- 安全加固：10-26 六项已部署复验 18/18；10-27 七项中 0042 已部署，其余代码全绿**待部署**。

## 业务与资质要点（详版见 REFERENCE.md）

- 主体注册已办结（10-22）：公章 10-27、对公账户 10-28、域名 10-27 过户（WHOIS=北京迪蜂科技有限公司）。「3 人社保」=ICP 经营许可硬条件 → 方案 A 暂不办。
- 小程序主体变更（`wxb7c7122de9c3ab1f`）：通过后 7 天内须管理员确认；强制后续=重做备案+14 天内重交类目资质（类目避开「医疗」，文案严禁诊疗）。
- ICP 备案：注销重备路径；关 WHOIS 隐私保护；工信部短信核验 24h 内必做；两域名打包同一订单。
- 竞品定位：¥18/¥128/¥328 锁定不改；「不卖 AI 神奇，卖能坚持下来」：厚免费+游戏化+本地引擎优先、AI 兜底+无广告+数据自托管；待办：实测自家 MAPE。
- AI 成本：DeepSeek flash 峰值拍照 ≈¥0.0047/次；万级 DAU 远低于 ¥4000/月，反证方案 A。
- LLM：只剩 `deepseek-flash`/`deepseek-v4-pro`；**只有 flash 接受图片**；`/llm/models` 须标 `supportsImages:true`；视觉走百炼 `qwen3.8-max-0902`；服务端切模型三端即时生效。
- 额度规则（权威值 `packages/shared/src/constants/index.ts`）：`FREE_DAILY_AI=3` + `AI_REDEEM_DAILY_LIMIT=2`；新手 150 分；streak7 满 7 天送 2 次。
- 会员/IAP：三档 free/pro/lifetime；Apple 个人账号已过；Android 企业账号已注册；iOS 本地 StoreKit 测试就绪。
- 多端小程序：Taro 4.3.0 双工程 + `packages/shared`；mini tsconfig 需 `moduleResolution:"bundler"`。
- 健康数据源：连接真源=云端 `health_connected`；「企业账号已注册」≠「应用已上架华为市场」。
- 微信：暂缓（`WECHAT_LOGIN_ENABLED` 改回 true 即启用）；移动应用 code 需 `sns/oauth2/access_token` 不可混用 jscode2session。

## 过审合规

Apple 4.2 / 3.1.1 / 5.1.1(v) / AI 告知同意；中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。
🔴 **隐私政策公示禁止跨端照抄**：两库不互通、公示主体不同；写 legal.ts 前先核对真实链路，只写确实存在的能力；每条第三方链接必须 curl 验 200 且引「与我方关系匹配」的文件；`deploy/verify-legal.mjs` 自动校验。

## 工作方式

需求驱动、多轮递进、「写→验→报」；缺陷/进度文档用 .docx；跨机同步只走 Git 私有仓（`github.com/yutaiyin139/d-bee` main，两机 `core.autocrlf false`）；收工把进度+待办写入当日日志；自测 `tools/*-selftest.mjs`。
**指令/shell 陷阱（11-01 踩过）**：①给用户的可执行指令必须放代码块一行一条（`→` 会被整行照抄）；②重试循环不加管道（需 `set -o pipefail`）；③推送失败=代理间歇波动，for 重试 5 次勿改方案。
**文档维护**：可执行文档直接更正；历史快照只加横幅不改正文；代码加护栏时文档同步改。
**提交前凭据扫描（11-02 踩坑两次后固化）**：①必须查**索引版本** `git show ":$f"`（`git diff --cached` 会含被删旧行 → 假阳性）；②手机号正则必须**带数字边界** `(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)` —— 19 位雪花 owner ID（如 `2111301028417638400`）的子串会裸匹配 `13010284176`，无边界正则每次都会误报；命中后先看上下文再判断，别无脑改文件。
**自检判据纪律（11-02 教训）**：任何「产物自检」命令写进手册前，必须在**干净构建的真产物**上实跑，且要能区分合法产物与异常产物。曾因未验证就把「index-*.js >1 个 = 构建残留」写进 Mac 手册，实际干净构建本就有 2 个（另一个是入口动态 import 的稳定 chunk）→ 错误判据比没有判据更危险（会让人反复 rm -rf 重打仍「不通过」）。
**记忆维护**：commit 流水不入 MEMORY.md；只存结论/铁律/决策/坑/权威口径；体积压到 ~10KB（超过注入截断）；细节移 REFERENCE.md。

## 环境备忘

- SSH 发布：`150.158.51.106` / `ubuntu` / 密码见本地 `.env`（`SSH_PWD` 勿入记忆/文档）；脚本 `deploy/deploy.sh`。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`。
- 云库 applicationId `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql）；云库地址 `https://zilv-mifeng.app.workbuddy.host`。
- curl 本机 dev server 需 `--noproxy '*'`；`package.json` 无测试框架/lint。
- 微营养素：foodsData*.ts 已 10 列化（1175 条零兜底）；`db/.tmp-backup.sql` 临时备份不入库。
