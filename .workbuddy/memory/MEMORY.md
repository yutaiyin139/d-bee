# D-Bee（自律蜜蜂）· 项目长期记忆（核心版；细节读同目录 REFERENCE.md 与当日日志）

> 🔖 **权威口径（勿再改动）**
> · **Bundle ID / appId = `cn.com.dbee.app`**（iOS+Android 同值）
> · **域名**：`d-bee.cn` = 自律蜜蜂 Web 端（隐私政策 URL / Apple webhook / Universal Link / 原生 endpoint 全用它）；`d-bee.com.cn` = 公司官网（纯静态）。同一企业备案订单（一单两站 -1/-2）。
> · **版本 1.7.3**（Android vc14 / iOS CURRENT_PROJECT_VERSION 12 / mini 0.1.0）
> · 🔴 **打原生包绝不能用 `npm run build`**（白屏，铁律 #10）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。
> · 🔴 **产物自检必须以 `index.html` 引用的入口 js 为唯一真源**（铁律 #11）：`ENTRY=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)`，再查 `dist/$ENTRY`。**干净构建本就有 2 个 `index-*.js`**（另一个是入口动态 import 的 chunk，hash 稳定），「>1 个 = 构建残留」是错误判据，会误判合法构建。同理 `describe()` 只在 `index.html` 内联脚本里，assets 中零命中。
> · 📄 **隐私政策静态页**：`npm run build` 会自动跑 `tools/gen-legal-static.mjs` → `dist/legal/{terms,privacy,disclaimer}/index.html`（零 JS 可爬，OPPO 硬要求）。单一真源 = `src/content/legal.ts`；`build:native*` 不生成（原生端不需要）。上线时 `dist/legal/` 须一并部署；nginx 无需改（`try_files $uri $uri/` 的 `$uri/` 命中目录 index）。备案号走 `VITE_ICP_BEIAN`，未传即整块不渲染。
> · 📄 **法律文案里的 `**强调**` 由两端渲染器各自转 `<strong>`**（11-02 修）：`LegalPage.tsx` 分段渲染（**不用 `dangerouslySetInnerHTML`**）、`gen-legal-static.mjs` 的 `rich()` **先 esc 后 bold（顺序不可颠倒）**；两端同带成对性守卫——`**` 为奇数时**剥星号**降级（保留星号=裸标记露出，奇偶分段=漏标记后正文全被误加粗）。改文案加 `**` 后须验产物 `grep -o '\*\*' | wc -l` = 0。渲染器只认 `p → list` 顺序，`list` 后无法再出段落；且 `DocSection` 只允许**一个** `p` 键（写两个 → TS1117）。

## 进度快照（截至 2026-11-04 晚）

**已完成**：iOS V1.7.3 已发布+上架就绪核查通过；Web **已发布生产 `http://150.158.51.106/`**（11-03 晚，`verify-live`+`verify-legal` 双 PASS，含 11-02 挂起的 `a977ee4` 一并上线）；Android vc13 验签通过 + vc14 内测包已交付待实测；阿里云真短信上线；ICP 企业备案已进管局；**11-03 全天密集收敛（P0/P1/P2 全项 + 四端一致性）**：苹果端合规 P0 清零（`74aa2bc` AI 显式标识 + 订阅摘要）；四端审计 `19eda78`（对标自律茄子/薄荷，P0~P2 计划）；小程序端 P0 全项 `07a46ca`（配额 fail-closed + AI 标识 9 处 + 免费手动录入 + 文案如实化）+ P1 全项 A~G（`842a879` numfmt 下沉 `@dbee/shared`、分享邀请码闭环、隐私授权门、MAPE 工具、兑换码调研、备案号渲染、在线支付前置清单）；P2 全项（导出置灰如实化、付费墙补永久无广告+积分兑Pro、退款误伤客服 SOP）；**四端一致性定价收敛 `7d61151`**（定价三副本 + 会员状态副本收敛单一真相源）；小程序上线前缺口清单 `b2efdfa`（证伪审计 5 处误判 + 揪 3 项真缺口）+ 阶段0备案口径 `877bd56`。**11-04 午后～晚间收敛（等备案期工程线 + 软著材料）**：四端一致性护栏 `2174cbe`（`tools/four-end-consistency.test.ts` 6 道 10 项，日期禁 toLocaleDateString / 定价禁硬编码 / 手写舍入快照 / 会员文案走 shared / AI 同意门清单 / 分叉须注释）+ `vite.config.ts` 强制 vitest 串行（**推翻 11-03「有 EPERM 时 exit=1 不假绿」结论**：实测 exit=0 假绿、丢 2 文件 40 项，已修）；四端上线路线图 `18cbc99`（首发建议 **mini**：唯一不依赖软著与 Mac）；技术白皮书（619 行 9 章 2 附录，`docs/自律蜜蜂技术白皮书-2026-11-04.md`，未提交）+ 软著完整材料清单（`docs/软著登记-完整申请材料清单-2026-11-04.md`，未提交）；Word 版白皮书已交付（`自律蜜蜂健康习惯追踪管理软件技术白皮书V1.0.docx`，封面/目录/九章/两附录）。更早条目读当日日志/`git log`。
**11-02 三项零资质整改闭环**：①小程序付费墙口径收敛 ②隐私政策静态 HTML 直出 ③iOS 管理订阅深链（`b3aab66`+`630ccd3`）；④§4.2 公示按包内实际能力补全（`99a1c52`，**法律文案待用户过目**）。§4.3 AI 显式标识 → **11-03 已解**（`74aa2bc`）：`src/components/AiLabel.tsx`（徽章+行内）接入 `CoachSheet`/`ReportScreen`/`LogSheet`（`isAiDraft()`：photo+text 全标，barcode 仅带 confidence 才标，manual/纯扫码不标）+ `legal.ts` 四之一补标识条款；同批补 `PaywallSheet` 订阅摘要块（周期+商店真实价+24h 续订+取消路径）。**主端代码合规 P0 已清零**。依据《标识办法》国信办通字〔2025〕2号 **2025-09-01 已施行**（我此前误记 2026-09-01）。总闸门视图见 `docs/苹果端上线前置条件总清单-2026-11-03.md`。

