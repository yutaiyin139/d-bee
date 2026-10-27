# D-Bee（自律蜜蜂）· 项目长期记忆（精简版；细节见当日日志与 docs/）

## 进度快照（2026-10-27 晚，🎉 **V1.7.2 已 bump 三端（Android vc13 / iOS build 11）+ 七项安全修复①③④⑤⑦全部代码落地、①④已部署上线端到端验证 + email 验证码通道（163 SMTP）上线**；V1.7.1 Web 已发布 / 上架前生产安全体检（0039/0040 + 网关 ③④⑤）/ Apple IAP 验签端点 / 腾讯云短信 provider 均已稳固；视觉双 provider（文本 DeepSeek `deepseek-flash` + 视觉 Qwen `qwen3.8-max-0902`）；Bundle ID 定案 `cn.com.dbee.app`）

> 🔴 **七项安全修复（10-27）进展**：① JWT access TTL 7 天→30 分钟 + refresh 滚动 + `app_users.token_version` 强制下线（迁移 0042 已落库）
> ② appleSandbox 生产默认关 + validate 拦截 ③ LLM 视觉 fail-closed 503 + 文本独立降额 50/日 ④ grant_honey 发分前查真实记录（functions.sql 同步 0039）
> ⑤ CORS Origin 白名单 `isOriginAllowed` ⑦ email 验证码通道（163 SMTP provider，465/SSL）。**①④ 已部署上线 + 端到端验证全过**（access token `ver=1`/TTL 1800s、登出后旧 token 立即 401）；③⑤⑦ 代码已就位待部署。
> 卡资质：⑥ 万能码切真短信 —— 🟢 **已解锁（10-27 晚短信审核通过、短信可用）**，切换只剩一条命令（见「短信通道切换」条）。
> **今日资质到货**：公章（10-27）已到手，已梳理 18 项盖章清单 `docs/公章使用清单-2026-10-27.md`；对公账户（10-28）到手 → 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议可启动。

- **✅ 6 项决策已拍板（10-22 晚）**：①主体=**有限责任公司** ②未提交产物**入库**（已提交 `b6b1725`+`43a5729`
  并推 origin/main）③LLM=**DeepSeek** ④短信=**先日志+万能码**（`SMS_PROVIDER=log`/`SMS_MASTER_CODE=888888`）
  ⑤网关语言=**Node**（`server/index.mjs`）⑥Apple 验签=**放 Node 网关**（**弃 `0029` 的 pg_net 方案，不再执行**）。
  决策原则：**便捷、技术可控、价格低廉、完全对比竞品**。全部凭据只存本地 `.env`（gitignore 覆盖），**未进 git**。
  完整后续计划见 **`docs/主体注册后-实施计划.md`**（§一 社保查证 / §七 竞品对比 / §A3 DeepSeek 坑 / §八 排期）。
- **⚠️ 两个安全待办（用户处理）**：①**重置 DeepSeek API key**（本次对话中明文出现过）；
  ②**轮换 SSH 密码与 dbee_app 数据库密码**——二者此前已提交进 GitHub 历史（`f99a2c5` 起），
  本次已全部脱敏 + 停止扩散，但**历史提交仍可检出**；`0002` 早期含 3 份用户档案同理。
  **轮换密码优先于重写历史**（`git filter-repo`+force push 属破坏性操作，未擅自执行）。
- **🔓 主体注册已办结（10-22）**：解锁微信生态（开放平台企业认证/商户号/公众号/小程序主体变更）、
  华为/小米企业入驻（Health Kit 硬门槛）、ICP 经营许可证可申请。
- **🔴 「3 人社保」查证结论：ICP 经营许可证的硬性条件，无法合规绕过**（2026 多省口径一致且核查趋严）：
  ≥3 名全职、**必须三个不同人**（许可/客服/安全负责人）、法人可算一人、**必须由本公司缴**（代缴/挂靠直接驳回，
  虚假材料处罚且一年内不得再申）、近 1 个月（部分省连续 3 个月）、管局做跨部门数据比对 + 可能上门核验场地。
  成本 ≈ ¥4000/月起（法人算 1 人则实际再招 2 人）+ 记账报税 ¥2000–5000/年 + 代办 ¥5000–15000（可压到约 47 工作日）。
  **已定策略 = 方案 A：暂不办 ICP 证，先靠 iOS IAP 验证付费意愿**（零固定成本，Apple 个人账号已通过、平台代收），
  有真实付费数据再决定是否背这个固定成本。**4 件确认项已全部答复（10-22 晚）**：经营范围**已含**
  「第二类增值电信业务」✅ / 注册资本 **≥100 万认缴** ✅ / 对公账户**在办、下周完成** 🟡 /
  小程序 `wxb7c7122de9c3ab1f` 仍是**个人主体、需变更** 🟡。→ **ICP 证的执照类前提已全部就位**，
  将来办证仅剩「3 人社保」一个缺口（~~域名过户到公司~~ **✅ 已完成 10-27**）。
- **📱 小程序主体变更流程（查证腾讯客服官方口径，10-22）**：入口后台→设置→主体信息→小程序主体变更；
  四步 + **¥300 审核费（不退）** + 审核 1–7 工作日。🎯 **本项目可免公证**（官方免公证第 1 条 =
  个人主体→企业、且个人即目标企业**法人**）：公证材料处再传申请函 + 法人身份证正反面 +
  **手持申请函照** + 申请函原主体处**签名 + 按手印**（个人主体签名手印、非盖章）；个人主体**不可委托代办**。
  申请函用**后台官方最新模板**、两页**骑缝章**。⏰ **审核通过后 7 天内**须管理员确认+重登+签协议，
  **超时作废、钱不退**。🔴 **变更后两个强制后续**：①**重做小程序备案**（信用代码变了→先注销原备案+新主体
  新增备案，**不支持直接变更**；平台初审 1–2 + 管局 1–20 工作日；✅ 备案期小程序可用，但新备案前
  不能发新版本）；②**类目资质重交**（盖新章，腾讯明确**变更后 14 天内**完成、逾期功能封禁）。
  ⚠️ **类目红线**：**避开「医疗-其他医学健康服务」**（须四选一提供医疗机构执业许可/器械生产许可/
  合作机构协议/器械备案凭证，本项目一个都没有）→ 选工具/生活服务类；**文案严禁诊疗/治病/筛查表述**
  （`legal.ts` disclaimer 已有「非医疗建议」，上架前全量复核）。支付限制（未绑非目标主体商户号）本项目不涉及。
