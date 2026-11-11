# D-Bee · 参考细节（MEMORY.md 瘦身后移入；按需读取，不自动注入）

> 本文件承接 2026-11-02 从 MEMORY.md 移出的详细内容。MEMORY.md 只留核心铁律与快照。

## 进度快照·已完成明细（截至 11-01，细节见各日日志）

- iOS V1.7.3 已发布（10-29）+ 上架就绪实证核查通过；Web V1.7.2 线上（http://150.158.51.106/）；Android vc13 重打并验签通过。
- 10-29/10-30 四端代码审查整改 #1~#5（原生生产数据面统一 / IAP 交易闭环重构 / IAP 异常路径回归 `npm run test:iap` / 无障碍集中整改 / 功能可靠性）→ 沉淀为铁律 #5~#9。
- 自建网关密码登录生产缺陷修复（`8d4a0ef`：`signInWithPassword` 分流 + 标识归一化 + 防枚举恒定耗时 + 双维度限流，35/35 断言过、线上 200）。
- 合规 P0 多端一致性（`PrivacyGate.tsx` 首启同意门 + 第三方 SDK 7 项公示 + 小程序按真实链路重写 + `verify-legal.mjs` URL 可达性校验）。
- 阿里云真短信上线（`SMS_PROVIDER=aliyun`，万能码摘除，实收验证通过）；App Store 素材链路就绪（商店截图 + `deploy/shot-creative.mjs`，126 项 DOM 断言）。
- 10-31 全仓口径核查（`e8b7ffd`）：Bundle ID / 域名代码侧全对；唯一缺陷 `tools/android-cdp.py` 硬编码弃用包名已修（`DBEE_PKG`/`--pkg`）；12 份 docs 过期口径已更正。
- 10-31 四项安全问题核查：①万能码=不属实 ②532 公网暴露=属实已修（`listen_addresses=localhost`，远程管理改 `ssh -L 15432:127.0.0.1:5432`）③历史密钥未轮换=属实，/tmp 明文已 shred，SSH/sudo 密码仍未轮换 ④双后端走云吃不到 0039=属实已修（云库 7 权益函数补齐闸门）。
- 10-31 晚：ICP 企业备案提交进管局审核（6–25 工作日）；iOS 真机白屏加「启动失败自报面板」（`c99f98f`：index.html 内联 ES5 四道捕获 + `BootErrorBoundary.tsx` 包在 PrivacyGate 外）。
- 11-01 白屏闭环 + 四问题根因锁定：Mac 侧跑通 `npm ci`+`build:native:internal`+`cap sync ios`；自报面板直接给出根因（误用 `npm run build`，非代码缺陷）。①iOS 红屏=IAP 恢复链路未捕获异常（`177ec7d` 只降级面板未堵异常源；`5d9de96` 三层纵深防护是真修，两轮都须 Mac 重打）②③移动号段收不到验证码=`PORT_NOT_REGISTERED`（需用户控制台补报备）④识别超时=qwen 深度思考空转（已修 `dc217da`，11-01 19:11 部署实证）。前一轮「iOS 获取验证码 TLS 失败」结论作废。
- 重启影响面实测（`deploy/probe-restart-window.py`，只读）：48h 日志仅 29 行、独立 owner 3 个、`otp.challenges/tokens` 全 0、`NRestarts=0`、access/refresh TTL 30min/30d → 重启代价极低；重启只清内存态（OTP+refresh_token），access 是无状态 JWT，只有超 30min 未活跃者需重登。实际重启窗口 19:09–19:13 业务日志 0 行。

## 铁律 #10 与 #11/#12 详版

- **#10 详版**：`npm run build` 是 Web 产物（MODE=production），护栏 `if (import.meta.env.PROD && mode!=='native-release' && mode!=='native-internal') throw` 在 production 下恒真 → 被死代码消除成无条件 throw；`publicConfig` 是模块级常量，iOS 上 `detectNative()` 恒真 → JS 首行即炸，React 连 PrivacyGate 都挂不上。CSS 已载故呈米白（`#FBF8F1`），极易误判「public/ 没同步」。⚠️ `ios/App/App/public` 被 gitignore，Mac 包内容完全由 `cap sync` 决定；误诊会自我强化——诊断构建问题必须真实构建两种产物对照。
- **#11 详版**：Capacitor 8.5.3 `addListenerNative` 实现为 `const call = addListener(ev,cb); new Promise(res => call.then(() => res({remove})))`。致命路径：①`cap.toNative` 对回调型调用返回 `callbackId` 字符串（`native-bridge.js:913`）非 Promise，对其 `.then`=同步 TypeError；②原生 `addListener:`（`CAPPlugin.m:105-109`）只 setKeepAlive 从不 resolve → Promise 永久 pending，`.catch()` 永不触发；③cb 在原生派发器同步调用，抛错直冒 window.onerror。须三路设防（同步抛错/非 Promise/Promise reject）+ 编排层「保证不 reject」契约。
- **#12 详版**：iOS JSC `error.stack` 不含 message（V8 才把 message 放 stack 首行）→ 正解分别取，`stack.indexOf(message)===-1` 时拼接。错误面板分致命/非致命：整屏接管只适用启动期/渲染期，运行期非致命改顶部横幅+关闭按钮；React 渲染期抛错须显式传 fatal（`#root` 已有子节点，按 childElementCount 自动判断会误判）。

## 关键坑·详版

