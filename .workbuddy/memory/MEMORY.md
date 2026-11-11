# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **全部详版在 `REFERENCE.md`**。本文件只留决策、铁律结论与指针。
> 🔴 **体积 ≤9k 字符**（非字节）；超限旧版归档进 `REFERENCE.md`。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增加复杂度，**决策前先征求用户同意**（尤其生产变更）；同一任务只在一个会话执行。

## 权威口径（勿再改动；详版 → REFERENCE.md）

- **Bundle ID = `cn.com.dbee.app`**（iOS/Android 同值）；**版本 1.7.3**（Android vc17 / iOS build 12 / mini 0.1.0）。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web（隐私政策 / Apple webhook / Universal Link / 原生 endpoint）；`d-bee.com.cn` = 公司官网。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码任何位置**不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；`POLICE_BEIAN` 仍空（不渲染＝合规），下证后回填（**2026-12-06 前**）。🔴 **公开公示信息不得只放 `.env`**（备案号/主体名/资质号）：被 gitignore → 换机器/CI 静默产出无备案号页面。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。🔴 二者与 web **共用 `dist/`**，且 native / `build:web` 都会**删掉 `dist/legal/`**（隐私政策静态页零 JS 可爬＝OPPO 硬要求）→ **部署 web 前必须重跑 `npm run build`** 并比对入口 js 文件名。**产物自检以 `index.html` 引用的入口 js 为唯一真源**（干净构建本就有 2 个 `index-*.js`）。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法见 REFERENCE.md。

## 现状（截至 2026-11-11 21:35 · Web 上线 / 兑换码加固 / 首购半价方案已作废回退；详版 → REFERENCE）