**11-03 下午：四端审计 + 小程序 P0-A~E 全部执行完**（审计 `19eda78`、执行 `07a46ca`，均已推）。审计文档 `docs/四端一致性与商业化优化-审计与实施计划-2026-11-03.md`；细节与逐条理由读 `2026-11-03.md`。**只改 `mini/`、主端零改动**（验证 `git status --porcelain -- src/ server/ packages/ db/` 为空）。三条最易踩的坑：① 小程序 `getPhotoQuota` **与主端故意不同**——主端 throw，本端返回 `degraded` 标记不抛（调用点是 `Promise.all` 并发，抛异常会让整屏数据一起变空）；`degraded` 让 UI 分开「服务降级」（不弹付费墙）与「额度用尽」。② `releasePhotoQuota` 返回 `boolean`（主端仍 `void`）**是有意超集**——识别失败必须退还预占额度（否则违反「识别成功才扣次数」），退还可能失败，UI 须按真实结果措辞。③ `checkin.tsx` 是**无入口孤儿页但不可删**（已注册 → 小程序码/分享路径可直达）；手动录入正式实现在首页内联弹层。**验证**：mini tsc src/ 错误 0、`build:weapp` 成功（896K < 2MB）；主端回归 tsc 0 + 逐文件 vitest **47/47 全绿**。


> ✅ **Git 同步态一律以 `git status -sb` 为准、此处不写死**。**web 已发布生产 `http://150.158.51.106/`**（11-03 晚，发布跑 `npm run build` 而非 `build:web`）。
> 🔴 **纪律自我打脸（今天第二次）**：我曾写「本地与远端均 `b528988`，无待推提交」，几分钟后推送失败就让它变成过时记载；改回「待推 1 个」后，又因新增一个提交再次过时（变成 2 个）。与上午 14:2x 那次同源。
> **教训升级（覆盖上午那条「事后回头更正」）**：病根不是「忘了更正」，而是
> **① 在事实落定之前就把它写成完成态**（推送没成功就写「已同步」）——必然产生一个
> 「记载与事实不符」的窗口，窗口长短取决于网络，今天两次都被抓住；
> **② 把易变的精确值写进长期记忆**（「待推 1 个」）——后续任一动作都会让它过时。
> → 做法：状态类记载**默认写保守态**，事实**确证后**再改成完成态（先看到远端 ref 变了才写「已同步」）；
>   易变精确值**不写死**，改为指向权威来源（`git status -sb`）。
>   「事后更正」是兜底，「事前不越界记载」才是做法。

