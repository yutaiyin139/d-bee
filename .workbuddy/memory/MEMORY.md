# D-Bee（自律蜜蜂）· 项目长期记忆（核心版）

> 📚 **细节全部在 `REFERENCE.md`**（关键坑全量 / 部署侧坑 / 数据面 / 业务资质 / 过审合规 / 工作方式纪律 / 铁律 10-12 详版）。本文件只留「决策与铁律」，体积控制在 ~9KB（超限会被注入截断）。

## 权威口径（勿再改动）

- **Bundle ID / appId = `cn.com.dbee.app`**（iOS+Android 同值）；**版本 1.7.3**（Android vc14 / iOS CURRENT_PROJECT_VERSION 12 / mini 0.1.0）。
- **域名**：`d-bee.cn` = 自律蜜蜂 Web 端（隐私政策 URL / Apple webhook / Universal Link / 原生 endpoint 全用它）；`d-bee.com.cn` = 公司官网（纯静态）。
- 🟢 **ICP 备案已下证（2026-11-06）**：`-1` = 官网 `d-bee.com.cn`；`-2` = 自律蜜蜂 `d-bee.cn`。🔴 **本仓库生效代码任何位置不得出现 `-1`**。真相源 = `packages/shared` 的 `ICP_BEIAN_D_BEE_CN`（`VITE_ICP_BEIAN` 仅紧急覆盖口）。`POLICE_BEIAN` 仍空（不渲染＝合规），**2026-12-06 前必办公安联网备案**。详版见 REFERENCE.md「ICP 备案号与单一真相源」。
- 🔴 **原生包禁用 `npm run build`**（白屏，铁律 #10）：内测 `VITE_ALLOW_CLOUD_NATIVE=true npm run build:native:internal`；上架 `VITE_NATIVE_ENDPOINT=https://d-bee.cn npm run build:native`。
- 🔴 **产物自检以 `index.html` 引用的入口 js 为唯一真源**（铁律 #11）：**干净构建本就有 2 个 `index-*.js`**（另一个是入口动态 import 的稳定 chunk），「>1 个＝残留」是错误判据。
- 🔴🔴 **铁律 #13：「已完成」必须附生产侧实测证据**（11-06 一晚抓到 **4 处**「任务标 completed + 本地全绿 + 生产未生效」：#4 A1 网关 404 / #5 0043 未应用 / #14 支付门控未部署 / #15 法务未部署；我据此做过一次失实汇报）。**本地绿 ≠ 线上绿**，中间隔「提交→构建→部署」。取证 5 法（打真实端点 / 产物内 grep 正文 / 比 mtime 时间线 / 查 DB 元数据 / 查部署物 mtime）+「探针第一版必须发现性非断言性」+「应用前必须红才算有效断言」详版见 REFERENCE.md「铁律 #13」。
- 📄 **隐私政策静态页**：`npm run build` 自动跑 `gen-legal-static.mjs` → `dist/legal/`（零 JS 可爬，OPPO 硬要求）；真源 `src/content/legal.ts`；`build:native*` 不生成；上线须一并部署。**别用 `build:web`**——它只跑 `vite build`，会删掉 `dist/legal/`。详版见 REFERENCE.md。
- 📄 **法律文案 `**强调**`**：两端各自转 `<strong>`；静态页 `rich()` **必须先 `esc()` 再 bold**；奇数个 `**` 剥星号降级；改后验 `grep -o '\*\*' | wc -l` = 0。详版（含降级三选一依据）见 REFERENCE.md「法律文案渲染细节」。

## 现状（截至 2026-11-06 上午）

- **数据面权威源 = 服务器自建 PostgreSQL `dbee`**（实证：`/.cloud/healthz` 返回 `database:"dbee"`）。**云库已非生产写入源**（iOS/Android/mini 暂仍连它，回迁等 HTTPS）。判定法详版见 REFERENCE.md「数据面权威源判定法」。
- iOS V1.7.3 已发布、上架就绪核查通过；Android vc13 验签通过、vc14 内测包待实测；**Web 已生产 `https://d-bee.cn/`**；阿里云真短信上线；**ICP 已下证 + B1 DNS ✅ + B2 HTTPS ✅**（SAN 覆盖 `d-bee.cn`+`www`，到期 **2027-02-04**，`renew --dry-run` 通过、timer enabled；官网 `d-bee.com.cn` 仍无 A）。
- 🟡 **备案号缺口已闭合（11-06 13:16 重新部署）**：`verify-legal.mjs` 双域名 PASS（页脚与三法务页全 `-2`、0 console/page error）。回滚点见 REFERENCE.md。
  🔴 **「合规闭合」只指备案号，不含法务正文**：#15（删失实「自动续费」/「Google Play」，**19:40**）与 #14（付费墙诚实降级，**19:35**）**均晚于 13:16 构建 → 未进线上**，两文件仍 `M`。实测线上 `/legal/terms/` 仍含失实句与「Google Play」各 1；产物内 `自动续费` 6、`Google Play` 1（构建剥离注释 → 必来自正文）。**= web 上线仅剩两个硬阻塞。**
