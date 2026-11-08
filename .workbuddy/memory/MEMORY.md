# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **全部详版在 `REFERENCE.md`**（含 11-08 A8 迁入的「精简前全文快照」+ 现状/路线/铁律详版）。本文件只留决策、铁律结论与指针，按需读详版。
> 🔴 **体积 ≤9k 字符**（口径＝**字符数**，非字节；中文 UTF-8 3 字节/字，历史达标版字节数均在 15KB+）。11-08 A8 二次瘦身达标（约 7.2k 字符）；旧版 102 行 / 10649 字符曾超限，其全文已逐字归档进 `REFERENCE.md`。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增加复杂度，**做任何决策前先征求用户同意**（尤其生产变更）；同一任务只在一个会话执行。

## 权威口径（勿再改动；详版 → REFERENCE.md）

- **Bundle ID = `cn.com.dbee.app`**（iOS+Android 同值）；**版本 1.7.3**（Android vc15 / iOS build 12 / mini 0.1.0）。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web（隐私政策 / Apple webhook / Universal Link / 原生 endpoint）；`d-bee.com.cn` = 公司官网静态页。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码任何位置**不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；`VITE_ICP_BEIAN` 仅紧急覆盖口。`POLICE_BEIAN` 仍空（不渲染＝合规）；公安联网备案 11-07 已启动，拿到号后回填（法定 **2026-12-06 前**）。
- 🔴 **公开公示信息不得只放 `.env`**（备案号/主体名/资质号）：被 gitignore → 换机器/CI 会静默产出无备案号页面。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。
- 🔴 **产物自检以 `index.html` 引用的入口 js 为唯一真源**：干净构建本就有 2 个 `index-*.js`，「>1 个＝残留」是错误判据。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法见 REFERENCE.md。
- 📄 **隐私政策静态页**：`npm run build` 自动生成 `dist/legal/`（零 JS 可爬，OPPO 硬要求）；**别用 `build:web`**（会删掉 `dist/legal/`）。法律文案 `**强调**` 静态页须先 `esc()` 再 bold。

## 现状（2026-11-08 上午 · 云端库彻底废弃；详版/旧快照 → REFERENCE.md）

- ✅ **WEB 完全上线** `https://d-bee.cn/` 200；入口 js `index-677ckuM3.js` 与本地 `dist/` 逐字一致；`verify-legal`+`verify-live` 双 PASS；三法务页 200；308=2 / 301=0；证书到期 **2027-02-04**。
- ✅ **数据面 = 自建 PostgreSQL `dbee`**（`healthz` 实证），迁移 **0045**；审核演示账户 `dbeesupport@163.com` 实测 signin 200 + token（iOS 2.1 拒审风险解除）。
- ✅✅ **云端库彻底废弃（11-08 用户指令）**：四端生产数据面全指自建 PG，云库不再写入、不再是生产依赖。mini `backend.ts` 默认 `cloud`→`selfhost`、`config/index.ts` 注入同步，`cloud` 仅显式回滚通道；selfhost 包产物实证返回 `d-bee.cn`；mini `legal.ts` 改自建库口径、`UPDATED` 刷 11-08。逐项证据 → `docs/待办清单-云库废弃收尾-2026-11-08.md` §一。
- 🔴 **云库数据放弃迁移**（云库无身份表、owner_id 19 位数字 ≠ 自建库 `wx:<openid>` → 孤儿数据）；**云库实例未停用/未删除**（平台控制台、不可逆、须用户本人，建议 selfhost 版真机验收 T+7 后）。
- 🔴 **mini 发版剩 2 项用户动作**：微信后台加 request 合法域名 `https://d-bee.cn`；确认备案期能否上传新版本。网关阶段 A 已就绪（`login-wechat` 404→401、`healthz` 200，工具 `deploy/apply-wechat-login-surgical.py`）。
- 🟠 尾巴：网关「模式=开发」（`DBEE_PROD` 未设，收紧前须先给本地开发换出路）、安全响应头、certbot renew 后复核 308、凭据轮换未执行、`APPLE_*` env 全缺、公安备案回填（12-06 前）。常规部署今后应设 `DBEE_DOMAIN=d-bee.cn`。
- 🟠 **git 未 push**：`github.com` 域名级限制（代理 502 / 直连超时 / `ls-remote` OpenSSL eof，`api.github.com`=200 证非凭据问题）；离线兜底 `release/d-bee-main-20261107.bundle`（verify PASS）。恢复后 `git -c http.sslBackend=openssl push origin main` 或 `git fetch <bundle> main && git push origin FETCH_HEAD:main`。
- 工程基线：`npm test` = **11 文件 / 231 项全绿**（跑完核对 `Test Files` 数 == 文件数）；跨端护栏 **9 道**。11-08 已修 `report-ratio.test.ts` 日期漂移。📄 待办清单 = `docs/待办清单-云库废弃收尾-2026-11-08.md`。