**下一步（上架前主线）**
-2. 🟠 **软著材料已备但卡 AI 条款红线（11-04）**：白皮书 + 完整申请材料清单已产出（`docs/`，2 份**未提交**），但版权中心要求经办人亲笔手抄「未用 AI」承诺、说明书须用户亲写 → 提交前须用户本人致电版权中心问口径。另两处待提交：白皮书 + 材料清单尚未 commit。
-1. ✅ **P1 全部落地（11-03）**：审计文档 P1-A~P1-G 七项 + #15 回迁可控准备均已执行完（详见 `2026-11-03.md`）。P1-A numfmt 已下沉 `@dbee/shared`（`842a879`），mini 端营养素精度已对齐主端 2 位小数。**剩三项全部被外部资质阻断**：P1-C 实测等真机+样本餐；P1-D 支付实装等商户号（清单已出，含 🔴 核销时序坑）；#19 回迁切换等 ICP 备案（开关代码已就位）。**P2 也已全项执行完（11-03 晚）**：P2-A 导出置灰/P2-C 积分兑Pro曝光/P2-D 文案/P2-F 退款SOP；仅 P2-B `foodInsight` 双实现合并（2-3d 重构）留待。
0. 🔴 移动号段收不到验证码=`PORT_NOT_REGISTERED` → 用户在阿里云控制台「签名管理→运营商报备结果」补报备（5–7 工作日）；期间移动用户走密码登录。
1. Mac/Xcode 真机实证整改 #1~#5 + 红屏修复 `5d9de96`（Windows 编不了 Swift）。
2. ASC 配 3 商品（`dbee_pro_monthly/yearly/lifetime`）+ IAP capability + webhook 指 `https://d-bee.cn` + `APPLE_BUNDLE_ID`/`SHARED_SECRET`/`APPLE_ALLOWED_ENVS` → iOS 提审（需备案号）。
3. ICP 备案注销重备推进（工信部短信核验 24h 内必做）。
4. 资质到货后 → 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议。
5. 上架前未决阻断：**凭据轮换**（SSH 密码已进 git 历史；明文只在本地 `.env`，严禁写入 git）/ **HTTPS + 域名解析**（四端硬阻断）。
6. 其余：软著→App 备案→算法备案；华为/小米企业入驻后替换 dbee-health 插件方法体；分享卡片 O-3；实测自家 MAPE；彩页重写；Android 真机复测；小程序三端联调。