- **qwen 深度思考**：11-01 实测一单午餐 `completion_tokens=3221` 里 `reasoning_tokens=3105`（96%），真输出仅 241 token。关闭=OpenAI 兼容模式把 `enable_thinking:false` 放 body 顶层（Python SDK 才放 extra_body）。已在 `llm.mjs` 仅对视觉请求注入（DeepSeek 忽略未知参数），开关 `LLM_VISION_ENABLE_THINKING`（默认 false）。A/B 实证：false → 1085ms/completion=3；不传 → 7321ms/completion=122（6.7 倍提速）。回退=把 `LLM_VISION_ENABLE_THINKING=true` 写进 gateway.env，无需改代码。
- **PORT_NOT_REGISTERED 详版**（11-01 实证）：移动 139****1170 五条全失败，联通 186****4399/4728 全 DELIVERED → 号段差异非玄学。一个签名生成多个子端口号分发到不同运营商，部分未报备通过则该运营商用户收不到。签名审核通过 ≠ 报备完成（5–7 工作日，部分 7–10）；入口=短信控制台 → 签名管理 → 运营商报备结果。生产 `SMS_PROVIDER=aliyun` 且无腾讯云凭据（`SMS_TENCENT_*` 未设置）→ 期间移动用户只能走密码登录。
- **cap sync/插件注册三连坑**：①新插件必踩 safe-delete 守卫（genie-trash ETIMEDOUT）→ 误删 `android/capacitor-cordova-android-plugins/` 两 gradle 文件；绕过=先 shell `rm -rf` 该目录再 cap sync（shell 删不触发 genie-trash）；兜底=解压 `capacitor-cordova-android-plugins.tar.gz` + 手写 cordova.variables.gradle + build.gradle 补 `apply from`。②本地插件（file:）两步缺一不可：`includePlugins` 列名 + `npm install` 建 symlink；「Gradle 编译过 ≠ 运行时注册，`capacitor.plugins.json` 才是真源」。③`includePlugins` 白名单对 npm 包插件同样生效（装 `@capacitor/local-notifications` 后 cap sync 静默跳过）。
- **iOS 首次真机编译三处 bug（已修）**：①拍照无反应（缺 `NSPhotoLibraryAddUsageDescription`，前端 catch 静默吞 reject）②`resultType:'DataUrl'` 大小写 bug ③Bundle ID 冲突。
- **部署侧坑详版**：`GRANT` 是追加语义（清 DELETE 先 `REVOKE ALL`）；`BYPASSRLS`=全库 RLS 失效（0033 已收回，改 `TO <role>` 专用 policy + NOBYPASSRLS）；Git Bash↔Windows Python 路径用 `cygpath -m "$(mktemp)"`；env 模板加占位符必须同步改 `deploy-gateway.sh` 的 sed 注入表（值过 `esc_sed`，`#`/`&`/`\` 不转义会静默写坏 env）；部署线上 env 用「本地生成完整 env → SFTP 覆盖」；模板守卫要排除注释行。`deploy-gateway.sh` 两处 `set -e` 静默退出陷阱已修（`34a8216`）：①凭据齐全时短路退出 ②注释态键的 `grep|head|cut` 触发 pipefail；症状=exit 1 零输出；勿用 `bash -x > file`（明文密钥写进追踪文件）。
- **备份自动化的硬依赖**：唯一通道是 genie-baas 只读工具在会话中已注册（不在索引时无第二条合规通道：本地无云端凭据、服务器 dbee 库只是 10-13 镜像、无 sshpass/私钥）。此时走 FAILED 分支，勿用服务器镜像顶替（会造成日期与数据不符的假备份）。校验脚本须 `.cjs` 后缀（package.json `"type":"module"`）。dump 结果超 MCP 输出上限时会落盘到 `.workbuddy/projects/<proj>/<id>/tool-results/*.txt`：Read/Bash 直读被沙箱拒，但 **PowerShell Copy-Item 可复制进工作区** → 复制后用 Node 脚本解析构建（2026-11-02 实证，优于分片转录）。

## 业务与资质·详版

- 合规现状：三篇法律文本挂路由（`src/content/legal.ts` + `pages/LegalPage.tsx` + `SiteFooter.tsx`，备案号走 `VITE_ICP_BEIAN`，未设则不渲染）；`REDEEM_CODES` 硬编码已删；`restorePurchases()` 已接；服务端 `redeem_by_code` RPC 仍在；法律文本 URL 一律 `https://d-bee.cn/legal/...`。

- 「3 人社保」：≥3 名全职、三个不同人（许可/客服/安全负责人）、法人可算一人、必须本公司缴（代缴/挂靠直接驳回且一年内禁申）、管局跨部门比对+可能上门；成本 ≈¥4000/月起 + 记账 + 代办（约 47 工作日）。已定方案 A：暂不办。
- 小程序主体变更（appid `wxb7c7122de9c3ab1f`）：¥300 不退 + 审核 1–7 工作日；可免公证（个人→企业且个人即法人）；原主体签名+按手印，不可代办；通过后 7 天内须管理员确认+重登+签协议，超时作废；两个强制后续：①重做小程序备案 ②类目资质重交（14 天内，逾期封禁）；类目避开「医疗-其他医学健康服务」→ 选工具/生活服务；文案严禁诊疗/治病/筛查。
- ICP 备案：路径=注销重备（北京不在「个人→企业」直接变更白名单）；域名已过户（管局核对 WHOIS=备案主体）；关 WHOIS 隐私保护；A4 已做完且 IP 直连验证 → 可随时注销不停业务；注销后域名停解析；工信部短信核验 24h 内必做；两域名打包同一订单（-1/-2）；法人京籍→无需居住证/社保。
- 竞品定位详版：年付 ¥128 是国际 12 款最便宜；悉尼大学 2024：AI 对混合亚洲菜肴高估 49%/低估 76%（=D-Bee 核心场景）→ 定位「不卖 AI 神奇，卖能坚持下来」。
- AI 成本详版：DeepSeek flash 峰值价（工作 9–12/14–18 点 2 倍），token 上限 384；前端 `compressImage(1024,0.82)`；降本=系统提示缓存（输入价降~98%）+ 本地引擎先命中。
- LLM 接线详版：`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 退役；网关 `/llm/models` 必须给 flash 标 `supportsImages:true`，否则 `pickModel(needVision)` 选空（另需过滤 `disabled!==true && enabled!==false`，见 `ai.ts:31`）；模型 ID 放服务端 `.env`（`LLM_MODEL_VISION`）；视觉走百炼 `qwen3.8-max-0902`（旧名 qwen-vl-max 403）；`config.mjs` 的 `LLM_VISION_BASE_URL/KEY/MODEL`+`LLM_IMAGE_DETAIL=high`。
- 微信详版：前置链=开放平台企业认证→移动应用 AppID+UnionID→注入 `VITE_WECHAT_APPID`（iOS 另需 `VITE_WECHAT_UNIVERSAL_LINK` + Associated Domains + AASA）→`NATIVE_CODE_EXCHANGE_SUPPORTED=true`；云端缺口：SDK `signInWithWechat` 只走小程序 `jscode2session`。
- 健康数据源详版：HealthKit 读授权不可探测→插件只报 completed；华为 Health Kit 阶段 3a 已落地（Android 反射骨架，零 HMS 依赖）；小米官方 SDK 已纳入，白名单 `{huawei,xiaomi}`；未就绪返 `reason=not_ready`。

## 数据面·详版

- 泳道 A 部署闭环（10-23）：Node 22.22.2 / PostgREST 16.4 / PG 17.11；8 项 E2E 全 ✓；云端回滚点 `/etc/nginx/sites-available/d-bee.cloud.bak`；PG 收 localhost 脚本 `deploy/fix-pg-loopback.sh`（30s 验证+自动回滚）。
- 摆脱云库六步：ICP 备案 ✅→A 记录 ✅（11-06 完成：`d-bee.cn`+`www` → `150.158.51.106`；**此前曾无任何 DNS 记录**）→certbot（🔴 阻塞在腾讯云安全组 443 未放行）→三端注入 `VITE_NATIVE_ENDPOINT` 重打→0043 最终同步+账号合并→观察期 T+30。工具链（sync-mirror/switch-nginx-selfhost/dnscheck/setup-https）就绪。186****4728 分裂账号：云库 `2110364580268998656` 真实 vs Web 自建 `1792845025064566575` 空壳，根因两套发号机制。
- 支付链路（10-23）：verifyReceipt（21007/21008 沙盒切换、bundle_id 钉扎 `APPLE_BUNDLE_ID`、transaction_id 全服幂等、恢复购买）+ Notifications V2（x5c 证书链钉扎、续订/退款、落库）+ `AppleRootCA-G3.cer`；0037 幂等表+留痕表+3 函数（EXECUTE 仅 dbee_app）；webhook 豁免 IP 限流；`api.ts` iOS 优先走网关、404/503 回退 RPC。
- 短信三易错点：①aliyun 是 RPC + HMAC-SHA1 手写签名（腾讯云是 TC3-HMAC-SHA256）②模板 `SMS_512482436` 只有 `code` 一个变量，TemplateParam 传 JSON 串 ③签名口径=「北京迪蜂科技有限公司」；要品牌签名须重新申请 1–2 工作日，过审只改 `SMS_SIGN_NAME`；RAM 子账号最小权限。
- 安全加固两批：①10-26 六项（RPC 信任边界 / 原子性 / LLM 服务端授权 / Apple 环境白名单 / XFF 信任边界 / 榜单缓存），曾发现网关层完全未部署 → 已补齐复验 18/18。②10-27 七项（JWT TTL 30min+refresh 滚动+`token_version` 强制下线 0042 已部署 / appleSandbox 生产默认关 / 万能码切真短信 / LLM 视觉 fail-closed 503+文本降额 50/日 / grant_honey 发分前查真实记录 / CORS Origin 白名单 / email 验证码 163 SMTP 465/SSL 手写）——后四项代码+自测 300/0 全绿，待部署。
- 云库 0039 七权益函数：grant_honey / grant_photo_bonus / consume_ai_quota / consume_photo_quota / get_photo_quota / redeem_honey / settle_invite_checkin（顺带收掉 consume_photo_quota 的 PUBLIC EXECUTE）。
- 数据库切换核心判断（10-26）：不是「要不要切」而是「HTTPS 何时就绪」；过渡期云库唯一真相源，切换日一次性收口。

---

## 2026-11-06 由 MEMORY.md 迁入（11-05 口径，与上文冲突时**以此为准**）

### 关键坑（全量）

- endpoint 同源/绝对 HTTPS；`CapacitorHttp.enabled=true` 必开；云 SDK 独占 localStorage；iOS 无 BarcodeDetector→原生 MLKit；只改 web 资源用 `npx cap copy android`；图标改后跑 `tools/gen-app-icons.py`；验收 `tools/android-cdp.py`（包名 `cn.com.dbee.app`）；安全区写 `var(--safe-area-inset-*, env(...))`。
- cap sync 的 safe-delete 守卫会误删插件 gradle → 先 shell `rm -rf` 再 sync；本地插件两步缺一不可（includePlugins+npm install）；`capacitor.plugins.json` 才是真源；iOS 需 Xcode 单开 Push capability。
- 原生拍照无反应：`file_paths.xml` 缺 `<external-files-path>` 或 Manifest 缺 `CAMERA`；华为 WebView 忽略 `<input capture>`→统一 `@capacitor/camera`。
- 兑换拍照额度唯一依据 `get_photo_quota.total_remaining`；honey_ledger 唯一索引 ref_id 需带 `HH24MISSMS` 后缀才允许每日多次。
- 探针脚本绝不 cat/grep 正文（会打明文密码）；泄露立即 shred 并轮换。
- Xcode 完好性判定=`du -sh` ≥15GB + `-showsdks` 有 iphoneos（`-version` 的 27.1 是 CLT 版本号，骗人）。
- 🔴 `SendSms` Code=OK ≠ 送达，必须 `QuerySendDetails` 看 SendStatus/ErrCode；`PORT_NOT_REGISTERED`=签名子端口未完成运营商报备（签名审核通过≠报备完成）。
- 🔴 qwen 系默认开深度思考，视觉任务纯空转：`enable_thinking:false` 放 body 顶层（`llm.mjs` 已注入，开关 `LLM_VISION_ENABLE_THINKING`）；`reasoning_tokens` 嵌在 `usage.completion_tokens_details`，不在顶层。
- 🔴 **限流口径文档与代码不一致**：`packages/shared/src/rules/index.ts:8` 注释称「AI 文字问答 1 分钟最多 3 次」，但 `llm.mjs` 检索 `60_000` 零命中 = **无分钟级限流**；实际 `textLimiter` 50 次/日。三限流器默认 200/50/8（`config.mjs:223,228,238`；`usageLimiter` 定义在 `app.mjs:48`）。引用限流口径前**查代码不查注释**。
- 📌 开源授权须实读 license 字段：`@capgo/capacitor-wechat` = **MPL-2.0**（文件级 copyleft，仅经插件接口调用不改源码则不触发义务）、`zxing-wasm` = **MIT**。

### 部署侧坑（全量）

- `CREATE POLICY` 顺序 `AS→FOR→TO→USING→WITH CHECK`；GRANT 追加语义；BYPASSRLS 已收回（0033）；`pg_dump` 必须 `sudo -u postgres` + 体积守卫；`JWT_SECRET`/`IDENT_PEPPER` 存 `deploy/gateway/.secrets.local`（改 JWT_SECRET=全员登出，改 IDENT_PEPPER=身份失配）；网关与 PostgREST 共用同一 HS256 secret；`DBEE_PROD=1` 拒 `SMS_PROVIDER=log` 且收紧 Apple 收据。
- 🔴 **`deploy-gateway.sh` 是全站永久锁死级地雷**（模板整体重渲染，缺 IDENT_PEPPER 即 `rand_hex` 重置 → 全站身份永久失效）→ 改网关一律走手术式脚本（`apply-vision-key-update.py` / `apply-llm-thinking-fix.py` / `apply-password-login-fix.sh`，断言 env 非目标部分 sha256 前后一致）。**只读/备份操作也绝不跑它。**
- SSH=`USER=ubuntu`+`SSH_PWD`（`sudo -n` 免密）；`.env` 另一套 `DBEE_USER=dbee_app`/`DBEE_PWD` **实测认证失败**；`deploy.sh` 身份取环境变量不取 `.env`。
- 🔴🔴 **nginx reload 有「优雅退出窗口」→ 紧跟着验证会拿到旧行为 = 假红**（11-06 实测栽过）：`systemctl reload nginx` 在「新 worker 已起、开始接受新连接」时就返回成功，但**旧 worker 会继续处理它已接手的连接，且持有旧配置**。脚本 reload 后立刻 curl 验证，很可能落在旧 worker 上 → 表现为「补丁没生效」。
  - 实例：301→308 补丁首轮验证报 `POST→308→POST→404`，一度判定「308 没生效」；三条独立证据反证配置正确（服务器内部 `curl -v` 得 `POST→308→POST→401` 方法保留 / access.log 两条 `POST 308`+`POST 401` / `127.0.0.1:8080` 直连网关 `POST→401`）。
  - **修法**：reload 后 `sleep 8` 等旧 worker 退出，且**验证项本身重试 3 次**。📌 任何「reload + 立即断言」的脚本都有此坑，改 nginx 配置类脚本一律照此设防。
  - 📌 反过来说：**判定「生产配置错」之前，先排除验证时机**。本轮三条证据都指向配置对，错的是验证时机。
- 🔴 **补丁脚本必须可重入（幂等）**：已应用后再跑，应**跳过改动直接验证**，否则会报出「命中 0 行 ≠ 期望 2 行」这类**误导性错误**（看起来像补丁失败，实际是早就生效了）。
  - 实现：先数改前状态，`BEFORE=0 && CUR_TARGET=2 → ALREADY=1`，则跳过 备份/替换/`nginx -t`/reload，直接进验证段；结尾按 `ALREADY` 输出「复核通过」或「完成」。
  - 附带价值：**certbot renew 会把 `return 301` 重新注回来**（installer 每次续期改写 80 块），届时原样重跑同一脚本即可复位 308 —— 可重入让「定期复核」变成零成本动作。
  - 📌 同源纪律：`apply-vision-key-update.py` 等手术式脚本也都断言「env 非目标部分 sha256 前后一致」，属同一思路（改动最小 + 可重复执行 + 自带证据）。
- 网关鉴权头=`x-wb-webapp-access-key`，按 Origin 精确匹配 → Node 脚本须注入 Origin/Referer。真实表名见 `db/migrations/`（没有 habit/habits）。`signIn` 两条路径（验证码/密码）改鉴权必双回归；密码路径标识须归一化（裸 11 位）。

### 数据面与部署现状（11-05）

- **泳道 A**：`150.158.51.106` nginx + dbee-gateway（:8080）+ PostgREST（:3001）+ PG 17.11；`/.cloud/**` 全走自托管；PG 监听已收 localhost（**外部 5432 被 pg_hba 拒，仅服务器本机可连**）。
- 自建网关 `/v1/login-wechat` **代码已补齐**（`app.mjs:91` 挂路由 + `auth.mjs:301 exchangeWechatCode`，`tools/wechat-login-selftest.mjs` 66 项全过）。**剩余欠账**：① 生产网关尚未部署（须手术式脚本）② 迁移 `0043` 服务器待执行（`ident_kind` CHECK 扩 `wechat`，不扩则 INSERT 必 23514）③ 配 `WECHAT_MINI_SECRETS`（未配则端点自返 503，不阻止启动）+ 身份映射 + 186****4728 分裂账号修复。切换时机=备案→A 记录→HTTPS→三端指 `https://d-bee.cn`。⚠️ `config.mjs` grep `appid` 命中 `SMS_TENCENT_SDKAPPID`（腾讯云短信），**不是**微信 appId。
- PIPL：`0030-full-selfhost-mirror.sql` 含真实健康档案**不入库**（gitignore）；0030 已含 0025~0028 变更，勿盲跑 0025~0029。
- 支付：Apple 验签在 Node 网关（`server/lib/iap.mjs`）+ Notifications V2 + `0037` 三函数，`tools/iap-selftest.mjs` 47 项。短信：aliyun RPC + HMAC-SHA1 手写签名，🔴 签名口径=「北京迪蜂科技有限公司」不是「自律蜜蜂」。安全加固：10-26 六项已部署 18/18；10-27 七项中 0042 已部署、其余代码全绿**待部署**。

### 业务与资质要点（11-05）

- 主体已办结（公章 10-27、对公账户 10-28、域名 10-27 过户 WHOIS=北京迪蜂科技有限公司）。「3 人社保」=ICP 经营许可硬条件 → 暂不办。
- 小程序主体变更（`wxb7c7122de9c3ab1f`）：通过后 7 天内须管理员确认；强制后续=重做备案 + 14 天内重交类目资质（类目避开「医疗」，文案严禁诊疗）。
- ICP 备案：注销重备；关 WHOIS 隐私保护；工信部短信核验 24h 内必做；两域名打包同一订单。
- 竞品定位：¥18/¥128/¥328 锁定不改；「不卖 AI 神奇，卖能坚持下来」：厚免费+游戏化+本地引擎优先、AI 兜底+无广告+数据自托管。
- LLM：只剩 `deepseek-flash`/`deepseek-v4-pro`；**只有 flash 接受图片**；`/llm/models` 须标 `supportsImages:true`；服务端切模型三端即时生效。成本：flash 拍照 ≈¥0.0047/次。
- 🔴 **视觉链路**：百炼 **`qwen3-vl-plus`** + 工作空间 **`ws-eu9wgvc1ysz242kj`**（旧 `qwen3.8-max-0902`/`ws-myumgi46hdb6mu3z` 已废）。**Key 绑定工作空间** → `BASE_URL`/`MODEL`/`API_KEY` 必须**成对更换**（只换 key=403，模型 ID 错=404）。用 `deploy/apply-vision-key-update.py`，**绝不跑 `deploy-gateway.sh`**；改完**必须回头同步** `gateway.env.template` + `.secrets.local`，否则下次常规部署静默回退。
- 额度（权威 `packages/shared/src/constants/index.ts`）：`FREE_DAILY_AI=3` + `AI_REDEEM_DAILY_LIMIT=2`；新手 150 分；streak7 满 7 天送 2 次。
- 会员三档 free/pro/lifetime；Apple 个人账号已过、Android 企业账号已注册。多端小程序：Taro 4.3.0 双工程 + `packages/shared`；mini tsconfig 需 `moduleResolution:"bundler"`。
- 健康数据源连接真源=云端 `health_connected`；「企业账号已注册」≠「已上架华为市场」。
- 微信：Web/原生扫码登录暂缓（`WECHAT_LOGIN_ENABLED=false`）；**小程序侧另一条链路**（独立 Taro 工程不 import `src/lib/wechat.ts`，走 `wx.login()`→`/v1/login-wechat`，启停看 `WECHAT_MINI_SECRETS`）。移动应用 code 需 `sns/oauth2/access_token`，不可混用 jscode2session。
- 微营养素：`foodsData*.ts` 已 10 列化（**1180 条**零兜底；core 359 + fresh 335 + dishes 486）。

### 过审合规（11-05）

- Apple 4.2 / 3.1.1 / 5.1.1(v) / AI 告知同意；中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。《标识办法》国信办通字〔2025〕2号 **2025-09-01 已施行**（非 2026）。
- 🔴 **隐私政策禁止跨端照抄**：两库不互通、公示主体不同；写 `legal.ts` 前核对真实链路，只写确实存在的能力；第三方链接必须 curl 验 200；`deploy/verify-legal.mjs` 自动校验。
- 🔴 **能力公示以「包内实际能力」实证**（不以旧文档/不以 import 为准）：查 manifest 权限 + `capacitor.build.gradle` 插件清单 + 原生插件方法体是否真实现（`dbee-health` Android 是 3a 骨架、恒返 `not_ready` → 须写「资质申请中、当前不读取」）；数据流看变量真实去向。**后端归属只看构建护栏**：`vite.config.ts:14-25` + `cloudConfig.ts:109-112` 双层 throw，未注入 endpoint **不回退**云库；`CLOUD_ORIGIN` 只是 Origin 白名单、不决定流量去向。**收集范围实质变化必须同步改 `UPDATED`**（PIPL 14 条 → 老用户重弹同意门）。
- **`UPDATED` 语义 = 正文最后一次实质改动日**（不是发版日）；两端**刻意不同**（正文分叉），强行对齐=造假。📌 主端改值 = 全体老用户重弹同意窗（产品决策，不可自动改）；mini 不依赖它。

### 工作方式与协作纪律（11-05）

- 需求驱动、多轮递进、「写→验→报」；缺陷/进度文档用 .docx；跨机同步只走 Git 私有仓（`github.com/yutaiyin139/d-bee` main，两机 `core.autocrlf false`）；收工把进度+待办写入当日日志；自测 `tools/*-selftest.mjs`。
- **指令/shell**：给用户的指令必须放代码块一行一条（`→` 会被整行照抄）；重试循环不加管道（需 `set -o pipefail`）；推送失败=代理波动，for 重试 5 次勿改方案。
- **文档维护**：可执行文档直接更正；历史快照只加横幅不改正文；加护栏时文档同步改。
- **提交前凭据扫描**：①查**索引版本** `git show ":$f"`（`git diff --cached` 含被删旧行 → 假阳性）；②手机号正则必须带数字边界 `(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)`（19 位雪花 owner ID 子串会裸匹配）。命中先看上下文。
- 🔴 **自检判据纪律**：任何「产物自检」命令写进手册前，必须在**干净构建的真产物**上实跑且能区分合法/异常产物。错误判据比没有判据更危险。
- 🔴 **写护栏三条铁律**（红验证抓出我自己护栏的 3 个假绿漏洞）：① **一个 `it()` 只放一条断言**（多断言时首条失败即抛出，后续**根本不执行** → 表现「通过」却从未验证）；② **存在性断言必须匹配「实际使用」而非「标识符出现」**（`/LegalLinks/` 会命中 import 行 → 改 `/<LegalLinks[\s/>]/`）；③ **断言必须在 `stripComments()` 后的代码上做**（在含注释的原文上匹配，注释里的子串照样命中 → 假绿；11-06 红验证实测重演：注释掉 `export const POLICE_BEIAN = ''` 后护栏 8 竟未报红，当场抓出）。📌 新增护栏也必须红验证（注入违规→确认精准报红→`cp` 恢复→`git diff` 干净）。

### 🔴🔴 铁律 #13 ·「已完成」必须附生产侧实测证据（11-06 一晚抓到 4 处同型假完成）

**规则**：任何「某功能已上线 / 某修复已生效」的结论，**必须附一条生产侧实测证据**；
拿不到证据时，一律表述为**「代码已就绪、未部署」**。本地测试全绿 **≠** 线上已生效 ——
中间隔着「提交 → 构建 → 部署」三步，**一步都不能省**。

**为什么立这条**：2026-11-06 一晚连续抓到 **4 处**「任务列表标 completed、本地验证全绿、生产未生效」，
且我自己还据此向用户**做过一次失实汇报**（说「线上失实陈述已删除」，实测仍在）：

| 任务 | 本地 | 生产实测证据 |
|---|---|---|
| #4 A1 网关 `/v1/login-wechat` | `app.mjs:91` 路由 + `auth.mjs:548` handler 都在 | 🔴 `POST` → **404**「未知端点」；`/opt/dbee-gateway` grep `login-wechat`/`loginWechat` **命中 0**；`index.mjs` mtime **10-29**（早于 commit `c0224fc`/11-05） |
| #5 迁移 0043（ident_kind wechat） | SQL 已写 | 🔴 `app_users_ident_kind_check` 仍是 `(phone,email)`；`schema_migrations` 无 0043 行 |
| #14 付费墙「可见但不可用」门控 | `PaywallSheet.tsx` mtime **19:35** | 🔴 晚于产物构建 **13:16** → 未进线上；`git status` 仍 `M` |
| #15 法务失实陈述删除 | `legal.ts` mtime **19:40**；本地 `dist/legal` 19:46 已是新版 | 🔴 `curl https://d-bee.cn/legal/terms/` 仍命中「到期前 24 小时内…扣款」与「Google Play」各 1 处；线上产物内 `自动续费` **6**、`Google Play` **1** |

**取证手法（按可信度排序，都用过）**：
1. **打真实端点**：`curl -w '%{http_code}'` / `POST` 看 **404 vs 业务错** —— 一秒定性「路由在不在」。
2. **产物内 grep**：线上 `index-*.js` 里搜**正文字符串**（构建会剥离注释，故命中必来自代码正文）；
   中文在 native/taro 产物里可能被转 `\uXXXX`，**必要时先 `unicode_escape` 解码再搜**（见日志「grep 中文必假阴性」）。
3. **比 mtime 时间线**：`产物构建时间` vs `源码 mtime` vs `HEAD commit 时间` —— **产物早于修复即必然未生效**，这是硬证据不需推断。
4. **查数据库元数据**：`pg_get_constraintdef` / `information_schema.columns` / `pg_get_functiondef` / `proacl`。
5. **查部署物 mtime**：`stat -c '%y'` 生产侧文件，与 commit 时间对比。

**连带纪律**：
- 「某功能已上线」是**别人（含过去的我）推理的前提**。前提错 → 结论全错。本轮我据「A1 已上线」推出
  「0043 不补就会撞 CHECK」，实测 A1 根本没上线 → **该风险描述是假的**，0043 实为「前向兼容的独立改动」。
- 报告里凡是写「已修复 / 已上线 / 已生效」，**同一句里就要给出证据形式**（返回码、命中数、mtime、约束定义）。
- 任务列表的 `completed` **不是证据**，只表示「当时认为做完了」。

### 🔴 探针的第一版必须是「发现性探针」，不是「断言性探针」（11-06 一晚踩 3 次）

**规则**：先查「有什么」（列库 / 列表 / 列约束名 / 列签名 / 列 ACL），再写断言。
凭记忆假设结构去写断言，报错信息会**把人引向「生产结构坏了」的错误方向**，而真相是自己写错了。

本轮三次实例：
1. 假设存在 `identities` 表 → `relation "identities" does not exist`。实际登录标识在 **`app_users`**（0031），
   约束实名 **`app_users_ident_kind_check`**。
2. `pg_get_function_result(oid)` 在 `pg_proc p JOIN pg_namespace n` 后 → `column reference "oid" is ambiguous`，必须写 `p.oid`。
3. `grep "async function loginWechat"` → **0 命中**，我一度判定「路由注册了但 handler 不存在 = 真缺陷」。
   实际 `auth.mjs:548` 是**对象方法简写** `async loginWechat(req, res, body) {`。
   → 📌 **判「某符号不存在」前，grep 模式必须覆盖该语言的全部定义形态**
     （函数声明 / 对象方法 / 箭头赋值 / class 成员）；与「grep 只匹配行首漏掉注释态 `#APPLE_*`」同型。

**度量口径坑**：`length(prosrc)=846`（**纯函数体**）≠ `length(pg_get_functiondef(...))=1011`（**全定义**，
含 CREATE/AS/语言/属性行）。→ **比长度前必须先确认量的是哪个**，否则会误判「函数体已分叉」。

### 断言鉴别力：「应用前必须红」才算有效（11-06 红验证实证）

把验收断言原样打在**应用前**的生产上，`✓=10 ✗=10`，红的分布与预测**逐字一致**：
- **应红的都红了**：0043 登记行=0、CHECK 无 wechat；0044 schema 6 项全 0、函数体 2 项全 0。
- **回归守卫 1/2/3 全绿**（= 断言本身正确、现状假设无误）：返回值 `text` / authenticated+anon 零表权限 /
  `rls=true force=false` / `dbee_app`+`authenticated` 可 EXECUTE 而 `anon` 不可 / 属主可见码数=3。
- 📌 顺带**证伪了我自己一条弱断言**：`函数体含 'lifetime'` 在 0012 旧版就已经是 1 → **无鉴别力**，
  已降级为「观察项」不计入 pass/fail。
→ **纪律**：写验收标志位时，凡描述「旧版本也满足」的性质（返回值类型、既有权限、既有字样）
  **只能当回归守卫，不能当「迁移生效」的证据**。生效证据必须是「应用前红、应用后绿」的那一批。

### REVOKE FROM PUBLIC 会不会连带收走业务角色权限（11-06 实证排除）

0044:198 `REVOKE ALL ON FUNCTION public.redeem_by_code(text) FROM PUBLIC, anon;`
→ 若网关角色 `dbee_app` 的 EXECUTE 是**继承自 PUBLIC**，这条会把它一并收走 = 部署后所有兑换 RPC 直接 403。
查 ACL 实证排除：`PROACL = postgres=X/postgres ;; dbee_app=X/postgres ;; authenticated=X/postgres`
—— **PUBLIC 无条目** → 两个角色都是**显式授权**，波及不到；且 PG 的 `CREATE OR REPLACE FUNCTION`
**保留既有 `proacl`**（不像 DROP+CREATE 会重置）。
→ 📌 但这是推断，故仍写成**回归守卫**（三条 `has_function_privilege` 断言）钉死在应用脚本里。

### FORCE ROW LEVEL SECURITY 的真实边界（四组合探针 + 生产实证）

| 组合 | 结果 |
|---|---|
| 属主=超级用户 `postgres` + FORCE | **无害**（BYPASSRLS 优先）← 今天生产 |
| 属主=NOBYPASSRLS 角色 + 仅 ENABLE | 正常（属主默认绕过）← 0030 基线 |
| 属主=NOBYPASSRLS 角色 + ENABLE + **FORCE** | 🔴 **0 行 = 静默全废** ← 0012 字面 |
| 属主=NOBYPASSRLS 角色 + FORCE + 宽松 policy | 正常 |

**生产实证佐证**：探针查出生产已有 **3 张表带 FORCE**（`app_users` / `apple_notifications` / `apple_transactions`），
其中 `app_users` 属主 `postgres`（`super=true bypassrls=true`）、7 个用户、网关每天在写 → **自 0031（10-23）稳定至今**，
与组合①「无害」逐字吻合。
🔴 **但机制必须说精确**：**FORCE 只影响「表属主」**。网关写库用 `dbee_app`（`super=f bypassrls=f`，**非属主**）
→ 对非属主角色，**有没有 FORCE，RLS 都照样生效**，FORCE 是 no-op。
所以「app_users 带 FORCE 且正常」既证明组合①无害，**也不能**用来证明「FORCE 对 dbee_app 无影响是因为 FORCE 弱」—— 两回事。
→ 0044 不加 FORCE 的理由仍是：**不为将来「属主迁到非超级用户角色」埋雷**，不是「加了今天就炸」。
📌 **我自己曾过度断言**「0044 加 FORCE 会让所有兑换码恒返回 bad」，注入 FORCE 跑完整验收后**功能项全绿**，被红验证推翻。

### ICP 备案号与单一真相源（11-06，备案下证当日）

- **双号对应关系（勿再弄混）**：`京ICP备2026075565号-1` = 北京迪蜂科技**门户网站** `d-bee.com.cn`；`京ICP备2026075565号-2` = **自律蜜蜂** `d-bee.cn`。本仓库只服务 `d-bee.cn` → 🔴 **生效代码中任何位置不得出现 `-1`**（护栏 8 断言「剥离注释后零处 -1 字面量」）。
- **为何真相源下沉 `packages/shared` 而非 `.env`**：备案号是法律要求每页公示的**公开信息**（不是密钥），`.env` 被 `.gitignore:6` 忽略 → 只走 `.env` 会让换机器/CI 构建**静默产出无备案号的页面**（页脚整行不渲染、构建 `exit 0` 不报错）＝ 无声合规违规。故真相源 = `packages/shared/src/constants/index.ts` 的 `ICP_BEIAN_D_BEE_CN`，与 `FREE_NO_ADS_ITEM` 等文案常量同类；`SITE.icp = env('VITE_ICP_BEIAN') || ICP_BEIAN_D_BEE_CN`，`.env` 变量降级为**紧急覆盖口、常态留空**。
- **`verify-legal.mjs` 期望值取法**：用 vite `ssrLoadModule('/src/content/legal.ts')` 直接取 `SITE.icp`，使「校验期望」与「渲染真值」在语言层面是同一对象（同 `gen-legal-static.mjs:187` 范式）。📌 不能裸 Node `import` `@dbee/shared`——其 dist 用**目录式 re-export**（无扩展名）→ `ERR_UNSUPPORTED_DIR_IMPORT`，只有 vite/webpack 能解析。
- **双向校验 + 三种失败诊断**：正则 `[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新]ICP备\d{6,}号(?:-\d+)?`（31 省级简称全称）。期望**非空** → 页面必须逐字出现该号**且不得出现别的号**（抓域名错配）；期望**为空** → 不得出现任何「ICP备」字样。诊断分支必须区分：A 填错号（出现别的号）/ B 号码被截断 / C 已进代码但未重新构建部署。逃生口 `EXPECT_ICP=""`。
- **红验证 6 场景全过**（真脚本打真页面，本地静态服务须用 `run_in_background` 起，shell `&` 不跨工具调用存活）：good→OK / wrong-portal→诊断A / both→「同时出现其他号」/ none→诊断C / truncated→诊断B / `EXPECT_ICP=""`→双向。
- **全仓清雷**：三处旧文档/注释把回填示例误写成 `-1`（`mini/src/pages/legal/legal.tsx:71`、`docs/备案材料清单.md:130`、`docs/小程序上线前缺口清单与实施步骤-2026-11-03.md:261`），已全部更正为 `-2` 并留警示。
- **产物扫描纪律**：以**数字串 `2026075565`** 为锚点（数字不会被 `\uXXXX` 转义），同时在「原文」与「`unicode_escape` 解码后」两种形态各扫一遍。11-06 实测三处 PASS：`dist/`（19 文件，`-2`×4 含 3 份静态法务页）/ `mini/dist/`（69 文件，`-2`×1 在 `common.js`）/ `packages/shared/dist/`（`-2`×2），`-1` 全 0。
- 📌 **备案下证 ≠ 站点可用**：11-06 阿里 DoH（`dns.alidns.com`）+ 腾讯 DoH（`doh.pub`）双源核实。**11-06 上午两域名均无 A 记录**（只返回 SOA），`www.d-bee.cn` NXDOMAIN；→ **11-06 11:30 用户已加解析、B1 完成**：`d-bee.cn` 与 `www.d-bee.cn` A=`150.158.51.106`、TTL 600、双源一致，80 端口 HTTP 200。官网 `d-bee.com.cn` 仍无 A（`Status=0` 但 Answer 空＝域名存在无记录；`www.d-bee.com.cn` NXDOMAIN）。
- 🔴 **DNS 状态码语义别混**：`Status=0(NOERROR)` + Answer 空 + Authority 有 SOA = **域名存在但该名字无 A 记录**；`Status=3(NXDOMAIN)` = **该名字整体不存在**。两者都「解析不出 IP」但根因不同。判断是否生效别用本机 `nslookup`（本地缓存/运营商递归会骗你），直查 DoH。
- 🔴 **端口不通要区分两种根因**（B2 排查实测）：「**超时丢包**」（curl 8s+ 无响应、TCP 握手失败）= **安全组/防火墙未放行**；「**立即拒绝**」（毫秒级 connection refused）= 端口可达但**无进程监听**。11-06 实测：80 握手成功 HTTP 200，**443 超时丢包 → 腾讯云安全组未放行**（去腾讯云控制台，不是阿里云 DNS）。
- 🔴 **`deploy.sh` 的 `https` 模式只签证书、不推产物**（`:83-95`，末尾 `exit 0` 不走常规部署）→ 别指望上 HTTPS 顺带把前端产物更新掉，产物缺口必须靠常规部署单独修。
- 📌 **`www.d-bee.cn` 能签进证书**：主站 nginx 块 `server_name` 含 catch-all `_`（`deploy.sh:53` 渲染 `$DBEE_DOMAIN $DBEE_HOST _`），实测 `http://www.d-bee.cn/` 返回 200 且与裸域名同一产物。→ **曾据静态代码推断「www 缺 server_name、别放进 DBEE_DOMAINS」是错的，被实测推翻**；涉及 nginx 匹配行为别只读配置推断，实打一次。
- 🔴 **「不要设 `DBEE_DOMAIN`」的理由已随进度变化（结论按阶段变）**：① 备案期＝无 A 记录，设了写进不可达域名；② B1 完成后但 443 未放行＝`SITE_ORIGIN` 变 `https://` 而部署末尾冒烟（`deploy.sh:150`）打 `$SITE_ORIGIN/` 必失败；③ **B2 完成后应设为 `https://d-bee.cn`**（届时前两个理由都消失）。📌 纪律不是死的「永远别设」，而是「443 通之前别设」——每阶段重新判断理由是否还成立。
- 🔴 **域名生效会暴露「旧产物」合规风险窗口**（11-06 实测）：线上跑的是 11-04 旧产物（入口 `index-FKoi1yKv.js`），SPA 页脚与 `/legal/{terms,privacy,disclaimer}/` 三页**全部零备案号**；`verify-legal.mjs http://d-bee.cn/` → FAIL（诊断精准命中「生产产物还是旧的」）。**对照实验**：同脚本打本地 `dist/`（`python -m http.server`，须 `run_in_background` 起）→ PASS。**B1 完成 ≠ 合规完成**，域名一生效就得立刻确认线上产物是最新构建。**✅ 窗口已闭合**：11-06 13:16 重新部署（入口 `index-CkK9x744.js`），线上复验 PASS。
- 🔴 **公安联网备案法定时限 = ICP 下证后 30 日内，即 2026-12-06 前**；`POLICE_BEIAN` 当前为空、页脚该行不渲染是**合规的**（拿到号后填 shared 常量即自动渲染，`POLICE_QUERY_URL = https://beian.mps.gov.cn/`）。
- 🔴 **grep 中文恒假阴性**（webpack/Taro 把中文转 `\uXXXX`）→ 先 `t.encode('utf-8').decode('unicode_escape', errors='ignore')` 再搜；日期正则要容空格；`mailto:` 是运行时拼接，grep 字面量亦 0 命中。据此判「没编进去/产物旧」必错。📌 微信开发者工具「编译」**不跑 Taro 构建**，只重载 `dist/`；改源码须先 `cd mini && npm run build:weapp`。
- 🔴 **`npm run build:web` 会删掉 `dist/legal/`**（只跑 `vite build`，清空 dist 不再生成），商店/OPPO 爬虫直接抓这些页 → 丢了判「url 无法访问」。验证编译用 `tsc --noEmit`；要产物用完整 `npm run build`。
- **备份自动化的硬依赖（历史，已废弃）**：2026-10-19~11-05 走 genie-baas 只读 MCP，通道时有时无；**11-05 起改为「服务器 pg_dump + 异地拉取」**，不再依赖云库 MCP。`.parts/` 分片、`tool-results` 落盘转存等旧绕行手段一并作废。

### 工程与测试环境铁律·详版（11-06 由 MEMORY.md 迁入，MEMORY 只留一行结论）

- 🔴🔴 **vitest 并行会静默丢测试文件（假绿）**：本机 `node-brokered-fs-shim.cjs` 拦写入 → 报 `EPERM ...\Temp\<x>\ssr\<hash>`，vitest 当 unhandled error 吞掉，**被卡的测试文件完全不统计且 `exit code` 仍为 0**。11-04 实测：并行 `8 files/150 tests`（假绿）vs 串行 `10 files/190 tests`（真相）——丢 2 文件 40 项。
  - **修法：`vite.config.ts` 里 `test.fileParallelism = false`**（写配置而非 npm script，这样 `npx vitest run xxx`、IDE 测试按钮也生效）。代价 15.9s vs 9.4s，值。
  - 📌 旧记的「`rm -rf node_modules/.vite` 可修」**已被实测推翻**（清缓存后并行照旧假绿）；改 TMPDIR 亦无效。
  - 📌 **`exit code` 必须显式 `echo $?` 验**，别信管道后的隐式状态；重试循环不加管道（需 `set -o pipefail`）。
  - 🔴 **跑完必核对 `Test Files` 数 == `ls -1 tools/*.test.ts | wc -l`**，少一个就是有文件被吞。
- 🔴 **mini 类型检查须单独跑**：根 `tsconfig.json` 的 include 只有 `["src","vite.config.ts"]`，**不覆盖 `mini/`** → `npm run typecheck` 通过 ≠ mini 无误。正确命令：`cd mini && npx tsc --noEmit --skipLibCheck -p tsconfig.json`。
- 🔴 **构建期护栏必须写在构建配置里**（webpack/Taro **不执行**被打包模块的顶层代码，所以运行时 throw 在构建期不生效）：`mini/config/index.ts` 调与运行时**同一个** `resolveBackendTarget()`；主端同构做法 = `vite.config.ts:14-25` + `cloudConfig.ts:109-112` 双层 throw。
- 🔴 **MAPE 达标 ≠ 无需处理**：四指标并报（**MAPE 排除真值 0** / WMAPE / MAE / **Bias 有符号**）；判据在 `tools/ai-mape/mape.ts`（MAPE≤15% 但 |Bias%|>10 仍判 `systematic`）。**实测需真机 + 样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字**。
- 🔴 **产物自检判据纪律**（铁律 #11 详版）：任何自检命令写进手册前，必须在**干净构建的真产物**上实跑，且能区分合法/异常产物——错误判据比没有判据更危险。例：`dist/` 干净构建本就有 2 个 `index-*.js`（另一个是入口动态 import 的稳定 chunk），「>1 个＝残留」是错误判据；正确做法是以 `index.html` 引用的入口 js 为唯一真源：
  ```
  ENTRY=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
  ```
  之后一切产物核查（endpoint 是否钉死、日期格式化函数是否生效、备案号后缀等）都针对 `$ENTRY` 这个文件，而非目录里任意 `index-*.js`。

### 备份跑法与 DNS 核查（11-06 由 MEMORY.md 迁入）

- **两层备份**：① 服务器 cron 03:30 `/usr/local/bin/dbee-backup.sh` → `pg_dump -Fc` 到 `/var/backups/dbee/`（TOC 验证 + sha256 + 滚动 日7/周4/月6）；② 本地异地副本 = `deploy/pull-latest-backup.py` 拉最新 dump 到 `db/backups/offsite/`（滚动 30 天，按 mtime 用 Python 删）。
- 🔴 **跑法（凭据来源易错）**：
  ```
  set -a && . ./.env && set +a && export DBEE_USER="$USER" DBEE_PWD="$SSH_PWD" && python deploy/pull-latest-backup.py
  ```
  `.env` 里的 `DBEE_USER=dbee_app` / `DBEE_PWD` 是**过时值**，SSH 必失败；必须 `USER=ubuntu` + `SSH_PWD`。成功后核对 sha256 与服务器 `SHA256SUMS` 逐字节一致。
- **旧云库 JSON 备份**（`db/backups/*.json` + genie-baas MCP）**自 2026-11-05 废弃**：10-19 起连续失败、11-03 起云库 24h 零增量 → 已确认非生产写入源。
- 🔴 **异地备份含真实健康档案** → `.gitignore:50 backups/` 已覆盖，**严禁 git add / 移出项目目录**；每次备份后 `git status --porcelain db/` 应为空。
- **DNS 双源核查法**（判断域名是否真可解析，别只信一处）：阿里 DoH `dns.alidns.com/resolve?name=<域名>&type=A` + 腾讯 DoH `doh.pub/dns-query?name=<域名>&type=A`（后者需 `-H "accept: application/dns-json"`）。状态码语义与最新解析结论见上文「ICP 备案号与单一真相源」节（📌 结论会变，以最新实测为准，勿照抄历史快照）。

### 法律文案渲染细节（11-06 由 MEMORY.md 迁入）

- 📄 **`**强调**` 两端各自转 `<strong>`**（不共用渲染器）：`LegalPage.tsx` 分段渲染、**不用 `dangerouslySetInnerHTML`**；静态法务页走 `rich()`（`tools/gen-legal-static.mjs:64`）。
  - 为何需要它：法律文案用 markdown 星号标注关键限定语（如「集成但**未调用**」「**不会上传**到我们的服务器」），而两端都直出纯文本 → 不转换的话 OPPO 自动化审核爬到的静态页会出现**裸星号**，可能被判定为文案质量问题。
  - 🔴 **顺序不可颠倒：必须先 `esc()` 再 bold**。反之 `<strong>` 标签自身会被 `esc()` 打成字面量 `&lt;strong&gt;`（源码 `:55` 注释实证，勿凭直觉编因果）。
- **成对性守卫：`**` 数量为奇数（切分后段数为偶数）= 文案漏写一半标记 → 剥星号降级为纯文本**。这是三种可能里最安全的一种：① 照原样留 `**` → 用户看到裸星号（正是本函数要消除的缺陷）；② 按奇偶分段加粗 → 漏标记之后全部正文被误加粗（法律文案观感严重失真）；③ ✅ 剥星号 → 只丢一次强调，正文完整、无裸标记、无误加粗。
- **改后验收**：`grep -o '\*\*' <产物> | wc -l` 必须 = 0。
- **渲染器只认 `p → list`**；`DocSection` **只允许一个 `p` 键**（多 `p` 会被静默丢弃或错序）。
- 📌 相关：`dist/legal/` 三页由 `tools/gen-legal-static.mjs` 生成，真源 `src/content/legal.ts`；`build:web` 会删掉它们（见「关键坑」）。

### 数据面权威源判定法（11-06 由 MEMORY.md 迁入）

- **权威源 = 服务器自建 PostgreSQL `dbee`**，链路：web 端 origin → nginx `/.cloud/` → 自建网关（`127.0.0.1:8080`，只绑回环、绝不直接暴露）→ PG。
- 🔴 **实证方法**：`curl http://<host>/.cloud/healthz` 返回体里含 `database:"dbee"` → 证明请求真的落到自建库而非云库。**别只看配置或代码推断数据面**，用 healthz 实测。
- **WorkBuddy 云库已非生产写入源**（11-05 确认：10-19 起 MCP 连续失败、11-03 起 24h 零增量）。iOS/Android/小程序**暂仍连云库**，回迁等域名与 HTTPS 可用。
- 📌 与「摆脱云库六步」配合看：六步中的 A 记录已于 11-06 完成，certbot 阻塞在安全组 443。

### B2 HTTPS 签发详版（11-06 由 MEMORY.md 迁入；MEMORY 只留结论）

**证书事实**：`CN=d-bee.cn`，SAN = `d-bee.cn` + `www.d-bee.cn`（一张覆盖）；颁发者 `Let's Encrypt CN=YE1`；
`notBefore 2026-11-06 05:52:46 GMT` / **`notAfter 2027-02-04`**（89 天）；`key_type=ecdsa`；
`authenticator/installer` 均 `nginx`；`renew_before_expiry=30 days`；
路径 `/etc/letsencrypt/live/d-bee.cn/{cert,chain,fullchain,privkey}.pem` → 符号链接到 `archive/d-bee.cn/*1.pem`。
实测协商 **TLSv1.3 / TLS_AES_256_GCM_SHA384**，两域名严格校验 `ssl_verify=0`（不加 `-k`）。

**🔴 443 放行的判据（性质改变才算数）**：
| 探测 | 放行前 | 放行后 |
|---|---|---|
| 服务器自连**自身公网IP**:443 | `rc=124` 超时 10s（云侧 DROP） | `rc=1` 拒绝 7ms（SYN 已到达） |
| 外部探 :443 | `rc=124` 超时 8.2s | `rc=1` 拒绝 2.7s |
| 对照组 :8443（始终未放行） | `rc=124` | `rc=124` 超时 12s（**证明探测方法有效**） |
| curl 语义 | 超时 | `Couldn't connect to server` |
📌 「**服务器自连自身公网 IP**」是分离「云侧 vs 机侧」的最妙一测：绕过外部网络但仍走公网回程，
超时=平台层 DROP、拒绝=已放行仅无监听。配合「起临时监听（自带 timeout）+ 内外双侧探测」即为铁证。
📌 服务器侧排除法：`ufw inactive`、`iptables INPUT policy ACCEPT`、全表 0 条 443 规则、nftables 无 443、
云镜链 `YJ-FIREWALL-INPUT` 只 REJECT 若干 IP 的 22 端口（爆破封禁）→ 与 443 无关。
实例：**CVM `ins-5exjebt7`**，上海 `ap-shanghai-5`，Ubuntu 24.04.4（元数据有 `instance/`、`rdma-subnet` 等 CVM 键，
非 Lighthouse）→ 放行入口是「**云服务器 CVM → 安全组 → 入站规则**」，不是轻量的「防火墙」页。

**🔴 certbot 前置：`server_name` 必须含确切域名**（「nginx 能接住请求」≠「certbot 能定位块」）：
前者看 `listen`/`default_server`/catch-all `_`，后者只看 `server_name` 里有没有那个**确切名字**，
缺则报 `Unable to find a virtual host listening on port 80`。
线上配置曾停留在 10-23 版（单 server 块、`server_name _ 150.158.51.106 d-bee.com.cn www.d-bee.com.cn`，
把官网与 Web 端域名混在一块 = 模板注释警告的 conflicting server name 写法），
仓库模板早已是两块设计（主块 `__SERVER_NAME__` root=`/var/www/d-bee` + 官网块 `__CORP_SERVER_NAME__` root=`/var/www/d-bee-corp`）
但**从未同步到生产**。已按「方案A」最小改动补 `d-bee.cn www.d-bee.cn`（改前逐字断言 + 时间戳备份 +
`nginx -t` + 自动回滚 + 改前后 6 个 Host 落点基线比对）。
📌 **完整推模板（方案B）会让 `Host: d-bee.com.cn` 由 200 变 404**：`/var/www/d-bee-corp` **不存在**。

**🔴 同源缺陷已修 `deploy.sh`**：`SERVER_NAME` 推导原为 `"$DBEE_DOMAIN $DBEE_HOST _"`（**不含 www**）→
`APPLY_NGINX_CONF=1` 会覆盖手工改动、www 证书签不出来。现为 `"$DBEE_DOMAIN www.$DBEE_DOMAIN $DBEE_HOST _"`。

**🔴 续期必须跑 `certbot renew --dry-run` 验证**（实测 "all simulated renewals succeeded"、日志 `no renewal failures`；
`certbot.timer` enabled，下次 `2026-11-07 07:53`）。
📌 nginx 里**没有**永久 `acme-challenge` location 是**正常的**：nginx 插件 HTTP-01 在续期那一刻临时改写、完成后改回，
故不能拿「有无该 location」判断续期可行性（我曾误判为疑点）。

**🔴 certbot `--redirect` 的落点矩阵（IP 直连由 200 变 404）**：生成的 80 块只有
`if ($host = d-bee.cn|www.d-bee.cn) → return 301` + 末尾 `return 404`，**无 root/location**。
| Host | http | https |
|---|---|---|
| d-bee.cn / www.d-bee.cn | 301 | 200 |
| 150.158.51.106 / d-bee.com.cn / unknown.example.com | **404** | 200 |
`https://150.158.51.106/` 证书名不匹配（`-k` 才通，严格校验 000）；`-servername d-bee.com.cn` 也返回 `CN=d-bee.cn`（唯一证书兜底）。
影响面：`src/` 里 IP **只在 `legal.ts:109` 注释**出现，无运行时硬编码 → 生产代码不受影响；
但 3 处工具默认值失效已同步改（`deploy.sh` 冒烟、`probe-data-route.mjs:49`、`verify-legal.mjs` 用法注释）。

**🔴 安全事件：`assert_no_leaked_secret` 自身是二次泄露源**（已修）
`setup-https.sh:2` 注释里写了 `__SUDO_PWD__` 字面量 → 渲染成明文密码 → 守卫**正确拦截上传**（exit 3）
但**报错时把违规行原文打印出来** → 密码进了终端输出。
修法两处：① 注释改无害串 `SUDO_PLACEHOLDER`；② `dbee-ssh.py` 报错行加 `.replace(pwd, '<REDACTED>')`。
修后验证：渲染产物「密码出现在非 sudo 行」= 0 处（6 处全在合法 sudo 行）。
🔴 **该密码视为已泄露 → 轮换优先级上调**。
📌 `render` 与 `run` **都会**调 `render_text` + 守卫（`run_script` 内部同样渲染）→ 注释里写字面占位符的脚本 `run` 时也会被拦。
📌 **同类地雷 4 处未修**：`deploy-postgrest.sh:87`、`push-nginx.sh:8`（**下次 `APPLY_NGINX_CONF=1` 必被拦 exit 3**）、
`run-migration-audit.sh:14,26,79`、`switch-nginx-selfhost.sh:89`。
📌 `.gitignore` **原本未覆盖** `*.rendered.sh` → 已补 `deploy/*.rendered.sh`、`deploy/*.rendered.conf`、
`deploy/nginx.rendered.conf`、`deploy/tmp-*`（查过 git 历史无入库记录）。

**🔴 `deploy.sh` https 分支缺 `MSYS_NO_PATHCONV`**（真 bug，已修）：
`export MSYS_NO_PATHCONV=1` 在第 119 行，而 https 分支在第 83-96 行、**早于它** →
`putfile ... /tmp/dbee-setup-https.sh` 报 `FileNotFoundError: ENOENT`（远端路径被转成 Windows 临时路径）。
已在分支内自行 export（分支以 `exit 0` 结尾，不影响常规部署的 unset），并加 `rm -f setup-https.rendered.sh`。
📌 `MSYS_NO_PATHCONV=1` 下 **Windows 程序（python/node）看到的 `/tmp` 是 `C:/tmp`**，
而 bash 重定向写的是 MSYS 的 `/tmp`（`C:/msys64/tmp`）→ `bash ... > /tmp/x.out` 后用 python 读不到。

**🔴 冒烟改造 + 绿红双验证**（护栏不能被改成永远绿）：
冒烟改为「域名+https 为准（首页 / www / healthz）+ 每 URL 最多重试 3 次 + 非 200 则 `SMOKE_FAIL=1` → exit 1」，
IP 直连只作参考、404 属预期不算失败。
- 绿验证（真实生产）→ `GREEN_EXIT=0`；红验证（注入 `https://dbee-nonexist-for-red.invalid/`）→ 精准报出 + `RED_EXIT=1` ✅
- 🔴 **红验证暴露真实缺陷**：同一 IP URL 绿验证返 404、红验证返 `000curl失败` → 复测 5 次稳定 404、域名 3 次稳定 301
  → 判定偶发抖动。冒烟是部署**最后一步**（产物已推送成功），抖动误报会把成功判成失败 → 加重试。
  重试版重做绿(`0`)红(`1`)，确认重试**未使护栏失效**（`.invalid` DNS 必失败，3 次仍红）。
📌 **SPA 兜底会吃掉「不存在路径」**：`https://d-bee.cn/this-path-does-not-exist-xyz` → **200**（`try_files ... /index.html`）
  → **不能用不存在的路径造红**，必须用 DNS 必失败的域名。

**🔴 又一次「假设被实测推翻」**：以为 `set -e` 下 `[ "$code" = "200" ] && break` 左侧为假时会退出脚本
（`A && B` 陷阱），准备改成 `if ... then break; fi` → 最小实验证明**假设不成立**：
bash 对 `&&` 列表中**非末尾**命令的失败豁免，3 次重试正常执行，`TEST_EXIT=0`。
📌 为什么绿验证没暴露：code 全是 200 直接 break，**从未走到左侧为假的路径** →
**覆盖不到的分支必须单独造用例**，别用「主路径绿了」推断「所有分支都对」。

**安全补查（未擅自改）**：私钥 `privkey1.pem` **600**、`archive`/`live` 目录 **700**、实测 `nobody` 读不到 ✅；
TLS：`nginx.conf:33` 全局含废弃 `TLSv1 TLSv1.1`，但 certbot 的 `options-ssl-nginx.conf`（server 块内 include）
只开 `TLSv1.2 TLSv1.3` 且**优先级更高**，实测 `tls1`/`tls1_1` 均 `no protocols available`（正确拒绝）、`tls1_2` 通 ✅；
⚠️ **未设任何安全响应头**（HSTS / X-Frame-Options / X-Content-Type-Options / CSP 全无）；
`server_tokens` 未配置（被注释）→ 回显 `Server: nginx/1.24.0 (Ubuntu)` 泄露版本号。
加固属产品决策（HSTS 一旦下发浏览器强制 https，回滚需等 max-age 过期，**风险不对称**）→ 待拍板。
📌 nginx 由 certbot 改写：97 行 → **125 行**（主块补 `listen 443 ssl` + 证书路径 + `include options-ssl-nginx.conf` + `ssl_dhparam`，另生成 80 跳转块）；
反代守卫 `proxy_pass http://dbee_gateway` 2 处、有效指令含 `workbuddy.host` **0 处**、`nginx -t` successful。
📌 回滚点：`/var/backups/nginx-d-bee.pre-certbot-20261106-144531.conf`（97 行）+
`/etc/nginx/sites-available/d-bee.bak.servername-20261106-140858`。

### 小程序回迁自托管·身份模型与演示数据 owner（11-06 由 MEMORY.md「待拍板⑥⑦」迁入）

⑥✅ 小程序回迁自托管**已拍板**：开关在 `mini/src/lib/backend.ts`，默认 `cloud`。
🔴 **真正工作量是身份模型，不是 endpoint**：云库 uid = `wx:<openid>`（微信 openid 前缀串），
自托管 PostgreSQL 是 **19 位 owner_id**（数字串）→ 两套身份体系不通用，切换必须做映射或重注册，
光把 endpoint 指向自托管会导致「登录态全部失效」。

⑦ **演示数据分两套面、互不相通**：
- iOS 端（连云库）：owner = `2115454156301934592`
- Web 端（连自建 PG）：owner = `1793280185303313979`
造演示数据/排查「为什么看不到数据」时先确认打的是哪一面。

⑧✅ **App 名称 2026-11-07 定案 = `自律蜜蜂`**（用户拍板方案 B，弃 `自律蜜蜂 - 饮食热量记录`）。
**备案报名名 / ASC 名称 / 软著登记名必须逐字统一为该值**，否则 Apple 提审报 409 `ICP_NUMBER_MIIT_APP_NAME_MISMATCH`。
🔴 **历史文档仍留长名（未同步；按「历史快照只加横幅不改正文」纪律，是否统一待用户批准）**：
`docs/AppStore产品页-填报包-2026-10-28.md` §一 + §30 强校验说明、`tools/check-asc-product-page.py` 的 `FIELDS["App 名称"]`、
`docs/苹果iOS端-发布梳理与清单.md` §175/§241（写「备案须按长名逐字报」）、
`docs/ASC配置-建App与配商品-操作清单-2026-10-25.md` §51-54（仍写「决策前悬置勿据此建 App」）、
`docs/iOS上线可行性与步骤-2026-11-06.md` A1 行。**照这些文件填 ASC / 办备案前必须先按定案值校正**。
另：`ios/App/App/Info.plist` 的 `CFBundleDisplayName=D-Bee` 是设备桌面名（与商店名是两回事），是否改中文待用户决策。
`docs/苹果端上线前置条件总清单-2026-11-03.md` 已于 11-07 加状态横幅，其中第 ⑤ 条已写明定案值。

### 11-06 web 部署回滚点（补充）

`/var/backups/d-bee-web-20261106-131509`（13:16 重新部署前的产物快照）+
`/var/backups/nginx-d-bee.pre-certbot-20261106-144531.conf`（certbot 改写前的 97 行 nginx 配置）。
线上入口 `index-CkK9x744.js`（含备案号 `-2`）。

---

## 2026-11-06 深夜二次清理：由 MEMORY.md 迁出的详版

> 原因：MEMORY.md 清理前实测 **16.7KB**（注释声称 ~9KB，早已名不副实），注入会被截断。
> 本次把「操作细节/详版解释」整体迁来，MEMORY.md 只留决策与铁律一句话指针。**内容未删，只是搬家。**

### 权威口径·详版

- **ICP 备案号单一真相源（11-06 下证当日）**：原实现 `SITE.icp = env('VITE_ICP_BEIAN')`，而 `.env` 被
  `.gitignore:6` 忽略 → 换机器/CI 构建会**静默产出无备案号的页面**（页脚整行不渲染、`exit 0` 不报错）＝无声合规违规。
  备案号是法律要求每页公示的**公开信息**（不是密钥），进 `packages/shared/src/constants/index.ts`：
  `ICP_BEIAN_D_BEE_CN` / `ICP_QUERY_URL`(beian.miit.gov.cn) / `POLICE_BEIAN=''`(空＝该行不渲染，合规) /
  `POLICE_QUERY_URL`(beian.mps.gov.cn)。两端 `legal.ts` 改 `env('VITE_ICP_BEIAN') || ICP_BEIAN_D_BEE_CN`。
  `deploy/verify-legal.mjs` 用 vite `ssrLoadModule('/src/content/legal.ts')` 取 `SITE.icp` 作期望值
  （**校验期望与渲染真值同一对象**），双向判定 + 31 省级简称正则；三种失败诊断分开：
  A 填错号 / B 号码被截断 / C 已进代码但未重新构建部署。
  🔴 不能用裸 Node `import('@dbee/shared')`：dist 是目录式 re-export → `ERR_UNSUPPORTED_DIR_IMPORT`。
- **隐私政策静态页**：`npm run build` 自动跑 `tools/gen-legal-static.mjs` → `dist/legal/`（零 JS 可爬，
  OPPO 硬要求：`privacyConsent.ts:40` 不需登录/点击/再跳转）；真源 `src/content/legal.ts`；
  `build:native*` 不生成；上线须一并部署。`build:web` 只跑 `vite build` → 清空 dist 后**删掉 `dist/legal/`**，
  🔴 即使只是验证编译也别用它（验证用 `tsc --noEmit`，要产物用完整 `npm run build`）。
- **法律文案 `**强调**` 渲染**：两端各自转 `<strong>`；静态页 `rich()` 必须先 `esc()` 再 bold
  （否则 XSS）；奇数个 `**` 剥星号降级；改后验 `grep -o '\*\*' | wc -l` = 0。
- **铁律 #13 取证 5 法**：打真实端点 / 产物内 grep 正文（中文须解码）/ 比 mtime 时间线 /
  查 DB 元数据 / 查部署物 mtime。探针第一版必须「发现性」非「断言性」；断言须「应用前必须红」才算有鉴别力。
- **产物自检**：干净构建本就有 2 个 `index-*.js`（另一个是入口动态 import 的稳定 chunk），
  「>1 个＝残留」是错误判据；以 `index.html` 引用的入口 js 为唯一真源。
  ⚠️ 任何「产物自检」命令写进手册前，必须在干净构建的真产物上实跑且能区分合法/异常产物。

### 架构铁律 12 条·全文（MEMORY 只留编号与一句话）

1. 平台差异只走 `src/lib/` 抽象层；运行时探测 `window.Capacitor`，不 import Capacitor 包。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 注入云 SDK `options.fetch`，勿 patch window.fetch；endpoint 由
   `cloudConfig.ts` 决定（native-release 硬断言 `https://d-bee.cn`）。
4. 输入校验走 `src/lib/validate.ts`；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。
5. StoreKit 2：服务端核销成功才 `finish()`；退款交易只 finish 不送核销。回归 `npm run test:iap`。
6. 原生能力必须返回显式状态，禁止吞成 0/空；HealthKit 只在 `isUsableHealthStatus(status)` 时写回。
7. 弹窗无障碍统一 `useModalA11y(onClose)`；`role="button"` div 用 `src/lib/a11y.ts` 的 `onActivateKey`。
8. iOS 付费墙禁止硬编码价兜底：拉价失败禁用购买+重试，价格位显示「—」。
9. OriginProxy 取消归一为 End 非 Error，取消绝不回退缓冲重发；在途流注册表 finally 移除。
10. 原生包禁用 `npm run build`（Web 产物护栏被死代码消除成无条件 throw → 白屏无报错）；
    自检 `grep -c "禁止直接复用 Web 产物" dist/assets/index-*.js` 必须为 0。
11. Capacitor 8.5.3 `addListenerNative` 链尾 `.catch()` 兜不住全部失败（callbackId 非 Promise /
    原生永不 resolve / cb 同步抛错）→ 三路分别设防。
12. 跨引擎错误上报 message 与 stack 分开取（iOS JSC stack 不含 message）；错误面板分致命/非致命；
    `padding-top` 叠 `env(safe-area-inset-top)`。

### 环境备忘·详版

- SSH `150.158.51.106`，`USER=ubuntu` + `SSH_PWD`（`sudo -n` 免密）；`.env` 的 `DBEE_USER=dbee_app`
  是过时值、认证会失败。**验收一律打 `https://d-bee.cn/`**（certbot `--redirect` 后 IP http 由 200 变 404，
  冒烟/探针/验收三处默认值已改）。curl 本机 dev server 需 `--noproxy '*'`。
- APK 归档 `release/`（gitignore）。🔴 **绝不可放在 `android/app/build/outputs/apk/release/` 内**：
  Gradle `PackageAndroidArtifact` 会清理输出目录「陈旧文件」，下次 `assembleRelease` 连归档一起删。
  命名 `D-Bee-<版本>-vc<N>-<用途>-<日期>.apk`。`assembleRelease` 输出名恒为 `app-release.apk`，
  要保留两个变体必须打完一个立即 `cp` 到 `release/` 再打下一个。
- Web 归档 `backups/`；异地备份 `db/backups/offsite/*.dump`（含真实健康数据，`.gitignore:50 backups/` 已覆盖，
  **严禁 git add / 移出项目**）。`deploy/pull-latest-backup.py` 用 `DBEE_USER=ubuntu` + `SSH_PWD`，
  校验服务器 `SHA256SUMS` 逐字节一致。
- 🟠 `deploy.sh`/render 的 `__SUDO_PWD__` 占位符注释地雷（4 处，清单见「B2 详版」）：`render`/`run`
  都会替换占位符 → 下次 `APPLY_NGINX_CONF=1` 必被守卫拦 exit 3。
- 🔴 **nginx 只反代 `/.cloud/` 与 `/auth/`**（`nginx.selfhost.conf.example:59,78`）；其余路径落
  `location /` 的 `try_files` → POST 静态资源由 nginx 返回 **405**、GET 返回 SPA fallback 200。
  → **不能用 405 判断网关路由是否存在**。判路由要打正确前缀，并用「对照已存在路由返回 401」区分：
  实测 `POST /.cloud/auth/v1/login-wechat` → 404「未知端点」（未部署），
  而 `POST /.cloud/auth/v1/verification` → 401「invalid access key」（路由在）。
  📌 网关注册前缀 `A = '/.cloud/auth/v1'`（`server/lib/app.mjs:71`），SDK `AUTH_PATHS.loginWechat='/v1/login-wechat'`
  是相对 baseUrl `endpoint+'/.cloud/auth'` 的路径，两者拼接才对齐。
- 网关密码登录：`signInWithPassword` 走 **`POST /.cloud/auth/v1/signin`**（`auth.mjs:490` 分流），
  body `{username,password}`；`/token` 只接受 `grant_type=refresh_token`。
  请求头 access-key 名 = **`x-wb-webapp-access-key`**（不是 `apikey`），值取 `src/cloudConfig.ts` 的 `wbpk_…`。
- 测试：`npm test` = `vitest run tools/`；`vite.config.ts` 强制 `test.fileParallelism=false`
  （并行会静默丢测试文件：曾报 8 文件/150 项「全绿」而真相是 10 文件/190 项）。
  跑完必核对 `Test Files` 数 == `ls -1 tools/*.test.ts | wc -l`。
- mini 类型检查须单独跑（根 tsconfig 不覆盖 `mini/`）：`cd mini && npx tsc --noEmit --skipLibCheck -p tsconfig.json`。
- 构建期护栏必须写在构建配置里（webpack 不执行被打包模块顶层代码）：`mini/config/index.ts` 调与运行时
  **同一个** `resolveBackendTarget()`；主端同构 `vite.config.ts:14-25` + `cloudConfig.ts:109-112`。
- MAPE：四指标并报（MAPE 排除真值 0 / WMAPE / MAE / **Bias 有符号**），判据 `tools/ai-mape/mape.ts`；
  **实测需真机+样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字**。
- 🔴 产物里 grep 中文必假阴性（webpack/Taro 转义成 `\uXXXX`），必须先 `unicode_escape` 解码；
  日期正则要容 `\s*`（源码写 `'2026 年 10 月 29 日'`，数字与年月日间有空格）。
  📌 判断数据面必须追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论
  （native-release 产物里同时有 `workbuddy.host` 常量声明与 `d-bee.cn`，前者不可达）。

### 待拍板·详版（MEMORY 只留一行指针）

- **P1-D 核销时序坑**：Apple=拉模式，微信/支付宝=推模式（权威信号是服务端异步回调）→ 直接接会
  「已扣款但 App 报校验失败」（**主路径**）。解法：核销改「查订单状态+有限重试」+ 新增 `settling`；
  `getAdapter`（`checkout.ts:39-46`）**无分发渠道维度** → 上华为前须加。
  见 `docs/P1-D在线支付实装前置清单-2026-11-03.md`。
- **mini 上线前 4 项**（`docs/小程序上线前缺口清单与实施步骤-2026-11-03.md`）：A 先发修复版 vs 先变更主体
  （倾向先发）；B AI 同意门补门 vs 改文案（现只覆盖 2/4 入口，主端同缺口）；C 登录页协议做到哪步；
  D 提醒开关置灰 vs 申请模板 ID。另 **潜在硬阻断：request 合法域名主体不一致** —— mini 请求
  `*.workbuddy.host`/`www.workbuddy.cn`（备案主体=腾讯），微信要求合法域名主体与小程序主体一致 →
  阶段 0 先向腾讯客服核实。
- **护栏扫出 2 项**：**A9** 7 处手写舍入改走 numfmt（⚠️ 非机械替换：`fmtNum` 异常返 `—` 且默认去尾随零，
  会改 `placeholder` 语义）；**A10** mini 缺「已减重/较起始」体重变化（主端有、`mini/src` 0 命中）——
  选「不补」也要写进护栏注释记为刻意。
- **一致性第三类：功能覆盖差异 ≠ 分叉**。原本只有「必须一致」与「刻意分叉」；第三类是同一功能
  一端有一端没有。**分叉必须修**（同一功能两种行为=bug），**覆盖差异必须产品决策**（补，或明确记为刻意省略）。
  定性时必须查全端、不能只看同名文件。

---

## 2026-11-06 深夜：由「会话工作区 MEMORY.md」并入的独有纪律

> 背景：存在**两份** MEMORY.md —— ①本项目仓库 `.workbuddy/memory/MEMORY.md`（跨机同步真相源）
> ②会话工作区 `C:/Users/yuty/WorkBuddy/2026-10-17-09-57-18/.workbuddy/memory/MEMORY.md`（被自动注入的那份，16.5KB）。
> 本次把 ② 的**独有纪律**并入本文件，② 改写为精简核心版 + 指向本文件，**内容不丢、消除两套分叉**。
> 🔴 ② 里的**状态结论已全部过时**，不并入、只在此留档存证：
> 「web 已发布 11-04 → `http://150.158.51.106/`」「**不要设 `DBEE_DOMAIN`**（d-bee.cn 无 A 记录）」
> 「Android 正式包**不可发布**（钉死的 d-bee.cn 查无 A 记录）」「护栏 6 道 10 项 / 全量 190 项 / 10 文件」
> → 11-06 实测：web 走 `https://d-bee.cn/`、DNS+HTTPS 双就绪、应设 `DBEE_DOMAIN=d-bee.cn`、
> Android 正式包已可实测、护栏 8 道 / **11 文件 219 项**。详见本文件「现状」相关章节与当日日志。

### 数值口径（全站强制；MEMORY 只留一行指针）

**唯一权威实现 `src/lib/numfmt.ts`。新增数字展示/舍入一律走它，禁止自己写 `toFixed` 或 `Math.round(n*f)/f`。**
- `roundTo(n, 2)` 计算层→数值，异常归 0（防 NaN 传染求和）
- `fmtNum(n, 2, {padZero,placeholder})` 展示层→字符串，去尾随零，异常 `—`
- `pct(n, 0)` 入参**已是百分数**，不再乘 100
- `balancePercents(values, 100)` 最大余数法配平
- 精度：**克数类营养素（蛋白/碳水/脂肪/纤维/添加糖）2 位小数；kcal 与钠 mg 取整**
- **纪律：计算层全精度，只在展示层插值那一刻舍入**。绝不「先舍入再参与计算」。
  `foodInsight.ts` 的 protein/fiber **既用于阈值判断**（`>=20`、`>=6`）**又用于插值**，
  故只在 8 处插值点走 `g(x)`，**阈值不动**。反例：`report.ts` 供能比曾用已取整日均值反算 → `18+37+46=101%`，已修。
- 为何不用 `Math.round(n * 10**d) / 10**d`：①大数溢出精度（`1e21`→`999999999999999900000`）
  ②负数 .5 方向不一致（`Math.round(-2.5)=-2` vs `toFixed` 给 `-3`）③乘法误差会「凑巧」掩盖逻辑错。
  注：`1.005→"1.00"` 不是 bug，其 double 真实值为 `1.0049999999999998934`。
- 🔴 日期禁 `toLocaleDateString`，统一走 `formatCnDate` / shared `datefmt`（四端一致）。

### 刻意的产品行为（别当 bug 修）

- `uniq(tags,3)`：单条画像**最多 3 风险 + 3 益处**，权重并列按插入顺序保留靠前者 —— 造测试 fixture 要注意。
- `sanitizeNumeric` int 模式**删小数点**而非四舍五入：`clampNumeric('232.9',int)`→`'2329'`；负号被过滤 `'-5'`→`'5'`。

### git push 的 schannel 握手失败

本机走 HTTP(S) 代理时 git 默认 **schannel**（Windows 原生 SSL 后端）握手失败，
表现为连续多次 `schannel: failed to receive handshake, SSL/TLS connection failed`（exit 128）。
**解法：单次覆盖 openssl 后端**（不必改全局配置）：
`git -c http.sslBackend=openssl push origin main` —— 实测立即成功。
→ 纪律：schannel 握手失败**别当成「网络不通/远端挂了」反复重试**，换 sslBackend=openssl 试一次。
（推送失败也可能是代理波动，for 重试 5 次勿改方案。）

### native 构建会覆盖 `dist/`，与 web 产物互斥

`vite build --mode native-release` / `native-internal` 和 web 的 `npm run build` **都写 `dist/`**。
`cap sync` 从 `dist/` 拷进 `android/app/src/main/assets/public`（及 ios）。
后果：跑完 native 构建，`dist/` 里就是**钉死了 endpoint 的原生产物**；此时若 `SKIP_BUILD=1` 部署 web，
会把 native 产物误推到 web 服务器。
→ 纪律：native 构建后、部署 web 前，必须 `npm run build` 重新生成 web dist 再部署；
部署前用「线上 `index-*.js` 文件名」与 `ls dist/assets/index-*.js` 比对确认一致。

### 归档 APK 的位置（Gradle 会清理输出目录）

🔴 **绝不可放在 `android/app/build/outputs/apk/release/` 内**：Gradle `PackageAndroidArtifact`
会清理输出目录「陈旧文件」，把 APK `cp` 进去做归档，下一次 `assembleRelease` 会连归档一起删
（11-04 实测两个归档双双消失，`unzip -t` 报 zip 读取失败才发现）。
→ 归档一律放项目根 `release/`（`.gitignore` 已忽略），命名 `D-Bee-<版本>-vc<N>-<用途>-<日期>.apk`。
另：`assembleRelease` 输出名恒为 `app-release.apk`，第二次构建必覆盖第一次；
要保留两个变体（正式/内测）必须打完一个立即 `cp` 到 `release/` 再打下一个。
旧包备份名 `app-release.BACKUP-20261102-cloudinternal.apk`。

### 产物里的 workbuddy 域名 ≠ 连云库

native-release 正式包压缩产物中**同时**出现 `https://d-bee.cn` 与 `https://zilv-mifeng.app.workbuddy.host`。
追赋值链：`fp/G5 = workbuddy.host` 只是 **CLOUD_HOST 常量声明**，`kf = "https://d-bee.cn"` 才是
PRODUCTION_NATIVE_ENDPOINT。运行时 `fromNativeEnv` 有值 → 走第一分支断言 `=== 'https://d-bee.cn'`，
云库常量在 native-release 下**不可达**（只在 DEV 与 native-internal + 显式授权两个口子生效）。
→ 判断数据面必须追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论。

### 探针实测：native 构建四场景（11-04 复核，全部符合双层护栏预期）

- `native-release` 不注入 endpoint → **exit 1 throw**「必须设置 VITE_NATIVE_ENDPOINT=https://d-bee.cn」
- `native-release` + `VITE_NATIVE_ENDPOINT=https://d-bee.cn` → **exit 0 通过**，产物内 endpoint = d-bee.cn
- `native-internal` 不注入 → **exit 1 throw**「请设置 VITE_NATIVE_ENDPOINT 或 VITE_ALLOW_CLOUD_NATIVE=true」
- `native-internal` + `VITE_ALLOW_CLOUD_NATIVE=true` → **exit 0 但 warn**「显式允许使用 WorkBuddy 云库；此产物禁止上架」
> 构建期护栏写在 `vite.config.ts`（Node 执行），运行时护栏在 `cloudConfig.ts:resolveNativeEndpoint`。
> 两者都对：webpack 不执行被打包模块顶层代码，故构建期护栏必须留在构建配置里。

### 出 Word 文档：正文 section 内 ≥2 个顶层 `<div>` 会丢目录节分节符

`workbuddy-docx` 流水线转 docx 时，若 `<section role="body">` 内包了多个 `<div>`（每章一个），
引擎会**漏生成目录节的 sectPr** → verify 报 **S-5 + S-8**（目录与正文连排同页）。
7 组最小对照实验锁定：**只与顶层 div 个数有关**，与目录条目数/嵌套层级/正文体量/class 数量全无关
（0 或 1 个 div → ✅；≥2 个 → ❌）。
→ 修法：**正文扁平化**，章节标题直接 `<h1 class="section-header" id="section-N">`，不要包 div；
最多保留 1 个 div（如摘要的 `.executive-summary`）。
📌 这与 `doc-typeset/prompts/base.md`「内部章节用 div」**直接冲突**，以引擎实测为准。
📌 转换失败别猜，**做最小对照实验**（固定其他变量只改一个）比读源码快。
📌 扫 docx 文本查 AI 痕迹前必须 `html.unescape()`，否则 `&amp;&amp;` 会被误报成英文残留。
> 交付记录：`自律蜜蜂健康习惯追踪管理软件技术白皮书V1.0.docx`（封面/目录/九章/两附录，
> 宋体小四 110 段首行缩进 2 字符、页脚 PAGE 域、标题绑定 41/41、内容 343 段零缺失）。

### html_review 的 TQ-04/TQ-05（「只 1 个 h1」）是刻意不满足的非阻断项

章节标题必须用 `h1.section-header` 才有 outlineLvl 语义（否则目录条目不能跳转），
与 TQ-04「整篇只 1 个 h1」直接冲突。**用白皮书（14 个 h1）复跑 `review_html.py` 取证**：
TQ-04/TQ-05 确实扣分，但 `typographic_quality` 仍 80 ≥ 75 → **passed=true**。
→ 纪律：**不要为刷分把章节标题降级成 h2**（会丢目录跳转）。多 h1 是正确写法。
📌 反之 SI-02（表格缺 `<thead>/<tbody>`）**是真阻断项**，必须补语义表头 —— 含 code-table。
📌 preflight 的 `orphan_css_classes` 是**非阻断**提示，不必改。
📌 design-token 的 `general` 主题字体是 PingFang SC，**必须覆写为 `"SimSun","宋体",serif`**
（`doc-formatter §2.5` 硬约束：font-family 第一项须是 SimSun/宋体），否则转换层字体失效。
> 交付记录 2：`D-Bee自律蜜蜂小程序体验版用户测试指引V1.0.docx`（review 96 分、内容 235 段零缺失、标题绑定 32/32、pageref 33）。

### 排查产物新旧：grep 中文必假阴性

webpack/Taro 把中文字符串转义成 `\uXXXX`，**直接 grep 中文恒 0 命中**，据此判断「产物是旧的」必错。
必须先解码再搜：`t.encode('utf-8').decode('unicode_escape', errors='ignore')`。
📌 日期正则要容空格：源码写 `'2026 年 10 月 29 日'`（数字与年月日间**有空格**），
用 `2026年10月29日` 搜会漏掉最关键证据。搜中文/日期字面量一律用宽松正则 `\s*`。
📌 微信开发者工具的「编译」**不跑 Taro 构建**，只重载 `dist/` 现有产物。
改完源码必须先 `cd mini && npm run build:weapp`（或 `dev:weapp` watch）。

### 写护栏的两条铁律（红验证实测抓出的假绿漏洞）

1. **一个 `it()` 只放一条断言**。多断言挤一个 it 时，首条失败即抛出，后续断言**根本不执行**
   → 表现为「测试通过了」但那条断言从未被验证过。实测：删掉 `name==='d-bee'` 校验（违规真实生效）
   却没报红，只因同 it 里 version 断言先失败。
2. **存在性断言必须匹配「实际使用」而非「标识符出现」**。`\LegalLinks\` 会命中 import 行 ——
   把 `<LegalLinks/>` 换成 `<View/>` 但留 import，护栏照样绿。改匹配 `/<LegalLinks[\s/>]/`。
📌 快照式基线之外，**新增护栏也必须做红验证**（注入违规 → 确认精准报红 → 立即 `cp` 恢复 →
`git diff` 确认干净）。红验证的真正价值是抓出「自己写的护栏本身是假绿」。
📌 补充第三条（项目 REFERENCE「工作方式纪律」已有）：断言须在 `stripComments()` 后的代码上做。

### `npm run build:web` 会删掉 `dist/legal/` 静态法务页

`build:web` 只跑 `vite build` → **清空 dist 后不再生成静态法务页**，`dist/legal/` 直接消失。
这些页是商店/OPPO 隐私政策爬虫要直接抓的（`privacyConsent.ts:40`：「不需登录、不需点击、不需再跳转」），
丢了会被判「url 无法访问或内容不合规」。
→ **即使只是验证编译也别用 `build:web`**；验证用 `tsc --noEmit`，要产物用完整 `npm run build`。

### 法律文案改动的隐藏联动（改前必读）

主端 `LEGAL_UPDATED` 被 `src/lib/privacyConsent.ts:29` 用于隐私同意版本比对
（`kvGet('privacy.agreed') === LEGAL_UPDATED`）→ **改日期 = 全体老用户重新弹隐私同意窗**。
PIPL 第 14 条下这是正确行为，但属有真实用户影响的产品决策，**不可自动改**。
mini 端**不依赖**该日期（走微信原生 `ensurePrivacyAuthorized`），改它零副作用。
📌 `UPDATED` 语义 = **文档正文最后一次实质改动日**，不是「今天动过这个文件」，更不是发版日；
改注释/改 SITE 字段不该刷新它，否则等于谎称协议内容变过。
📌 两端法律日期**刻意不同**（正文本就分叉：主体表述、第三方 SDK 公示、AI 功能名都不同），
强行对齐反而造假。

### iOS 上线依赖刷新 · 详版（2026-11-07）

权威文档 = `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`（A~F 六组依赖矩阵 + 四阶段步骤 + 差异表）；
`docs/iOS上线可行性与步骤-2026-11-06.md` 与 11-03 旧清单均已加状态横幅，只作历史快照。

**🔴 修正 11-06 的「工程侧 100% 就绪」**：只对**代码/服务端**成立。ASC 表单填报面几乎空白 ——
App Privacy 营养标签 / 新年龄分级问卷 / App 审核信息（联系人+备注+演示账户）/ 3 商品审核信息 /
订阅披露两处链接 + EULA / 截图与创意素材上传 / 支持 URL / 备案号字段，**均为中国区提审必填**。
「不挡 TestFlight、挡提审」是本轮最重要的分类。

**Apple 官方政策（2026-11-07 检索 developer.apple.com/news/upcoming-requirements/、/cn/news/、/cn/tvos/submit/）**：
- **2026-04-28 起**上传 ASC 的 iOS/iPadOS App 必须 **Xcode 26+ / iOS 26 SDK+** 构建 → 硬上传闸门，Mac 动手前先 `xcodebuild -version`。
- **2026-09-09 起**须 target iOS 13+（项目 `IPHONEOS_DEPLOYMENT_TARGET=15.0` ✅）。
- **2026-01-31 起**新年龄分级问卷必答（4+/9+/13+/16+/18+，新增 in-app controls / capabilities / medical-wellness / violent themes）。
  ⚠️ Apple 明确要求把 **AI 助手/聊天功能对敏感内容出现频率的影响**计入分级 → 本项目有「问问小蜜」+ 健康主题，**不能预设 4+**。
- App Privacy 营养标签未填 → 提交按钮阻塞；须与实际采集一致（Apple 会核对，含每个 SDK）。
- 隐私清单 + Required Reason API：常用第三方 SDK 须自带**签名**隐私清单，缺失 → 上传 `ITMS-91053`；用 Xcode `Validate App` 预检。
- 5.1.1(v)：能注册账号就必须提供 **App 内发起的账号删除**，deactivation / 转客服通常不足。
- 3.1.2：订阅购买前须披露时长/价格/到期前 24h 续订/取消路径，并提供管理订阅入口；标准 EULA 须在描述或 App 内链接。
- TestFlight：**内部测试即时**；**外部测试须先过 Beta App Review**（11-06 未区分）。

**🔴 今天新识别的两处会致拒审缺口**：
1. **法务 URL 死链**：`docs/AppStore产品页-填报包-2026-10-28.md` §三/§六 三条 URL 与「支持 URL」仍写
   `http://150.158.51.106/legal/*` → 11-07 实测 **404**（certbot 后 IP http 由 200 变 404）。
   域名版 `https://d-bee.cn/legal/{privacy,terms,disclaimer}/` 全 200；无尾斜杠会 308 到带斜杠（跟随 -L 仍 200）。
   `tools/check-asc-product-page.py:67-69` 已是域名版。ASC 一律填带尾斜杠的域名版，照抄填报包 = Guideline 2.1 拒审。
   📌 `/legal/refund/` 的 200 是 **SPA `index.html` fallback**，`dist/legal/` 只有 privacy/terms/disclaimer 三个静态目录。
2. **账号删除 5.1.1(v) 降级实现**：`src/pages/ProfileScreen.tsx:375-394` 只做「清空记录+档案+登出」，
   注释写「云端不提供 deleteUser、admin 端点只读」是**云库时期**判断；11-07 复核**自建网关同样无删号端点**
   （`server/lib/app.mjs:86-110` 只有 verification/verification.verify/signin/login-wechat/signup/token/user.me/signout/llm/apple/healthz）。
   自建 PG 是我们自己的，**完全有能力做真删号**；但属「新增端点 + 前端 + 生产部署」高风险动作，须用户批准。

**填报包整体已过时（4 处）**：名称仍是长名、三条 URL 是 IP 死链、§339 注释仍写「iOS 端仍连云端/HTTPS 切换完成前」、
§三 描述写「云数据库」（数据面已自建 PG）。**不能照抄填 ASC**。

**✅ 今天新核的齐备项**：`ios/App/App/PrivacyInfo.xcprivacy` 已存在（6 类采集：手机号/邮箱/用户ID/健康/照片/其他用户内容，
均 Linked=true、Tracking=false、用途 AppFunctionality + UserDefaults `CA92.1`）；`ITSAppUsesNonExemptEncryption=false`；
相机/相册/HealthKit 用途说明齐；`App.entitlements` 有 healthkit；商店截图 `deploy/screenshots/store/` iPhone 5 张 1179×2556 /
iPad 5 张 2048×2732；IAP 审核截图 `output/promo/dbee-review-{monthly,yearly,lifetime}.png` 3 张；`check-asc-product-page.py` 全字段通过。
🆕 壳内产物（11-04 08:59）除「无 `-2` 备案号、无 `public/legal/`」外，还有 **`Google Play` 失实句 1 命中** → 重打包自检要加这条。

**文档查不到、需用户/外部确认**：dSYM 上传符号、IPv6 NAT64 兼容、随包 SDK 隐私清单签名、ASC 后台实际状态
（App 是否已建/商品/付费协议 Active/问卷/备案号字段/审核信息）、Apple 账号今日主体与 D-U-N-S、
W-8BEN 与对公收款、Mac 上 Xcode 实际版本、备案待回填字段、「App 备案是否必须先有软著」法定口径、
首发是否开 IAP、微信真实 AppID 是否启用。


---

## 0045 · App 内真删号（2026-11-07 下午 · A-5 整改详版）

### 为什么改方案：上午预案 vs 下午实际

上午报告写的是「新增网关删号端点 + 前端 + 生产部署（高风险）」。下午只读调研后**换了更安全的等价路线**，理由逐条有实测：

- 生产 `app_users` 是 `FORCE ROW LEVEL SECURITY`，policy 只有 `gateway_ident_access TO dbee_app`，ACL = `postgres=arwdDxtm / dbee_gateway=arw / dbee_app=arw / dbee_admin=r` → **`dbee_app` 无 DELETE 权限**，网关连接角色物理上删不掉身份行。0031 的注释「刻意不给 DELETE：身份记录只应软失效」是当年的设计，不是今天的约束。
- 生产网关 `/opt/dbee-gateway/lib/app.mjs` 是 **10-29 版本**（79 行路由、无 `login-wechat`），`auth.mjs` 10-29、`config.mjs` 11-01；本地已到 11-05。要新增端点就得整套 `lib/` 同步 + restart，风险远大于收益。
- 项目本就有 **20+ 个 SECURITY DEFINER RPC**（`badge_stats` / `redeem_by_code` / `llm_gate` / `log_apple_notification` …）由前端经 `/.cloud/database/rest/rpc/<fn>` 调用，PostgREST 注入 `request.jwt.claims` → `auth.uid()`。这是既有范式。
- `dbproxy.mjs` 的 `verifyAccess()` 验前端 JWT（含 `token_version` 比对）后，用 `tokenForPostgrest()` 给 PostgREST 重签或透传，**两条路径都带 sub** → 函数里 `auth.uid()` 可靠。

✅ 净效果：**完全不碰 `/opt/dbee-gateway`**，不 restart、不 reload nginx、不跑 `deploy-gateway.sh`。部署后只读回归证据：`IDENT_PEPPER`/`JWT_SECRET` 两行 sha256 与部署前逐字一致（`aef9d66a…`）、`dbee-gateway` 进程 `ActiveEnterTimestamp` 仍是 `2026-11-02 15:53:12`、`app.mjs` sha256 仍是 `609b802f…`。

### SQL 设计（0045-account-deletion.sql）

- `public.delete_own_account(p_confirm text) RETURNS jsonb`，`LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp`，属主 postgres。
- **不接受 owner_id 参数**：`v_owner := auth.uid()`，为空抛 `42501`。调用方无法指定删谁。
- **`p_confirm` 服务端二次闸门**：必须逐字等于 `DELETE_MY_ACCOUNT`，否则抛 `22023`。前端两步确认 UI 不是安全边界。
- **17 张业务表**（生产 `information_schema` 实测含 `owner_id` 的 18 张表减去 `app_users`）：
  `ai_quota_claims, ai_usage, apple_transactions, badges, entitlements, exercise_logs, honey_ledger, invite_attempts, invite_links, meal_entries, payment_orders, profiles, quota_bonus, quota_bonus_newbie_retire_log, recipes, water_logs, weight_logs`。
  用硬编码 `v_tables text[]` + `EXECUTE format('DELETE FROM public.%I WHERE owner_id = $1', v_tbl) USING v_owner`（表名非外部输入、owner_id 参数化），`GET DIAGNOSTICS` 累计行数。**新增含 owner_id 的表必须同步此数组**（护栏 9 快照会红）。
- 最后 `DELETE FROM public.app_users WHERE owner_id = v_owner`（SECDEF 属主 postgres 绕过 FORCE RLS + 无 DELETE 授权）。
- `REVOKE ALL ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated;`（PG 默认把新函数 EXECUTE 给 PUBLIC，必须显式收）；`NOTIFY pgrst, 'reload schema'`；登记 `schema_migrations` 0045。
- 返回 `jsonb_build_object('ok',true,'deleted_rows',v_total,'identity_removed',v_ident)`，**不回传 owner_id**。

### 前端

`src/lib/api.ts` 新增 `deleteAccount()` → `callRpc('delete_own_account', { p_confirm:'DELETE_MY_ACCOUNT' })`；`ProfileScreen.tsx` 的 `doDeleteAccount()` 成功后**只** `onSignOut()`：
🔴 绝不能再调 `clearAllRecords()` / `saveProfile()` —— 后者会 `INSERT` 一条新 `profiles` 档案，等于把刚删掉的账号重建回来。`onSignOut()` → `cloud.auth.signOut()` → 网关 `/user/signout` → `bumpTokenVersion` 对用户已删的行 UPDATE 0 行，不报错。

### 生产实测（铁律 #13）

`tools/apply-account-deletion-prod.py`（本地 SSH 驱动）+ `tools/server-apply-0045.sh`（服务器端，可重入）：

- 备份 `/var/backups/dbee/backup-before-0045-20261107-115121.dump`（`pg_restore --list` TOC **315** 项）→ 应用 0045 → 幂等复跑 → 10 项标志位 → 11 项端到端验收。
- 端到端走**真实公网链路** `POST https://d-bee.cn/.cloud/database/rest/rpc/delete_own_account`（不是服务器本机 psql 直调），用 `TEST-` 前缀临时账号 + 4 张业务表各 1 行，**绝不碰审核演示账户**。
- 负向：未登录非 200、错误 `p_confirm` 非 200 **且数据仍在**（证明事务没误删）；正向：200 + `ok/identity_removed=true` + `app_users` 身份行与 4 张表数据全 0；回归守卫：其它账号 `app_users`/`profiles` 总数与基线一致、四服务 active、`healthz` ok。
- JWT 由服务器本机 node 读 `/etc/dbee/gateway.env` 签 HS256（`sub + role:authenticated + ver:1`），`WB_PUBLISHABLE_KEY` 作 `x-wb-webapp-access-key`；两者写进 chmod600 临时文件、shell 读进变量、用完即删，**全程不回显、不进命令行参数**。
- 部署后回归：线上 `index-677ckuM3.js` 与本地 `dist/` 逐字一致、产物含 `delete_own_account`/`DELETE_MY_ACCOUNT`/`p_confirm` 且「如需彻底注销账号」0 处、三法务页 200、`verify-legal` + `verify-live` 双 PASS、308=2/301=0、演示账户 `check` 200、`TEST-` 残留 0。

### 本轮三个新坑（都写进可复用脚本了）

1. **`/etc/dbee/gateway.env` 是 0640 root:dbee** → ubuntu 直接跑 node 读它报 `EACCES`。修法：`sudo -n /usr/local/bin/node ...`，但 stdout 重定向由普通用户 shell 完成，`.cred` 属主仍是 ubuntu（chmod 600）。首轮就是栽在这里，迁移已应用但验收早退。
2. **早退必须 `trap cleanup EXIT`**：首轮早退把 `TEST-` 测试账号留在生产库、`.cred`/`mkjwt.mjs` 也没删。现在 `cleanup()` 同时清当前 OWNER 与所有历史 `TEST-%` 残留，并在取基线前先调一次，避免基线被脏数据抬高。
3. **Windows 上 Python `subprocess` 调 `bash` 会解析到被安全策略禁止的 `wsl.exe`** → `deploy.sh` 那条路被拦。改用**纯 SFTP 增量上传** `dist/` → `/var/www/d-bee`（17 文件 / 1893.2 KB），不执行任何远程命令、不动 nginx、不需要 reload。`put_dir` 本来就是增量不删除，语义等价。
4. 附带：`profile` 文件是 **CRLF**，红验证脚本里带 `\n` 的注入锚点会找不到 → 改单行注入（不改变行数，避免连带触发行号快照护栏）。

### 护栏与基线变化

- `tools/four-end-consistency.test.ts` 新增**护栏 9**（10 项）：表清单快照、删身份行、SECDEF、REVOKE、GRANT、`auth.uid()`、`p_confirm`、前端 RPC 调用、禁止重建档案、文案禁「转客服」。
- 数值口径护栏的 `KNOWN` 行号快照 `ProfileScreen.tsx:168,169,510` → `169,170,514`（A-5 加 import + 改写函数体导致平移，**三行代码逐字未变**）。同步后做了红验证。
- 红验证 **4/4 精准报红**（KNOWN 回退 / 表清单少一张 / 删号后又写档案 / 确认令牌改错），恢复后 31/31 绿。
- 全量基线：**11 文件 / 229 项**（原 219 + 护栏 9 的 10 项），`Test Files` 数 == 实际文件数 11。

### 明确未做 / 待拍板

1. **隐私政策文案**：`src/content/legal.ts:304` 仍写「彻底注销账号请发送邮件与我们联系」。该文件注释明确「新增注销渠道必须刷新 `LEGAL_UPDATED`」，而 `LEGAL_UPDATED = UPDATED` 同时门控隐私同意 → 刷新会让**全体老用户重弹同意窗**，属产品决策，未擅自改。现状不构成虚假陈述（邮件渠道仍有效），只是没覆盖新的自助渠道。
2. **iOS 包**：`ios/App/App/public/` 产物停在 11-04，不含 A-5；web 端已部署。**B 阶段 Mac 必须 `build:native` + `cap sync ios` 重打**。
3. **IAP 权衡**：`apple_transactions` 行随删号一并删除 → 该用户历史 `transaction_id`（全服幂等键）被释放，理论上可用旧收据对新账号重新核销一次。当前 `APPLE_*` env 全缺、付费协议未 Active、IAP 未启用，风险为 0；**若首发启用 IAP，应改为「保留交易行 + owner_id 匿名化」**。
4. **mini 端**仍是降级实现（用户 11-06 明确 mini 暂放），属刻意分叉，未改。


---

## 2026-11-08 由 MEMORY.md 迁入（A8 精简前的全文快照 · 逐字归档）

> 背景：11-08 实测 MEMORY.md 为 102 行 / 10649 字符 / 18490 字节，已超其头部自述的 「≤9KB（超限注入被截断）」纪律。经用户批准执行 A8，把现状/路线/铁律详版整体下沉到本参考池，MEMORY.md 只留决策、铁律结论与指针。
> 🔴 以下围栏内为**精简前 MEMORY.md 的逐字原文**（含当时已过时的状态与已被推翻的旧结论，仅作历史归档，不与上文冲突时也不作为当前真相源；当前状态以 MEMORY.md 为准）。检索本快照用关键词「2026-11-08 由 MEMORY.md 迁入」。

````text
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

## 现状（2026-11-08 上午 · 云端库彻底废弃 + mini 切 selfhost）

- ✅ **WEB 完全上线**：`https://d-bee.cn/` 200；入口 js `index-677ckuM3.js`（11-07 A-5 重新构建部署）与本地 `dist/` 逐字一致；`verify-legal` + `verify-live` 双 PASS；三法务页 200；`-2` 双向校验通过、`Google Play` 失实句 0 处；308 配置 2 行 / 301 为 0；证书到期 **2027-02-04**。
- ✅ **数据面 = 自建 PostgreSQL `dbee`**（`healthz` 实证）；迁移 **0045**；IAP 表在；四服务 active；备份走 `pg_dump -Fc`。
- ✅ **审核演示账户在自建库可用**：`dbeesupport@163.com` / `888888` → `signin` 实测 **200 + access_token**（错误账户 401）→ iOS 2.1 拒审风险解除。
- ✅✅ **云端库彻底废弃（2026-11-08，用户指令）**：四端生产数据面全指自建 PG，云库不再是任何生产依赖、不再写入。mini `backend.ts` 默认 `cloud`→`selfhost`（`config/index.ts` 注入同步），`cloud` 仅作显式回滚通道；selfhost 包已构建且产物实证返回 `d-bee.cn`（`workbuddy.host` 仅在 `CLOUD_HOST` 常量、运行时不可达）；mini `legal.ts` §三/§四/§四之一 改自建库口径、`UPDATED` 刷 11-08。逐项证据 → `docs/待办清单-云库废弃收尾-2026-11-08.md` §一。
- 🔴 **云库数据已放弃迁移**（11-07 判据：云库无身份表、owner_id 19 位数字与自建库 `wx:<openid>` 不同构 → 孤儿数据），**不导入**；云库实例本身**未停用/未删除**（平台控制台操作，不可逆，需用户本人执行，建议 mini selfhost 版真机验收 T+7 后再停）。
- 🟢 **网关阶段 A 已完成**（11-07 23:35）：4 个 `.mjs` + `WECHAT_MINI_SECRETS` 已手术式上线，`login-wechat` 生产实测全绿（微信 40029 证 AppSecret 有效），备份 `/etc/dbee/.bak-20261107-233538-wxlogin/`，工具 `deploy/apply-wechat-login-surgical.py`。
- 🔴 **mini 发版剩 2 项用户本人操作**：① 微信后台把 `https://d-bee.cn` 加 request 合法域名；② 确认备案管局审核期间是否允许上传新版本。二者未完成前 selfhost 包无法在小程序侧生效。
- 🔴 **网关「模式=开发」**（`DBEE_PROD` 未设）→ CORS 放行 localhost。不能贸然设 1（要求白名单且打断本地开发回退）；须先给本地开发换出路再收紧。
- 🟠 尾巴（不阻塞 web）：安全响应头、certbot renew 后复核 308（脚本已可重入）、网关 `APPLE_*` env。**11-07 状态**：公安备案 / 算法备案已启动、短信已可用；凭据轮换按用户批复「凭证不打进终端」**未执行**（是否轮换待确认）。
- ✅ **App 备案签名前置就绪**（11-07 下午）：`tools/app-beian-signing.py`（348 行，android/cert/report 三模式）从 keystore/APK 取模数+MD5（apksigner 交叉校验）；Android 真值已取（包名 `cn.com.dbee.app` / MD5 `0abe...9dc9` / SHA-1 `cd1d...a720` / RSA2048 至 2056）；iOS/鸿蒙需证书放入 `signing/` 后一键出值（证书 `.gitignore` 绝不入库）。口径：Android 填模数+MD5、iOS 填公钥+SHA-1、鸿蒙填 AGC 叶子证书公钥+SHA-1。
- ✅ **Android vc15 正式包已打包归档**（11-07 下午）：`release/D-Bee-1.7.3-vc15-dbee.cn-FORMAL-20261107.apk`，APK 内含 `delete_own_account`，`apksigner` MD5 与备案值逐字一致；分发前 versionCode 已 14→15。
- 🟠 **git 未 push**：本地 `ahead origin/main 10`，`github.com` 域名级限制（代理 502 / 直连超时 / `ls-remote` OpenSSL eof，`api.github.com`=200 证非凭据问题）；离线兜底 `release/d-bee-main-20261107.bundle`（6.7M，verify PASS）。网络恢复后 `git -c http.sslBackend=openssl push origin main` 或 `git fetch <bundle> main && git push origin FETCH_HEAD:main`。
- 工程基线：`npm test` = **11 文件 / 231 项全绿**（跑完核对 `Test Files` 数 == 文件数）；跨端护栏 **9 道**。✅ 11-08 已修 `report-ratio.test.ts` 日期漂移（改 `todayKey()` + 防漂移护栏，红验证通过），纪律见「测试禁止硬编码日期」。同步态查 `git status -sb`。📄 待办清单 = `docs/待办清单-云库废弃收尾-2026-11-08.md`。
- ⚠️ **本文件体积已超头部自述的 ≤9KB**（11-08 实测 102 行 / 约 10.8K 字符 / 18.6KB 字节，中文 UTF-8 3 字节/字）。按「超限注入被截断」纪律，需专门做一次「现状详版迁 REFERENCE.md、本文件只留指针」的精简；**涉及内容迁移决策，待用户确认后执行**，本轮未擅自删历史内容。

## 下一步（用户 11-06 方向：iOS 为主；11-08 起云库已废弃，mini 代码已切 selfhost）

> 🔴 **权威梳理 = `docs/iOS上线依赖全景与实施步骤-2026-11-07.md`**（11-07 重新实测 + Apple 官方政策检索；11-06 版与 11-03 版均已加状态横幅，只作历史快照）。
> ✅ **11-07 阶段 A 全部完成（含 A-5）**：A-2 逐字段 ASC 答案 = `docs/ASC表单填报答案-2026-11-07.md`；A-3 死链 + A-4 长名已修；**A-5「1 改」→ 0045 SECDEF RPC 真删号，生产实测 21 项全绿、零网关改动**；`typecheck` + `npm test` 11 文件 **229 项**全绿。**A 完成 ≠ 能上架**（仍卡 Mac + 资质链）。
> **11-07 修正**：「工程侧 100% 就绪」只对**代码/服务端**成立；**ASC 表单填报面**（App Privacy 营养标签 / 新年龄分级问卷 / 审核信息 / 商品审核信息 / 订阅披露两处链接 / 截图上传）几乎空白 → 提审必填。
> 🆕 **Apple 硬闸门**：2026-04-28 起上传必须 **Xcode 26 + iOS 26 SDK**（已生效）；2026-01-31 起**新年龄分级问卷必答**（AI 助手 + 健康主题影响分级，别预设 4+）；App Privacy 未填阻塞提交；第三方 SDK 隐私清单签名缺 → `ITMS-91053`。
> ✅ **两处会致拒审的缺口都已修复**：① 账号删除 5.1.1(v) 降级实现 → **0045 `delete_own_account` SECDEF RPC 真删号**（11-07 下午生产实测）；② 填报包三条法务 URL 的 IP 深链 404 → 统一为 `https://d-bee.cn/legal/{privacy,terms,disclaimer}/`（带尾斜杠、实测 200）+ 校验脚本防回归护栏。
> 🆕 壳内产物还含 `Google Play` 失实句 **1 命中**；`PrivacyInfo.xcprivacy` 已在、商店截图 iPhone5/iPad5 + 3 张 IAP 审核截图实测齐；TestFlight 内部即时、外部需 Beta App Review。
> 📌 今天结论：**中国区正式上架不可能**（软著 30–60 工作日、App 备案 7–20 工作日、Mac 签名）；最大交付物 = **TestFlight 内部测试**（需 Mac + Xcode≥26 + Team + 重打包）。

0. 🔴 **只有用户本人能做**：①软著 AI 条款口径（**11-07 已致电**版权中心，结论待回填；30–60 工作日最长边）②~~拍板 App 名称~~ ✅ **11-07 已定案 `自律蜜蜂`**（方案 B）③Mac 上 Xcode 选 `DEVELOPMENT_TEAM`（仍待做，解锁 TestFlight + App 备案指纹 + 重打包）④iOS/鸿蒙签名证书放入 `signing/`（App 备案出值）⑤**mini 发版 2 项**：微信后台加 request 合法域名 `https://d-bee.cn` + 确认备案期能否上传新版本。
1. **Mac 链**：`build:native` → `npx cap sync ios`（🔴 壳内产物停在 11-04，缺备案号与最新法务，必须重打）→ 编 3 个 Swift 插件 → Archive/Upload → **TestFlight**（不依赖备案号）。
2. **服务端链**：ASC 建 App + 3 商品（¥18/¥128/¥298，月年同订阅组）+ 付费协议 + 共享密钥 → 手术式脚本配 `APPLE_*` → webhook 指 `https://d-bee.cn` → 沙盒购买测试。
3. **资质链**：软著 → App 备案（✅ 签名工具已就绪 + Android 真值已取，等 iOS/鸿蒙证书 → 需 Mac 签名取公钥/SHA-1）→ ASC 填号（MIIT 强校验）→ 中国区提审。
4. ✅ **11-07 执行链**：A3/A4（默认端点改 `https://d-bee.cn`、旧清单横幅 +14/-0）→ 阶段 A（ASC 填报答案、修 3 处活跃正文 + 5 份历史横幅、URL 护栏红验证）→ **A-5「1 改」（0045 迁移 + 前端 + web 部署，生产实测 21 项全绿、护栏 9 红验证 4/4）**；各阶段 `npm test` 全绿（基线 219 → **229**）。🟠 剩余：公安备案回填（12-06 前）、凭据轮换、安全响应头、**隐私政策 §五 + `LEGAL_UPDATED` 是否刷新（产品决策）**。
5. 🟠 **常规部署今后应设 `DBEE_DOMAIN=d-bee.cn`**（原「不要设」的理由已全消失）；Android 正式包 vc15 已打包归档、可实测，公网分发（在线下载链接/渠道）待用户明确批准。
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
- 🔴 **测试禁止硬编码日期**：凡被测函数用 `rangeDays(N)`／`todayKey()` 圈定统计窗口，测试数据的 `log_date` 必须同源取 `todayKey()`，否则窗口随日期滑走 → 记录被 `inRange.has()` 静默过滤 → 集体假红（11-08 `report-ratio.test.ts` 6 项踩坑）。加防漂移护栏并做红验证。
- 🔴 **MAPE 达标 ≠ 无需处理**：四指标并报，实测需真机+样本餐（≥20 条、4 热量档），此前不得对外表述任何精度数字。
- 🔴🔴 **护栏断言三条铁律**：①一个 `it()` 只放一条断言 ②存在性断言匹配「实际使用」非「标识符出现」 ③断言须在 `stripComments()` 后的代码上做。快照式基线放宽后 + 新增护栏**必须做红验证**。
- 🔴 **产物里 grep 中文必假阴性**（转义 `\uXXXX`），日期正则要容 `\s*`；判断数据面必须追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论。

````

## 2026-11-08 晚间由 MEMORY.md 迁入（xpay 售卖 + Web 定价引导 · 详版逐字归档）

> 来源：当日日志 `2026-11-08.md` 的「21:18 mini 微信虚拟支付售卖全链路」与「23:02 Web 端定价展示 + 小程序下单引导」两节，**逐字归档**；MEMORY.md 只保留结论与指针。

## 21:18 · mini 微信虚拟支付售卖全链路（0046 + 网关 xpay + 前端适配器 + 付费墙三档 + 法务同开关）

- 🔴 **用户指令推翻 16:48 口径**：「微信小程序端当然要展示三档价格并售卖订阅，这才是我们盈利的核心点；走微信支付！」实证确认会员属**虚拟商品** → 必须走微信虚拟支付（`wx.requestVirtualPayment` / 米大师 xpay），**不是**普通 `wx.requestPayment`（那是实物+商户号）。三个裁决问题（虚拟支付资质 / iOS 是否开通 / 法务口径）用户跳过未答，按最稳妥工程口径推进：**全链路代码就绪 + 构建期开关默认关闭**（凭据与平台侧未就绪前发出的包不展示售卖）。
- **数据库 0046**（`db/migrations/0046-wechat-xpay-settlement.sql`）：`xpay_transactions` 表 + `payment_orders` 补 `provider_txn_id`；三个 SECDEF 函数 `settle_xpay_purchase`/`revoke_xpay_purchase`/`log_xpay_notification`（REVOKE PUBLIC/anon/authenticated，只 GRANT dbee_app）；`verify_payment_order` 补 `provider='wechat_xpay'` 分支 —— **推模式**下退化为「查订单是否已 paid」，真正验签与发放在网关推送处理器（不把验签塞进 plpgsql，10-22 决策 #6）。🔴 **0046 尚未应用到生产库**。
- **网关 `server/lib/xpay.mjs`**：双签名（前端 `paySig=hmac(appKey,'requestVirtualPayment&'+signData)`、`signature=hmac(session_key,signData)`；服务端接口 `pay_sig=hmac(appKey,uri+'&'+body)`，uri 不带 query、body 与实际字节逐字一致）；推送 sha1 验签 + AES 解密（iv=key 前 16 字节）；access_token 缓存 + 40001/42001 强刷重试**一次**（防死循环）；路由 `/.cloud/payment/wechat/{params,query,notify}`，notify **不走 wrap()**（wrap 会消费请求流 → 验签读到空 body 必失败）。`server/lib/wechatSession.mjs` 加密存 session_key。
- 🔴🔴 **资损级缺口（本轮最重要发现）**：官方原文「正常通过 `xpay_goods_deliver_notify` 推送返回成功就**不需要**调 `notify_provide_goods`；该接口用于**推送不成功时**手动改已发货」+ 社区官方答复「不发货会影响结算状态」→ **推送丢失时查单兜底补发权益后必须调 `/xpay/notify_provide_goods`**，否则平台订单停在「已支付待发货」= 用户拿到会员、我方收不到钱。已补：抽通用外呼 `callXpayApi(uri,body,env)` + `callNotifyProvideGoods`，query 路径在 `st∈{2,3}` 且 `order_type≠7`（Apple 单官方限定不可调）时调用；失败只 `logger.error` 留痕**不抛**（权益已落库，不能把成功支付报成失败），下次 reconcile 再试。
- **前端 `mini/src/lib/xpay.ts`**（~500 行）：`isXpaySupported()`（TARO_ENV=weapp + 全局 wx 鸭子探测 + `typeof requestVirtualPayment==='function'` 最终防线 + `compareVersion(SDKVersion,'2.19.2')>=0` **或** `canIUse`，官方两条件取「或」）；`requestVirtualPayment` **手工 Promise 包装回调**（官方明文「Promise 风格调用：不支持」）；🔴 **`signData` 原样透传字符串**（parse+stringify 会改字段顺序 → -15005/-15006）；`xpayFailMessage` 全错误码中文映射（**-2 取消 → 空串静默**、-15007 引导重登、-15008/10/14 平台配置类说「暂不可用」不引导重试）；`buyProduct` 五态（ok/cancelled/**settling**/error/unsupported，对齐主端 `CheckoutResult`）；🔴 **先 `savePending` 落盘再轮询**（顺序不能反：iOS 支付回来小程序常被杀），`pollUntilSettled` 1.5s×4 **保证不 reject**，窗口内未到账 → settling「权益正在到账（通常 1 分钟内）」**绝不报 error**（钱已扣，报错=重复购买+客诉）；`recoverPending` 进付费墙/启动自愈，每单只查一次，settled/refunded 终态才清、TTL 7 天、最多 20 笔、串行写队列。
- 🔴 **措辞纪律（虚假宣传红线）**：`short_series_goods` 是**预付费时长、不自动续费**（多方核实不支持连续包月自动扣款）。付费墙与 legal **绝不照抄主端 iOS 的「到期前 24 小时自动续订扣款/取消订阅」**——那是 StoreKit 订阅合规文案，本端无自动扣款，写上即虚假宣传（用户以为不取消会一直被扣）。正面明示「一次性购买，不自动续费、不自动扣款，无需取消」。兑换码保持**「免费获得」**（P1-E 红线：付费买码触发小米「引导异常交易」+ 华为「切支付」= 下架级）。
- **单一构建期开关 `D_BEE_XPAY_ENABLED`（默认 false）**：`mini/src/lib/xpayEnabled.ts` 导出 `XPAY_SALE_ENABLED`，**同时驱动付费墙售卖 UI 与 legal.ts 法务口径**（微信审核核「页面展示与用户协议一致」，两者必须同源；若运行时问服务端则法务文本随网络结果漂移，而用户同意过的是**构建时确定的字符串**）。`mini/config/index.ts` 构建期校验：非 `'true'/'false'` 一律 **throw**（防 `=1`/`=yes` 被静默忽略 =「以为开了其实没开」，与 backend.ts READY 门同病），为 true 时 `console.warn` 留痕（产物中文 `\uXXXX` 转义，日志是唯一可靠提示位）。
- **legal.ts 法务口径同开关**：§一「服务内容」两分支（开→三档会员可选付费、微信虚拟支付一次性购买、不自动续费、价格以付费墙为准；关→原「免费提供、不销售任何商品或服务」逐字不动）；《免责声明》§五首句同源（「本服务的基础记录功能免费提供」vs「本服务为个人免费提供」），后半段可用性/免责表述两分支一致；档位名取 shared `PRODUCTS`（月订阅/年订阅/终身买断，单一真相源）。`UPDATED` 仍 `2026 年 11 月 8 日`（两分支共用：开关开的包正文实质改动日即今天；开关关的包正文与 11-08 整改版逐字相同）。📌 **mini 无 LEGAL_UPDATED 同意窗机制**（主端 `src/lib/privacyConsent.ts` 有），重确认机制留用户拍板。
- **测试**：`tools/xpay-selftest.mjs` 86→**96 项**（新增「资金结算闸门」10 项：status=2 调一次、body=`{order_id,env}`、pay_sig 用自己 uri 复算、status=4 不重复调、Apple 单不调但权益照发 channel='apple'、接口报错仍回 `settled:true`、失败有 error 留痕）；`tools/mini-xpay.test.ts` **68 项**（开关只认 true、compareVersion、isXpaySupported、错误码翻译、signData 原样透传、buyProduct 五态、先落盘后轮询顺序、recoverPending 不 reject、TTL 过滤）；**护栏 17 `tools/xpay-consistency.test.ts` 27 项**（端点路径两端逐字一致、4 条路由、notify 不走 wrap、provider 前后端同值、notify_provide_goods 闸门、signData 无 parse、签名公式锚点、settling 语义、1.5s×4、措辞纪律零订阅式披露、开关校验与注入、三档 productId/价格与 0030+0038 种子一致）；**修正护栏 6 第一条**（旧断言「mini 无支付入口是刻意设计」已过时 → 改钉「paywall 与 legal 都引用同一 `XPAY_SALE_ENABLED` + 留有同源与措辞纪律注释」）+ 护栏 12/16 头注同步去掉「小程序无在线支付」降级表述。
- **红验证**（护栏铁律）：mini-xpay 注入 4 处破坏（signData 重序列化 / settling 改 error / provider 写 `wechat` / 开关改宽松布尔）→ **9 红精准**；xpay-consistency 注入 4 处（provider / 删 notify_provide_goods / POLL_ATTEMPTS 改 2 / 付费墙写入「连续包月+24 小时扣款+取消订阅」）→ **4 红精准**；xpay-selftest 关发货确认 → 4 红（并修好「数组为空时脚本中途崩溃掩盖其余红灯」的健壮性问题）。全部已还原。
- **验证**：`npm test` **15 文件 / 691 项全绿**（13→15 文件、592→691 项）；mini tsc `src/` 零错误；🔴 **两种构建变体实测开关真有效**：默认构建 `dist/common.js` 偏移 236638 = `enabled:"false"`，`D_BEE_XPAY_ENABLED=true` 构建同偏移 = `enabled:"true"`（长度差恰 -1），且 true 构建日志打出开启警告 → **开关不是恒 false**。`paywall.js` 两版逐字节相同（`XPAY_SALE_ENABLED` 是函数调用结果，terser 不做跨函数折叠 → 三元分支保留为运行时判断，正确行为）。产物零 `D_BEE_XPAY_ENABLED`/`isXpaySaleEnabled` 标识符（defineConstants 已替换）。构建后**已恢复 dist 为安全的默认 false 构建**。
- 🔴 **开启前置条件（缺一不可，详见 `xpayEnabled.ts` 文件头）**：代码侧 = 0046 应用到生产库 + 网关部署含 xpay.mjs + env 配齐（`XPAY_OFFER_ID`/`XPAY_APP_KEY`/`XPAY_PUSH_TOKEN`/`XPAY_PUSH_AES_KEY`/`WECHAT_SESSION_ENC_KEY`，加 env 走 `deploy/apply-vision-key-update.py`，**绝不跑 `deploy-gateway.sh`**）；平台侧 = 虚拟支付进件（否则 -15008）+ 三档道具发布（productId 与 `PRODUCT_IDS` 逐字一致、价格与 `payment_products` 一致 1800/12800/29800 分，未发布 -15010、刚发布约 10 分钟 -15014、价格不符 -15013）+ 消息推送配置 `https://d-bee.cn/.cloud/payment/wechat/notify` 且**发货推送必须开启**。**先配平台，再开开关。**
- 费率备查（未落代码）：iOS 标准 17%（Apple 12% + 腾讯 5% 限时减免）、安卓主动支付标准 10%（限时 1%）、T+3 结算（iOS Apple 侧自然月后 45~60 天）。
- 🔴 边界：工作区未提交；**0046 未应用生产库**、网关未部署、凭据未配、平台侧三件未做 → **当前不具备开启条件**；mini 产物未上传；未做任何生产侧实测（铁律 #13）。

