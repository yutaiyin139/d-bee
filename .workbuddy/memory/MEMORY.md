# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **全部详版在 `REFERENCE.md`**。本文件只留决策、铁律结论与指针。
> 🔴 **体积 ≤9k 字符**（非字节）；超限旧版归档进 `REFERENCE.md`。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增复杂度，决策先征求同意（尤其生产变更）；同一任务只在单会话。🔴 **删文件先评估+等确认**（全授权不豁免，详版 → REFERENCE）。

## 权威口径（勿再改动；详版 → REFERENCE.md）

- **Bundle ID = `cn.com.dbee.app`**（iOS/Android 同值）；**版本 1.7.4**（Android vc22 / iOS build 12 / mini 0.1.0）。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web（隐私政策 / Apple webhook / Universal Link / 原生 endpoint）；`d-bee.com.cn` = 公司官网。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码任何位置**不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；`POLICE_BEIAN` 仍空（不渲染＝合规），下证后回填（**2026-12-06 前**）。🔴 **公开公示信息不得只放 `.env`**（备案号/主体名/资质号）：被 gitignore → 换机器/CI 静默产出无备案号页面。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。🔴 二者与 web **共用 `dist/`**，且 native / `build:web` 都会**删掉 `dist/legal/`**（隐私政策静态页零 JS 可爬＝OPPO 硬要求）→ **部署 web 前必须重跑 `npm run build`** 并比对入口 js 文件名。**产物自检以 `index.html` 引用的入口 js 为唯一真源**（干净构建本就有 2 个 `index-*.js`）。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法见 REFERENCE.md。

## 现状（11-14 晚 · v1.7.6 / vc24 已发布；下方 11-13 条目为历史快照；详版 → REF）