**待拍板（不阻塞开发）**
- 🔴 **软著 AI 条款红线**：版权中心要求经办人亲笔手抄承诺「未使用 AI 开发」，申报文档不得 AI 代写 → **不可盲目提交，须先致电版权中心问口径**，说明书须用户亲写。素材包：`docs/软著登记-事实素材包与合规红线-2026-10-28.md` + `tools/gen-softcopyright-source.py`。
- ①ICP 经营许可证（3 人社保）→ 方案 A：暂不办。②Apple 账号：先申 D-U-N-S、个人推进。③云库去留。④老用户迁移（推荐 A：开发数据不迁移）。⑤存量 7 行 newbie bonus 处置。⑥✅ **小程序回迁自托管已拍板（11-03）**：开关 `mini/src/lib/backend.ts`（默认 cloud 零改变，切需 `D_BEE_BACKEND=selfhost`+`D_BEE_SELFHOST_READY=true`），legal.ts 用 `BACKEND_KIND` 分支。🔴 **真正工作量是身份模型不是改 endpoint**：云库 uid=`wx:<openid>` vs 自托管 owner_id=19 位数字串、`ident_kind` CHECK 只有 phone/email、网关无 login-wechat。好消息：22 RPC + 11 表 + RLS **全已在自托管侧**，SDK 前缀 `/.cloud` 与网关**完全对齐**。清单 `docs/小程序回迁自托管-切换清单-2026-11-03.md`。⑦演示账户两套数据面（iOS 云库 owner `2115454156301934592` / web 自建 `1793280185303313979` 互不相通；iOS 切自建库须重建账户+预置数据，否则 Guideline 2.1）。⑧🔴 **App 名称口径二选一**（11-03 发现文档冲突）：《ASC配置清单》= `自律蜜蜂` vs《填报包》= `自律蜜蜂 - 饮食热量记录`。**备案名/ASC名/软著名三者须逐字统一**，否则填备案号时 409 `ICP_NUMBER_MIIT_APP_NAME_MISMATCH` 存不进。已在 ASC 清单加警示块，**决策前该字段悬置、勿据此建 App**。
- ⚠️ 安全待办（用户处理）：①重置 DeepSeek API key ②轮换 SSH/dbee_app 密码（轮换优先于重写 git 历史）。
- 📌 审计文档 5 项待拍板 **11-03 全部有结论**：①手动录入已做。②**数据面拍板「四端最终都迁回自托管」**，#15 可控准备已完（`b10df0c`），切换等备案（#19）。③MAPE **工具已就绪**（`0f9e397`），实测等真机+样本餐，之前不得对外表述精度。④「本期解读」**不更名**。⑤Android 兑换码调研**已完成**（`a1c1393`）：兑换码**不隐藏**（华为官方认可自建赠送码，前提免费发码），真风险是支付直连（华为强制 IAP Kit + 购买页禁展示支付方式名称），定性「上华为前必须改」。
- 🔴 **P1-D 核销时序坑（资质就绪前必须先决策）**：Apple=拉模式（客户端主动验签），微信/支付宝=推模式（权威信号=服务端异步回调，通常晚于客户端核销）→ 现设计直接接会「用户已扣款，App 报支付校验失败」（**主路径**非边缘）。解法：核销改「查订单状态+有限重试」+ 新增 `settling` 状态。另 `getAdapter`（checkout.ts:39-46）**无分发渠道维度** → 上华为前须加。详见 `docs/P1-D在线支付实装前置清单-2026-11-03.md`。
- 🔴 **小程序上线前缺口 4 项拍板（11-03 晚，清单 `docs/小程序上线前缺口清单与实施步骤-2026-11-03.md`）**：A 先发修复版还是先变更主体（倾向 A1 先发后变，但主体不一致有驳回风险）；B AI 同意门补门还是改文案（现只覆盖 2/4 入口，主端 Onboarding/ReportScreen 同缺口，建议补门）；C 登录页协议做到哪步（C1 加链接 / C2 checkbox / C3 全量 PrivacyGate）；D 提醒开关置灰/申请模板ID/删区块（建议置灰对齐 P2-A）。
- 🔴 **潜在硬阻断：request 合法域名主体不一致**（11-03 发现，无任何文档记录过）：mini 实际请求 `zilv-mifeng.app.workbuddy.host` + `www.workbuddy.cn`（备案主体=腾讯，非北京迪蜂科技），微信要求合法域名主体与小程序主体一致；若走不通且 `d-bee.cn` 未备案 → 小程序根本无法联网。已列阶段 0 第 1 步：先向腾讯客服核实。
- 🟠 **11-04 护栏新增 2 项待拍板**（跨端总视图 `docs/四端上线路线图与首发决策-2026-11-04.md`）：
  **A9** 7 处手写舍入历史债要不要改走 numfmt —— ⚠️ **不是纯机械替换**，`fmtNum` 异常返回 `—` 且默认去尾随零，
  会改 `placeholder` 语义，属有产品影响的重构，须逐处确认展示预期（尤其图表轴刻度与「已减重」文案）；
  **A10** mini 要不要补「已减重 X kg / 较起始 +X kg」体重变化展示 —— 主端有、全 `mini/src` 搜「已减重|较起始」0 命中。
  减脂产品的体重变化是核心正反馈，mini 若首发打获客建议补（工作量小，走 `@dbee/shared`）；
  选「不补」也要写进护栏注释记为刻意，否则下次又被当疑点重查一遍。
- 🟠 **一致性问题的第三类：功能覆盖差异 ≠ 分叉**（11-04 护栏扫出，7.2 分类表已补）。
  原本只有「必须一致」与「刻意分叉」两类；第三类是**同一功能一端有一端没有**。
  处理规则不同：**分叉必须修**（同一功能两种行为 = bug），**覆盖差异必须做产品决策**（补，或明确记为刻意省略）。
  二者都不能靠 grep 自动判定，靠「一端命中、另一端 0 命中」这个信号 + 人工定性。
  📌 定性时必须**查全端**不能只看同名文件：`mini/src/pages/profile/profile.tsx:6` 注释就明说了趋势图刻意改列表。