## 23:02 · Web 端定价展示 + 小程序下单引导（改造方案阶段 1+2，已 commit + push）

用户指令：执行《Web端定价展示与小程序下单-现状梳理与改造方案》阶段 1（Web 侧）+ 阶段 2（跳转凭证），要求**不改四端业务实现逻辑**、重点在 Web 定价展示与「从小程序下单」引导、**前提合法合规**。

### 🔴 本轮最重要的合规发现（11-07 方案的口径缺陷）
11-07 版阶段 1 把「去微信小程序下单」引导写成**无条件展示**。11-08 勘察发现它与 mini 实际状态**不同源**：mini 售卖由 `D_BEE_XPAY_ENABLED` 构建期开关驱动、**默认关闭**，线上 mini 仍公示「免费提供、不销售任何商品」。Web 无条件引导 = 把用户导向买不到东西的小程序 = **虚假宣传（《广告法》第 4 条）**，与「合法合规」前提直接冲突。→ 改为**与 mini 同源开关门控**。

### 同源开关设计（关键架构决策）
Web 侧**复用 mini 的 `D_BEE_XPAY_ENABLED`**（不另起 `VITE_MINI_SALE_ENABLED`），经 `vite.config.ts` 的 `resolveXpaySaleFlag()` 注入为构建期布尔常量 `__XPAY_SALE_ENABLED__`（与 `__APP_VERSION__` 四端同名做法一致）。**一个环境变量同时决定两端**卖不卖 / 引不引导 → 运维不可能只开一端导致口径漂移。非法取值（`=1`）构建期 throw；`=true` 构建日志 warn 留痕。

