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

## 现状（11-15 23:08 · V1.7.8 / vc26 已全量发版；下方 11-14 及更早条目为历史快照；详版 → REF）

- ✅✅ **11-15 23:08 V1.7.8 / vc26 全量发版**（🔴 实证数字唯一权威 = `docs/发版留证-小程序导出实装与占位护栏-V1.7.8-vc26-2026-11-15.md`；原文 → REF §六）：四项拍板 **D1** mini 通知诚实说明（真源 `isNotifyPushAvailable = CHECKIN_TEMPLATE_ID.length > 0`）／**D2** mini 导出**实装**（`isExportAvailable=true`，留 PIPL 45 条邮箱兜底 + false 态回退）／**D3** 删死代码／**D4** 护栏 29（39 项 + 反漂移），红验证 9/9。门禁 **30 文件 / 1329 项**、typecheck 双 0；Web **`index-CIpsiX29.js`** 19/19 逐字节一致；APK **8,262,867 B / `223a31a4…`**、入口 `index-D6Ix1upI.js`。
- 🔴 **剩余边界**：**mini 导出与通知说明零真机实证**（铁律 #13：本轮只证到「源码对 + 产物含实现 + 护栏绿 + Web 生产逐字节一致 + APK 三步实证」）；iOS 壳须 Mac + Xcode≥26 重打包；mini 体验版须本人上传 **`prebuild-20261115-2230/mini-dist-v178`**（🔴 **`mini/dist` 仍是 17:07 旧包 v1.7.7，导入即发旧版**）；Android 公网分发待批准（A7）；模板 ID 回填后**还须补服务端 `subscribeMessage.send`**。
- 🔴 **11-15 新踩 5 坑（详版 → REF §二）**：`dbee-ssh.py putdir` 不可靠 → **发布改逐文件 put + 事后全量 sha256**；`dist/` 为 Web/native 共用 → `cp -a` 覆盖会得**混合产物**，须先移出再复制 + 校验；**法务 URL 是 `/legal/<name>/index.html`**（写 `*.html` 命中 SPA fallback ＝假红，拿不存在路径对照即可识别）；APK 的 `capacitor.plugins.json` 在 `assets/`；**探针字串须取源码常量原文**。
- 📚 11-14 期口径（`0051` 编辑份量闭环 / `index-DfW2isy_.js` / 幽灵列探针）已归档 → REF §一（原文 §六）。**仍长期有效**：vite 把 2000 压成 `2e3`、5000 压成 `5e3` → 须匹配 `label:.份量.,min:1,max:…` 精确常量；验 schema cache 须真实 PATCH + 红验证；psql 用 `sudo -n … -f -`。
- ✅✅ **云库废弃（REF 20:15）**：四端数据面全自建 PG、数据放弃迁移。🔴 释放差 2 步（用户本人）：① 重传 mini+重设体验版 ② 停用实例（不可逆）；实例**仍在线**。20:15 决策：数据可弃/免 T+7/走① → `docs/云库彻底释放执行单-*`。
- 🔴🔴 **收款（原文 → REF §五；详版 → REF 11-08 / 11-09 节）**：mini xpay 与 Android `0047`+`apppay.mjs` 全链路就绪；两开关独立默认 false（`D_BEE_XPAY_ENABLED` / `D_BEE_APPPAY_ENABLED`，关闭态 Web 零引导字样）。铁律：补权益后必调 `/xpay/notify_provide_goods`；已扣款未确认 → `settling` **绝不报 error**；`signData` 原样透传；**发权益权威信号＝验签回调 `settle_app_payment`**；`verify_payment_order` 回调未到恒 false；幂等键 `out_trade_no`、拒「1 分钱买会员」；开启前置 6 项在 `mini/src/lib/xpayEnabled.ts` 头。🟠 资质未到位 → 开关保持 false、公网分发待批准（A7）。
- 🔴🔴 **兑换码 P0 + 0048**（详版 → REFERENCE「2026-11-10 晚」）：3 张 lifetime 码明文进 public 历史 → 已 DELETE；0048 零止损但**已应用生产**。护栏只钉哈希、永不写明文（连注释都不行）；核验用库内 sha256 比对，绝不调 `redeem_by_code`（真烧码）；`--months`=兑换后时长 / `--expires-days`=可兑窗口，无日卡档。
- 🔴🔴 **`psql`/脚本六铁律**（详版 → REFERENCE）：`-v` 走 `-f`+heredoc / 解析用 `-tA` / 变更类禁 `2>/dev/null` / **发码明文先落盘再写库** / 清理脚本用 `${VAR:?}` / sed 遇特殊密码静默不改 → 改 Python 临时脚本。
- 🟠 **备案链**：域名/ICP ✅ 已下证；App / 小程序 / 算法 / 公安备案均管局审核中（前两项硬阻断 Android 上架、mini 发版+虚拟支付开通）。`四端收款堵点与政策依据详表`（**结论 #5 已作废**）与 `四端收费一致性核验与合规实施总纲`（L1~L3/护栏/发版验收仍有效）均加纠偏横幅。
- 📚 11-13 过时快照（Web 0048/vc22/25 文件 975 项/11-11 mini 兑换/官网/首购半价回退）已逐字迁入 REFERENCE「11-14 迁入」；版本口径以上方 11-15（V1.7.8 / vc26）为准。