- ✅ **19:45「我的」页+健康档案+智能设备四端同构已实施（🔴 未发版）**：`d8f2207` 已 push；shared `myPage.ts`/`healthRecord.ts` 真源 + 两端各 4 Sheet；三处收敛（邀请好友 / 查看完整报告 ↗ / 今日目标只读摘要，移除现场 `calcTarget()`）。`npm test` **28 文件/1269 项**、新护栏 115 项（5 类红验证精准）、typecheck 0、三构建 + 双端产物探针 PASS。**版本仍 1.7.6/vc24，零生产变更**；发版须先确认版本号。留证 `docs/实施留证-我的页与健康档案四端同构-2026-11-14.md`。
- ✅✅ **11-14 最新（覆盖下方旧版本口径）**：**V1.7.6 / vc24 已全量发版**，`d4975fa` + 滞留的 `4732dc5` 已 push，`main...origin/main` 同步。生产库 **0050** 已应用（`profiles.plan_started_at` 可空 + 回填 `created_at`，备份 `backup-before-0050-20261114-162513.dump`，FAIL=0）。**体重管理方案**三段卡片 + 红黄绿 BMI 参考带（四重非色彩编码）+ 第 N 天 / 达成日；`HEALTH_PLAN_*` 常量名与文件名不变。Web 19/19 逐字一致 / 18/18 探针 / 法务 v1.7.6 / healthz / Chromium PASS；Android 正式包三步实证全绿（产物级细节 → REFERENCE「11-14 19:45 迁入」）。`npm test` **27 文件 / 1138 项**、方案页护栏 **141 项**。留证 `docs/发版留证-体重管理方案-V1.7.6-vc24-2026-11-14.md`。🔴 产物探针「会员定价」「自动续费」命中为中性/否定式文案＝**假红**，精确 CTA 全 0；干净 Web 构建本就有 2 个 `index-*.js`（另一个是 zxing 稳定 chunk）。边界不变：iOS 需 Mac 重打包、mini 体验版本人上传、公网分发待批准。
- ✅✅ **云库废弃（REF 20:15）**：四端数据面全自建 PG、运行时零残留、数据放弃迁移。🔴 **释放差 2 步（用户本人）**：① 重传 mini 新版本+重设体验版 ② 停用实例（不可逆）；真机调试 ≠ 体验版。**实例仍在线**（dbproxy 401 `DATABASE_42501`）。**20:15 决策：数据可弃/免 T+7/当日释放，走①** → `docs/云库彻底释放执行单-*`。
- 🔴🔴 **mini 虚拟支付**（11-08，全文 → REFERENCE「11-08 晚间迁入」）：`wx.requestVirtualPayment`(米大师 xpay) 全链路就绪、开关默认 false；**开启前置 6 项在 `mini/src/lib/xpayEnabled.ts` 文件头**。铁律：补权益后**必调 `/xpay/notify_provide_goods`**、已扣款未确认 → **`settling` 绝不报 error**、`signData` 原样透传。
- 🔴🔴 **收款定案**（全文 → REFERENCE「2026-11-09 晚」）：Web 只引导、Android 能收款、四端业务零改动。🔴 两开关独立默认 false：`D_BEE_XPAY_ENABLED`(mini) / `D_BEE_APPPAY_ENABLED`(Android 按钮+Web 引导)；关闭态 Web 零引导字样。Android `0047`+`apppay.mjs`：微信 V3/支付宝 RSA2 零依赖密码学；**发权益权威信号＝验签回调 `settle_app_payment`**；`verify_payment_order` 查单语义（回调未到恒 false，绝不报 error）；幂等键 `out_trade_no`、金额校验拒「1 分钱买会员」。余 → REFERENCE §二。
- 🔴 **开启收款前置（资质未到位开关保持 false）**：微信开放平台移动应用审核 + 商户号 **APP 支付权限** + 支付宝企业应用 + **App 备案下证** + 软著 → 「1 分钱」真实联调（清单 → `docs/Web引导闭环与Android收款实装-2026-11-09.md` §五）。🟠 公网分发待批准（A7）。
- 🔴🔴 **兑换码 P0 + 0048**（详版 → REFERENCE「2026-11-10 晚」）：3 张 lifetime 码明文进 public 历史 → 已 DELETE；0048 零止损但**已应用生产**。护栏只钉哈希、永不写明文（连注释都不行）；核验用库内 sha256 比对，绝不调 `redeem_by_code`（真烧码）；`--months`=兑换后时长 / `--expires-days`=可兑窗口，无日卡档。
- 🔴🔴 **`psql`/脚本六铁律**（详版 → REFERENCE）：`-v` 走 `-f`+heredoc / 解析用 `-tA` / 变更类禁 `2>/dev/null` / **发码明文先落盘再写库** / 清理脚本用 `${VAR:?}` / sed 遇特殊密码静默不改 → 改 Python 临时脚本。
- 🟠 **备案链**：域名/ICP ✅ 已下证；App / 小程序 / 算法 / 公安备案均管局审核中（前两项硬阻断 Android 上架、mini 发版+虚拟支付开通）。`四端收款堵点与政策依据详表`（**结论 #5 已作废**）与 `四端收费一致性核验与合规实施总纲`（L1~L3/护栏/发版验收仍有效）均加纠偏横幅。
- 📚 **11-13 已完成 / 过时快照**（Web 0048 水位、Android vc22、25 文件/975 项工程基线、11-11 mini 兑换修复、官网上生产、首购半价作废回退）已逐字迁入 `REFERENCE.md`「11-14 迁入」，零信息丢失；**当前版本口径以上方 11-14 最新条目为准**。

## 下一步 / 待拍板（详版 → REFERENCE.md）