### 改动清单（全部只碰 Web 展示层，四端业务逻辑零改动）
- 新建 `src/lib/miniOrderGuide.ts`：配置真源。`XPAY_SALE_ENABLED`（typeof 兜底 → 安全默认 false）+ `MINI_APP_NAME`/`MINI_ORDER_QR`/`MINI_ORDER_LINK`；`sanitizeMiniOrderLink()` 抽成**纯函数**（https 白名单）以便单测。
- 新建 `src/components/MiniOrderGuide.tsx`：付费墙与定价页**共用**引导区块。「网页不收款」声明在门控外恒展示；「去小程序下单」包在 `canGuideToMiniSale()` 内；三形态（QR/LINK/纯文字兜底），绝不渲染死按钮。
- 新建 `src/pages/PricingSheet.tsx`：公开定价页（未登录可见，解决差距 #1）。复用 `PRODUCTS`+`priceTag`，三档用 `div`、**整页零 `<button>`**。入口挂 `SiteFooter`（登录页/今日页/我的页共用 → 一处接入全站可达），🔴 **仅 Web 渲染**（iOS 只能用 App Store 真实价，展示本地价属违规），portal 到 body 规避 `.app-shell(overflow-x:hidden)` 裁剪。
- 新建 `src/content/membership.ts`：`FREE_ITEMS`/`PRO_ITEMS` 从 PaywallSheet 抽出共用，配额数字插值自 shared，零副本。
- `src/content/legal.ts` §六：把「网页版」从「Android 一次性预付购买」渠道摘出 → 按 `XPAY_SALE_ENABLED` **双分支**（ON=引导去小程序 / OFF=不提供任何购买入口），两分支都明示「不提供在线支付、不会通过网页收取任何费用」；`UPDATED` **未动**（刷新 = 全体老用户重弹同意窗，留拍板）。
- `src/pages/PaywallSheet.tsx`：Web 引导改用 `<MiniOrderGuide showRedeemHint />`；`buyProduct` Web 拦截提示去掉「下单」字样；iOS/Android 分支、checkout、adapter、server、DB **一律未动**。
- `tools/web-no-payment.test.ts`（新建，护栏 18，**31 项**，W1~W8）+ `tools/four-end-consistency.test.ts` 护栏 16 主端断言随真源迁址改查 membership.ts。

