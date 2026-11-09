# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **全部详版在 `REFERENCE.md`**。本文件只留决策、铁律结论与指针。
> 🔴 **体积 ≤9k 字符**（非字节）；超限旧版已归档进 `REFERENCE.md`。
> 状态默认写保守态，确证后才写完成态；commit 查 `git log`，同步态查 `git status -sb`，**勿写死哈希与「待推 N 个」**。
> 🔴 协作：不乱增加复杂度，**决策前先征求用户同意**（尤其生产变更）；同一任务只在一个会话执行。

## 权威口径（勿再改动；详版 → REFERENCE.md）

- **Bundle ID = `cn.com.dbee.app`**（iOS/Android 同值）；**版本 1.7.3**（Android vc16 / iOS build 12 / mini 0.1.0）。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web（隐私政策 / Apple webhook / Universal Link / 原生 endpoint）；`d-bee.com.cn` = 公司官网静态页。
- 🟢 **ICP 已下证（11-06）**：`-1`=官网、`-2`=自律蜜蜂。🔴 生效代码任何位置**不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`；`POLICE_BEIAN` 仍空（不渲染＝合规），公安备案已启动、拿到号回填（法定 **2026-12-06 前**）。
- 🔴 **公开公示信息不得只放 `.env`**（备案号/主体名/资质号）：被 gitignore → 换机器/CI 静默产出无备案号页面。
- 🔴 **原生包禁用 `npm run build`**（白屏）：内测 `npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。
- 🔴 **产物自检以 `index.html` 引用的入口 js 为唯一真源**：干净构建本就有 2 个 `index-*.js`，「>1 个＝残留」是错误判据。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法见 REFERENCE.md。
- 📄 **隐私政策静态页**：`npm run build` 自动生成 `dist/legal/`（零 JS 可爬，OPPO 硬要求）；**别用 `build:web`**（会删掉 `dist/legal/`）。

## 现状（2026-11-09 · Web 含定价页已上线 + Android vc16；详版 → REFERENCE）