- 🔴 **certbot `--redirect` 副作用：IP 直连 `http://150.158.51.106/` 由 200 变 404**。`src/` 无 IP 运行时硬编码 → 生产不受影响；冒烟/探针/验收三处默认值已改。**验收一律打 `https://d-bee.cn/`，别再打 IP。** 落点矩阵详版见 REFERENCE.md「B2 HTTPS 签发详版」。
- 四端合规/一致性已收敛：苹果端合规 P0 清零（AI 显式标识 + 订阅摘要）、四端审计 + 小程序 P0/P1/P2 全项、定价与会员状态收敛单一真相源（`packages/shared`）、跨端护栏 `tools/four-end-consistency.test.ts`（**护栏已扩到 8 道 21 项**，全量测试 **201** 项全绿 = 10 文件）。
- 11-05/11-06 收敛流水（微信登录 A1~A3 `c0224fc`、四端法律公示一致性 `2bc4513`/`bd0d407`、ICP 备案号回填 + 护栏 8）详版见当日日志与 REFERENCE.md。
- 🔴 **11-05 那批提交本地领先 origin、尚未推送**（同步态一律 `git status -sb` 现查，勿记数字）；是否推送待用户决定。更早流水一律 `git log` / 当日日志，**不入本文件**。

## 下一步（上架前主线）

0. 🔴 移动号段收不到验证码=`PORT_NOT_REGISTERED` → 阿里云「签名管理→运营商报备结果」补报备（5–7 工作日），期间走密码登录。
1. 软著：**须用户本人致电版权中心问 AI 条款口径**（要求经办人亲笔手抄「未用 AI」承诺、说明书须用户亲写）→ 再提交并 commit 两份文档。
2. Mac/Xcode 真机实证整改 #1~#5 + 红屏修复（Windows 编不了 Swift）。
3. ASC 配 3 商品（`dbee_pro_monthly/yearly/lifetime`）+ IAP capability + webhook 指 `https://d-bee.cn` + `APPLE_BUNDLE_ID`/`SHARED_SECRET`/`APPLE_ALLOWED_ENVS` → iOS 提审（备案号已就绪 `-2`）。
4. ✅ 备案号重部署（13:16）+ B2 HTTPS（14:51）完成。**今后常规部署应设 `DBEE_DOMAIN=d-bee.cn`**（原「不要设」纪律的理由——无 A 记录 / 443 未通——已全消失）。
5. B1 ✅ B2 ✅ → **B3 微信 request 合法域名**（可配 `https://d-bee.cn`，前置已满足）→ B5 mini 切自托管（= **释放云库的真正前置**；链路 A1 网关部署 → `WECHAT_*` env → mini 双开关构建 → 提审 → 数据迁移）。细节见 REFERENCE.md。
6. 🔴 **Android 正式包已可实测**：此前判「不可发布」的唯一理由（钉死的 `https://d-bee.cn` 无 A 记录、无 HTTPS）**已双双解除**；分发/上架前 `versionCode` 须 **+1 到 15**。
7. 🔴 **公安联网备案 2026-12-06 前必办**（ICP 下证后 30 日内法定时限）；拿到号后填 `packages/shared` 的 `POLICE_BEIAN`，页脚该行会自动渲染。
8. 资质到货后 → 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议。
9. 🔴 **凭据轮换优先级上调**：本轮 `assert_no_leaked_secret` 拦截时把 sudo 密码明文打进终端（守卫自身成了泄露源，已修为打码）→ 该密码视为已泄露，与「待拍板」安全待办合并处理。
10. 🟠 **4 处 `__SUDO_PWD__` 注释地雷未修**（清单见 REFERENCE.md「B2 详版」）：`render`/`run` 都会替换占位符 → 下次 `APPLY_NGINX_CONF=1` 必被守卫拦 exit 3。
11. 其余：App 备案→算法备案；华为/小米入驻后替换 dbee-health 插件方法体；分享卡片 O-3；实测自家 MAPE；彩页重写；Android 真机复测；小程序三端联调；🟠 安全响应头加固（HSTS/`server_tokens`，风险不对称需拍板）。

## 待拍板（不阻塞开发）