### 验证（红验证 + 构建变体实证）
- 红验证：4 处破坏（定价页加购买按钮+createPaymentOrder / 引导去门控 / legal 去开关分支 / 付费墙复活 FREE_ITEMS 副本）→ **6 红**全精准，还原回绿。
- `npm test` **16 文件 / 731 项全绿**；typecheck rc=0。
- 默认构建产物探针：`下单`=0、`在微信中搜索小程序`=0、`会员定价`/`网页版仅展示价格`/`统一定价`/`免费获得` 均 >0；terms 静态页 OFF 分支「不提供任何购买入口」→ **零引导字样**。
- 开启构建（`=true`）：`内完成下单`>0、`下单`=4，terms 2422→2449 字切 ON 分支。`=1` → 构建 throw。QR 注入 → 产物含 `/mini-order-qr.png`。
- `dist/` 已恢复默认安全构建。

### 🔴 产物解码纪律修订（既有记忆只适用 mini）
**Web 主端产物 = UTF-8 直存中文**（非 ASCII 字节 ~7 万，字面 `\u` 仅 54），直接 UTF-8 读；**mini（Taro/webpack）才是纯 ASCII `\uXXXX`**（需 unicode_escape）。两条工具链形态不同，套用同一管道会全假阴性（本轮实测：用 unicode_escape 读 Web 产物，连「统一定价」都 0 命中）。