**版本/git**：commit 流水不入记忆，一律 `git log`；同步态一律 `git status -sb`（本行原先写死了 HEAD 哈希，违反自己上面那条纪律，11-04 已改；11-05 再次移除残留的 HEAD 哈希——写死即过时，且「未提交清单」属 `git status` 的职责）。**待用户过目后才提交**：`docs/自律蜜蜂技术白皮书-2026-11-04.md` + `docs/软著登记-完整申请材料清单-2026-11-04.md`（软著材料，须用户本人致电版权中心确认 AI 条款口径）。
- 🔴 **改任何跨端逻辑前先跑 `npx vitest run tools/four-end-consistency.test.ts`**（11-04 新建，6 道护栏 10 项）：
  日期 `toLocaleDateString` 禁用 / 定价硬编码禁用 / 手写舍入快照基线 7 处 / 会员文案必走 shared `memberSubText` /
  AI 同意门无门清单快照 4 页（调 AI 页面总数 8）/ 刻意分叉处必须留说明注释。
  护栏 3 与 5 是**快照式**（只准减不准增）：改完若变少说明历史债已清，**必须同步更新基线**，否则护栏失去侦测力。
  📌 放宽基线后要做**红验证**（注入一条违规看是否真红），否则可能把护栏改成永远绿。
  📌 护栏扫出两项待决策：**A9** 手写舍入历史债改走 numfmt（会改 `placeholder` 语义，有产品影响）、
  **A10** mini 全端无「已减重/较起始」体重变化展示（属**功能覆盖差异**，非写法分叉 → 要产品决策不要「修」）。
  跨端总视图见 `docs/四端上线路线图与首发决策-2026-11-04.md`（首发建议 mini）。

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
- 🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（覆盖 gateway.env，缺 IDENT_PEPPER 则账户不可恢复）→ 改网关一律走手术式脚本（`apply-vision-key-update.py` / `apply-llm-thinking-fix.py` / `apply-password-login-fix.sh`，断言 env 非目标部分 sha256 前后一致）。SSH 账号=`.env` 的 `USER=ubuntu`+`SSH_PWD`（实测 `sudo -n` 免密）；🔴 `.env` 里另一套 `DBEE_USER=dbee_app`+`DBEE_PWD` **实测 SSH 认证失败**（过时值）。`deploy.sh` 身份取**环境变量**不取 `.env`，须按文档传 `DBEE_USER=ubuntu`。
- 网关鉴权头=`x-wb-webapp-access-key`，按 Origin 精确匹配 → Node 脚本须注入 Origin/Referer。真实表名见 `db/migrations/`（没有 habit/habits）。
- `signIn` 两条路径（验证码/密码）改鉴权必双回归；密码路径标识须归一化（裸 11 位）。

## 数据面与部署现状（详版见 REFERENCE.md）

- **泳道 A（10-23 闭环）**：`150.158.51.106` nginx + dbee-gateway（:8080）+ PostgREST（:3001）+ PG 17.11；`/.cloud/**` 全走自托管；PG 监听已收 localhost。
- Web 已切自建 PG；Android/iOS/小程序仍走云库；自建网关的 `/v1/login-wechat` **代码已补齐**（11-05 `c0224fc`：`app.mjs:91` 挂路由 + `auth.mjs:301 exchangeWechatCode`，响应体与 `auth.mjs` 的 `sessionPayload` 同构，`tools/wechat-login-selftest.mjs` 66 项全过含幂等/建号/错误分类）。**剩余欠账 = ① 生产网关尚未部署**（`deploy/*.py|*.sh` 零涉及 wechat，须走手术式脚本，**绝不跑 `deploy-gateway.sh`**）+ **② 迁移 `0043` 服务器待执行**（`ident_kind` CHECK 扩 `wechat`，不扩则 INSERT 必被 23514 拒）+ ③ `.env`/`.secrets.local` 配 `WECHAT_MINI_SECRETS`（未配则端点自返 503，不阻止启动，同 IAP/LLM 模式）+ 身份映射 + 186****4728 分裂账号修复 + `0043-data-sync-final.sql`。切换时机=备案→A 记录→HTTPS→三端指 `https://d-bee.cn`。⚠️ `config.mjs` grep `appid` 命中的是 `SMS_TENCENT_SDKAPPID`（腾讯云短信），**不是**微信 appId，别误判「已配好」。
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
- LLM：只剩 `deepseek-flash`/`deepseek-v4-pro`；**只有 flash 接受图片**；`/llm/models` 须标 `supportsImages:true`；服务端切模型三端即时生效。
- 🔴 视觉链路（11-02 迁移）：走百炼 **`qwen3-vl-plus`** + 工作空间 **`ws-eu9wgvc1ysz242kj`**（旧 `qwen3.8-max-0902`/`ws-myumgi46hdb6mu3z` 已废）。**百炼 API Key 绑定工作空间** → `BASE_URL`/`MODEL`/`API_KEY` 三者必须**成对更换**（只换 key = 403，模型 ID 错 = 404）。单独改这三键用 `deploy/apply-vision-key-update.py`（手术式），**绝不跑 `deploy-gateway.sh`**（模板整体重渲染，`.secrets.local` 缺失即 `rand_hex` 重置 `IDENT_PEPPER` → 全站身份永久失效）。改完**必须回头同步** `gateway.env.template` + `.secrets.local`，否则下次常规部署静默回退。
- 额度规则（权威值 `packages/shared/src/constants/index.ts`）：`FREE_DAILY_AI=3` + `AI_REDEEM_DAILY_LIMIT=2`；新手 150 分；streak7 满 7 天送 2 次。
- 会员/IAP：三档 free/pro/lifetime；Apple 个人账号已过；Android 企业账号已注册；iOS 本地 StoreKit 测试就绪。
- 多端小程序：Taro 4.3.0 双工程 + `packages/shared`；mini tsconfig 需 `moduleResolution:"bundler"`。
- 健康数据源：连接真源=云端 `health_connected`；「企业账号已注册」≠「应用已上架华为市场」。
- 微信：Web/原生扫码登录暂缓（`WECHAT_LOGIN_ENABLED=false`，营业执照相关）；**小程序侧是另一条链路、不受该开关影响**（mini 独立 Taro 工程不 import `src/lib/wechat.ts`，走 `wx.login()`→`/v1/login-wechat`，启停看网关 `WECHAT_MINI_SECRETS` 而非该开关）。移动应用 code 需 `sns/oauth2/access_token` 不可混用 jscode2session。