- ✅ **WEB 完全上线** `https://d-bee.cn/` 200；**11-09 已重部署含定价页**，入口 js `index-677ckuM3.js`→`index-Bm9H-Xgy.js`（线上/本地 sha256 逐字一致）；三法务页 200、308=2/301=0；证书到期 **2027-02-04**。
- ✅ **数据面 = 自建 PostgreSQL `dbee`**（`healthz` 实证），生产迁移水位 **0045**（🔴 0046 xpay 迁移**已写未应用**）；审核演示账户 `dbeesupport@163.com` 实测 signin 200 + token。
- ✅✅ **云端库彻底废弃（11-08 用户指令）**：四端生产数据面全指自建 PG，**运行时云库残留已清零**（mini 删 `CLOUD_HOST`/`cloud` 分支、显式 cloud 一律 throw；`CLOUD_*`→`SELFHOST_*`；原生插件同源；vite 删云库内测口）。**护栏 10/10b** 红验证精准；产物零云端域名。逐项 → 清单 §一/§七/§八。
- 🔴 **云库数据放弃迁移**（云库无身份表、owner_id 19 位数字 ≠ `wx:<openid>` → 孤儿数据）；**实例仍在线未停用**（平台控制台、不可逆、须用户本人，建议 selfhost 真机验收 T+7 后）。
- 🔴 **「彻底释放」仍差 2 步，均需用户本人**：① **重新上传 mini 体验版**（11:33 版报 `TextDecoder is not defined`，已在 `mini/src/lib/textDecoderPolyfill.ts` 修好并重建 —— **须重新上传新版本号 + 重设体验版才生效**）；② 云库实例停用。🔴 **线上旧包仍连旧云库、真实用户仍在写入**。**真机调试通过 ≠ 体验版通过**。详见清单 §九/§十。
- 🟠 尾巴：网关「模式=开发」（`DBEE_PROD` 未设）、安全响应头、certbot renew 后复核 308、凭据轮换、`APPLE_*` env 全缺、公安备案回填（12-06 前）。常规部署应设 `DBEE_DOMAIN=d-bee.cn`；git push 已恢复（复发 schannel 走环境备忘预案）。
- ✅ 11-08 mini 三连对齐（统一录入层 / iOS 栈溢出结案 / 权益订阅健康对齐主端，护栏 16）。详版 → 当日日志。
- 🔴 **21:18 mini 微信虚拟支付售卖**（用户指令推翻 16:48「不引入在线支付」）：会员属**虚拟商品** → `wx.requestVirtualPayment`（米大师 xpay）。全链路代码就绪（0046 + `server/lib/xpay.mjs` + `mini/src/lib/xpay.ts` + 付费墙三档 + legal 同开关），**构建期开关 `D_BEE_XPAY_ENABLED` 默认 false**，同时驱动售卖 UI 与法务口径（法务文本必须构建时确定）。**开启前置 6 项清单在 `mini/src/lib/xpayEnabled.ts` 文件头**。**先配平台，再开开关。**详版 → REFERENCE「11-08 晚间迁入」。
- 🔴🔴 **xpay 资损铁律**（详版 → REFERENCE「11-08 晚间迁入」）：① 推送丢失查单兜底补权益后**必须调 `/xpay/notify_provide_goods`**（Apple 单 `order_type=7` 不调），否则订单停在「已支付待发货」→ **资金不结算**；失败只留痕不抛。② 已扣款未确认到账 → **`settling`，绝不报 error**；`savePending` 必须**早于**轮询。③ `signData` **原样透传**，改字段顺序 → -15005/-15006。④ 道具直购 = 预付费时长、**不自动续费**，绝不照抄 iOS「24 小时自动续订」（= 虚假宣传）；兑换码必须「免费获得」。⑤ provider 必须 `'wechat_xpay'`。
- 🔴 **Web 定价展示 + 小程序下单引导**（阶段 1+2；**11-09 已部署上线**，详版 → REFERENCE「11-08 晚间迁入」）：公开定价页 `PricingSheet`（未登录可见、零 `<button>`、入口挂 `SiteFooter` 仅 Web）+ `MiniOrderGuide` + 配置真源 `lib/miniOrderGuide.ts` + 权益清单 `content/membership.ts`。🔴 **Web 引导复用 mini 的 `D_BEE_XPAY_ENABLED`**（vite 注入 `__XPAY_SALE_ENABLED__`），一个变量同决定两端，默认关闭时 Web **零「下单」字样**（防引导到不卖东西的小程序 = 虚假宣传）；legal §六 双分支、`UPDATED` 未动。四端业务逻辑零改动。护栏 18（31 项，红验证 4 破坏→6 红）。开启前置 → `docs/Web端跳转小程序-静态码操作手册-2026-11-08.md` §三。
- ✅ **11-09 Android vc16 正式包**（vc15→16 重打含定价页；详版 → 当日日志）：三步实证 = aapt vc16 / apksigner MD5 `0abe7fc5...45fb9dc9` 与备案逐字一致 / APK 内 `index-DdEPR-Bn.js` 零云库+零下单+含 `delete_own_account`。归档 `release/D-Bee-1.7.3-vc16-dbee.cn-FORMAL-20261109.apk`。🔴 打包后已 `npm run build` 恢复 web dist（native 会删 `dist/legal/`）。🟠 **公网分发待批准**（清单 A7）。
- 工程基线：`npm test` = **16 文件 / 731 项全绿**；跨端护栏 **18 道**（17 = xpay-consistency 27 项；18 = web-no-payment 31 项，断言项见该文件头）。🔴 改 `packages/shared/src` 后**必须** `cd packages/shared && npm run build`。🔴 **开关构建变体自检**：mini grep `dist/common.js` 的 `enabled:"true"/"false"`；Web grep「下单」字样（默认构建必须 0）。📄 清单 `docs/待办清单-云库废弃收尾-2026-11-08.md`。

## 下一步 / 待拍板（详版 → REFERENCE.md）