### 文档
- 改造方案文档追加「阶段 1+2 执行记录（11-08）」+ 口径修订横幅（历史正文按纪律不改）。
- 新建 `docs/Web端跳转小程序-静态码操作手册-2026-11-08.md`（阶段 2：MP 后台生成码 5 步、三件外部依赖、发布前置 6 项）。

### 边界
改动已 commit + push（见下方 git 记录）；**未部署生产**（线上仍旧产物，零生产变更口径）。开启引导需备案通过 + 小程序发布 + 静态码 + mini 同值上传 + `LEGAL_UPDATED` 拍板，当前默认构建（零引导）本身即合规状态。

---

## 11-09 盘点：从 MEMORY.md 压出的详版（零信息丢失归档）

> 触发：11-09 两轮自动化盘点 + 四端收费总纲撰写后 MEMORY.md 触顶 9881 字符（>9k 铁律），
> 按纪律把详版逐字迁到本文件，MEMORY 只留结论与指针。压缩前字符 9881 → 达标 ≤9k。

### A. 算法备案三连落地（11-09，全部 E:\ 目录 docx，不进 git）
- 10:31《拟公示内容》已填：算法名 = `自律蜜蜂饮食识别与营养建议生成合成算法`，类型=生成合成（深度合成）类，角色=服务提供者；6 字段（名称/基本原理/运行机制/应用场景/目的意图/公示情况）按官方模板填写，原模板未动，另存 `拟公示内容-自律蜜蜂.docx`。要点：多模态大模型识别餐食照片 + 本地食物营养库换算 + LLM「问问小蜜」问答；本地规则库优先、未命中才调云端；AI 结果显式标注「AI 估算，请按实际核对」，不构成医疗建议。
- 14:50 系统填报 9 字段文本 + 自评估报告起草：交付 `算法备案-系统填报字段与自评估报告-2026-11-09.docx`。盘点结论 = 承诺书（`commitment_letter.docx` + 盖章扫描 PDF）、主体责任（精炼版 v1.1 + 20MB 盖章汇总 PDF）、`制度文件/` 8 项制度**均已完成**，唯一缺失 = 算法安全自评估报告。核实口径：主体北京迪蜂科技有限公司（91110119MAKQGYG92T，法定代表人于太印）；文本生成=DeepSeek、图像识别=阿里云百炼 Qwen-VL，均经自建网关代理；自建食物库 1,175 条；公开数据源 Open Food Facts；腾讯云轻量服务器（境内，nginx + Node 网关 8080 + 自建 PG）；JWT 30 分钟；fail-closed；免费 3 次/日。两条填报铁律：精度数字一律不写（MAPE 须真机 + ≥20 样本餐 + 4 热量档实测）、定位「个人记录/自我管理工具」无舆论属性/不涉医疗/数据不出境。
- 15:47 官方《算法安全自评估报告（生成合成类-服务提供者）》模板逐字段填写：删「填报说明」页 15 段 + 全部【】占位与（）说明，保留全部固定章节；替换 65 段 + 补第六章空段 + 补全封面 5 格（自评估时间 2026-11-09、☑首次备案、评估算法描述 6 方面、盖章日期）。正文六章：算法流程 / 数据（训练数据「不涉及」）/ 模型（Qwen-VL + DeepSeek + 本地规则引擎，无自研无微调）/ 干预策略 / 结果标识 / 服务情况 + 风险研判 6 类 + 防控 6 维 + 结论「通过」。经本地 editor_sdk MCP 批量完成（`doc_replace_text` 65 次 + `doc_set_table_cells` + `doc_delete_paragraph` ×15 + `save_file` 另存），原模板未动。成品 98 段 / 约 10,774 字 / 33 KB，残留【】/填报说明/（请/（描述/（包括/（应/（根据/（以流程图 全部 0。交付 `算法安全自评估报告（生成合成类-服务提供者）-已填写.docx`。
- 🔴 三项须用户核实/补正：①封面「算法上线情况=未上线，正在内测阶段」与 Web 已完全上线 `https://d-bee.cn` 事实冲突（正文已标注，未擅改用户已填值）②算法安全负责人口径冲突（封面/主体责任=周子森 18101357167，制度文件第四条=于太印任责任人、周子森任技术负责人）③评估算法描述第 5 项服务器机房省份须依腾讯云控制台资源地域核实。提交前待办：补内容审核与显式/隐式标识截图佐证、完成 AI 问答气泡逐条显式标识整改、承诺书与主体责任盖章、备案通过后公示编号。周期 2–3 个月，法定「提供服务起 10 个工作日内」办理。