- **🌐 `d-bee.com.cn` 备案（10-22）**：**个人备案已完成、正在走企业变更**。🔴 **各省管局规则不一，
  部分省不允许个人→企业直接变更**：允许则不中断、约 1–2 周；不允许须「注销原备案+企业重备」，
  **注销后域名停解析直到新备案通过**（注销 3–5 + 初审 1–2 + 管局 1–20）。行动：先在腾讯云控制台查本省是否
  允许；**域名必须先过户到公司再提交**（管局核对 WHOIS 持有者=备案主体，没过户必驳）；
  **关 WHOIS 隐私保护**；变更前后**须同省**、目标企业名下**不能已有成功备案**；若被迫注销重备，
  **先把 A4 切换做完并验证 IP 直连可用**再注销，停站期业务不断；部分省卡「原个人=现企业法人」——本项目同一人天然满足。
- **📊 竞品对比结论（§七，已完全对比）**：⚠️ **D-Bee 的 ¥18/月、¥128/年与 1 亿用户的薄荷健康完全同价**
  （薄荷包月续订仅 ¥15 更便宜），食物库 1,175 vs **100 万+**（差 850 倍）→ **绝不能拼「食物库广度」或
  「AI 识别准」**。✅ 但按年付 **D-Bee ¥128 是国际 12 款竞品中最便宜**（Cal AI ¥144 起 / MyFitnessPal ¥576 /
  Noom ¥1505），价格低廉已达标、**不需改价**（¥18/¥128/¥328 已锁定）。
  🔴 **关键风险**：悉尼大学 2024 研究——AI 食物识别对**混合亚洲菜肴高估达 49%、低估达 76%**，
  而中式炒菜/盖饭/汤全是混合菜肴 = D-Bee 核心场景；Cal AI 的 ±14.6% 还是西式食物测的。
  → **定位必须是「不卖 AI 神奇，卖能坚持下来」**：厚免费 + 蜜糖积分/邀请/打卡/徽章/榜单游戏化 +
  终身买断 ¥328（薄荷无此项）+ **本地规则引擎 `foodInsight.ts`（1,175 条零兜底、零幻觉、零边际成本）优先、
  AI 仅兜底** + 无广告 + 数据自托管 + 多端一致（三端小程序）。对标「自律茄子」的买断心智，不对标薄荷的库规模。
  **待办：实测 D-Bee 自己的 MAPE**（现完全空白，是竞品分析最后缺口，也是文案能否说「准」的依据）。
- **⚙️ AI 成本测算（§A3，按 DeepSeek V4 Flash 峰值价）**：输入 $0.30/输出 $1.20 每 1M token；
  **峰值 = 北京时间工作日 9–12、14–18 点，价格 2 倍**，恰是三餐记录高峰，**必须按峰值估**。
  拍照识别单次 ≈ ¥0.0047、教练问答 ≈ ¥0.0069（每图 token **恒上限 384**，2000² 与 5000² 同价；
  前端 `compressImage(maxSide=1024,quality=0.82)` 已压过一道，**无需 Files API**）。
  按额度上限 5 次/日：**100 DAU ≈ ¥42/月、1,000 ≈ ¥423、10,000 ≈ ¥4,230** → **万级 DAU 前 AI 成本
  远低于 3 人社保 ¥4000/月**，反证方案 A 正确。降本手段：系统提示走缓存命中（输入价降 ~98%）、
  本地引擎先命中再调 LLM。