- 🔴 **主线 = iOS 上线**，权威 `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`；中国区正式上架卡软著（30–60 工作日）/ App 备案（7–20）/ Mac 签名，最大交付物 = **TestFlight 内部测试**（Mac + Xcode≥26 + Team + 重打包）。ASC 填报面几乎空白（逐字段答案 `docs/ASC表单填报答案-2026-11-07.md`）；Apple 硬闸门：Xcode 26 + iOS 26 SDK（2026-04-28 生效）、新年龄分级问卷必答（2026-01-31）。壳内产物停在 11-04，重打包前必须重打。
- 🔴 **只有用户本人能做**：软著 AI 条款口径回填、Mac 选 `DEVELOPMENT_TEAM`、iOS/鸿蒙签名证书入 `signing/`、mini 发版（开服务端口→上传→体验版验收→提审）、云库实例停用、公安备案回填、ASC 表单填报。✅ 11-07 已定案 App 名称 `自律蜜蜂`。
- 🟠 **待拍板**（详版 → REFERENCE「待拍板·详版」）：隐私政策 §五 + `LEGAL_UPDATED` 刷新（**全体老用户重弹同意窗**）、mini 无同意窗重确认载体、凭据轮换、网关模式收紧、Android vc15 公网分发、护栏 A9/A10、一致性第三类、Apple 个人主体 vs 备案企业主体。
- ⚠️ 已决不再讨论：ICP 经营许可暂不办 / 云库去留=回迁自托管 / 老用户不迁移数据 / 存量 7 行 newbie bonus / 演示数据两套面互不相通 / App 名称=`自律蜜蜂` / 凭据不打进终端 / **小程序会员售卖走微信虚拟支付（见现状 21:18）**。
- 三条主线：**开发**（看板=本文件「现状」，自动化「D-Bee 开发进度盘点」每日收敛）；**备份两层**（cron 03:30 `pg_dump -Fc` + 异地副本 `deploy/pull-latest-backup.py`，含真实健康数据**严禁 git add**）；**运营**（彩页、社群，自动化每周提醒）。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**6 项决策（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）。凭据只存本地 `.env`。🆕 11-08 ⑦ **小程序会员售卖走微信虚拟支付**，售卖能力与法务口径由 `D_BEE_XPAY_ENABLED` 同源驱动（见现状 21:18）。

## 架构铁律（12 条全文 → REFERENCE.md）

最易踩：⑤**StoreKit 2 服务端核销成功才 `finish()`**（退款只 finish 不核销）；③云端请求走 `OriginProxy` 注入 SDK `options.fetch`、勿 patch window.fetch。
其余：①平台差异只走 `src/lib/`、探测 `window.Capacitor` ②`cloudConfig.ts` 零项目内依赖 ④校验 `validate.ts`/文案 `errmsg.ts` ⑥原生能力返回显式状态、禁吞成 0/空 ⑦弹窗无障碍 `useModalA11y`/`onActivateKey` ⑧iOS 付费墙禁硬编码价兜底 ⑨OriginProxy 取消归一为 End、绝不回退缓冲重发 ⑩原生包禁用 `npm run build` ⑪Capacitor `addListenerNative` 三路设防 ⑫跨引擎 message 与 stack 分开取 + 安全区 `env(safe-area-inset-top)`。

## 云数据库安全铁律（最高优先级）

- 发权益函数必须 SECURITY DEFINER + 入参白名单；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。
- **0039 闸门**：新增/修改权益函数只改自建 migrations 单库即可；🔴 云库废弃后**不再双库同步**，`db/cloud-patch-0039/`、`tools/split-*-for-cloud.py`、`deploy/probe-0039-parity.sh` 均仅历史存档，勿再执行。
- nginx 唯一生效模板=`nginx.selfhost.conf.example`；改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。
- 单条 SELECT 求值顺序未定义：`set_config` 混函数须 `WITH s AS MATERIALIZED`。
- 🔴 **删号/身份类改动走 PostgREST SECDEF RPC，别改网关**（`app_users` FORCE RLS + 无 DELETE，只有属主 postgres 能删）；0045 范式 = 不带 owner_id 参数、只信 `auth.uid()`、`p_confirm` 闸门、`REVOKE PUBLIC/anon` + `GRANT authenticated`。删号后前端禁调 `saveProfile()`；新增含 `owner_id` 的表须同步 0045 `v_tables`（护栏 9 拦）。详版 REFERENCE「0045」。