## 过审合规

Apple 4.2 / 3.1.1 / 5.1.1(v) / AI 告知同意；中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。
🔴 **隐私政策公示禁止跨端照抄**：两库不互通、公示主体不同；写 legal.ts 前先核对真实链路，只写确实存在的能力；每条第三方链接必须 curl 验 200 且引「与我方关系匹配」的文件；`deploy/verify-legal.mjs` 自动校验。
🔴 **能力公示必须以「包内实际能力」实证，不以旧文档/不以 import 为准**（11-02 §4.2 闭环）：查 manifest 权限 + `capacitor.build.gradle` 插件清单 + 原生插件方法体是否真实现（`dbee-health` Android 是阶段 3a 骨架，恒返 `not_ready`、HMS 依赖被注释 → 公示须写「资质申请中、当前不读取」，不可谎报能读）；数据流要看变量真实去向（`healthSteps` 只进渲染与估算、`api.ts` 中 `steps` 零命中 → 才敢写「不上传」）。**后端归属只看构建护栏与配置层实际行为**：`vite.config.ts:14-25` + `cloudConfig.ts:109-112` 双层 throw，未注入 endpoint **不回退**云库（旧文档「回退 CLOUD_HOST」四处均已过时）；`CLOUD_ORIGIN` 只是白名单校验的 Origin 头、不决定流量去向。**收集范围有实质变化必须同步改 `UPDATED`**（PIPL 第 14 条 → `LEGAL_UPDATED` 版本化机制会让老用户重弹同意门，属预期）。

## 工作方式