## 下一步 / 待拍板（详版 → REFERENCE.md）

- 🔴 **主线 = iOS 上线**，权威 `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`；中国区正式上架卡软著（30–60 工作日）/ App 备案（7–20）/ Mac 签名，最大交付物 = **TestFlight 内部测试**（Mac + Xcode≥26 + Team + 重打包）。ASC 填报面几乎空白（逐字段答案 `docs/ASC表单填报答案-2026-11-07.md`）；Apple 硬闸门：Xcode 26 + iOS 26 SDK（2026-04-28 生效）、新年龄分级问卷必答（2026-01-31）。壳内产物停在 11-04，重打包前必须重打。
- 🔴 **只有用户本人能做**：软著 AI 条款口径回填、Mac 选 `DEVELOPMENT_TEAM`、iOS/鸿蒙签名证书入 `signing/`、mini 发版 2 项、云库实例停用、公安备案回填、ASC 表单填报。✅ 11-07 已定案 App 名称 `自律蜜蜂`。
- 🟠 **待拍板**：隐私政策 §五 + `LEGAL_UPDATED` 刷新（**会让全体老用户重弹同意窗**）、凭据轮换、网关模式收紧、Android vc15 公网分发渠道、护栏 A9/A10、一致性第三类「功能覆盖差异 ≠ 分叉」、Apple 个人主体 vs 备案企业主体、P1-D 核销时序坑。
- ⚠️ 已决不再讨论：ICP 经营许可暂不办 / 云库去留=回迁自托管 / 老用户不迁移数据 / 存量 7 行 newbie bonus / 演示数据两套面互不相通 / App 名称=`自律蜜蜂` / 凭据不打进终端。
- 三条主线：**开发**（看板=本文件「现状」，自动化「D-Bee 开发进度盘点」每日收敛）；**备份两层**（cron 03:30 `pg_dump -Fc` + 异地副本 `deploy/pull-latest-backup.py`，含真实健康数据**严禁 git add**；旧云库 JSON 备份 11-05 废弃）；**运营**（彩页、社群，自动化每周提醒）。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**6 项决策（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）。凭据只存本地 `.env`。

## 架构铁律（12 条全文 → REFERENCE.md）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**（退款只 finish 不核销）；⑩原生包禁用 `npm run build`；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch。
其余：①平台差异只走 `src/lib/`、运行时探测 `window.Capacitor` ②`cloudConfig.ts` 零项目内依赖 ④校验 `validate.ts`/文案 `errmsg.ts` ⑥原生能力返回显式状态、禁吞成 0/空 ⑦弹窗无障碍 `useModalA11y`/`onActivateKey` ⑧iOS 付费墙禁硬编码价兜底 ⑨OriginProxy 取消归一为 End、绝不回退缓冲重发 ⑪Capacitor `addListenerNative` 三路设防 ⑫跨引擎 message 与 stack 分开取 + 安全区 `env(safe-area-inset-top)`。

## 云数据库安全铁律（最高优先级）