- **🔴 DeepSeek 接线三个坑（查官方文档实测，会直接导致功能不可用）**：
  ① **`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役**，官方只剩 `deepseek-flash` 与
  `deepseek-v4-pro` 两个 ID，**配置写旧 ID 会调用失败**；② **只有 flash 系列接受图片**，传图给其他模型返
  `400 "This model does not support image"`（旧名 `deepseek-v4-flash-vision-exp` 已退役并入 flash；
  **`deepseek-v4-pro` 明确 "Vision: Not supported"**）→ **文本统一用 `deepseek-flash`**；③ 网关 `/llm/models`
  **必须给 flash 标 `supportsImages: true`**，否则前端 `pickModel(needVision)` 的 `filter(m=>m.supportsImages===true)`
  选空 → 拍照识别报错（另需过滤 `disabled!==true && enabled!==false`，见 `ai.ts:31`）。
  **模型 ID 必须放服务端配置**（`.env` 的 `LLM_MODEL_VISION`）而非散落代码，DeepSeek 改名时只改一行。
- **🎯 视觉识别已切双 provider 路由（10-24 落地，`63c0a71`+`cc96b65`）**：DeepSeek 视觉偏弱（官方定位
  「快速便宜、细粒度图像细节偏弱」），无法胜任「一盘菜精准识别多道菜」→ **文本（AI 教练/周报/计划）走
  DeepSeek `deepseek-flash`，图片识别走阿里云百炼 `qwen3.8-max-0902`**（视觉最强、用户 Workspace 有权限；
  旧名 qwen-vl-max/qwen3-vl-plus 无权限 403）。`server/lib/config.mjs` 新增 `LLM_VISION_BASE_URL/KEY/MODEL` +
  `LLM_IMAGE_DETAIL=high`（未配时回落原 llm 键，向后兼容）；`llm.mjs` wantVision 时走独立视觉 provider。
  线上已部署验证：文本返回 `deepseek-flash`、视觉返回 `qwen3.8-max-0902` 均 200。**服务端切模型对三端即时生效，
  无需重发 web/重打包**。⚠️ 部署线上 env 用「本地生成完整 env → SFTP 上传覆盖」最可靠（sed 对含特殊字符的
  key 转义易错、旧文件 ^M 回车符会漏匹配）。
- **版本/git**：Web **V1.7.1 已发布**（http://150.158.51.106/ ，`index-BJB7byNW.js` 实测含 honey_balance/版本串 1.7.1）；
  **版本已 bump 至 V1.7.2**（`e6234e4`，三端：package.json 1.7.2 / Android versionCode 13 / iOS build 11，待随安全修复部署后发版）。
  **V1.7.0 三端版本已统一**（`54ea9a0`）。最新 commit **`e6234e4`**（chore(release): 版本 bump 至 V1.7.2，10-27）。
  **10-27 全天（4 commit，`4f5ff2c..e6234e4`）**：
  `ab516a2` fix(security) 七项安全修复之①④——JWT 强化（TTL 30min + token_version 强制下线，迁移 0042）+ appleSandbox 生产默认关；
  `5821dbe` feat(gateway) email 验证码通道上线（163 SMTP，465/SSL 零依赖 node:tls 手写）+ 安全审计③⑤⑦修复（LLM fail-closed + 文本降额 50/日 + CORS Origin 白名单）；
  `be2267f` docs(legal+备案) 主体过户后法律文本公司化 + 联系邮箱统一 163 + 备案路径改注销重备（+ 公章使用清单 443 行）；
  `e6234e4` chore(release) 版本 bump V1.7.2。
  **工作区未提交**：`docs/公章使用清单-2026-10-27.md`（修改，13:40 后补充）。
  **10-25 晚～10-26 全天密集收敛（上架前安全/性能主线 + 资质到货）**：
  `3186680` fix(security) 35 文件 +2539/-85（0039/0040 迁移 + 网关 8 文件 + 前端配套 + 部署链路 + 7 个服务器实测脚本）；
  `de9a3cc` fix(security) dbee-ssh.py 渲染泄露守卫 + V1.7.1 生产安全体检；
  `c8d86a0` chore(release) 版本 bump 至 V1.7.1（Web/Android/iOS 三端，versionCode 12 / CURRENT_PROJECT 10）；
  `195ca13` fix(log) LogSheet 保存按钮冲突态 UX 修复（自动定位到覆盖/追加横幅 + 闪烁提示）。
  10-25 收敛：`dc0110d`+`8cba299`（0037 落地 + 综合报告 + mini 文案修复 + 日志去噪）、`1bc27a7`（微信支付 adapter）、
  视觉双 provider `63c0a71`+`cc96b65`、postinstall 自动构建 shared `d3fb8cc`、Bundle ID 定案 `23b295d`。
  10-26 全天（16 commit，`7460c90..4f5ff2c`）：`50cb9cc` fix(native) 教练问答超时+流式（四端，origin-proxy read timeout 60s→180s）、
  `b54675b` feat(sms) 腾讯云短信 provider（零依赖 TC3-HMAC-SHA256，签名与官方 demo 逐字一致）、
  `e34250b` feat(legal) 隐私政策等法律文档 URL 直达（商店/备案/ASC 填报必需）、
  `d1cb82e` docs 对外填报信息速查表（包名/合规URL/签名指纹/主体资质集中）、
  `9e809b7` docs 数据库切换详细规划（四端云库依赖/分叉量化/分阶段切换）、
  `3049375`+`1a53e47` pgAdmin 空表根因诊断（RLS+auth.uid() 机制闭环）+ 0041 dbee_admin 只读排查角色、
  `4f5ff2c` 七项安全审计结论存档。**工作区已干净**（origin-proxy 180s 超时已随 `50cb9cc` 提交）。
- **🎉 泳道 A 部署闭环（10-23 10:08）**：服务器 `150.158.51.106` 上 **nginx（自托管配置）+ dbee-gateway
  （Node 22.22.2 / :8080）+ PostgREST（16.4 / :3001）+ PG 17.11（dbee 库，0033 已应用）** 四件套均 active；
  `/.cloud/**` 全部走本机自托管栈，**不再依赖 WorkBuddy 云端**。8 项 E2E 全 ✓（含正常 OTP 路径：
  从 journald 读到真实验证码，非万能码兜底；带 JWT 读 profiles=200/`[]`，匿名=401，RLS 按 sub 过滤生效）。
  云端回滚点保留在 `/etc/nginx/sites-available/d-bee.cloud.bak`。切换脚本 `deploy/switch-nginx-selfhost.sh`
  （本机编排）+ `deploy/gateway/switch-nginx-selfhost.remote.sh`（远端）+ `deploy/nginx.selfhost.conf.example`。
- **📦 数据/结构分离（PIPL 最小必要，10-22 已落地）**：
  `0030-full-selfhost-mirror.sql` 含 17 表**全量真实用户健康档案**（年龄/性别/身高体重/饮食记录/减重障碍，
  **含 10 岁、17 岁未成年人记录**）→ **不入库**。改为：
  `db/migrations/0030-schema.sql`（**新增已入库**，`--schema-only` 产物，60KB，17 表 + 27 函数 + 24 策略 +
  GRANT，**0 行数据**）；`db/gen-full-mirror-sql.py` **新增 `--schema-only` 开关**（结构入库、数据本地重生成）；
  `0030-full-*` 与 `0002-mirror-to-local-pg.sql` 均已 **gitignore**（`0002` 原已跟踪，本次 `git rm --cached`
  移出，本地文件保留）。`db/functions.sql`（27 个 SECURITY DEFINER 函数 DDL，0 处真实 owner_id）已入库。
- **【主线·10-20 20:18 拍板】云库 → 自托管 PostgreSQL**：云库已恢复，从云库实时抓取生成完整镜像 `0030`
  （123KB，17 表 + 27 函数 + 24 策略 + GRANT + 全量数据，补齐旧 0002 缺的 10 表与 21 个业务函数），
  经 `deploy/sync-mirror.sh` 在服务器 dbee（PG 17.11）执行成功、自检全过（17 表行数与云库一致）。
  远程已打通（先 SSH 隧道后改直连：`listen_addresses='*'` + pg_hba 白名单 + 放行 5432），
  SQL 级 CRUD + 26 函数自测全过。
  🔴 **`dbee_app` 原为 BYPASSRLS（越权，未注入身份也能读到全部 17 份 profiles），已由 `0033` 收回**
  → 现为 `NOBYPASSRLS` + `app_users` 上 `TO dbee_app` 的精确 policy（网关身份面需要读写它，
  否则 0031 的 FORCE RLS + 无 policy 会把网关自己锁死，这正是当初只能靠 BYPASSRLS 硬闯的根因）。
  ✅ **前端已切**（10-23）：①自建 auth/JWT 网关（同时注入 `app.user_id`(RLS) 与
  `request.jwt.claim.sub`）②LLM 代理（SSE）③`/.cloud/database/rest/*` PostgREST 语义端点
  ④nginx 上游已切自托管 —— **四项全部落地并 E2E 验证通过**，见上方「泳道 A 部署闭环」。
  **不需要存储代理**——拍照识别走 base64 dataUrl 直塞 LLM `image_url`（`ai.ts:152/226`），全仓无 `cloud.storage` 调用。
  ⚠️ `0030` **已含 0025~0028 业务变更**（grep `AI_REDEEM_DAILY_LIMIT`/`streak7`/`newbie`/`invite_attempts`/
  `leaderboard` 命中 20 处），**勿盲跑 0025~0029 迁移**（会重复/冲突）；`0029` 已决定弃用。
- **📊 数据库切换详细规划（10-26 `9e809b7`，核心判断）**：不是「要不要切」而是「HTTPS 何时就绪」的资质问题。
  四端数据面现状：**Web 已切自建 PG**；**Android/iOS/小程序仍走云库**（原生 `detectNative()` 从未注入
  `VITE_NATIVE_ENDPOINT` 回退 CLOUD_HOST + iOS 受 ATS 强制 HTTPS；小程序 `mini/src/lib/cloud.ts` 硬编码 endpoint 无同源反代）。
  自建网关唯一缺口 = 无 `/v1/login-wechat`（code2session 在云侧）。**数据双向分叉每天扩大**（云库领先 meal_entries 128/97 等；
  自建独有 app_users/profiles#19/apple_*/schema_migrations）。**账号分裂事故**：186****4728 云库=2110364580268998656（真实）
  vs 10-24 Web 登录生成的 1792845025064566575（空壳），根因两套发号（平台 210/211 vs 自建时间戳 179）。切换时机=
  备案变更→域名过户→A 记录→80 公网→签 HTTPS→三端指 https://d-bee.com.cn（乐观 2 周/保守 4 周）；过渡期云库唯一真相源，
  切换日一次性收口（0042-data-sync-final.sql，原 0041 编号已被 dbee_admin 只读角色占用）。分阶段：0 安全整改（5432 收口+ufw 最优先）→
  1 账号映射+合并（HTTPS 前演练）→ 2 T-0 切换（HTTPS 就绪日）→ 3 观察期 T+30（云库只读保活）。详见 `docs/数据库切换详细规划-2026-10-26.md`。