- ✅ **WEB 上线** `https://d-bee.cn/` 200；线上入口 js **`index-PoY9AgRG.js`**（11-11 重部署含 iOS 输入框 16px 修复，线上/本地 sha256 一致）、三法务页 200、证书到期 **2027-02-04**。**数据面 = 自建 PostgreSQL `dbee`**（`healthz` 实证），生产迁移水位 **0048**。🔴 **0046 xpay / 0047 apppay 仍未应用 → 版本表跳号空洞**（实测无害；补应用须 **0046→0047 顺序**，0047 覆盖 0046）。Android **vc17** 重打归档（含 apppay，开关默认关）。
- ✅✅ **云端库彻底废弃（11-08）**：四端数据面全指自建 PG、运行时残留清零、产物零云端域名（护栏 10/10b）；数据放弃迁移。🔴 **「彻底释放」仍差 2 步、均需用户本人**：① 重传 mini 体验版（`TextDecoder` polyfill 已补，**须新版本号+重设体验版**）② 云库实例停用（不可逆）；**实例仍在线、旧包仍连旧库、真实用户仍在写入**，真机调试 ≠ 体验版。🟠 尾巴逐项 → `docs/待办清单-云库废弃收尾-2026-11-08.md`。
- 🔴🔴 **mini 微信虚拟支付售卖**（11-08）：虚拟商品 → `wx.requestVirtualPayment`（米大师 xpay），全链路就绪（0046 + `xpay.mjs`/`xpay.ts` + 付费墙三档 + legal 同开关），开关默认 false；**开启前置 6 项在 `mini/src/lib/xpayEnabled.ts` 文件头**。头号铁律：补权益后**必调 `/xpay/notify_provide_goods`**、已扣款未确认 → **`settling` 绝不报 error**、`signData` **原样透传**。全文 → REFERENCE「11-08 晚间迁入」。
- 🔴🔴 **收款定案 + Android 已实装**（全文 → REFERENCE「2026-11-09 晚」；权威 `docs/Web引导闭环与Android收款实装-2026-11-09.md`）：**Web 暂不收费只引导到 mini/App，Android 实装到能收款，四端业务逻辑零改动**。🔴 **两开关各自独立、默认 false**：`D_BEE_XPAY_ENABLED`（mini）/ `D_BEE_APPPAY_ENABLED`（同决定 Android 支付按钮 + Web 引导）；关闭态 Web **零引导字样**。Android 侧（`0047` + `apppay.mjs` 715 行 + `apppayClient.ts`）：微信 V3 + 支付宝 RSA2 **零依赖密码学**；**推模式结算**——发权益权威信号＝服务端验签回调 → `settle_app_payment`；`verify_payment_order` 改**查单语义**（回调未到恒 false，「权益到账中」**绝不报 error**）；**幂等键＝`out_trade_no`**、**金额校验**拒发「1 分钱买会员」。🔴 其余铁律 → REFERENCE §二。
- 🔴 **开启收款前置（资质未到位前开关保持 false）**：微信开放平台移动应用审核 + 商户号 **APP 支付权限** + 支付宝企业应用 + **App 备案下证** + 软著 → 「**1 分钱**」真实联调（清单 → 权威文档 §五）。最新正式包 = vc17（归档 `release/`）；🟠 公网分发待批准（A7）。
- 工程基线：`npm test` = **22 文件 / 887 项全绿**（11-11 21:35 回退后实测，`Test Files` == `ls tools/*.test.ts`；16:53 记的 21/870 已过时）。🔴 改 `packages/shared/src` 后必须 `cd packages/shared && npm run build`（**回退 src 后同样要重建 dist**）。🔴 **Web「下单」判据已失效**（`预下单` 子串恒 3 命中）→ 改判**真实引导 CTA 全 0**（`去小程序下单`/`去 App 购买`/`立即购买`/`去支付`）。
- 🔴🔴 **兑换码 P0 事故 + 0048 加固**（详版 → REFERENCE「2026-11-10 晚 · 兑换码 P0」）：3 张 **lifetime** 码明文留在 **public** 仓库历史 → 已 DELETE 止损（total=0）；🔴 **0048 对此零止损**（先回填 hash 再清明文，泄露码照样算出同 hash）。0048（哈希+有效期+节流）**已应用生产**。🔴 **护栏只钉哈希永不写明文（连注释都不行）**。🔴 核验已发的码用**库内比对 sha256**，绝不调 `redeem_by_code`（调了就真烧码）。🔴 发码参数正交：`--months`=兑换后时长、`--expires-days`=可兑换窗口；**体系无日卡档**（最小 1 月）。
- 🔴🔴 **`psql`/脚本六铁律**（详版 → REFERENCE「psql 三坑」「sed 分隔符坑」）：① 需 `-v` 插值必须走 `-f`+heredoc ② 解析输出必须 `-tA` ③ 变更类语句绝不 `2>/dev/null`+显式查退出码 ④ **发码类明文先落盘再写库** ⑤ 一次性清理脚本别留 id 默认值 → `${VAR:?}` ⑥ **sed 分隔符坑**：密码含特殊字符时 `sed "s|__X__|$PW|"` 报 `unknown option to 's'` 且静默不改文件 → 改 Python f-string 写临时脚本（用后即删+断言 `exists=False`）。
- 🟠 **备案链**：域名/ICP ✅ 已下证；App / 小程序 / 算法 / 公安备案均管局审核中（前两项硬阻断 Android 上架、mini 发版+虚拟支付开通）。`四端收款堵点与政策依据详表`（**结论 #5 已作废**）与 `四端收费一致性核验与合规实施总纲`（L1~L3/护栏/发版验收仍有效）均加纠偏横幅。
- ✅ **11-11 mini 兑换成功反馈修复（已 commit/push `3a449cc`）**：用户实测「点了兑换没提示、实际已成功」。两缺陷已修：① 提示条页顶 + `navigateBack` 销毁 → 补 `Taro.showToast`（`icon:'none'`）② 文案写死「终身会员已生效」谎报档位 → 下沉 shared `redeemSuccessText(ent)` 按真实权益生成。新增护栏 `tools/mini-paywall-feedback.test.ts`。
- 🟠 **11-11 官网独立项目上生产（跨项目，主项目代码/配置零改动）**：`d-bee.com.cn` 官网独立仓库 `E:\DEV\d-bee-website`（`github.com/yutaiyin139/d-bee-website`），按「AI 拍照识别饮食热量」真实产品逻辑重设计上线（弃 11-01「AI 习惯养成」错原型）；`check-facts.mjs` 23 条护栏逐字对齐主项目 `PRODUCTS`/`priceTag()`/`membership.ts`/`PricingSheet.tsx`/`legal.ts` 真源。🔴 主项目改这些文案须同步官网护栏快照。
- ⛔ **11-11 21:30 首购半价方案已作废并整体回退**（用户决定放弃渠道首月半价宣传）：17 改 + 3 新增全丢弃，业务代码回到 15:00 基线 `6b0bba7`；0049 从未应用、生产零影响、官网/法务无需改。改动完整备份（patch + 全量副本 + 恢复说明）→ 会话工作区 `.workbuddy/memory/backup/intro-revert-20261111-2130/`。技术分析与 21:25 复核缺陷留 REFERENCE「11-11 首购半价」（已加作废横幅）。