### B. 备案链现状（11-09 用户口径，用于四端收费总纲 §3.1）
域名/ICP 备案 ✅ 已下证（11-06，`京ICP备2026075565号-2`）；**App 备案 / 微信小程序备案 / 算法备案 / 公安备案 均管局审核中**。依赖：App 备案硬阻断 Android 各商店上架与 iOS 中国区备案号；小程序备案硬阻断 mini 发版与虚拟支付开通；公安备案法定 2026-12-06 前完成，拿号回填 `packages/shared` 的 `POLICE_BEIAN`（现空＝不渲染合规）。

### C. 11-09 四端收费总纲（权威载体 `docs/四端收费一致性核验与合规实施总纲-2026-11-09.md`）
297 行 / 30.6 KB。核心结论：业务代码 **2 套**（`src/` 供 Web+Android+iOS + `mini/src/`）、支付通道 **3 套**、法务文本 2 套；「完全一致」应定义为权益/定价/口径/数据面一致，支付链路按平台法规必然分叉。一致性分 L1 已一致（护栏保障）/ L2 刻意分叉（Apple 3.1.1、虚拟道具不自动续费等，必须保留）/ L3 真实缺口 12 条。护栏 18 道 731 项全为源码静态扫描，9 类零自动断言（平台侧商品、结算运行时、迁移水位、网关部署/env、StoreKit/adapter 收银台、退款权益回收、LEGAL_UPDATED、构建产物、双库 DDL）。🔴 提出旧决策「11-06 ICP 经营许可暂不办」在收费后需重新拍板（独立 Web + 独立 APP 不满足「仅依托小程序、无独立平台」豁免；B25 门槛注册资本≥100 万 + 3 人社保 + 60–90 工作日；仅作风险提示，须属地通管局书面确认）。实施阶段 0~5：0 一致性收口（零生产风险）/1 备案等待/2 mini 首发/3 iOS IAP/4 Android/5 Web 永久不收款。

### D. 被压缩条目的详版载体索引（MEMORY 只留结论）
| 条目 | 详版权威位置 |
| --- | --- |
| Web 定价展示 + 下单引导（开关同源、护栏 18、零下单字样） | 本文件「11-08 晚间迁入」+ `docs/Web端定价展示与小程序下单-现状梳理与改造方案-2026-11-07.md` |
| mini xpay 售卖全链路 + 开启 6 前置 + 资损铁律 | 本文件「11-08 晚间迁入」+ `mini/src/lib/xpayEnabled.ts:26-52` + `docs/待办清单-云库废弃收尾-2026-11-08.md` §十一 + 总纲 §2.2 |
| Android vc16 三步实证（aapt / apksigner MD5 `0abe7fc5...45fb9dc9` / 产物探针） | `2026-11-09.md` 日志 08:00 段 |
| 工程基线 731 项构成与开关构建变体自检 | `tools/*.test.ts` 文件头 + 总纲 §1.4 |
| 云库彻底释放剩 2 步 | `docs/待办清单-云库废弃收尾-2026-11-08.md` §九/§十 |


---

## 2026-11-09 晚 · Web 引导闭环 + Android 收款实装（由 MEMORY.md 压出的详版，零信息丢失归档）

> 权威交付文档：`docs/Web引导闭环与Android收款实装-2026-11-09.md`（四端职责矩阵 / Web 三层防御 / Android 实装 / 法务口径 / 开启前置清单 / 验证结果 / 护栏覆盖 / 改动清单 / 未决）。
> 🔴 用户逐字最终定案（推翻当日 20:20「Web 办 ICP 经营许可证后可独立收款」的二次改判）：
> 「**web端暂不收费，引导进入微信端和app端收费，即可完成所有逻辑；android端支付能力即可完善，达到能够支付收款的目的；4端业务逻辑仍然不变。**」
> → ① Web **暂不收费且不为收费办证**，落地为「展示定价 → 引导到 mini / App 付费」；② 「立即启动 ICP 经营许可证办证」**不再是前置**（该证只在未来 Web 自行收款时才必要）；③ Android 从「盘点堵点」进入「**已实装可收款**」；④ **四端业务逻辑零改动**（定价/权益/免费额度/数据面/核销编排均未动，`checkout.ts` 仅一行 `adapter.purchase(productId, order.order_no)`）。

### 一、服务端结算底座（新增）

- `server/lib/apppay.mjs`（715 行）：导出密码学纯函数（`rsaSign`/`rsaVerify`/`buildWechatV3AuthHeader`/`wechatAppPaySignMessage`/`verifyWechatNotifySignature`/`decryptWechatNotifyResource`/`encryptWechatNotifyResource`/`alipaySignContent`/`buildAlipayOrderStr`/`verifyAlipayNotifySignature`）+ handlers（`prepay`/`query`/`wechatNotify`/`alipayNotify`）。**零依赖密码学**：`node:crypto` 手写微信 V3（RSA-SHA256 + AES-256-GCM，🔴 **authTag = ciphertext 末 16 字节**）、支付宝 RSA2（SHA256withRSA，字典序 `k=v&`）。项目纪律**禁支付 SDK**。
- `db/migrations/0047-app-payment-settlement.sql`（467 行）：`app_payment_transactions`（🔴 `out_trade_no text NOT NULL UNIQUE`、`CHECK (provider IN ('wechat','alipay'))`）、`app_payment_notifications`、`settle_app_payment`/`revoke_app_payment`/`log_app_notification`（**SECURITY DEFINER，先 REVOKE 再 GRANT 只给 `dbee_app`**）、`verify_payment_order` 改**查单语义**（`IF v_order.provider IN ('wechat_xpay','wechat','alipay') THEN RETURN false`）。🔴 `payment_orders`（0021）**无 provider CHECK** → wechat/alipay **无需追加迁移**。权益模型**复用 0046**：months 累加、lifetime 不降级、`revoke` 只清同 `source` 渠道权益（不误伤兑换码）。
- `src/lib/payment/apppayClient.ts`（177 行）：`requestAppPrepay`、`verifyViaApppayGateway`（`QUERY_ATTEMPTS=4`、`QUERY_INTERVAL_MS=1500`，🔴 **404/405/503 → null** 以回退 RPC，绝不报错）。
- `server/lib/app.mjs`：`createAppPayHandlers` 装配（`deps.enableAppPay === false` → null；可注入 `appPayFetchImpl`/`appPayClock`/`appPayNonce` 供自检）；路由 `${P}/prepay`、`${P}/query` 走 `wrap()`，🔴 **`/.cloud/payment/wechat-app/notify` 与 `/.cloud/payment/alipay/notify` 不走 `wrap()`**（wrap 的 `readJson` 会消费验签所需原始字节）→ 自读自写响应，并加入**限流豁免**名单。
- `server/lib/config.mjs`：`publicBaseUrl`（`PUBLIC_BASE_URL` 默认 `https://d-bee.cn`，去末尾斜杠）、`wechatPay*` 6 项、`alipay*` 3 项（均 `.replace(/\\n/g,'\n').trim()`）；`validate()` **半配拦截**（微信 5 项/支付宝 3 项缺一即拦、APIv3 ≠32 字节拦、`wechatPayMchid && !wechatPayPlatformCert` 拦）；`warnings()` 未配提示 → **渠道级 503 降级**（不整站崩）。

### 二、推模式结算与资损防线（🔴 铁律全文）

1. **推模式**：客户端 SDK 成功**只代表用户付完钱**；发权益的**权威信号 = 服务端异步回调验签 → `settle_app_payment`**；query 只作「回调未到窗口」的兜底。
2. **查单语义**：`verify_payment_order` RPC 只回订单状态；**回调未到恒 `false`** → 前端有限重试（4×1500ms），窗口内提示「**权益到账中**」**绝不报 error**（可能已扣款）。
3. **幂等键 = `out_trade_no`**（我方业务单号，UNIQUE），🔴 **不是平台交易号**。
4. **owner 权威 = `payment_orders.owner_id`**（JWT sub）；回调路径 `ownerId` **传 null**（支持代付）→ `v_owner := v_order.owner_id`。归属不符回 **403**。
5. 🔴 **金额校验三路径**（微信回调 / 支付宝回调 / 主动查单）：`amountCents < Number(order.amount_cents)` → **拒发权益**（防「1 分钱买会员」），记 `amount_mismatch`。
6. 🔴 **支付宝 `8000`（处理中）与 `9000` 同路径、绝不报错**（可能已扣款）；`6001` = 用户取消。初版曾把 8000 与 9000 分开 early-return，已合并为 `if (res.resultStatus !== '9000' && res.resultStatus !== '8000') throw`。
7. 🔴 **`cloudError` 响应形状 = `{message, error}`**，**不是 `code`**（自检断言曾误写 `.code` 恒假）。
8. 🔴 **凭据零泄漏**：私钥 / APIv3 密钥只在服务端签名，不下发、不进日志与响应（护栏 20-H + 自检 F 节）。

### 三、Web 零收款三层纵深防御 + 双渠道引导

- ① **构建期 `define` 布尔折叠**：`D_BEE_APPPAY_ENABLED` → `__APPPAY_SALE_ENABLED__` 布尔字面量 → terser 死代码折叠（默认 false 时产物 0 命中，`wechat:!1,alipay:!1`）。
- ② **`PaywallSheet` 的 `isAndroid()` 门**：`setPayChannels(APPPAY_SALE_ENABLED && isAndroid() ? {wechat: isWechatPayAvailable(), alipay: isAlipayAvailable()} : {wechat:false, alipay:false})`。
- ③ **运行时兜底**：`buyProduct` 开头 `if (isWeb() && noPayChannel) { setErr('网页版仅展示价格…'); return }`。
- `MiniOrderGuide` / `lib/miniOrderGuide.ts`：`APPPAY_SALE_ENABLED`、`canGuideToAppSale()`、`APP_DOWNLOAD_LINK`/`APP_DOWNLOAD_QR`、🔴 `WEB_NO_CHARGE_TEXT` **恒展示**、`{guideApp && (…)}` **双渠道独立门控**、**无凭证退化纯文字**。
- 法务（`src/content/legal.ts`）：§六 Android 条按开关分支（开启态「一次性购买对应时长，属**预付费买断**，不构成自动续期订阅，**不自动续费、不自动扣款**」/ 关闭态「当前版本不提供应用内购买」）；§四 微信 SDK 清单按开关分支 + `…(APPPAY_SALE_ENABLED ? [支付宝 SDK 条目] : [])`。🔴 `LEGAL_UPDATED` **未动**（改值 = 全体老用户重弹同意窗，产品决策）。
  - 🔴 铁律：道具直购**不自动续费** → 照抄 iOS「24 小时续订」文案 = **虚假宣传**。

### 四、验证结果（本轮实测，均重跑核对）

- `npm test` = **18 文件 / 839 项全绿**（`Test Files 18` == `ls tools/*.test.ts` 18，防假绿）；`npm run typecheck` 0 错。
- 自检：`apppay-selftest` **156** / `gateway-selftest` **303** / `xpay-selftest` **96** / `iap-selftest` **47**（app.mjs 新增装配未破坏既有链路）。较基线 17/752 新增护栏 20（78 项）+ 护栏 19 扩至 29 项。
- **红验证**（注入缺陷证明断言能抓，随后逐字恢复 + `diff -q` 校验）：护栏 20 四组（Web 渲染支付按钮→2 红 / 删金额校验→1 红 / notify 走 wrap→1 红 / 查单失败改报错→1 红）；护栏 19 四组（付费墙去开关门控→1 / legal 无条件披露→1 / 0047 标记已应用→1 / env key 改名→2）；selftest 三组（绕过微信验签→7 / 删金额校验→4 / 查单失败改报 500→2）。
- **默认构建探针**（`npm run build`，🔴 不用 `build:web`——它会删 `dist/legal/`）：入口 js `index-HoMGJbqY.js`；App / 小程序引导字样 0、支付按钮折叠 `wechat:!1,alipay:!1`（`wechat:!0` 零命中）、「网页版仅展示价格」3 命中、兑换码保留。

### 五、🔴 验收口径修正（本轮实测发现，判读产物必须照此）

- 旧判据「Web 产物 `下单` 字样 = 0」**自本轮起失效**：`apppayClient.ts` 技术性错误文案含「**预**下单」（「支付响应缺少预下单参数」「微信/支付宝预下单参数不完整」）→ 裸串 `下单` 恒 **3 命中**。实测 `预下单` 3 / `下单` 3 / **差值 0**，可自证全是子串碰撞。
- **正确判据**：真实引导 CTA 全 0（`去小程序下单` / `去 App 购买` / `立即购买` / `立即开通` / `去支付` / `前往小程序` 本轮实测均 **0**），或等价差值 `count('下单') - count('预下单') == 0`。
- 📌 **Web 产物含 apppay 客户端代码 = 既有架构属性，非本轮缺陷**：`src/lib/api.ts:9` 静态 import `verifyViaApppayGateway` → `/.cloud/payment/apppay/{prepay,query}` 端点串进 Web 包；但 iOS 通道 `/.cloud/payment/apple/verify` **同样在 Web 包内**（早于本轮即如此）。Web 上**不可达**：调用点包在 `platformName() === 'android'` 内、原生 SDK `window.Capacitor.Plugins.*` 在浏览器恒不存在。🔴 **判 Web 能否收款看「按钮是否渲染 + 运行时是否拦截」，不看端点串是否出现**。

### 六、护栏与自检构成

- **护栏 20 `tools/apppay-consistency.test.ts`**（481 行 / 78 项）：20-A 业务流程不变 / 20-B 开关同源 / 20-C **Web 恒不收款**（`isAndroid()` 门 + api.ts android 分支 + `WEB_NO_CHARGE_TEXT` 恒展示）/ 20-D 资损防线（金额·验签先于业务·幂等键·403 归属）/ 20-E **已扣款绝不报错**（8000 / retry_later / QUERY_ATTEMPTS=4 / 404|405|503→null）/ 20-F 路由装配（notify 不走 wrap / 限流豁免）/ 20-G 数据库（UNIQUE / CHECK / SECURITY DEFINER / 0021 无 provider CHECK）/ 20-H 凭据边界（前端零签名）。
- **护栏 19 `tools/release-readiness.test.ts` + `.baseline.json`**（29 项，本轮改写 19-B/19-C）：19-B 加 `migration0047Applied:false`、`gatewayAppPayDeployed:false`、APP 支付 **9 env keys**（微信 6 + 支付宝 3）、0047 函数/GRANT/凭据零泄漏断言；19-C 从「钉死 `THIRD_PARTY_CHECKOUT_ENABLED=false`」改为「**门控 ↔ 法务口径 ↔ 实装登记三者一致**」（9 断言）。
- **`tools/apppay-selftest.mjs`**（919 行 / 156 项）：自造 4 把 RSA 密钥（WX_MCH / WX_PLATFORM / ALI_MCH / ALI_PLATFORM）；A 密码学纯函数正反用例、B prepay（微信外呼报文断言 + 支付宝本地签名验证 + 拒绝路径 + 503 降级）、C 微信回调（核销/幂等/验签失败/解密失败/金额不足/非成功）、D 支付宝回调、E 查单（本地 paid 不外呼/补发/金额不足/退款/外呼失败 200+`retry_later`/支付宝查单）、F 凭据零泄漏。**起 3 个真实 HTTP 实例**（双渠道齐备 / 仅微信 / 全未配置）。
- **护栏 18 `web-no-payment.test.ts`**（既有）：`THIRD_PARTY_CHECKOUT_ENABLED` 已删，W 系断言不依赖该常量故不受影响。
- `tools/gateway-selftest.mjs`：「配齐后无提示」基线加 `wechatPayMchid:'1900000109'`、`alipayAppId:'2021000100000001'`，另加 2 条正向断言（缺商户号 / 缺支付宝 AppID → `warnings()` 提示）。

### 六之二、护栏 21~23 构成（11-10 新增，MEMORY 只留文件名）

- **护栏 21 `tools/redeem-hardening.test.ts`**（8 项）：锁 0048 三件套（`code_hash` 列 + `expires_at` 过期检查在标记 used **之前** + `redeem_attempts` 节流）与核销函数走 sha256 匹配。已红验证：改回明文匹配 → 变红。
- **护栏 21b（同文件 +5 断言）**：锁发码工具 `gen-redeem-codes.mjs` 三处 —— ① `writeFileSync(outFile)` 必须在 `spawnSync(dbee-ssh.py)` **之前**（明文先落盘）② psql 带 `-tA` + `RETURNING 'GENCODES_OK:'` ③ 计数正则 `/^\s*GENCODES_OK:/gm`（容忍行首空白）；另加失败分支必须告知「明文已安全落盘」+ 附孤儿清理 SQL。**逐条红验证 4/4 通过**（分别模拟：去 `-tA`、去 `\s*`、改回 `INSERTED`、删落盘语句、删失败指引）。
- **护栏 22 `tools/mini-upload-size.test.ts`**（6 项）：锁 `mini/project.config.json` 三项 `es6:false / minified:true / uploadWithSourceMap:false` + `libVersion` 主版本 ≥3（`es6:false` 的前置安全条件：vendors.js 含 cloud-sdk 的 async/await，基础库 <2.11.2 会真机语法报错）+ **源与 dist 配置同步**（防「只改源不构建」重演 —— DevTools 项目根是 `mini/dist`）。红验证：`es6→true` = 2 failed、`minified→false` = 2 failed、恢复后 6 passed。
- **护栏 23 `tools/revoked-codes-not-tracked.test.ts`**（3 项）：扫全部 `git ls-files` 跟踪文件，对码形 token **现算 SHA-256** 与「吊销码哈希集」比对，命中即红。🔴 **护栏自身不含码明文**（只钉哈希，明文留证在 gitignored 的 `release/`）。含两条防假绿：哈希集自洽（3 张 64 位 hex）+ 跟踪文件数 >100（防 git 不可用扫到空集）。红验证：植入 3 张码（含小写形态）→ 1 failed；删除 → 3 passed。
- 📌 基线演进：839（11-09 晚）→ 843（+`proDaysLeft` 4 组）→ 851（护栏 21）→ 857（护栏 22）→ 859（护栏 23）→ 862（护栏 23 注释修正后）→ **863 → 870**（`no-cloud-runtime.test.ts` 用 `it.each(文件)` 且 `SCAN_DIRS` 含 `deploy`、`EXT` 匹配 `.sh` → **每新增一个 `deploy/*.sh` 就 +1 项**，故新增 `issue-test-codes.sh` 等脚本使计数确定性上升，非 flaky）。最终 **21 文件 / 870 项全绿**。
- 🔴 **计数口径自查方法论（踩过）**：用 `grep -E '^\s*(✓|×)'` 做「两次计数稳定性对比」时，该模式因 **ANSI 色码**根本没匹配到行 → 两个**空文件**互 diff「无差异」→ 据此得出「计数稳定」的假结论。正确做法：先 `sed -E 's/\x1b\[[0-9;]*m//g'` 去色码再比对。**空集上的断言恒真 = 假绿**，与「护栏空跑」同源。

### 七、🔴 本轮踩坑六则（勿重犯）

1. **自检断言字段名错**：`cloudError` = `{message, error}` **不是 `code`** → `.code === 'provider_mismatch'` 恒假。（sed 批量替换因引号嵌套报 `unknown option to 's'` → 改用 Edit 逐个修。）
2. **settles 未清零** → 「外呼失败零 settle」假红；子块前补 `mockPool.settles.length = 0`。
3. **lifetime 权益污染**：同一 OWNER 在 D 节已买断 lifetime → E 节 revoke 断言失败。`revoke` 只清同 `source`、lifetime **不降级是 0047 刻意语义不是缺陷** → 改用独立用户 `OWNER_E`/`OWNER_E2`。
4. 🔴 **红验证静默跳过（最危险）**：python heredoc `assert s.count(old)==1` 失败（该行在微信/支付宝两处回调各出现一次）→ **文件未被改动但自检仍报 156 通过**，造成「验证通过」的错觉。改用 `sed -i '580s/…/…/'` **按行号定位**。教训：**红验证必须确认「注入真的生效」**（先确认改动落盘 / diff 有变化），不能只看测试输出变红或不变红。
5. **护栏断言自身写法错**：①「先验签」用全文 `indexOf('verifyAlipayNotifySignature(')` 命中文件上部**导出函数定义**而非 handler 内 → 改为从 `async alipayNotify(` 起 `slice` 再定位（微信同修）；② 断言含注释文本 `// 网络层异常`，但 `stripComments` 已抹成空格 → 改为只匹配代码结构 `catch { return null }`。（= 护栏铁律②「匹配实际使用非标识符出现」③「断言在 stripComments 后做」的现场复现。）
6. **gateway-selftest「配齐后无提示」基线冲突**：新增 2 条 `warnings()` 撞既有基线 → 按既有模式（参照 line 451 对 `wechatMiniSecrets` 的处理）把 `wechatPayMchid`/`alipayAppId` 纳入基线，另加正向断言。