- 🔴 **软著 AI 条款红线**（同下一步 1）。素材：`docs/软著登记-事实素材包与合规红线-2026-10-28.md` + `tools/gen-softcopyright-source.py`；**已产出待你过目的两份**（技术白皮书 + 完整申请材料清单）在 `docs/`，过目后才提交。
- ①ICP 经营许可暂不办。②Apple 账号先申 D-U-N-S。③云库去留。④老用户不迁移数据。⑤存量 7 行 newbie bonus。⑥✅ 回迁自托管已拍板——**真正工作量是身份模型不是 endpoint**。⑦演示数据两套面互不相通。⑧🔴 App 名称口径二选一未决（备案/ASC/软著须逐字统一，否则 Apple 409）→ 字段悬置。⑥⑦⑧ 详版见 REFERENCE.md「小程序回迁自托管·身份模型」。
- 🔴 **P1-D 核销时序坑**：Apple=拉模式，微信/支付宝=推模式（权威信号是服务端异步回调）→ 直接接会「已扣款但 App 报校验失败」（**主路径**）。解法：核销改「查订单状态+有限重试」+ 新增 `settling`；`getAdapter`（checkout.ts:39-46）**无分发渠道维度** → 上华为前须加。详见 `docs/P1-D在线支付实装前置清单-2026-11-03.md`。
- 🔴 **小程序上线前 4 项**（`docs/小程序上线前缺口清单与实施步骤-2026-11-03.md`）：A 先发修复版 vs 先变更主体（倾向先发）；B AI 同意门补门 vs 改文案（现只覆盖 2/4 入口，主端同缺口）；C 登录页协议做到哪步；D 提醒开关置灰 vs 申请模板 ID。
- 🔴 **潜在硬阻断：request 合法域名主体不一致**：mini 请求 `*.workbuddy.host`/`www.workbuddy.cn`（备案主体=腾讯），微信要求合法域名主体与小程序主体一致 → 阶段 0 先向腾讯客服核实。
- 🟠 **护栏扫出 2 项**：**A9** 7 处手写舍入改走 numfmt（⚠️ 非机械替换：`fmtNum` 异常返 `—` 且默认去尾随零，会改 `placeholder` 语义）；**A10** mini 缺「已减重/较起始」体重变化（主端有、`mini/src` 0 命中）——选「不补」也要写进护栏注释记为刻意。
- 🟠 **一致性第三类：功能覆盖差异 ≠ 分叉**。分叉必须修；覆盖差异必须产品决策（补 or 记刻意省略）。定性须**查全端**。
- ⚠️ 安全待办（用户处理）：①重置 DeepSeek API key ②轮换 SSH/dbee_app 密码（轮换优先于重写 git 历史）。

**版本/git**：commit 流水一律 `git log`；同步态一律 `git status -sb`，**勿写死 HEAD 哈希与「待推 N 个」**。状态类记载默认写**保守态**，确证后才写完成态。**待用户过目后才提交**：`docs/自律蜜蜂技术白皮书-2026-11-04.md` + `docs/软著登记-完整申请材料清单-2026-11-04.md`。

## 三条主线

1. **开发**：看板=本文件「现状」，自动化「D-Bee 开发进度盘点」每日收敛。
2. **备份（两层）**：①服务器 cron 03:30 `pg_dump -Fc`；②本地异地副本 `deploy/pull-latest-backup.py`（含真实健康数据，**严禁 git add**）。**旧云库 JSON 备份自 11-05 废弃**。跑法、路径与凭据陷阱详版见 REFERENCE.md「备份跑法与 DNS 核查」。
3. **运营**：彩页、技术交流、社群，自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18+Vite5+TS；Windows 出 Android、Mac mini M4 出 iOS；Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（HealthKit / Health Connect / 华为需先上架华为市场 / 小米官方 SDK）。
**6 项决策（10-22）**：①主体=有限责任公司 ②未提交产物入库 ③LLM=DeepSeek ④短信=aliyun 真短信 ⑤网关=Node（`server/index.mjs`）⑥Apple 验签放 Node 网关（弃 pg_net）。凭据只存本地 `.env`。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层；运行时探测 `window.Capacitor`，不 import Capacitor 包。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 注入云 SDK `options.fetch`，勿 patch window.fetch；endpoint 由 `cloudConfig.ts` 决定（native-release 硬断言 `https://d-bee.cn`）。
4. 输入校验走 `src/lib/validate.ts`；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。
5. **StoreKit 2：服务端核销成功才 `finish()`**；退款交易只 finish 不送核销。回归 `npm run test:iap`。
6. **原生能力必须返回显式状态，禁止吞成 0/空**；HealthKit 只在 `isUsableHealthStatus(status)` 时写回。
7. 弹窗无障碍统一 `useModalA11y(onClose)`；`role="button"` div 用 `src/lib/a11y.ts` 的 `onActivateKey`。
8. iOS 付费墙禁止硬编码价兜底：拉价失败禁用购买+重试，价格位显示「—」。
9. OriginProxy 取消归一为 End 非 Error，取消绝不回退缓冲重发；在途流注册表 finally 移除。
10. 🔴 原生包禁用 `npm run build`（详见上「权威口径」与 REFERENCE 详版）；自检 `grep -c "禁止直接复用 Web 产物" dist/assets/index-*.js` 必须为 0。
11. 🔴 Capacitor 8.5.3 `addListenerNative` 链尾 `.catch()` 兜不住全部失败（callbackId 非 Promise / 原生永不 resolve / cb 同步抛错）→ 三路分别设防。
12. 🔴 跨引擎错误上报 message 与 stack 分开取（iOS JSC stack 不含 message）；错误面板分致命/非致命；`padding-top` 叠 `env(safe-area-inset-top)`。