## 下一步 / 待拍板（详版 → REFERENCE.md）

- 🔴 当前无待提交源码改动（工作区仅记忆文件）；首购半价不再 commit。
- 🔴 **主线 = iOS 上线**（权威 `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`）：中国区正式上架卡软著（30–60 工作日）/ App 备案（7–20）/ Mac 签名，最大交付物 = **TestFlight 内部测试**（Mac + Xcode≥26 + Team + 重打包）。ASC 填报面几乎空白（答案 `docs/ASC表单填报答案-2026-11-07.md`）；Apple 硬闸门 Xcode 26 + iOS 26 SDK、新年龄分级问卷必答。🔴 壳内产物停在 11-04，**apppay + A-5 真删号须 Mac 重打包才进 iOS 包**。
- 🔴 **只有用户本人能做**：软著 AI 条款、Mac 选 `DEVELOPMENT_TEAM`、证书入 `signing/`、mini 发版（开端口→上传→体验版验收→提审）、云库停用、公安备案回填、ASC 填报、算法备案收尾、**支付资质申请**（微信开放平台移动应用 + 商户号 APP 支付权限 + 支付宝企业应用）。
- 🟠 **待拍板**（详版 → REFERENCE）：隐私政策 §五 + `LEGAL_UPDATED` 刷新（**全体老用户重弹同意窗**）、mini 无同意窗重确认载体、凭据轮换、网关模式收紧、Android vc17 公网分发、护栏 A9/A10、Apple 个人主体 vs 备案企业主体、仓库是否转 private。
- ⚠️ 已决不再讨论：云库去留=回迁自托管 / 老用户不迁移数据 / 存量 7 行 newbie bonus / 演示数据两套面互不相通 / App 名称=`自律蜜蜂` / 凭据不打进终端 / **mini 售卖走微信虚拟支付** / **Android 走微信+支付宝 APP 支付** / **Web 暂不收费只引导、ICP 经营许可证当前不办** / **不做渠道首月半价宣传**（11-11 21:30 定案，方案已回退）。
- 三条主线：**开发**（看板=本文件「现状」，自动化每日收敛）；**备份两层**（cron 03:30 `pg_dump -Fc` + 异地副本 `deploy/pull-latest-backup.py`，含真实健康数据**严禁 git add**）；**运营**（每周提醒）。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**决策（10-22 起）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）⑦ 收款路由见「已决不再讨论」（两开关同源驱动）。凭据只存本地 `.env`。

## 架构铁律（12 条全文 → REFERENCE.md）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**（退款只 finish 不核销）；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch；⑩原生包禁用 `npm run build`（详版见「权威口径」）；⑧iOS 付费墙禁硬编码价兜底；⑪`addListenerNative` 三路设防。其余 ①平台差异只走 `src/lib/` ②`cloudConfig.ts` 零项目内依赖 ④`validate.ts`/`errmsg.ts` ⑥原生能力禁吞成 0/空 ⑦`useModalA11y` ⑨OriginProxy 取消归一为 End、绝不回退重发 ⑫跨引擎 message/stack 分开取 + `env(safe-area-inset-top)`。

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
- **测试防假绿**：vitest **强制串行**，跑完**必核对 `Test Files` 数 == `ls tools/*.test.ts`**；mini 类型检查单独跑；构建期护栏须写在**构建配置**里；**禁硬编码日期**（`log_date` 同源取 `todayKey()`）；**小程序验收一律以体验版为准**（真机调试注入 Web API 掩盖 JSCore 缺口、`urlCheck=false` 掩盖合法域名问题）；MAPE 达标 ≠ 无需处理（四指标并报，达标前不得对外表述精度数字）。
- **护栏断言三铁律**：①一个 `it()` 只一条断言 ②匹配「实际使用」非「标识符出现」③断言在 `stripComments()` 后代码上做；新增/放宽**必须红验证**，且🔴 **须确认注入真生效**（`assert s.count(old)==1` 失败会静默跳过注入却仍全绿 → 按行号定位）；禁用域名是判据不是依赖（护栏 10c 白名单+正向断言）。
- **产物判读三条**：①**中文形态分工具链**（mini=纯 ASCII `\uXXXX`→`unicode_escape`，勿 `latin1`；Web 主端=UTF-8 直存）②`import.meta.env.VITE_*` 字符串替换 grep 命中≠生效、`define` 布尔才被 terser 折叠 ③**裸串 grep 子串碰撞**（「下单」命中「预下单」）→用完整 CTA 短语；判数据面追「哪个常量被 `resolveEndpoint` 返回」。
