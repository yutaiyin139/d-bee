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

⑧🔴 **App 名称口径二选一（未决，该字段悬置）**：`自律蜜蜂` vs `自律蜜蜂 - 饮食热量记录`。
**备案名 / ASC 名 / 软著名必须逐字统一**，否则 Apple 提审报 409 `ICP_NUMBER_MIIT_APP_NAME_MISMATCH`。
决策前不要在任何一处先填。

### 11-06 web 部署回滚点（补充）

`/var/backups/d-bee-web-20261106-131509`（13:16 重新部署前的产物快照）+
`/var/backups/nginx-d-bee.pre-certbot-20261106-144531.conf`（certbot 改写前的 97 行 nginx 配置）。
线上入口 `index-CkK9x744.js`（含备案号 `-2`）。