- 🔴 未提交：`android/app/build.gradle` **versionCode 20→22**（v1.7.4 打包前置，唯一未提交项）；其余 11-13 改动均已 commit/push（`git status -sb`）。首购半价不再 commit。
- 🔴 **主线 = iOS 上线**（权威 `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`）：正式上架卡软著(30–60 工作日)/App 备案(7–20)/Mac 签名；最大交付 = **TestFlight 内部测试**（需 Mac+Team+重打包）。ASC 填报面几乎空白；Apple 硬闸门 Xcode 26 + iOS 26 SDK、新年龄分级问卷必答。🔴 壳内停在 11-04，apppay + A-5 真删号 + 16px 修复须 Mac 重打包。
- 🔴 **只有用户本人能做**：软著 AI 条款、Mac 选 `DEVELOPMENT_TEAM`、证书入 `signing/`、mini 发版、云库停用、公安备案回填、ASC 填报、算法备案收尾、**支付资质申请**（微信移动应用 + 商户号 APP 支付 + 支付宝企业应用）。
- 🔴 **三端晃动（REF「11-12 上午」）**：16px 在 `styles.css:83`；**Web ✅ / Android vc22 ✅ / mini ✅**；**iOS ❌**（壳内 11-04，须 Mac 重打包）。`100vw`/`100dvh` 未动。
- 🔴 **四端分享修复（11-12，全文 → `docs/四端分享功能梳理与修复-2026-11-12.md`）**：iOS 微信拉不起/钉钉链接打不开 = 图片 base64 被塞进 Share 的 `url` → 改 Filesystem 写 Cache + `files`；原生邀请链接改用公网域名。护栏 19 红验证 + 23/908 绿、Android 壳内已同步。**iOS 未重打包**：须 Mac（壳内仍 11-04）。
- 🟠 **对标薄荷 / 备案等待期**（11-12，详版 → REFERENCE「13:40」「14:22」）：§1.2 复核 + PCM #3 立项；Wave 4.1 图片指纹违隐私政策须删。计划 → `docs/备案等待期-差距缩减与超越实施计划-2026-11-12.md`（6–12 周 / A 不追·B 清零·C 反超 / D0 无度量 / P0~P2 + 9 项待拍板）。
- ✅ **P0 执行**（详版 → REF「16:22」「16:45」）：P0.1 零删除重构建闭环 / P0.2 度量 / P0.3 口径护栏 / P0.4 水位 0048 / P0.7 提醒默认关，24/933 绿；P0.5 待评审、P0.6 缺公安备案号、P0.8 待拍板。🔴 上传·体验版·停库须用户本人（**免 T+7** → 20:15）。
- ✅ **P1.4/1.5/1.6**（详版 → REF「17:30」）：shared 文案真源 + 四端渲染 + 护栏 25；mini 用 `MINI_RECORDING_CAPS` 省略无扫码/包装。**Web/Android 已含文案，mini/dist 未重构建**（P1.7）。
- ✅ **21:50 透明化说明默认收起**（改 2 组件 `TransparencyNotes.tsx` + 护栏 25-E 11 项，`c3268c5` 已入库；详版 → REF「21:50」）：数据/能力/次数三块默认收起、点击展开（复刻「饮食体检」手势 + `aria-expanded`），只改可见性不删文案、不记忆偏好；四端源码一次覆盖。
- 🟠 **待拍板**（详版 → REFERENCE）：隐私政策 §五 + `LEGAL_UPDATED`、mini 同意窗重确认载体、凭据轮换、网关模式收紧、Android vc22 公网分发、护栏 A9/A10、Apple 个人 vs 备案企业主体、仓库是否转 private。
- ⚠️ 已决不再讨论：云库回迁自托管 / 老用户不迁移 / 存量 newbie bonus / 演示数据两套面 / App 名称=`自律蜜蜂` / 凭据不打进终端 / **mini 微信虚拟支付** / **Android 微信+支付宝 APP 支付** / **Web 暂不收费、ICP 经营许可证不办** / **不做渠道首月半价**（11-11 已回退）。
- 三条主线：**开发**（看板=本文件「现状」，自动化每日收敛）；**备份两层**（cron 03:30 `pg_dump -Fc` + 异地副本，含真实健康数据**严禁 git add**）；**运营**（每周提醒）。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**决策（10-22 起）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）⑦ 收款路由见「已决不再讨论」（两开关同源驱动）。凭据只存本地 `.env`。