- **📱 短信通道切换（10-27 晚审核通过、短信可用；切换已简化为一条命令）**：`server/lib/sms.mjs` 的 tencent provider
  （TC3-HMAC-SHA256 手写、零依赖）+ `config.validate` 门禁早已就绪，但**部署链路曾是缺口**——`deploy-gateway.sh`
  只渲染 `SMS_MASTER_CODE`，腾讯云四项凭据在模板里是注释，**拿到凭据也传不进去**。10-27 已补齐：
  ①模板四项凭据改占位符 `__SMS_TENCENT_*__` ②脚本注入 + 持久化到 `.secrets.local`（空值不落行，避免误判已配置）
  ③环境变量覆盖 `SMS_PROVIDER`/`DBEE_PROD`/`CORS_ALLOWED_ORIGINS`/`APPLE_ALLOWED_ENVS`/`APPLE_SANDBOX`
  ④tencent 模式**自动摘除 `SMS_MASTER_CODE`**（validate 规则「tencent+万能码=拒启」由脚本代劳）
  ⑤缺凭据 fail-fast 前置校验 ⑥所有 sed 注入值经 `esc_sed` 转义（`#`/`&`/`\` 会静默写坏 env）。
  🔴 **`DBEE_PROD=1` 的两个连带效应（最易踩）**：
  · **Apple 收据自动收紧为只收 Production**（`appleAllowedEnvs` 默认值依赖 `cfgProd`，`appleSandbox` 同步变 false）
    → iOS 未提审、沙盒验签没测完时**必须显式带 `APPLE_ALLOWED_ENVS=Sandbox,Production`**，否则 StoreKit 沙盒购买全失败；
  · **CORS 未配白名单则拒绝所有跨域**（同源不受影响，当前 Web 走 nginx 同源反代故能跑；脚本已加提前拦截提示）。
  切换命令与验收清单见 `docs/公章与对公账户到手-行动清单-2026-10-26.md` §一 P1。
  模板正文约定：`您的验证码是{1}，{2}分钟内有效`（`TemplateParamSet` 按位传 `[code, otpTtlMin]`）。
  ✅ **已入库 `e00387b`**（10-27 22:39，12 文件 +559/-311：部署脚本 + env 模板 + 5 份文档 + 记忆）。
- **🔴 上架前生产安全体检与加固（10-26，`3186680`+`de9a3cc`，六项 ①–⑥ 已全部生效）**：10-26 凌晨服务器只读探查发现
  **网关层完全未部署**（运行 10-23 骨架版，18/18 特征串探针全 OLD、`lib/iap.mjs` 缺失致 Apple 端点 404、LLM Pro 门控/
  XFF 限流/dbproxy 资源管理均未上线）——数据库 0039/0040 已在库生效，但代码未部署。04:07 用户确认后按序完成部署：
  密钥回收（`deploy/fetch-llm-secrets.py`）+ 模板固化（gateway.env.template 写死 Qwen 视觉键、API key 走占位符）+
  提交 `3186680` + `deploy-gateway.sh` 一次成功 → **复验全绿**（18/18 探针 NEW、Apple verify/notifications 404→503
  iap_not_configured 路由已注册、LLM 无 token 401、healthz 200）。六项状态：①RPC 信任边界✅②原子性✅③LLM 服务端授权✅
  ④Apple 环境白名单（代码上线，生效前提=上架前配 APPLE_BUNDLE_ID/SHARED_SECRET）✅⑤XFF 信任边界+资源管理✅⑥honey_balance/
  榜单缓存（DB 生效，前端待随下次发版触达）。
  **新发现发布阻断项（V1.7.1 报告 `docs/V1.7.1-安全验证报告与发布实施计划-2026-10-26.md`）**：①SMS 万能码生产启用
  （SMS_PROVIDER=log+24 位万能码，最高优先级，需实现 tencent()/aliyun() 真短信 provider）②5432 公网可连
  （listen_addresses='*'+pg_hba 家庭宽带 IP 会漂移，生产只走回环应收回）③凭据泄露多处（探查脚本/临时文件/git 历史，
  已加 `assert_no_leaked_secret()` 守卫 + 修 5 个脚本同类缺陷）④无 HTTPS+域名未解析（443 未监听，四端上架硬阻断）
  ⑤服务器侧无备份定时器（日备靠本机自动化单点驱动）⑥P3：schema_migrations 0020/0030 重复登记、/tmp 无 noexec。
  **V1.7.1 版本号现状**：package.json 1.7.1 / Android versionName 1.7.1 + versionCode 12 / iOS MARKETING_VERSION 1.7.1（2 处）+
  CURRENT_PROJECT_VERSION 10 / mini 0.1.0。
- **🔴 支付链路（已落地，10-23 `9e1db43`）**：Apple 验签**已从 pg_net 空壳改为 Node 网关**（`server/lib/iap.mjs` 479 行）：
  verifyReceipt 验签（21007/21008 沙盒自动切换、bundle_id 钉扎、transaction_id 全服幂等、恢复购买）+
  App Store Server Notifications V2 webhook（x5c 证书链钉扎验签、SUBSCRIBED/DID_RENEW 续订、REFUND/REVOKE 撤销、
  全量落库留痕）+ 根证书 `AppleRootCA-G3.cer` 入库钉扎（指纹与官方一致）。`0037-apple-iap-settlement.sql`：
  apple_transactions 幂等表 + apple_notifications 留痕表 + settle/revoke/log 三个 SECURITY DEFINER 函数
  （EXECUTE 仅 dbee_app，authenticated/anon/dbee_web 三层全堵）。`app.mjs` 注册 `/.cloud/payment/apple/{verify,notifications}`
  （webhook 豁免 IP 限流防 Apple 429 重试风暴）；`api.ts` verifyPaymentOrder iOS 优先走网关、404/503 回退 RPC。
  自测：`tools/iap-selftest.mjs` 41 项端到端断言全过、gateway-selftest 219 项无回归。**旧缺口（伪造凭证白拿权益）已封**。
- **🔴 数据库迁移全面审计（10-23，`ef12b95`+`9cfa31c`）→ P0 越权漏洞已修复闭环**：33 个编号 = ✅28 生效 +
  🔴3 失效（0015 部分失效可白嫖终身会员 / 0016 CHECK 全缺 / 0026 newbie 未生效 / 0027 邀请无日上限）+
  🗑️1 弃用（0029 pg_net 不可用）。根因四：①生成器只输出 GRANT 从不 REVOKE（追加语义，0002 遗留写权限没撤）
  ②不抓 pg_constraint（CHECK/外键必丢）③覆盖式迁移无法用存在性判版本 ④无迁移追踪表。
  **修复**：`0034-schema-migrations.sql`（追踪表）+ `0035-security-and-integrity.sql`（收 2 表写权限 + 补 10 CHECK +
  grant_honey newbie + 作废存量 bonus + bind_invite daily_limit）+ `0036-data-sync-from-cloud.sql`；
  前端配套 `consumeAiQuota` fail-closed（`e1795f4`，弃静默 catch{} 直写 ai_usage 的 fail-open 漏洞）+
  三端 UI token 化（`cbf0077`）。工具 `tools/migration-audit.sh` 固化三类探针（存在性/版本性/可利用性）。
  **执行顺序铁律：先修工具再修数据（P0-3/P0-4 → P0-1 → P0-2），否则镜像重建会冲掉成果**。
  ⚠️ 存量 7 行 `source='newbie'` bonus 处置待拍板（A 作废推荐 / B 补偿保留 / C 连数据清）。
- **合规现状（已核查，优于旧文档记载）**：用户协议/隐私政策/免责声明**三篇已存在且已挂路由**
  （`src/content/legal.ts` 230 行 + `pages/LegalPage.tsx` + `components/SiteFooter.tsx`，备案号走
  `VITE_ICP_BEIAN` 环境变量渲染，未设置时该行不渲染）→ **合规页面工作量 ≈ 0**，只等备案号下来填变量；
  `REDEEM_CODES` 硬编码兑换码**已从 src/ 删除**（Apple 3.1.1 硬伤已消）；`restorePurchases()` 已接（3.1.2 合规）。
  服务端 `redeem_by_code` RPC 仍在，不影响 Apple 审核，Web/Android 端可继续用兑换码运营。
- **额度规则（已定，权威值在 `packages/shared/src/constants/index.ts`）**：`FREE_DAILY_AI=3` +
  `AI_REDEEM_DAILY_LIMIT=2`（每日 3 次免费识别 + 2 次积分兑换 50 分/次，用尽只能 Pro）。新手 150 积分
  （grantHoney 'newbie'）；连续打卡每满 7 天送 2 次识别（grantPhotoBonus 'streak7'，7/14/21 循环）。
  迁移 0025（兑换上限 5→2）+ 0026（newbie 发积分、作废存量 newbie 识别 bonus）。
  ⚠️ `docs/AI成本与配额.md:101`「每天 10 次」**已过时**，按 3+2 重算。
- **识别自动保存（已收敛）**：识别成功即 settleDraft 自动落库；该餐已有记录弹「覆盖/追加/取消」，
  无记录直接落库关闭，另有切页兜底；不做撤销等过度设计。
- **多端小程序**：Taro 4.3.0（React+TS）双工程 + `packages/shared`，微信/支付宝/抖音三端编译通过；
  已一比一复刻主工程 11 页（含 coach / paywall / legal），tsc 0 错。受限能力（支付/健康步数/分享卡 canvas）
  诚实引导占位。`file:` 依赖路径：主工程 `file:packages/shared`、mini `file:../packages/shared`；
  mini tsconfig 需 `moduleResolution:"bundler"`（否则 `@dbee/shared/cloud-sdk` 子路径导不出）。
- **原生 App**：Capacitor 8.5.3；阶段 0 解耦 ✅、Android 全过 ✅；**iOS 首次编译已打通（10-24）并真机测试**
  （origin-proxy / health / iap 三自研 Swift 插件 + @capacitor/camera 均编译通过；三处 iOS 独有 bug 已修，见「iOS 首次真机编译」条）。
  iOS 侧 StoreKit 测试环境已备好（`DbeeProducts.storekit` + 共享 scheme），`cap sync ios` 已重跑 5 插件识别正常。
- **iOS 首次真机编译已打通（10-24）**：根因层层拨开——「权限问题」→「xcrun 路径损坏」→ **真凶 = Xcode 只装了 3.8G 坏壳**
  （完整 Xcode 27 应 ≥15GB，且 `usr/bin/xcrun` 根本不存在；`xcodebuild -version` 报「Xcode 27.1」实为 CLT 随版本号对齐，
  极具迷惑性）。**判定铁律：验证 Xcode 完好 = `du -sh` ≥15GB + `xcodebuild -showsdks` 列出 iphoneos**，不能只看 `-version`。
  删坏壳重装完整 Xcode 后：`cap sync ios`（5 插件）→ SPM 解析 → 编译通过 → 真机功能测试。**三处 iOS 独有 bug 已修**：
  ①拍照无反应（缺 `NSPhotoLibraryAddUsageDescription`，前端 catch 静默吞 reject 掩盖了根因）②拍照后没进识别
  （`resultType:'DataUrl'` 大小写 bug，iOS 精确匹配失败回退 base64，Android 因 toUpperCase 幸免）③Bundle ID 冲突
  （`com.dbee.app` 被抢注 → `cn.dbeehealth.app` 不可用 → 定案 `cn.com.dbee.app`）。**postinstall 自动构建 shared 已落地**（`d3fb8cc`），
  新 clone 一条 `npm ci` 直达，不再漏步。剩余：ASC 配 3 商品 + IAP capability + webhook → iOS 提审。
  正确顺序（已固化入手册）：`npm ci`（含 postinstall 构建 shared）→ `npm run build`（vite）→ `npx cap sync ios` → Cmd+R。
- **健康数据源**：只读系统健康平台，不直连手环；HealthKit 读授权不可探测→插件只报 completed，连接真源=
  云端 health_connected，重连入口常驻「我的>健康数据源」；`effectiveBurnKcal=max(burnKcal,activityKcal)` 不叠加。
  华为 Health Kit 阶段 3a 已落地（前端同构 + DbeeHealth 插件 Android 反射骨架，零 HMS 编译依赖）；
  小米官方数据服务 SDK 已纳入，`src/lib/health/android.ts` 白名单 `{huawei, xiaomi}`（新增 vivo/OPPO 只改白名单）。
  UI 三机型一套（仅 label 与排查路径切换），品牌识别覆盖 HUAWEI/HONOR/HarmonyOS、Xiaomi/Redmi/MI/MIUI/HyperOS。
  资质未就绪时插件返回 `reason=not_ready`，前端提示「接入正在申请资质」。**主体已注册（10-22），
  Android 端企业开发者注册已完成（用户 10-23 告知）**——华为/小米企业入驻可启动。
  ⚠️ 注意区分：**「企业开发者账号已注册」≠「应用已上架华为应用市场」**，而华为 Health Kit 的硬门槛是
  **后者（上架）**，另需软著 + App 备案。所以 Health Kit 数据通道尚未解锁，仍需走上架流程。
- **会员/IAP**：三档 free/pro/lifetime（¥18/¥128/¥328）；Apple 个人开发者账号已通过（10-20）；
  **Android 企业开发者账号已注册（10-23）→ Google Play 支付线解锁**（`payment_orders.provider` 是 text
  且**无 CHECK 约束**，加 `'google'` 无需改表结构，只需补网关验签分支）。
  前端 `checkout()` + `restorePurchases()`（3.1.2 合规）已接；服务端 `0029-iap-verify-receipt.sql`
  **已实测永久作废**（服务器 `pg_available_extensions` 里 `pg_net` 不可用=0，库内外呼方案走不通）→
  Apple 验签**已在网关落地**（`server/lib/iap.mjs` + `0037` 核销迁移，见上方「支付链路」条，10-23 `9e1db43`）。
  **iOS 本地 StoreKit 测试环境已就绪**（`DbeeProducts.storekit` 3 商品 zh_CN 本地化 + 共享 scheme，
  免 ASC 建商品即可测 getProducts/purchase/restore 客户端链路；付费墙已接商店价格拉取 `dfa3191`）。
  剩余步骤：Mac 编译插件 → ASC 配商品（dbee_pro_monthly/yearly/lifetime）→ Xcode 开 IAP capability →
  App Store Server Notifications V2 webhook 指向网关 → iOS 提审。
  ⚠️ **Apple/Google 验签须排在 0034/0035 收权之后**（已满足，0035 已落地收紧写 entitlements 唯一通道=服务端函数）。
- **微信相关**：主体已注册，**暂缓状态可解除**（`src/lib/wechat.ts` 的 `WECHAT_LOGIN_ENABLED=false`
  改回 true 即恢复，10-15 已按「零代码改造」设计）。前置链：微信开放平台企业认证（需营业执照，
  数天–2 周）→ 移动应用 AppID + UnionID → 注入 `VITE_WECHAT_APPID`（iOS 另需
  `VITE_WECHAT_UNIVERSAL_LINK` = 已备案域名 + Associated Domains + apple-app-site-association）→
  改 `NATIVE_CODE_EXCHANGE_SUPPORTED=true`。⚠️ App 内微信登录还有**云端能力缺口**：SDK 的
  `signInWithWechat(code,appid)` 只走小程序 `jscode2session`，移动应用 code 需 `sns/oauth2/access_token`，
  两接口不可混用——自建网关后此缺口可自行补齐（不再受制于云方）。快速兜底 = 路线 B
  （系统浏览器 + 云 Relay 扫码 + Universal Link 回跳，不需移动应用资质，前置仅备案+HTTPS）。
  ⚠️ iOS 的 `WechatOpenSDK` 来自第三方 SPM 镜像 `github.com/yanyin1986/WechatOpenSDK`（腾讯官方不经
  SPM 分发），上线前须核对 tag 或改官方 XCFramework。小程序 appid `wxb7c7122de9c3ab1f` 需做主体变更
  （趁未上线赶紧变，变更会使老用户 openid 失效需重新关联）。
- **下一步（泳道 A 已闭环 ✅，Apple 验签已落地 ✅，iOS 首次真机编译已打通 ✅（10-24），V1.7.1 Web 已发布 ✅（10-26），腾讯云短信 provider 已实现 ✅（10-26 `b54675b`），七项安全修复①③④⑤⑦已落地 ✅（10-27）、①④已部署上线，版本已 bump V1.7.2）**：
  ~~①服务器前置修复~~ ✅ ~~②部署 Node 网关~~ ✅ ~~③deploy-postgrest.sh~~ ✅ ~~④A4 切 nginx + 8 项回归~~ ✅
  ~~⑥Apple 验签落地网关 + 0037 核销~~ ✅（10-23 `9e1db43`，iap-selftest 41 断言全绿）；~~上架前安全体检 ①–⑥~~ ✅（10-26 全部生效）；
  ⑤**A5 Mac mini 首次构建 iOS** ✅（10-24 已编译通过并真机测试，三处 iOS 独有 bug 已修）；
  🔴**七项安全修复（10-27）**：① JWT 强化 ✅（迁移 0042 已落库，access TTL 30min + token_version 强制下线）
  ④ appleSandbox 生产默认关 ✅ —— **①④ 已部署上线 + 端到端验证通过**（线上 access token `ver=1`/`TTL=1800s`、登出后旧 token 立即 401）；
  ③ LLM 视觉 fail-closed 503 + 文本独立降额 50/日 ✅ ⑤ functions.sql 同步 0039 事实验证版 ✅ ⑦ CORS Origin 白名单 ✅
  + email 验证码通道（163 SMTP provider，465/SSL）✅ —— **③⑤⑦+email 代码已就位 + 自测 300/0 全绿，待部署上线**（与①④同批或下次）；
  卡资质：⑥ 万能码切真短信 —— 🟢 **已解锁且链路已入库（`e00387b`）**，只等腾讯云四项凭据到手跑一条命令（见「短信通道切换」条）。
  随后主线（上架前）：**ASC 配 3 商品（`dbee_pro_monthly`/`yearly`/`dbee_lifetime`）+ 开 IAP capability + 填收款 +
  App Store Server Notifications V2 webhook 配指向网关 + 配 APPLE_BUNDLE_ID/SHARED_SECRET/SANDBOX → iOS 提审**；
  资质到货后（公章 10-27 已到手、对公账户 10-28）→ 小程序主体变更 / 短信签约 / 商户号 / ASC 付费协议（iOS 沙盒前提）；
  🔴**上架前未决阻断（见「上架前生产安全体检」条）**：~~①SMS 真短信 provider~~ 🟢 **已解锁（10-27 审核通过，一条命令切换，见「短信通道切换」条）**
  ②5432 收回回环 ③凭据轮换 ④HTTPS+域名解析（四端上架硬阻断，iOS ATS/webhook/微信支付宝抖音合法域名）；
  ⑦~~域名过户个人→企业~~ **✅ 已完成（10-27，WHOIS Registrant = 北京迪蜂科技有限公司）**；ICP 备案主体变更
  （**备案路径已定 = 注销重备**（10-27 `be2267f`；🔴 **备案省份 = 北京**，不在「个人→企业」直接变更白名单；
  ⚠️ 北京管局新规：法人非京籍须**北京居住证或连续 6 个月北京社保**，主体负责人必须为法定代表人
  → **先确认法人户籍材料再提交注销**）；注销后域名停解析、备案期不可加解析，工信部短信核验 **24h 内必做**；
  A4 已做完且 IP 直连验证通过，可随时注销不停业务）；
  ⑧**软著登记**（30–60 工作日，周期最长，越早越好）+ App 备案 + 算法备案；
  ⑨小程序主体变更（**流程已查证、可免公证**，详见上方专条；趁未上线尽早做）；
  ⑩华为/小米企业入驻后替换 dbee-health 插件方法体并真机验收（小米入驻审核已完成 10-26，下一步=运动健康数据服务申请）；⑪分享卡片 O-3 落地（零资质依赖传播抓手）；
  ⑫**实测 D-Bee 自己的 MAPE**（竞品分析最后缺口，文案能否说「准」的依据）；⑬彩页按新定位重写（现基于 V1.4 已落后）；
  ⑭Android 真机复测 V1.7.0 APK（已重打 V1.7.1 vc12 待真机验收，V1.7.2 vc13 已 bump 待重打）；⑮小程序三端真机联调；
  ⑯**可选安全加固**：PG `listen_addresses` 收回回环 / 腾讯云安全组关 5432 入站
  （现状 PG 监听 0.0.0.0，仅靠 pg_hba 白名单兜底，ufw inactive）。
  ⚠️ **老用户迁移三路径待拍板**（推荐 A：判定为开发数据不迁移，小程序与 App 均未上线）。
- **待拍板（原 6 项已全部落定，剩余不阻塞开发）**：①**是否申请 ICP 经营许可证 = 是否现在背 3 人社保**
  （已建议**方案 A：暂不办，先 iOS IAP 验证付费**，等有付费数据再决定）；②Apple 账号先用**个人**上架抢时间
  还是等企业账号（建议**先申请 D-U-N-S 占位**、个人账号推进构建，证下来再决定切不切主体）；
  ③**云库长期去留**（自托管彻底替代 / 回迁 / 双写）；④**老用户迁移三路径**（推荐 A：判定为开发数据不迁移）；
  ⑤**存量 7 行 `source='newbie'` bonus 处置**（A 作废推荐 / B 补偿保留 / C 连数据清，涉及删数据等确认）。
  🔴**新增（10-26 体检，上架前须拍板）**：~~⑥**SMS 真短信通道**~~ 🟢 **已解锁（10-27 审核通过）**：
  切换只剩一条命令（凭据到手即执行），详见「短信通道切换」条；⑦**5432 是否收回回环**（生产链路走回环，无需对外）
  ⑧**凭据轮换**（DeepSeek key / SSH 密码 / dbee_app 密码曾入 git 历史或明文出现）。
  ~~⑨邮箱登录去留~~ → **已落定（10-27）**：接 email 通道（163 SMTP provider `5821dbe`，零依赖 node:tls 手写，465/SSL + 授权码），联系邮箱统一 163（`be2267f`）。
  ~~④经营范围 ⑤注册资本 ⑥对公账户 ⑦小程序主体~~ → **已全部答复**（④⑤✅ 满足、⑥在办下周完成、⑦需变更且流程已查证）。
  长期待办：华为应用市场上架（~~企业认证~~已完成✅ + 软著 + App备案）、营业执照已办结✅。

## 三条主线

1. **开发**：看板即本文件「进度快照」，由自动化「D-Bee 开发进度盘点」每日收敛；细节看当日日志。
2. **备份**：自动化「D-Bee 每日数据备份」产出 `db/backups/YYYY-MM-DD.json`（失败落 `FAILED-YYYY-MM-DD.md`）。
3. **运营**：宣传彩页、技术交流、社群，由自动化「D-Bee 运营事项」每周提醒。

## 已定技术路线（勿再讨论）

Capacitor 8.5.3 混合壳；React18 + Vite5 + TS；appId `cn.com.dbee.app`（**2026-10-24 定案，原 `com.dbee.app` 被 Apple 抢注、
`com.d-bee.app` 因 Android 禁连字符弃用**；域名 `d-bee.com.cn` 与 Bundle ID 是两个独立体系互不影响）；Windows 出 Android、Mac mini M4 出 iOS；
Node≥22 / JDK21 / Xcode≥26。健康数据源只读系统平台（iOS HealthKit / Android Health Connect / 华为 Health Kit
需先上架华为市场 / 小米官方 SDK），详见 `docs/健康数据源方案.md`。

## 架构铁律

1. 平台差异只走 `src/lib/` 抽象层（platform/kv/capture/scan/share）；抽象层运行时探测 `window.Capacitor`，
   **不 import Capacitor 包**（Web 零新增依赖）。
2. `cloudConfig.ts` 零项目内依赖（最早求值），勿引入循环引用。
3. 云端请求走 `OriginProxy` 原生插件（注入 Origin），注入点 = 云 SDK `options.fetch`（`src/cloud.ts`），
   **勿 patch window.fetch**。Origin 钉死三处：lib/originProxy.ts、Java/Swift、Nginx，换域名三处同步。
4. 输入校验走 `src/lib/validate.ts`（过滤→夹回→门禁）；错误文案统一 `src/lib/errmsg.ts`（`zh()`/`errText()`）。

## 云数据库安全铁律（最高优先级）

- 发权益/积分/额度的函数必须 SECURITY DEFINER + 入参白名单；审计用 `pg_get_functiondef` 看真实 DDL。
- 光有函数白名单不够：**涉权益/积分/额度表必须 REVOKE authenticated 的 INSERT/UPDATE/DELETE**（RLS 只限
  「自己的行」，挡不住直写）。已封堵：honey_ledger / entitlements / ai_usage / badges 仅 SELECT；
  拍照额度走预占 token（consume/release）。`isPro`：pro 档缺 `pro_until` 判已过期（防永久会员）。
- 0016 已加 10 条 CHECK 约束（profiles/meal_entries/water_logs/exercise_logs 数值边界）。

## 关键坑（一行版）

endpoint 同源/绝对 HTTPS；`CapacitorHttp.enabled=true` 必开；云 SDK 独占 localStorage（登录态真源，勿用 kv 接管）；
iOS 需 HTTPS；iOS 无 BarcodeDetector→原生 MLKit；SW 在 capacitor:// 不注册；cap sync 撞 safe-delete 守卫→只改
web 资源用 `npx cap copy android`；微信回调 Activity 随 applicationId 改名；图标改后跑 `tools/gen-app-icons.py`；
模拟器网络需沙箱外启动 + captive_portal_mode 0；验收用 `tools/android-cdp.py` + logcat（d-bee-diag / d-bee-origin）；
安全区写 `var(--safe-area-inset-*, env(...))`。
- **cap sync 新插件必踩**：update 阶段撞 safe-delete 守卫（genie-trash ETIMEDOUT）会误删
  `android/capacitor-cordova-android-plugins/` 的 build.gradle + cordova.variables.gradle。首选绕过：先 shell
  `rm -rf android/capacitor-cordova-android-plugins`（shell 删不触发 genie-trash）再 `cap sync`，
  extractTemplate 会重建。兜底三步：解压 `node_modules/@capacitor/cli/assets/capacitor-cordova-android-plugins.tar.gz`
  的 build.gradle、手写 cordova.variables.gradle（模板见 `cli/dist/android/update.js:224`）、在 build.gradle
  的 PLUGIN GRADLE EXTENSIONS 补 `apply from: "cordova.variables.gradle"`。
- **本地插件（file:）两步缺一不可**：①`capacitor.config.ts` 的 `android.includePlugins` 必须列插件名
  ②`npm install` 建 symlink。否则编译过但运行时 `window.Capacitor.Plugins.X` 为 undefined，UI 入口不显示。
  口诀：Gradle 编译过 ≠ 运行时注册（`android/app/src/main/assets/capacitor.plugins.json` 才是真源）。
- **原生拍照/扫码点了没反应**：①`file_paths.xml` 缺 `<external-files-path>` → FileProvider 找不到 root 抛
  IllegalArgumentException；②Manifest 缺 `CAMERA` → getUserMedia 兜底失败、onShowFileChooser 不走授权流程。
- **兑换的拍照额度用不了**：`guardAiQuota()` 不能按「当日拍照次数阶梯」拦截（quota_bonus 不计入次数）；
  唯一依据 `get_photo_quota.total_remaining`（基础+奖励），有额度直接 `consume_photo_quota`；
  photoLadderHint 只用于额度用尽时的引导文案。
- **华为 EMUI/HarmonyOS WebView 忽略 `<input capture>`**：原生端拍照统一走 `@capacitor/camera`
  （鸭子类型探测，不 import 包），web 端保留 `<input capture>`。
- **honey_ledger 唯一索引 `(owner_id, reason, ref_id)` 会把「每日多次」卡成「每日一次」**：ref_id 必须带唯一
  后缀（如 `to_char(clock_timestamp(),'HH24MISSMS')`），单日计数用 `ref_id LIKE 前缀%`；排查「该记录已经存在」
  先查 `pg_indexes` 唯一索引。

### 部署侧坑（10-23 实测，一行版；完整推演见 `2026-10-23.md`）

`CREATE POLICY` 子句顺序硬规定 `AS→FOR→TO→USING→WITH CHECK`（写成 TO…FOR… 语法错）；`GRANT` 是**追加**语义
（要清历史 DELETE 必须先 `REVOKE ALL` 再精确 GRANT）；`BYPASSRLS` = **全库** RLS 失效（`auth.uid()` 为 NULL
时策略完全不参与过滤，未注入身份也能读全部数据；修法是给网关要用的表建 `TO <role>` 专用 policy 后 `NOBYPASSRLS`）；
systemd `StartLimitIntervalSec/Burst` 属 **`[Unit]`** 段（放 `[Service]` 被忽略 + Unknown key 告警，刹车失效）；
V8 服务**勿设** `MemoryDenyWriteExecute`（JIT 要可写可执行内存）；`pg_dump` 必须 `sudo -u postgres`
（`sudo bash -c` 以 root 跑撞 peer 认证），且失败时 gzip **仍留 20 字节空壳** → 加体积守卫 + `gunzip -t`；
**Git Bash ↔ Windows 原生 Python 路径**：设了 `MSYS_NO_PATHCONV=1`+`MSYS2_ARG_CONV_EXCL='*'` 后 `mktemp` 的
`/tmp/…` 被 Python 当成 `C:\tmp` 而 FileNotFoundError，反斜杠 `C:\…` 又被 safe-delete 判 "embedded drive prefix"
拒绝 → 统一 `cygpath -m "$(mktemp)"`；**模板「不得残留」守卫要排除注释行**（`grep -vE '^\s*#'`，否则注释里的
解释性文字被误杀）；paramiko 长任务必设 `set_keepalive(30)`，且 `run_script` **先输出结果再清理远端临时文件**
（顺序反了则清理时的 `open_sftp()` 撞上断连会把已拿到的输出全吞）；`JWT_SECRET`/`IDENT_PEPPER`/`SMS_MASTER_CODE`
存 `deploy/gateway/.secrets.local` 跨部署复用（**改 JWT_SECRET=全员登出，改 IDENT_PEPPER=老用户身份失配**）；
网关与 PostgREST **必须共用同一 HS256 jwt-secret**（否则数据面全 401）；`DBEE_PROD=1` + `SMS_PROVIDER=log`
会被 `config.validate()` 拒启动（短信未采购前只能不设 DBEE_PROD）；🔴 **`DBEE_PROD=1` 会连带把 Apple 收据
收紧为只收 Production**（`appleAllowedEnvs` 默认值依赖 `cfgProd`）→ iOS 沙盒测试期须显式
`APPLE_ALLOWED_ENVS=Sandbox,Production`，否则 StoreKit 沙盒购买验签全失败；配置项要两头对齐（`cfg.dbSsl` 曾在
config.mjs 未定义 → `DBEE_SSL=1` 静默失效）；**env 模板加新占位符必须同步改 `deploy-gateway.sh` 的 sed 注入表**
（否则 `install-gateway.sh` 的 `grep -q '__'` 门禁直接拦下部署；且所有注入值都要过 `esc_sed`，
`#`/`&`/`\` 不转义会**静默**写坏 env）；服务器 PG 17.11 监听 `0.0.0.0:5432`（**公网可达**，非旧记忆的
「仅回环」，靠 pg_hba 白名单兜底、ufw inactive），Node 未预装（apt 仅 v18，项目要 ≥22）→ 官方 tarball +
sha256 钉死 + npmmirror 镜像优先。