需求驱动、多轮递进、「写→验→报」；缺陷/进度文档用 .docx；跨机同步只走 Git 私有仓（`github.com/yutaiyin139/d-bee` main，两机 `core.autocrlf false`）；收工把进度+待办写入当日日志；自测 `tools/*-selftest.mjs`。
**指令/shell 陷阱（11-01 踩过）**：①给用户的可执行指令必须放代码块一行一条（`→` 会被整行照抄）；②重试循环不加管道（需 `set -o pipefail`）；③推送失败=代理间歇波动，for 重试 5 次勿改方案。
**文档维护**：可执行文档直接更正；历史快照只加横幅不改正文；代码加护栏时文档同步改。
**提交前凭据扫描（11-02 踩坑两次后固化）**：①必须查**索引版本** `git show ":$f"`（`git diff --cached` 会含被删旧行 → 假阳性）；②手机号正则必须**带数字边界** `(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)` —— 19 位雪花 owner ID（如 `2111301028417638400`）的子串会裸匹配 `13010284176`，无边界正则每次都会误报；命中后先看上下文再判断，别无脑改文件。
**自检判据纪律（11-02 教训）**：任何「产物自检」命令写进手册前，必须在**干净构建的真产物**上实跑，且要能区分合法产物与异常产物。曾因未验证就把「index-*.js >1 个 = 构建残留」写进 Mac 手册，实际干净构建本就有 2 个（另一个是入口动态 import 的稳定 chunk）→ 错误判据比没有判据更危险（会让人反复 rm -rf 重打仍「不通过」）。
🔴 **写护栏的两条铁律（11-05 红验证实测抓出我自己护栏的 2 个假绿漏洞）**：① **一个 `it()` 只放一条断言** —— 多断言挤一个 it 时首条失败即抛出，后续断言**根本不执行**，表现为「测试通过了」但那条从未被验证（实测删掉 `name==='d-bee'` 校验却没报红，只因同 it 里 version 断言先失败）。② **存在性断言必须匹配「实际使用」而非「标识符出现」** —— `/LegalLinks/` 会命中 import 行，把 JSX 换成 `<View/>` 却留 import，护栏照样绿；改匹配 `/<LegalLinks[\s/>]/`。📌 **新增护栏也必须做红验证**（注入违规→确认精准报红→立即 `cp` 恢复→`git diff` 确认干净），其真正价值是抓出「自己写的护栏本身是假绿」。
🔴 **产物/文案核查：grep 中文恒假阴性**（webpack/Taro 把中文转义成 `\uXXXX`）→ 必须先 `t.encode('utf-8').decode('unicode_escape', errors='ignore')` 再搜；同理**日期正则要容空格**（源码是 `'2026 年 10 月 29 日'`，用 `2026年10月29日` 搜会漏掉最关键证据）；`mailto:` 在产物里是模板串运行时拼接，grep 完整字面量亦 0 命中。**据此判「没编译进去/产物是旧的」必错**。📌 微信开发者工具的「编译」**不跑 Taro 构建**，只重载 `dist/`；改完源码须先 `cd mini && npm run build:weapp`。
🔴 **`npm run build:web` 会删掉 `dist/legal/` 静态法务页**（只跑 `vite build`，清空 dist 后不再生成）。这些页是商店/OPPO 隐私爬虫要直接抓的（`privacyConsent.ts:40`「不需登录、不需点击、不需再跳转」），丢了被判「url 无法访问」。→ **即使只验证编译也别用 `build:web`**：验证用 `tsc --noEmit`，要产物用完整 `npm run build`（末尾 `gen-legal-static.mjs` 出 3 份）。
**法律日期 `UPDATED` 语义 = 文档正文最后一次实质改动日**，不是「今天动过这个文件」更不是发版日；改注释/改 `SITE` 字段不该刷新它，否则等于谎称协议内容变过。两端日期**刻意不同**（正文本就分叉：主体表述、第三方 SDK 公示、AI 功能名都不同），强行对齐反而造假。📌 主端 `LEGAL_UPDATED` 驱动隐私同意版本比对（`privacyConsent.ts:29`）→ 改值 = **生产全体老用户重弹同意窗**，属产品决策不可自动改；mini 不依赖该日期（走微信原生 `ensurePrivacyAuthorized`），改它零副作用。
**记忆维护**：commit 流水不入 MEMORY.md；只存结论/铁律/决策/坑/权威口径；体积压到 ~10KB（超过注入截断）；细节移 REFERENCE.md。

## 环境备忘

- SSH 发布：`150.158.51.106` / `ubuntu` / 密码见本地 `.env`（`SSH_PWD` 勿入记忆/文档）；脚本 `deploy/deploy.sh`。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`。
- 云库 applicationId `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql）；云库地址 `https://zilv-mifeng.app.workbuddy.host`。
- curl 本机 dev server 需 `--noproxy '*'`。
- 🔴🔴 **测试 = vitest**（`npm test` = `vitest run tools/`，测试放 `tools/*.test.ts`；无 lint）。**EPERM 会静默丢测试文件并假绿放行**：报 `EPERM ...Temp\<hash>\ssr\<hash>`（栈里是 WorkBuddy 的 `node-brokered-fs-shim.cjs` 拦截写入），文件被跳过。
  - ⛔ **推翻 11-03 的「有 EPERM 时 exit=1，不会假绿放行」结论**（11-03 六次采样得出）：
    11-04 实测**并行跑 EPERM 时 exit code = 0**，vitest 把它归入 `Unhandled Errors` 打印但
    **不影响退出码**，且被卡的测试文件完全不统计 → **假绿成立**。11-03 那六次可能恰好
    命中了不同路径（或只看了 stderr 有字就判 exit=1）。教训：**「exit code 会不会非零」
    必须显式 `echo $?` 验，不能凭有无报错输出推断**。
  - 实测对照（11-04，同一份代码）：并行 `8 files / 150 tests`（假绿）vs 串行 `10 files / 190 tests`（真相）—— 丢 2 文件 40 项。
  - ✅ **已修：`vite.config.ts` 加 `test.fileParallelism = false`**。写在配置而非 npm script，
    这样 `npx vitest run xxx`、IDE 测试按钮也都串行。代价 15.9s vs 9.4s。
    📌 `rm -rf node_modules/.vite` **无效**（清缓存后并行照旧假绿）；重定向 TMPDIR 亦无效。
  - **当前基线 197 = 10 文件**（four-end-consistency 17 + numfmt 30 + mini-profile-member 28 + mini-invite-link 31 + ai-mape 28 + iap-checkout 9 + price-single-source 18 + mini-backend-switch 22 + report-ratio 8 + mini-report-ratio 6）。
  - 🔴 **每次跑完必核对 `Test Files` 数 == `ls -1 tools/*.test.ts | wc -l`**，少一个就是有文件被吞。
  - 🔴 **别用 shell 循环累加求和**（11-03 实测 `$((total+n))` 出 bug 显示 14），逐文件读数后用 python 复算。