- 发权益函数必须 SECURITY DEFINER + 入参白名单；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。
- **0039 闸门双库对齐**：新增/修改权益函数须双库同步打补丁（自建 migrations / 云库 MCP + `db/cloud-patch-0039/`；探针 `deploy/probe-0039-parity.sh`）。
- nginx 唯一生效模板=`nginx.selfhost.conf.example`；改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。
- 单条 SELECT 求值顺序未定义：`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**（`app_users` FORCE RLS + 无 DELETE，只有属主 postgres 能删）；0045 范式 = 不带 owner_id 参数、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon` + `GRANT authenticated`。删号后前端禁调 `saveProfile()`；新增含 `owner_id` 的表须同步 0045 `v_tables`（护栏 9 拦）。详版 REFERENCE「0045」。

## 部署最高危（全量 → REFERENCE.md「部署侧坑」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（参照 `deploy/apply-vision-key-update.py`）；**只读/备份操作也绝不跑它**。
- 🔴 SSH=`USER=ubuntu`+`SSH_PWD`；`.env` 的 `DBEE_USER=dbee_app` **实测认证失败**（过时值）。视觉链路 `BASE_URL`/`MODEL`/`API_KEY` 必须成对更换且同步 `gateway.env.template`+`.secrets.local`（否则下次部署静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口**：旧 worker 仍持旧配置 → 立即验证会「假红」。修法 `sleep 8` + 重试 3 次；补丁脚本必须可重入。任何「reload + 立即断言」脚本都有此坑。
- 🔴 服务器端验收脚本三坑（`/etc/dbee/gateway.env` 0640 需 `sudo -n` / 造临时账号必须 `trap cleanup EXIT` / Windows 调 bash 拉起被禁 `wsl.exe` → 静态部署改纯 SFTP），详版 REFERENCE。

## 环境备忘（详版 → REFERENCE.md）

- SSH `150.158.51.106`（🔴 `SSH_PWD` 明文勿入记忆/文档）；**验收一律打 `https://d-bee.cn/`，别打 IP**（IP http 已由 200 变 404）。
- APK 归档 `release/`（**绝不放在 `android/app/build/outputs/apk/release/` 内**，Gradle 会清理）；Web 归档 `backups/`；异地备份 `db/backups/offsite/*.dump` 含真实健康数据，严禁 git add / 移出项目。
- 🔴 **nginx 只反代 `/.cloud/` 与 `/auth/`**，其余 POST 落静态层返回 **405** → 不能用 405 判断网关路由是否存在；判路由要打正确前缀并用「对照已存在路由返回 401」区分。
- 🔴🔴 **测试 = vitest**（`npm test` = `vitest run tools/`），`vite.config.ts` 强制串行（并行会静默丢文件＝假绿）；跑完必核对文件数。**mini 类型检查须单独跑**；构建期护栏必须写在构建配置里（webpack 不执行被打包模块顶层代码）。
- 🔴 **测试禁止硬编码日期**：被测函数用 `rangeDays(N)`／`todayKey()` 圈定窗口时，`log_date` 必须同源取 `todayKey()`，否则窗口滑走 → 被 `inRange.has()` 静默过滤 → 集体假红（11-08 `report-ratio.test.ts` 6 项踩坑）。加防漂移护栏并做红验证。
- 🔴 **MAPE 达标 ≠ 无需处理**：四指标并报，实测需真机+样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字。
- 🔴🔴 **护栏断言三条铁律**：①一个 `it()` 只一条断言 ②匹配「实际使用」非「标识符出现」 ③断言在 `stripComments()` 后的代码上做。新增护栏 / 放宽快照基线**必须红验证**。
- 🔴 **产物里 grep 中文必假阴性**（`\uXXXX` 转义，须解码）；判断数据面要追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论。
- 🔴 git push 遇 `schannel: failed to receive handshake` → 单次 `git -c http.sslBackend=openssl push origin main`，别反复重试当成网络不通。
- 🔴 **数值口径唯一权威 `src/lib/numfmt.ts`**（计算层全精度、只在展示层插值那一刻舍入），禁止自写 `toFixed` / `Math.round(n*f)/f`。