## 云数据库安全铁律（最高优先级）

- 发权益函数必须 SECURITY DEFINER + 入参白名单；**涉权益表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 挡不住直写）。
- **0039 闸门双库对齐**：新增/修改权益函数必须双库同步打补丁（自建走 migrations，云库走 MCP + `db/cloud-patch-0039/`；探针 `deploy/probe-0039-parity.sh`）。
- nginx 唯一生效模板=`nginx.selfhost.conf.example`；改 nginx 只走 `deploy.sh APPLY_NGINX_CONF=1` 或 `switch-nginx-selfhost.sh`。
- 单条 SELECT 求值顺序未定义：`set_config` 混函数须 `WITH s AS MATERIALIZED`。

## 部署最高危（全量见 REFERENCE.md「部署侧坑」）

- 🔴🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（缺 IDENT_PEPPER 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本；**只读/备份操作也绝不跑它**。
- 🔴 SSH=`USER=ubuntu`+`SSH_PWD`；`.env` 的 `DBEE_USER=dbee_app` **实测认证失败**（过时值）。视觉链路 `BASE_URL`/`MODEL`/`API_KEY` **必须成对更换**且改完同步 `gateway.env.template`+`.secrets.local`（否则下次部署静默回退）。详版见 REFERENCE.md「部署侧坑」。

## 环境备忘（操作要点）

- SSH `150.158.51.106`（凭据与陷阱见「部署最高危」第 2 条；🔴 `SSH_PWD` 明文**勿入记忆/文档**）。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`；异地备份 `db/backups/offsite/*.dump`（含真实健康数据，`.gitignore` 已覆盖，**严禁 git add / 移出项目**）。
- 旧云库 applicationId `wbapp_w6iIU6TqTyHvJxESPTxBTy`（`https://zilv-mifeng.app.workbuddy.host`）——**已非生产源**。
- curl 本机 dev server 需 `--noproxy '*'`。
- 🔴🔴 **测试 = vitest**（`npm test` = `vitest run tools/`，测试放 `tools/*.test.ts`）。**并行假绿已修**（`vite.config.ts` 强制串行）。🔴 跑完必核对 `Test Files` 数 == `ls -1 tools/*.test.ts | wc -l`（**基线 201 = 10 文件**），少一个就是被吞。详版见 REFERENCE.md「工程与测试环境铁律」。
- 🔴 **mini 类型检查须单独跑**（根 `tsconfig.json` 不覆盖 `mini/`）：`cd mini && npx tsc --noEmit --skipLibCheck -p tsconfig.json`。
- 🔴 **构建期护栏必须写在构建配置里**（webpack 不执行被打包模块顶层代码）：`mini/config/index.ts` 调与运行时**同一个** `resolveBackendTarget()`；主端同构 `vite.config.ts:14-25` + `cloudConfig.ts:109-112`。
- 🔴 **MAPE 达标 ≠ 无需处理**：四指标并报（MAPE 排除真值 0 / WMAPE / MAE / **Bias 有符号**），判据 `tools/ai-mape/mape.ts`；**实测需真机+样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字**。
- 🔴 **改任何跨端逻辑前先跑 `npx vitest run tools/four-end-consistency.test.ts`**（**8 道护栏 21 项**）；护栏 3/5 是**快照式**（只准减不准增），改完变少说明历史债已清，**必须同步更新基线**，并做**红验证**（注入违规看是否真红），否则护栏会变成永远绿。
- 🔴🔴 **护栏断言三条铁律**（详版 REFERENCE.md「写护栏三条铁律」）：① 一个 `it()` 只放一条断言；② 存在性断言匹配「实际使用」非「标识符出现」；③ 断言必须在 `stripComments()` 后的代码上做（否则注释子串命中 → 假绿）。
- 🔴 **法律要求公示的公开信息不得只放 `.env`**（备案号/主体名/资质号）：`.env` 被 gitignore → 换机器/CI 构建会**静默产出无备案号的页面**（`exit 0` 不报错）。真相源一律进 `packages/shared`，`.env` 变量降级为紧急覆盖口。
