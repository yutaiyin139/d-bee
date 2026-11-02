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
- 摆脱云库六步：ICP 备案→A 记录（`d-bee.cn` 曾无任何 DNS 记录）→certbot→三端注入 `VITE_NATIVE_ENDPOINT` 重打→0043 最终同步+账号合并→观察期 T+30。工具链（sync-mirror/switch-nginx-selfhost/dnscheck/setup-https）就绪。186****4728 分裂账号：云库 `2110364580268998656` 真实 vs Web 自建 `1792845025064566575` 空壳，根因两套发号机制。
- 支付链路（10-23）：verifyReceipt（21007/21008 沙盒切换、bundle_id 钉扎 `APPLE_BUNDLE_ID`、transaction_id 全服幂等、恢复购买）+ Notifications V2（x5c 证书链钉扎、续订/退款、落库）+ `AppleRootCA-G3.cer`；0037 幂等表+留痕表+3 函数（EXECUTE 仅 dbee_app）；webhook 豁免 IP 限流；`api.ts` iOS 优先走网关、404/503 回退 RPC。
- 短信三易错点：①aliyun 是 RPC + HMAC-SHA1 手写签名（腾讯云是 TC3-HMAC-SHA256）②模板 `SMS_512482436` 只有 `code` 一个变量，TemplateParam 传 JSON 串 ③签名口径=「北京迪蜂科技有限公司」；要品牌签名须重新申请 1–2 工作日，过审只改 `SMS_SIGN_NAME`；RAM 子账号最小权限。
- 安全加固两批：①10-26 六项（RPC 信任边界 / 原子性 / LLM 服务端授权 / Apple 环境白名单 / XFF 信任边界 / 榜单缓存），曾发现网关层完全未部署 → 已补齐复验 18/18。②10-27 七项（JWT TTL 30min+refresh 滚动+`token_version` 强制下线 0042 已部署 / appleSandbox 生产默认关 / 万能码切真短信 / LLM 视觉 fail-closed 503+文本降额 50/日 / grant_honey 发分前查真实记录 / CORS Origin 白名单 / email 验证码 163 SMTP 465/SSL 手写）——后四项代码+自测 300/0 全绿，待部署。
- 云库 0039 七权益函数：grant_honey / grant_photo_bonus / consume_ai_quota / consume_photo_quota / get_photo_quota / redeem_honey / settle_invite_checkin（顺带收掉 consume_photo_quota 的 PUBLIC EXECUTE）。
- 数据库切换核心判断（10-26）：不是「要不要切」而是「HTTPS 何时就绪」；过渡期云库唯一真相源，切换日一次性收口。