## 过审合规

Apple 4.2 / 3.1.1（阶段 3 删 REDEEM_CODES）/ 5.1.1(v) 账号删除 / AI 告知同意；
中国：ICP 备案、App 备案、软著、算法备案、大模型登记、PIPL。

## 工作方式

需求驱动、多轮递进、「写→验→报」小步验证；缺陷/进度类文档用 .docx；跨机同步只走 Git 私有仓库
（`github.com/yutaiyin139/d-bee`，main），两台机器 `core.autocrlf false`；推送失败是常态波动，**for 循环重试 5 次**
勿改方案；收工把进度快照 + 明日待办 + 待拍板写入当日日志。自测脚本 `tools/*-selftest.mjs`
（运行器 `node tools/v15-selftest.run.mjs`）。

## 环境备忘

- SSH 发布：`150.158.51.106` / `ubuntu` / 密码见本地 `.env`（`SSH_PWD`，**勿写入记忆或文档**，
  memory/ 会进 git）；发布脚本 `deploy/deploy.sh`。
- APK 归档 `dist-release/`（gitignore）；Web 归档 `backups/`。
- 云库应用 ID `wbapp_w6iIU6TqTyHvJxESPTxBTy`（genie-baas db_exec_sql，只在已绑定应用的会话可用）。
- curl 本机 dev server 需 `--noproxy '*'`；`package.json` 无测试框架/lint。
- 微营养素：foodsData*.ts 已 10 列化（钠/纤维/添加糖，/100g），1175 条零兜底。