## 部署最高危（全量 → REFERENCE.md「部署侧坑」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 `IDENT_PEPPER` 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（参照 `deploy/apply-vision-key-update.py`）；**只读/备份操作也绝不跑它**。
- 🔴 SSH=`USER=ubuntu`+`SSH_PWD`；`.env` 的 `DBEE_USER=dbee_app` **实测认证失败**（过时值）。视觉链路 `BASE_URL`/`MODEL`/`API_KEY` 必须成对更换且同步 `gateway.env.template`+`.secrets.local`（否则下次部署静默回退）。
- 🔴🔴 **nginx reload 有优雅退出窗口**：旧 worker 仍持旧配置 → 立即验证会「假红」。修法 `sleep 8` + 重试 3 次；补丁脚本必须可重入。
- 🔴 服务器端验收脚本三坑（`gateway.env` 0640 需 `sudo -n` / 造临时账号必须 `trap cleanup EXIT` / Windows 调 bash 被禁 `wsl.exe` → 改纯 SFTP），详版 REFERENCE。

## 环境备忘（详版 → REFERENCE.md）

- SSH `150.158.51.106`（🔴 `SSH_PWD` 明文勿入记忆/文档）；**验收一律打 `https://d-bee.cn/`，别打 IP**（IP http 已由 200 变 404）。
- APK 归档 `release/`（**绝不放在 `android/app/build/outputs/apk/release/` 内**，Gradle 会清理）；Web 归档 `backups/`；异地备份 `db/backups/offsite/*.dump` 含真实健康数据，严禁 git add / 移出项目。
- 🔴 **nginx 只反代 `/.cloud/` 与 `/auth/`**，其余 POST 落静态层返回 **405** → 不能用 405 判断网关路由是否存在；判路由要打正确前缀并用「对照已存在路由返回 401」区分。
- 🔴🔴 **测试 = vitest**（`npm test` = `vitest run tools/`），`vite.config.ts` 强制串行（并行会静默丢文件＝假绿）；跑完必核对文件数。**mini 类型检查须单独跑**；构建期护栏必须写在构建配置里（webpack 不执行被打包模块顶层代码）。
- 🔴 **测试禁止硬编码日期**：被测函数用 `rangeDays(N)`／`todayKey()` 圈窗口时，`log_date` 必须同源取 `todayKey()`，否则窗口滑走 → 被 `inRange.has()` 静默过滤 → 集体假红（11-08 `report-ratio.test.ts` 踩坑）。
- 🔴 **MAPE 达标 ≠ 无需处理**：四指标并报，实测需真机+样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字。
- 🔴🔴 **护栏断言三条铁律**：①一个 `it()` 只一条断言 ②匹配「实际使用」非「标识符出现」 ③断言在 `stripComments()` 后的代码上做。新增护栏 / 放宽快照基线**必须红验证**。「反向检测」脚本里的禁用域名是**判据不是依赖**，须白名单 + 正向断言补上（护栏 10c），不能硬删字符串骗绿。
- 🔴 **小程序验收一律以体验版为准**：真机调试会话会注入 `TextDecoder` 等 Web API 掩盖 JSCore 缺口，开发者工具 `urlCheck=false` 还掩盖合法域名问题。
- 🔴 **产物中文形态分工具链**：**mini（Taro/webpack）= 纯 ASCII `\uXXXX`** → Python `codecs.decode(s,'unicode_escape')`，🔴 切勿再 `.encode('latin1','ignore')`（会把中文整个丢掉）；**Web 主端（vite）= UTF-8 直存中文** → 直接 UTF-8 读，套 unicode_escape 会全假阴性。判断数据面要追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论。
- 🔴 **构建期字符串替换 vs 布尔常量注入的验证法不同**：`import.meta.env.VITE_*` 是字符串替换（字面量留在产物，grep 命中 ≠ 生效）→ 安全过滤逻辑必须抽纯函数单测；`define` 布尔常量才会被 terser 死代码折叠（可用「引导字样 0 命中」验证开关）。
- 🔴 git push 遇 `schannel: failed to receive handshake` → 单次 `git -c http.sslBackend=openssl push origin main`，别反复重试当成网络不通。
- 🔴 **数值口径唯一权威 `src/lib/numfmt.ts`**（计算层全精度、只在展示层插值那一刻舍入），禁止自写 `toFixed` / `Math.round(n*f)/f`。