- 🔴 **mini 端类型检查须单独跑且带 `--skipLibCheck`**：根 `tsconfig.json` 的 include 只有 `["src","vite.config.ts"]`，**不覆盖 `mini/`** → `npm run typecheck` 通过 ≠ mini 无误。mini 自己的 tsconfig 无 skipLibCheck，裸跑会被 `node_modules/@tarojs/components` 的 `CommonEventFunction` 噪音淹（exit=2 但与自有代码无关）。正确姿势：`cd mini && npx tsc --noEmit --skipLibCheck -p tsconfig.json`。
- 🔴 **构建期护栏必须写在构建配置里，不能指望被打包的业务代码**（11-03 实测教训）：webpack **不执行**被打包模块的顶层代码，故 `mini/src/lib/backend.ts` 的 throw 只在小程序启动时触发，误配的包照样 `build:weapp` exit=0 发出去。修法 = 在 `mini/config/index.ts`（Node 构建期执行）里调**同一个** `resolveBackendTarget()`，两层复用同一函数不漂移。主端同构：`vite.config.ts:14-25` 构建期 + `cloudConfig.ts:109-112` 运行时。
- 🔴 **MAPE 达标 ≠ 无需处理**：单看 MAPE 会误导决策，必须四指标并报（MAPE 排除真值 0 且显式计数 / WMAPE 抗小真值放大 / MAE 带单位 / **Bias 有符号**）。判据 `tools/ai-mape/mape.ts`：MAPE>15% 且 |Bias|/MAPE≥0.6 → systematic（先改 prompt）；<0.6 → random（考虑换模型）；**MAPE≤15% 但 |Bias%|>10 仍判 systematic**（11-03 用模板样本实测揪出的真 bug：热量 MAPE 12.76% 判达标而 Bias -17.29%，减脂产品系统性低估热量会累积成用户减脂失败，且该状态不该做精度营销）。工具已就绪，**实测需真机+样本餐（≥20 条、覆盖 4 热量档），在此之前不得对外表述任何精度数字**。
- 微营养素：foodsData*.ts 已 10 列化（**1180 条**零兜底；core 359 + fresh 335 + dishes 486，11-04 跑真实 `parse()` 复算，旧记「1175」已过时）；`db/.tmp-backup.sql` 临时备份不入库。
- 🔴 **限流口径文档与代码不一致（11-04 发现，待修）**：`packages/shared/src/rules/index.ts:8` 注释称「AI 文字问答免费用户 1 分钟最多 3 次防刷」，但 `server/lib/llm.mjs` 检索 `60_000`/`60000` **零命中** = **不存在任何分钟级限流器**；实际是 `textLimiter` **50 次/日**。三个限流器默认值 **200/50/8**（`config.mjs:223,228,238`；`usageLimiter` 定义在 **`app.mjs:48`** 后注入 llm.mjs，不在 llm.mjs 内）。→ 对外文案/白皮书引用限流口径前**必须查代码不查注释**；该注释待改或补回分钟级限流。
- 📌 **开源授权类型必须实读 `package.json` license 字段**（11-04 白皮书初稿写错 2 处）：`@capgo/capacitor-wechat` = **MPL-2.0**（非 MIT，文件级 copyleft；仅经插件接口调用不改源码则不触发开源义务）、`zxing-wasm` = **MIT**（非 Apache-2.0）。