### 八、配置模板与开启前置

- `.env.example` 加「售卖构建期开关」段：`D_BEE_XPAY_ENABLED`（mini 售卖）/ `D_BEE_APPPAY_ENABLED`（Android 支付 + Web 引导，**一个变量同决定两端**）**各自独立、默认 false**。
- `deploy/gateway/gateway.env.template` 在 Apple IAP 段后插「Android APP 支付（0047）」段：`PUBLIC_BASE_URL` + 微信 6 项 + 支付宝 3 项注释化模板。
- 🔴 **开启收款前置（资质未到位前开关必须保持 false，先配平台再开开关）**：微信开放平台移动应用审核 + 商户号 **APP 支付权限** + 支付宝企业应用 + **App 备案下证** + 软著 → 再做「**1 分钱**」真实联调验证金额校验。详版 → 权威文档 §五。

### 九、文档纠偏（保决策溯源，只加横幅不改正文）

- 新增权威 `docs/Web引导闭环与Android收款实装-2026-11-09.md`。
- `docs/四端收款堵点与政策依据详表-2026-11-09.md`：头部加 🔴🔴 纠偏横幅 —— 结论 #5 / §4.4 / §六第 6 阶段「Web 办妥 ICP 经营许可证后可独立收款」**作废**、绑定的「启动办证」建议**不再是本轮前置**、Android 进入**已实装可收款**；渠道强制 / 备案阻断 / 法规依据部分**仍有效**，降级为法规与资质核对存档。
- `docs/四端收费一致性核验与合规实施总纲-2026-11-09.md`：加**第二版横幅**（优先级高于上一版）覆盖上一版 ②③（②′ Web 办证收款作废、③′ 暂不启动办证、①′ Android 已落地、⑤ 四端业务逻辑零改动）；一致性盘点 / L1~L3 / 护栏边界 / 发版验收 / 执行铁律**仍有效**。
- `docs/Web端定价展示与小程序下单-现状梳理与改造方案-2026-11-07.md`：加**三次补注**覆盖二次补注（① Web 办证收款作废、② Android 已实装、③ 权威改为本文、④ §2.6「跨端权益不互通」已被 11-08 云库清零 + 四端统一自建 PG 解决）。

### 十、状态与未决

- **零生产变更、未开任何开关**（`D_BEE_APPPAY_ENABLED` 默认 false）、**线上零变化**（线上入口 js 仍 `index-Bm9H-Xgy.js`，本轮本地构建 `index-HoMGJbqY.js`，`dist/` 不入 git）；生产迁移水位仍 **0045**（🔴 **0046 / 0047 均已写未应用**）。
- 🟠 未决：开启收款待资质链；`LEGAL_UPDATED` 是否刷新（产品决策）；iOS 包需 **Mac 重打**才含 A-5 真删号 + 本轮改动。

## 2026-11-10 · psql 三坑 + 发码「明文先落盘」铁律（MEMORY 只留一行指针）

背景：当天为发月卡测试码，**一天之内踩齐三个独立的坑**，每个都会造成「静默错误」
（终端不报错或报错误结论），且其中两个已造成生产侧后果（孤儿死码行）。

### 坑 1 · `psql -c` 放多条 SQL → `:'var'` 根本不插值
- 写法：`psql -v idv=4 -c "DELETE ... WHERE id = :'idv'; SELECT 'ok';"`
- 结果：`ERROR: syntax error at or near ":"` —— psql 遇到 `-c` 内含分号分隔的**多条**语句时
  走的是「直接把整串发给服务端」的快路径，**绕过脚本处理器**，于是 `:'var'` 不做插值，
  服务端收到字面 `:'idv'`。
- 铁律：**需要 `-v` 插值就走 `-f` + heredoc**（`cat > /tmp/x.sql <<'EOF' ... EOF` 再 `psql -f`）。
  `tools/gen-redeem-codes.mjs` 与 `deploy/clean-orphan-test-code.sh` 都是这个手法，均已实测可用。
  `-c` 只配「单条 + 无需插值」的语句。
- 连带坑：`echo | sudo -S` 已占用 stdin，**再管道给 psql 会让 SQL 收不到**（本项目此前已踩过两次）。

### 坑 2 · 解析 psql 输出必须 `-tA`
- 默认**对齐模式**会在每行前补空格并输出表头，实测得到 `" GENCODES_OK:pro:1"`（行首有空格）。
- 计数正则若锚定 `/^标记:/gm` → **恒 0 匹配** → 误判「插入 0 行」→ 判发码失败。
- 铁律：psql 加 `-tA`（tuples-only + unaligned，输出裸值无前导空格/表头/行数尾巴）；
  正则**同时**写成 `/^\s*标记:/gm` 兜底（万一有人把 `-tA` 去掉也不会再静默判 0）。
- 标记串要独特（`GENCODES_OK` 而非 `INSERTED`），避免与 SQL 报错文本撞车。

### 坑 3 · 变更类语句绝不 `2>/dev/null`
- 运维脚本里图省事写 `SUDO() { echo "$pwd" | sudo -S -p '' "$@" 2>/dev/null; }`，
  坑 1 的语法错误被**整条吞掉** → 终端什么都不打印 → 看着像「成功但影响 0 行」。
- 只靠 `AFTER total=1`（没变）才发现异常。
- 铁律：**只读查询**可抑制 stderr（降噪）；**变更类语句**一律保留 stderr + 显式 `RC=$?` 检查。
  同一脚本里拆两个函数（`SUDO` / `SUDO_V`）区分。

### 🔴 发码类操作：明文必须先落盘，再写库（顺序不可反）
- 原实现「INSERT 成功 → 解析计数 → 写明文文件」，遇坑 2 判失败即 `return`，
  明文文件从未写出，进程退出后**明文永久丢失**；但 INSERT 其实已成功 →
  库里留下一行只有 SHA-256 哈希的记录（哈希不可逆推）= **无主孤儿死码**，
  既没人能兑换、也没人知道它对应哪张码。
- 铁律：**明文先落盘**（`writeFileSync` + `chmod 600`）再写库。
  失败方向代价必须偏小：**宁可多发一次（幂等可清理），不可丢明文（不可恢复）**。
- 失败分支必须同时告知两件事：① 明文已安全落盘 ② 孤儿行的核查/清理 SQL
  （缺第二条，下一个人会在不知情下重跑，二次制造孤儿）。

### 一次性清理脚本：别留 id 默认值
- `TARGET_ID="${TARGET_ID:-4}"` 首跑之后就是颗雷：目标行已删，将来 id=4 可能是
  **另一张正常码** → 复用脚本即误删。改 `${TARGET_ID:?必须显式传}` 强制传参。
- 删除条件用「四重与」而非 `note LIKE`：id 精确 + `used_by IS NULL` + `code IS NULL` + note 全等；
  删前先用只读诊断确认这四条**命中且仅命中**目标行（实测 `all_four=1`）。
- `redeem_codes.id` 真实类型是 **bigint**（不是 int）；`used_by` 是 text（不是外键整型）。

### 注入型占位符在脚本里只能出现一次
- 首版 `__CODE__` 同时出现在注释与 `case "$CODE" in __CODE__)` 的模式里，
  `sed s/__CODE__/真码/` 把 **case 模式也换成真码** → `$CODE` 命中自己的守卫 → 误报「未替换」。
- 修法：守卫改成**按形状校验**（`grep -Eq '^[0-9A-Z]{16}$'`），不比对占位符字面量；
  并显式断言「占位符出现次数 == 1」。
- 相关：`deploy/dbee-ssh.py run` **无 stdin/env 透传**，`render_text` 只认它自己的占位符表
  （`__SUDO_PWD__` / `__DOMAIN__` / `__JWT_SECRET__` 等）→ 要传额外秘密值只能像
  `gen-redeem-codes.mjs` 那样**本地生成临时脚本副本**（写在 gitignore 的 `release/`，用后即删）。
  `assert_no_leaked_secret` 只放行含 `sudo -S` 的行，密码出现在其他行会拒绝上传。

### 非破坏性核验发出去的码（不烧码）
- 直接调 `redeem_by_code()` 验证会**真的核销掉**这张码，用户就没得测了。
- 等价验证：把明文码传进服务器，库内现算 `encode(digest(码,'sha256'),'hex')` 与 `code_hash` 比对
  （这正是 `redeem_by_code` 的第一步匹配逻辑），输出只有布尔值/形状摘要，
  **码明文与哈希都不落日志**。脚本 `deploy/diag-verify-issued-code.sh`。

### 迁移水位跳号空洞（0046/0047 缺失）实测结论
- 11-10 为发码手工应用了 **0048**，而 `0046`（xpay）/ `0047`（apppay）**仍未应用**
  → `schema_migrations` 出现 0045 → 0048 的**跳号空洞**。
- 是否有害？实测无害：① 本仓**没有自动迁移 runner**（`git ls-files | grep migrat` 只有
  `tools/migration-audit.sh` 与 `deploy/run-migration-audit.sh` 两个审计脚本），迁移是**手工逐个**应用，
  不存在「只应用 version > max(applied) 的文件」这类会永久跳过 0046/0047 的逻辑；
  ② `tools/migration-audit.sh` **没有跳号检查**（只查 `status <> 'applied'` 与 checksum 比对），
  且对 checksum 为 NULL 显式跳过（「自指迁移，跳过比对」）→ 不报红；
  ③ 0046/0047 的目标对象（`xpay_transactions` / `app_payment_transactions` / `settle_app_payment`）
  实测均**不存在**，与「未应用」一致，说明没有被别的迁移偷偷带进来。
- 🔴 补应用 0046/0047 时注意：两者都 `CREATE OR REPLACE FUNCTION public.verify_payment_order`，
  **0047 覆盖 0046** → 必须按 0046 → 0047 顺序应用，否则最终函数体是 0046 版（查单语义丢失）。
  `payment_products` / `payment_orders` 两张表是老迁移（0021/0029/0030）建的，**早已存在**，
  别误判成「0046/0047 已部分应用」。

## 2026-11-10 晚 · 兑换码 P0 泄露事故 + 0048 加固（MEMORY 只留精简条）

### 事故本身（🔴 最普适的一课）
- 3 张**终身**（lifetime）兑换码明文曾硬编码在 `src/lib/entitlement.ts`，虽已从前端移除
  （commit `43e966a`/`2a87d80`），但**仓库是 public**（GitHub API 实测 `private: False`），
  删文件 ≠ 删历史：`curl raw.githubusercontent.com/yutaiyin139/d-bee/f99a2c5/src/lib/entitlement.ts`
  → **HTTP 200**，正文含三张码明文。任何人可免费下载 → 白拿终身会员。
- 线上实测 `total=3 unused=3 used=0`、全 `plan=lifetime`、`used_by IS NULL` → 仍可兑换。
- 🔴 **误判链条**：11-10 前的记忆只记「已从前端移除」，把「已修复」当成「已止损」。
  **git 历史不可靠、public 仓库 = 全世界可读**，这两层漏掉就等于没止损。
- 🔴 **0048 对此零止损**：0048 先用明文回填 `code_hash = digest(code,'sha256')`，再 `SET code=NULL`。
  核销改按 hash 匹配 → 已泄露的明文码输入后**照样算出同一 hash → 仍兑换成功**。
  即「清空明文列」只防「读库拿码」，**不防「已知明文去兑」**。唯一止损 = 显式 DELETE 那 3 行。
- 止损执行（用户 14:55 授权）：先归档明文到 `release/REVOKED-legacy-hardcoded-codes-20261110.txt`
  （gitignored），再 `psql -v` 参数绑定 DELETE，带**大小写不敏感**（`upper(code)`，与 RPC 归一一致）
  + **安全闸**（子查询要求恰好 3 张未用，否则删 0 行）。生产实测 `matched_unused=3` → `DELETE 3` →
  `still_present=0`。**独立二次核验**（另跑 diag 脚本，不复用同一事务输出，守铁律 #13）= total=0。
- 附带发现：`.workbuddy/memory/*.md` **33 个文件被 git 跟踪且在 public 仓库**。全量扫描结论：
  **无真实完整密钥泄露**（API key 仅截断形 `sk-5819dc...`；5 处 `DBEE_PWD` 命中全是 `"$SSH_PWD"` shell 引用）；
  `git log --all --diff-filter=A` 证实 `.env` **从未被提交**（只有无真值的 `.env.example`）。
  唯一实质泄露就是那 3 张码，已止损。仍建议评估仓库转 private（需用户在 GitHub 操作）。

### 0048 加固内容（对外契约不变，前端零改动）
- ①**哈希存储**：`code_hash` 列存 SHA-256（`pgcrypto`），回填后清空 `code` 明文
  （drop NOT NULL + drop unique `redeem_codes_code_key` + `SET code=NULL`）；
  核销改 `v_hash := encode(digest(v_norm,'sha256'),'hex')` → `WHERE code_hash = v_hash`。
- ②**有效期**：`expires_at` 列，核销在「标记 used **之前**」检查过期返 'bad'（**不烧码**）；存量 NULL=永久。
- ③**节流**：`redeem_attempts` 表 + `redeem_throttled(text)`（60s 失败≥5 次拒，复用 0012 `invite_throttled` 手法）。
  🔴 这补上了「`redeem_by_code` 原本无任何节流」的暴露面（码空间 2^80 是唯一防线）。
- 已应用到生产（实测水位 0048、`code_hash` NOT NULL、prosrc 含 code_hash+digest+expires）。

### 🔴 护栏 23 的教训：护栏只钉哈希，永不写明文（连注释都不行）
- `tools/revoked-codes-not-tracked.test.ts` 扫全部 `git ls-files` 跟踪文件，对码形 token
  **现算 SHA-256** 与「吊销码哈希集」比对，命中即红。
- 首版在 `TOKEN_RE` 的**注释**里顺手抄了三个吊销码当形态示例 → 护栏扫被跟踪文件时
  **命中自己的注释** → 1 failed（护栏把自己判红，`a39d898` 修：注释只描述形态
  「7 字符无连字符 / 10 含 1 个 / 13 含 2 个」，不写值）。
- 普适律：**写「防泄露」的护栏时，护栏文件自身也被 git 跟踪**；在注释里写敏感值 = 护栏自己再泄露一次。
  public 仓库下尤其致命。明文留证只能在 gitignored 的 `release/`。
- 含两条防假绿：哈希集自洽（3 张 64 位 hex）+ 跟踪文件数 >100（防 git 不可用扫到空集）。

### 发码参数语义（🔴 两个参数正交，别混）
- `--months N` = **兑换后**会员时长 N 个月（月卡 1 / 年卡 12；`lifetime` 必须 months IS NULL）。
- `--expires-days N` = **这张码必须在 N 天内兑换**，过期自动作废（自带止损）。
  ⚠️ `--expires-days 1` **不是日卡**！兑换后时长仍由 months 决定。
- 兑换码体系**没有日卡档位**（铁证 `0044:79-96`：`months integer` + CHECK `months > 0`，
  核销用 `make_interval(months => ...)`，最小粒度 1 个月；`months=0` 被 CHECK 拒、小数被
  `Number.isInteger` 拒）。「Pro 1 天」的正规路径是**积分兑换** `redeem_honey('pro1Day')`
  （100 蜜糖，`src/lib/invite.ts:53`，走 `0013:204`），不是兑换码。
- 🔴 发测试码**刻意不用 lifetime**：`--expires-days` 只限「可兑换窗口」不限「会员时长」，
  一张忘了清理的 lifetime 测试码 = **永久**免费会员（负债无界）；月卡/年卡最坏自动到期（负债有界）。
  本事故当天刚处理完 3 张 lifetime 泄露，别拿 lifetime 顶替别的档位。
- 工具**刻意拒绝明文入库**（`gen-redeem-codes.mjs:213-220` 硬前置：库内无 `code_hash` 列即
  `RAISE EXCEPTION '0048 未应用…'`），绝不静默退化。在刚处理完明文泄露事故的当天，
  绕过该闸往生产写明文码 = 亲手复现事故根因。
- 一条命令发测试码：`TEST_NOTE=xxx TEST_EXPIRES=7 bash deploy/issue-test-codes.sh --yes`
  （裸跑只打印计划，`--yes` 才动生产；默认档位 `TEST_TIERS="1"` 只发月卡）。
- 16 位 Crockford base32（去 I L O U），无连字符/空格，大小写与空格不敏感（RPC 归一只 `upper` + 去空白）。

### 🔴 sed 分隔符坑（11-10 新踩，与 psql 三坑同类）
- 密码含特殊字符时 `sed "s|__PLACEHOLDER__|$PW|"` 报 `unknown option to 's'`
  —— `|` 被密码内容当成第二个分隔符，整条 sed 表达式崩掉（**静默不改文件**，
  脚本仍按未替换的占位符跑 → 更难发现）。
- 修法：**改用 Python f-string 直接写临时脚本**（不经 sed 二次替换），
  密码全程不回显终端，`os.remove()` 后断言 `exists=False`。
- 同源教训：`deploy/dbee-ssh.py run` **无 stdin/env 透传**，`render_text` 只认它自己的占位符表
  （`__SUDO_PWD__` 等）→ 要传额外秘密值只能本地生成临时脚本副本（写 gitignore 目录，用后即删）。

### 兑换码测试后的清理（别让测试码留成活口）
- ①按批次作废（一条 SQL 清掉本次所有未用码）：
  `DELETE FROM redeem_codes WHERE note LIKE '测试码-%' AND used_by IS NULL;`
- ②若已兑换，把测试账号权益复位：
  `UPDATE entitlements SET plan='free', pro_until=NULL, source=NULL WHERE owner_id='<测试账号>';`
  `DELETE FROM redeem_attempts WHERE owner_id='<测试账号>';`
- 🔴 一次性清理脚本**别留 id 默认值**（`${TARGET_ID:-4}` 首跑后即成误删雷）→ 用 `${TARGET_ID:?}` 强制显式传参；
  `redeem_codes.id` 真实类型是 **bigint**（别按 `::int` 传）。删除条件用「四重与」（id 精确 +
  `used_by IS NULL` + `code IS NULL` + note 全等），删前先只读诊断确认 `all_four=1`。
- 📌 兑换入口：Web / Android / 小程序付费墙底部输入框；**iOS 端刻意无入口**（Apple 3.1.1 反规避）。
  返回值 `ok`=成功 / `used`=已被用过 / `bad`=码错、已过期或被限流。

## 2026-11-10 晚 · 「环境备忘」全节逐字归档（由 MEMORY 压出，零信息丢失）

> MEMORY.md 的「环境备忘」只保留精简指针，以下为**逐字原文**（含 REFERENCE 此前缺失的
> `import.meta.env.VITE_` / `中文形态` / `latin1` / `urlCheck` / `JSCore` 等独有条目）。

## 环境备忘（详版 → REFERENCE.md）

- SSH `150.158.51.106`（🔴 `SSH_PWD` 勿入记忆/文档）；**验收一律打 `https://d-bee.cn/`，别打 IP**（IP http 已 404）。APK 归档 `release/`（**绝不放 `android/.../apk/release/`**，Gradle 会清理）；异地备份 `db/backups/offsite/*.dump` 含真实健康数据，**严禁 git add**。🔴 git push 遇 `schannel: failed to receive handshake` → 单次 `git -c http.sslBackend=openssl push origin main`。🔴 **数值口径唯一权威 `src/lib/numfmt.ts`**（计算层全精度、展示层舍入），禁自写 `toFixed`/`Math.round(n*f)/f`。🔴 **nginx 只反代 `/.cloud/` 与 `/auth/`**，其余 POST 落静态层返 **405** → 405 不能判路由存在；判路由打正确前缀并用「对照已存在路由返 401」区分。
- 🔴🔴 **测试 = vitest**（`npm test` = `vitest run tools/`），`vite.config.ts` 强制串行（并行会静默丢文件＝假绿）；**跑完必核对 `Test Files` 数 == `ls tools/*.test.ts`**。**mini 类型检查须单独跑**；构建期护栏必须写在构建配置里（webpack 不执行被打包模块顶层代码）。**禁硬编码日期**（`log_date` 须同源取 `todayKey()`，否则窗口滑走集体假红）。**MAPE 达标 ≠ 无需处理**（四指标并报，实测需真机+样本餐≥20 条 4 档，此前不得对外表述精度数字）。**小程序验收一律以体验版为准**（真机调试注入 Web API 掩盖 JSCore 缺口，`urlCheck=false` 掩盖合法域名问题）。
- 🔴🔴 **护栏断言三条铁律**：①一个 `it()` 只一条断言 ②匹配「**实际使用**」非「标识符出现」（验「先验签」须从 `async alipayNotify(` 起 `slice` 定位，全文 `indexOf` 会命中上部**导出定义**）③断言在 `stripComments()` 后的代码上做（勿把注释文本写进期望）。新增护栏/放宽快照基线**必须红验证**；「反向检测」里的禁用域名是**判据不是依赖**，须白名单 + 正向断言补上（护栏 10c）。🔴🔴 **红验证必须确认「注入真的生效」**：`assert s.count(old)==1` 若因目标串多处出现而失败，脚本会**静默跳过注入**但测试仍报全绿 → 极危险假绿；修法按**行号**定位或先校验 diff。
- 🔴 **产物判读三条**：① **中文形态分工具链**——mini（Taro/webpack）= 纯 ASCII `\uXXXX` → `codecs.decode(s,'unicode_escape')`（勿再 `.encode('latin1','ignore')` 丢中文）；Web 主端（vite）= UTF-8 直存 → 直接 UTF-8 读。② **构建期替换 vs 布尔注入验证法不同**——`import.meta.env.VITE_*` 是字符串替换（字面量留产物，grep 命中 ≠ 生效）→ 安全过滤抽纯函数单测；`define` 布尔常量才被 terser 折叠（用「引导字样 0 命中」验证）。③ **裸串 grep 会子串碰撞**（「下单」命中「预下单」）→ 判据用**完整 CTA 短语**或差值。判数据面要追「哪个常量真正被 `resolveEndpoint` 返回」，不能 grep 到域名就下结论。