## 架构铁律（12 条全文 → REFERENCE.md）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch；⑩原生包禁用 `npm run build`；⑧iOS 付费墙禁硬编码价兜底；⑪`addListenerNative` 三路设防。其余 ①平台差异只走 `src/lib/` ②`cloudConfig.ts` 零依赖 ④`validate.ts`/`errmsg.ts` ⑥原生能力禁吞成 0/空 ⑦`useModalA11y` ⑨OriginProxy 取消归一为 End ⑫跨引擎 message/stack 分开取 + `env(safe-area-inset-top)`。

## 云数据库安全铁律（最高优先级）

- 发权益函数必须 **SECURITY DEFINER + 入参白名单**；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。🔴 **0047 沿用此范式**。
- **0039 闸门**：权益函数只改自建 migrations 单库；🔴 云库废弃后**不再双库同步**（`db/cloud-patch-0039/`、`tools/split-*-for-cloud.py`、`deploy/probe-0039-parity.sh` 仅历史存档，勿再执行）。nginx 唯一生效模板=`nginx.selfhost.conf.example`，改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**（`app_users` FORCE RLS + 无 DELETE，只有属主 postgres 能删）；0045 范式 = 不带 owner_id 参数、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon` + `GRANT authenticated`。删号后前端禁调 `saveProfile()`；新增含 `owner_id` 的表须同步 0045 `v_tables`（护栏 9 拦）。

## 部署最高危（全量 → REFERENCE.md「部署侧坑」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（参照 `deploy/apply-vision-key-update.py`）；**只读/备份操作也绝不跑它**。
- 🔴 视觉链路 `BASE_URL`/`MODEL`/`API_KEY` 须**成对更换**且同步 `gateway.env.template`+`.secrets.local`（否则部署静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口**：旧 worker 仍持旧配置 → 立即验证会「假红」。修法 `sleep 8` + 重试 3 次；补丁脚本必须可重入。🔴 服务器端验收脚本三坑（`gateway.env` 0640 需 `sudo -n` / 临时账号须 `trap cleanup EXIT` / Windows 禁 `wsl.exe`）。

## 环境备忘（🔴 全节逐字原文 → REFERENCE「环境备忘」全节逐字归档；此处只留一句话级触发线索）

- **连接/路径**：SSH `150.158.51.106`、`USER=ubuntu`+`SSH_PWD`（`.env` 的 `DBEE_USER=dbee_app` 认证失败）；验收打 `https://d-bee.cn/` **别打 IP**；APK 归档 `release/`；`db/backups/offsite/*.dump` 含真实健康数据 **严禁 git add**；push 遇 `schannel` 失败 → 单次 `git -c http.sslBackend=openssl push`。
- **两条唯一权威**：数值口径 `src/lib/numfmt.ts`（禁自写 `toFixed`/`Math.round(n*f)/f`）；nginx **只反代 `/.cloud/` 与 `/auth/`** → 其余 POST 返 **405，405 不能判路由存在**。
- **测试防假绿**：vitest 强制串行，跑完必核对 `Test Files` 数 == `ls tools/*.test.ts`；mini 类型检查单独跑；构建期护栏写在构建配置里；禁硬编码日期（同源取 `todayKey()`）；**小程序验收一律以体验版为准**（真机调试注入 Web API 掩盖 JSCore 缺口）；MAPE 达标 ≠ 无需处理（四指标并报，达标前不得对外表述精度）。
- **护栏断言三铁律**：①一个 `it()` 只一条断言 ②匹配「实际使用」非「标识符出现」③断言在 `stripComments()` 后代码上做；新增/放宽**必须红验证**，且🔴 **须确认注入真生效**（`assert s.count(old)==1` 失败会静默跳过注入却仍全绿 → 按行号定位）；禁用域名是判据不是依赖（护栏 10c 白名单+正向断言）。
- **产物判读三条**：①**中文形态分工具链**（mini=纯 ASCII `\uXXXX`→`unicode_escape`，勿 `latin1`；Web 主端=UTF-8 直存）②`import.meta.env.VITE_*` 字符串替换 grep 命中≠生效、`define` 布尔才被 terser 折叠 ③**裸串 grep 子串碰撞**（「下单」命中「预下单」）→用完整 CTA 短语；判数据面追「哪个常量被 `resolveEndpoint` 返回」。