## 下一步 / 待拍板（详版 → REFERENCE.md）

- ✅ **git 已闭环**（11-14 的「push 待网络恢复 / ahead 2」已解除）：11-15 三次 push 成功，`main...origin/main` = `0 0`。11-14 的 P0 / P1.4-1.6 / 21:50 透明化收起均已入库并随 V1.7.6~V1.7.8 发版；**「mini/dist 未重构建（P1.7）」已于 11-15 两轮解除**（但用户上传仍未完成）。四条原文 → REFERENCE「2026-11-15 23:08 迁入」§四。首购半价不再 commit。
- 🔴 **主线 = iOS 上线**（权威 `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`）：正式上架卡软著(30–60 工作日)/App 备案(7–20)/Mac 签名；最大交付 = **TestFlight 内部测试**（需 Mac+Team+重打包）。ASC 填报面几乎空白；Apple 硬闸门 Xcode 26 + iOS 26 SDK、新年龄分级问卷必答。🔴 壳内停在 11-04，apppay + A-5 真删号 + 16px 修复须 Mac 重打包。
- 🔴 **只有用户本人能做**：软著 AI 条款、Mac 选 `DEVELOPMENT_TEAM`、证书入 `signing/`、mini 发版、云库停用、公安备案回填、ASC 填报、算法备案收尾、**支付资质申请**（微信移动应用 + 商户号 APP 支付 + 支付宝企业应用）。
- 🔴 **三端晃动（REF「11-12 上午」）**：16px 在 `styles.css:83`；**Web ✅ / Android vc25 ✅ / mini ✅**；**iOS ❌**（壳内 11-04，须 Mac 重打包）。`100vw`/`100dvh` 未动。
- 🔴 **四端分享修复（11-12，全文 → `docs/四端分享功能梳理与修复-2026-11-12.md`）**：iOS 微信拉不起/钉钉链接打不开 = 图片 base64 被塞进 Share 的 `url` → 改 Filesystem 写 Cache + `files`；原生邀请链接改用公网域名。护栏 19 红验证 + 23/908 绿、Android 壳内已同步。**iOS 未重打包**：须 Mac（壳内仍 11-04）。
- 🟠 **对标薄荷 / 备案等待期**（11-12，详版 → REFERENCE「13:40」「14:22」）：§1.2 复核 + PCM #3 立项；Wave 4.1 图片指纹违隐私政策须删。计划 → `docs/备案等待期-差距缩减与超越实施计划-2026-11-12.md`（6–12 周 / A 不追·B 清零·C 反超 / D0 无度量 / P0~P2 + 9 项待拍板）。
- 🟠 **待拍板**：隐私政策 §五 + `LEGAL_UPDATED`、mini 同意窗重确认载体、凭据轮换、网关模式收紧、Android vc25 公网分发、护栏 A9/A10、Apple 个人 vs 备案企业主体、仓库是否转 private。
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
