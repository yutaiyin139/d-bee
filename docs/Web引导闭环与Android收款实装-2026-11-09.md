# Web 引导闭环 + Android 收款实装（2026-11-09 定案与实施）

> **本文是当前收费工作的权威口径**，取代同日两份文档中「Web 办妥 ICP 经营许可证后可独立收款」的中间判断：
> · `docs/四端收款堵点与政策依据详表-2026-11-09.md`（结论 #5 / §4.4）
> · `docs/四端收费一致性核验与合规实施总纲-2026-11-09.md`（§2.5 / 结论 #5 / 阶段 6）
>
> 立项依据（用户 2026-11-09 最终指令，逐字）：
> > 「web端暂不收费，引导进入微信端和app端收费，即可完成所有逻辑；android端支付能力即可完善，达到能够支付收款的目的；4端业务逻辑仍然不变。」
>
> ⚠️ 法规/平台规则部分仅作风险提示与核对清单，不构成法律意见，最终以属地通管局与平台后台答复为准。

---

## 〇、结论先行（决策者只读这 6 条）

1. **四端业务逻辑（定价 / 权益 / 免费额度 / 数据面 / 核销编排）一律不变。** 本轮只补「Android 收款的渠道缺口」与「Web 引导文案」，`checkout.ts` 主流程一行未改，四端共用同一条「下单 → 支付 → 核销」。

2. **Web 暂不收费，且不为收费办证。** Web 只做两件事：展示三档价格 + 明示「网页不收款」，并把访客**引导**到微信小程序 / Android App 内购买。商业闭环由「引导到能收款的端」完成，Web 自身零收款入口、零订单创建。

3. **Android 收款已实装到「代码 + 服务端就绪」。** 微信 APP 支付（V3）+ 支付宝 App 支付（RSA2）双渠道，客户端适配器、网关结算底座（`apppay.mjs`）、数据库迁移（`0047`）全部就位，端到端自检 156 项全绿。

4. **一个构建期开关 `D_BEE_APPPAY_ENABLED` 同决定两端**（默认 `false`）：开 = Android 付费墙出支付按钮 **且** Web 出「去 App 购买」引导；关 = Android 零按钮 **且** Web 零引导字样（terser 死代码折叠，产物实测 0 命中）。**绝不可能出现「Web 引导去 App、进去却买不了」**。

5. **默认构建 = 零引导合规态。** 当前线上/本地默认 `false`，产物中「下载 App」「去 App 内完成下单」「应用商店搜索」等引导字样全部 0 命中，支付按钮折叠为 `wechat:!1,alipay:!1` 永不渲染。要真正开卖，须先满足 §五 的平台前置，再显式 `D_BEE_APPPAY_ENABLED=true npm run build`。

6. **上线收款仍卡外部资质**（非代码问题）：微信 APP 支付需**开放平台移动应用审核通过 + 商户号 + APP 支付权限**；支付宝需**企业应用 + 商户私钥/支付宝公钥**；Android 分发还需 **App 备案下证 + 软著**。资质未到位前保持开关关闭即可，代码不会「假装能收款」。

---

## 一、四端职责矩阵（本轮定案）

| 端 | 是否收款 | 渠道 | 门控开关 | 当前状态 |
| --- | --- | --- | --- | --- |
| **Web（d-bee.cn）** | ❌ **暂不收费** | 无（仅展示价格 + 引导） | `D_BEE_XPAY_ENABLED` / `D_BEE_APPPAY_ENABLED` 控**引导**，不控收款（Web 恒不收款） | 代码就绪；默认零引导 |
| **微信小程序（mini）** | ✅ 可（虚拟支付） | 微信虚拟支付（米大师 xpay） | `D_BEE_XPAY_ENABLED`（默认 false） | 11-08 已实装，本轮不动 |
| **Android** | ✅ **可（本轮实装）** | 微信 APP 支付 V3 + 支付宝 App 支付 | `D_BEE_APPPAY_ENABLED`（默认 false） | **代码+服务端就绪**，卡商户资质 |
| **iOS** | ✅ 可（IAP） | Apple 应用内购买 | 无（跟随 App Store 上架） | 既有，本轮不动 |

> 🔴 **渠道隔离硬约束**（继承 11-08）：Web **不得**成为「小程序虚拟商品」的支付落地页（《微信小程序平台运营规范》2.5.13 / 2.14.7 禁止引导至网站成交）。Web 引导只做**导流**（去微信里打开小程序 / 去应用商店下 App），不在 Web 页面内完成任何支付。

---

## 二、Web 引导闭环（双渠道，独立门控）

### 2.1 唯一配置真源 `src/lib/miniOrderGuide.ts`

名称沿用 `miniOrderGuide` 只是历史沿革，实际已是**双渠道真源**。导出：

- `XPAY_SALE_ENABLED` ← 构建期常量 `__XPAY_SALE_ENABLED__` ← `D_BEE_XPAY_ENABLED`
- `APPPAY_SALE_ENABLED` ← 构建期常量 `__APPPAY_SALE_ENABLED__` ← `D_BEE_APPPAY_ENABLED`
- `canGuideToMiniSale()` = `XPAY_SALE_ENABLED`（小程序渠道引导门）
- `canGuideToAppSale()` = `APPPAY_SALE_ENABLED`（App 渠道引导门）
- `WEB_NO_CHARGE_TEXT`（「网页版仅展示价格，不提供在线支付，也不会通过网页收取任何费用。」，**恒展示，与开关无关**）
- `MINI_ORDER_QR` / `MINI_ORDER_LINK`（小程序码 / URL Link）
- `APP_DOWNLOAD_QR` / `APP_DOWNLOAD_LINK`（App 下载码 / https 链接）
- `sanitizeMiniOrderLink()`（协议白名单纯函数，只放行 https，杜绝 `javascript:` / `data:` 注入；两个渠道链接共用同一实现）

### 2.2 两条渠道独立门控（谁就绪开谁，不互相等待）

`src/components/MiniOrderGuide.tsx` 按 `guide`（小程序）/ `guideApp`（App）分别渲染：

- **两者皆 false（默认）**：只渲染「网页不收款」声明 + 兑换码提示，**零处引导字样**。
- **任一为 true**：追加对应渠道引导，并按已配置凭证择一渲染二维码 / https 链接；两者都未配置时退化为「搜索名称」纯文字，🔴 **绝不渲染点了没反应的死按钮**。

### 2.3 Web 零收款的三层防御（纵深，任一层都足以挡住）

1. **构建期折叠**：`D_BEE_APPPAY_ENABLED=false` → `canGuideToAppSale()` 是布尔字面量 `false` → terser 把整个 App 引导块与支付按钮死代码折叠，产物 grep 0 命中（默认构建探针实测）。
2. **付费墙渠道门**：`setPayChannels(APPPAY_SALE_ENABLED && isAndroid() ? {...} : {wechat:false, alipay:false})` —— **显式 `isAndroid()`**，Web 即便产物带了 `VITE_WECHAT_APPID` 使 `isWechatPayAvailable()` 为 true，也在此排除。
3. **运行时兜底**：`buyProduct` 开头 `if (isWeb() && noPayChannel) { setErr('网页版仅展示价格…'); return }`，Web 无通道直接拦截，**绝不创建订单**（护栏 W6 + 20-C）。

---

## 三、Android 收款实装（本轮核心）

### 3.1 前端：适配器只补「渠道缺口」，不碰业务逻辑

- `src/lib/payment/apppayClient.ts`（新增，177 行）：网关客户端。
  - `requestAppPrepay({orderNo, productId, provider})` → `POST /.cloud/payment/apppay/prepay`
  - `verifyViaApppayGateway(orderNo)` → `POST /.cloud/payment/apppay/query`，**有限重试 4×1500ms**，返回 `true/false/null`（语义与 iOS `verifyViaGateway` 完全对齐：`null` = 通道不可用 → 上层回退 RPC）。
- `src/lib/payment/wechatPay.ts` / `alipay.ts`：`fetchPrepayParams` 接线到 `requestAppPrepay`；支付宝 `resultStatus`：`6001`=取消、`8000`=处理中（**绝不报错**，同微信 settling 防线）、`9000`=成功，其余才 throw。
- `src/lib/payment/checkout.ts`：**唯一改动**是 `adapter.purchase(productId, order.order_no)` —— 把同一笔 `order_no` 传给适配器作平台商户单号，避免孤儿单。主流程「下单→支付→核销」零改动。
- `src/lib/payment/types.ts`：`purchase(productId, orderNo?)` 第二参可选（iOS IAP 忽略，不分叉类型）。
- `src/lib/api.ts`：`verifyPaymentOrder` 加 Android 分支——`platformName()==='android'` 时先走网关查单，`gw!==null` 直接采信，`null` 回退 RPC。
- `src/pages/PaywallSheet.tsx`：删除硬编码 `THIRD_PARTY_CHECKOUT_ENABLED=false`，渠道门改为 `APPPAY_SALE_ENABLED && isAndroid()`。

### 3.2 服务端结算底座 `server/lib/apppay.mjs`（新增，715 行）

与 0046 的 `xpay.mjs`（米大师虚拟支付，`provider='wechat_xpay'`）**并列且互不复用**：本模块是普通商户号的 APP 支付（`provider='wechat'/'alipay'`），两套商户体系。

- **端点**（`server/lib/app.mjs` 装配）：
  - `POST /.cloud/payment/apppay/prepay`（需 Bearer，走 `wrap()`）→ 平台拉起参数
  - `POST /.cloud/payment/apppay/query`（需 Bearer，走 `wrap()`）→ 补发权益
  - `POST /.cloud/payment/wechat-app/notify`（微信直发，**不走 wrap**，自读原始字节验签）
  - `POST /.cloud/payment/alipay/notify`（支付宝直发，**不走 wrap**，form 表单）
  - 两个 notify 路径都加入 `rateLimitExempt`（平台重试不得被 429 放大）。
- **🔴 推模式**：客户端 SDK 成功只代表「用户付完了钱」；**发权益的权威信号 = 服务端异步回调验签通过后 `settle_app_payment`**。prepay 只下单不发权益；notify 才发；query 兜底「回调未到」窗口。
- **零依赖密码学**（项目纪律禁支付 SDK）：全部 `node:crypto` 手写——微信 V3 = RSA-SHA256（商户私钥签名 / 平台证书验签）+ AES-256-GCM（APIv3 密钥解密回调）；支付宝 = RSA2（SHA256withRSA）。签名/验签/解密全部抽成**导出纯函数**，供自检用自造密钥做正/负用例。
- **六条安全边界**：① prepay/query 必带 Bearer（含 token_version 校验）；② 金额/商品以 `payment_orders` 为唯一事实源（客户端只报 `order_no`）；③ 回调验签用平台公钥/证书，失败即 400 且**绝不放行发权益**；④ 回调金额 < 订单金额 → 拒发（防「1 分钱买会员」）；⑤ 幂等键 = `out_trade_no`（UNIQUE）；⑥ 商户私钥/APIv3 密钥绝不下发前端、不进日志。

### 3.3 数据库 `db/migrations/0047-app-payment-settlement.sql`（新增，467 行）

- 表：`app_payment_transactions`（`out_trade_no UNIQUE` = 全服幂等键，`provider CHECK IN ('wechat','alipay')`）、`app_payment_notifications`（回调留痕）。
- 函数（均 `SECURITY DEFINER`，先 REVOKE 再 GRANT 只给 `dbee_app`）：`settle_app_payment`（权益逻辑逐字复用 0046：months 累加 / lifetime 不降级 / 幂等去重）、`revoke_app_payment`（退款，只清同 `source` 渠道权益，不误伤兑换码所得）、`log_app_notification`。
- `verify_payment_order` 改为**查单语义**：对 `provider IN ('wechat_xpay','wechat','alipay')` 未结算恒 `false`（paid 由服务端回调写入，客户端无法伪造），骨架分支仍默认拒绝（未接验签的渠道不得白给会员）。
- `payment_orders`（0021 建）**无 provider CHECK**，故 `wechat`/`alipay` 无需追加迁移即可下单。

### 3.4 配置 `server/lib/config.mjs`

新增 `publicBaseUrl`（`PUBLIC_BASE_URL`，默认 `https://d-bee.cn`，拼 notify_url）、`wechatPay*`（6 项）、`alipay*`（3 项）。`validate()` 硬拦半配（微信 5 项缺一即拦、支付宝 3 项缺一即拦、APIv3 非 32 字节拦、**有商户号缺平台证书拦**——否则回调永远验签不过=资损）；`warnings()` 给未配提示（渠道级 503，不影响另一渠道）。

---

## 四、法务口径同步（`src/content/legal.ts`）

与页面展示**同源同开关**，杜绝「协议说有渠道、页面没按钮」或反之：

- **§六 Android 条**按 `APPPAY_SALE_ENABLED` 分支：
  - 开启态：「会员权益可通过本应用内的微信支付或支付宝一次性购买对应时长，属预付费买断，**不构成自动续期订阅，不自动续费、不自动扣款**，无需取消」（🔴 绝不照抄 iOS「24 小时自动续订」= 虚假宣传）。
  - 关闭态：「当前版本不提供应用内购买，也不通过本应用收取任何费用」。
- **§四 三方 SDK 清单**同样门控：关闭态写微信 SDK「集成但未调用、尚未开放、不收集个人信息」；开启态如实披露「处理订单信息 + 设备标识」，并追加支付宝 SDK 条目（关闭态不列，列了反而失实）。
- 🔴 开启开关前须评估隐私政策 `LEGAL_UPDATED` 是否要刷新（刷新 = 全体老用户重弹同意窗，属产品决策，**不由代码自动改**）。

---

## 五、开启收款的前置清单（🔴 先配平台，再开开关）

默认 `D_BEE_APPPAY_ENABLED=false`。要真正让 Android 收款，须**全部**满足：

**A. 微信 APP 支付（6 项 env）**
- [ ] 微信开放平台「移动应用」审核通过 → `WECHAT_PAY_APPID`
- [ ] 微信支付商户号开通 **APP 支付**权限 → `WECHAT_PAY_MCHID`
- [ ] 商户 API 证书序列号 → `WECHAT_PAY_SERIAL_NO`
- [ ] 商户 API 私钥（PKCS#8）→ `WECHAT_PAY_PRIVATE_KEY`
- [ ] APIv3 密钥（32 字节）→ `WECHAT_PAY_APIV3_KEY`
- [ ] 🔴 微信支付平台证书公钥 → `WECHAT_PAY_PLATFORM_CERT`（缺则回调验签必失败，钱收了发不出权益）

**B. 支付宝 App 支付（3 项 env）**
- [ ] 支付宝开放平台企业应用 → `ALIPAY_APP_ID`
- [ ] 应用私钥（PKCS#8）→ `ALIPAY_PRIVATE_KEY`
- [ ] 支付宝公钥 → `ALIPAY_PUBLIC_KEY`

**C. 服务端部署**
- [ ] `0047` 迁移应用到生产库（`SELECT max(version) FROM public.schema_migrations` = 0047）
- [ ] `apppay.mjs` + `app.mjs` 新路由部署到网关（🔴 走手术式脚本，**绝不跑 `deploy-gateway.sh`**）
- [ ] `PUBLIC_BASE_URL` = `https://d-bee.cn`（notify_url 平台可回达）
- [ ] 微信商户平台 / 支付宝后台配置回调 URL（与 `apppay.mjs` 拼接路径逐字一致）

**D. 分发资质**
- [ ] App 备案下证
- [ ] 软著（微信/支付宝商户入驻、部分应用市场上架需要）
- [ ] `VITE_APP_DOWNLOAD_LINK` 或 `VITE_APP_DOWNLOAD_QR`（Web 引导凭证；不配则退化为「应用商店搜索」纯文字）

**E. 联调**
- [ ] 真机 1 分钱全链路联调（下单 → 拉起 → 回调 → 到账 → 退款撤销）通过

**开启命令**（Web + Android 资源）：`D_BEE_APPPAY_ENABLED=true npm run build`；原生包 `D_BEE_APPPAY_ENABLED=true npm run native:sync`（🔴 同一变量，两端必然同值）。

---

## 六、验证结果（本轮实测）

- `npm run typecheck`：全过（0 error）。
- `npm test`：**18 文件 / 839 项全绿**（Test Files 数 == 文件数，串行无假绿）；较基线 16/731 新增护栏 20（78 项）+ 护栏 19 扩至 29 项。
- `node tools/apppay-selftest.mjs`：**156 项全绿**（自造 RSA 密钥做正/负用例，覆盖密码学纯函数 + 真实 HTTP 端到端 prepay/notify/query）。
- 回归自检：`gateway-selftest` 303 项、`xpay-selftest` 96 项、`iap-selftest` 47 项全绿（app.mjs 新增 apppay 装配未破坏既有链路）。
- **红验证**（项目铁律，证明断言真能抓缺陷）：
  - 护栏 20：Web 渲染支付按钮 → 2 红；删金额校验 → 1 红；notify 走 wrap → 1 红；查单失败改报错 → 1 红。
  - 护栏 19：付费墙去开关门控 → 1 红；legal 无条件披露 → 1 红；0047 标记已应用 → 1 红；env key 改名 → 2 红。
  - apppay-selftest：绕过微信验签 → 7 红；删金额校验 → 4 红；查单失败改报 500 → 2 红。
  - 全部注入缺陷后文件已逐字恢复（`diff -q` 校验）。
- **默认构建探针**（`npm run build`，🔴 不用 `build:web`——它会删掉 `dist/legal/`）：App 引导字样 0 命中、小程序引导 0 命中、支付按钮折叠为 `wechat:!1,alipay:!1`（`wechat:!0` 零命中）、Web 不收款声明「网页版仅展示价格」3 命中、兑换码提示保留 —— **默认零引导合规态**成立。入口 js `index-HoMGJbqY.js`。
- 🔴 **验收口径修正（本轮实测发现，务必照此判读）**：旧判据「产物 `下单` 字样 = 0」**自本轮起失效**。原因是 `apppayClient.ts` 的技术性错误文案含「**预**下单」（「支付响应缺少预下单参数」「微信/支付宝预下单参数不完整」），使裸串 `下单` 在 Web 产物中恒为 **3 命中**（`预下单` 3 / 独立 `下单` **0**，差值为 0 可自证）。
  - 正确判据改为：**真实引导 CTA 全 0** —— `去小程序下单` / `去 App 购买` / `立即购买` / `立即开通` / `去支付` / `前往小程序` 逐项 0 命中（本轮实测均为 0）。
  - 或等价地用差值：`count('下单') - count('预下单') == 0`。
- 📌 **Web 产物含 apppay 客户端代码 = 既有架构属性，非本轮缺陷**：`src/lib/api.ts` 静态 import `verifyViaApppayGateway`，故 `/.cloud/payment/apppay/{prepay,query}` 端点串会进 Web 包；但 iOS 通道 `/.cloud/payment/apple/verify` **同样**在 Web 包内（早于本轮即如此）。这些代码在 Web 上**不可达**：调用点包在 `platformName() === 'android'` 内，且原生 SDK（`window.Capacitor.Plugins.*`）在浏览器恒不存在。**凭据零泄漏已验证**（私钥 / APIv3 密钥均不进产物，护栏 20-H + 自检 F 节）。判定 Web 是否可收款，看**支付按钮是否渲染 + 运行时兜底是否拦截**，不看端点串是否出现。

---

## 七、护栏覆盖（跨端一致性机器断言）

- **护栏 18 `web-no-payment.test.ts`**（36 项，既有）：Web 定价页零收款 / 零下单 / 零 `<button>`、引导同源、URL 协议白名单。本轮 `THIRD_PARTY_CHECKOUT_ENABLED` 已删，W 系断言不受影响（未依赖该常量）。
- **护栏 19 `release-readiness.test.ts`**（29 项，本轮改写 19-B/19-C）：19-B 加 0047 水位 + APP 支付 9 env key 登记校验；19-C 从「钉死 `THIRD_PARTY_CHECKOUT_ENABLED=false`」改为「门控值 ↔ 法务口径 ↔ 实装登记三者一致」。
- **护栏 20 `apppay-consistency.test.ts`**（78 项，新增）：20-A 业务流程不变 / 20-B 开关同源 / 20-C Web 恒不收款 / 20-D 资损防线（金额·验签·幂等·归属）/ 20-E 已扣款绝不报错 / 20-F 路由装配 / 20-G 数据库幂等键·权限 / 20-H 凭据边界。

---

## 八、本轮改动文件清单

**新增**
- `src/lib/payment/apppayClient.ts`（177）· `server/lib/apppay.mjs`（715）· `db/migrations/0047-app-payment-settlement.sql`（467）
- `tools/apppay-consistency.test.ts`（481，护栏 20）· `tools/apppay-selftest.mjs`（919）
- `tools/release-readiness.test.ts` + `tools/release-readiness.baseline.json`（护栏 19，本轮首次入库）
- `docs/四端收款堵点与政策依据详表-2026-11-09.md` · `docs/四端收费一致性核验与合规实施总纲-2026-11-09.md` · 本文

**修改**
- `vite.config.ts`（注入 `__APPPAY_SALE_ENABLED__`）· `src/globals.d.ts`（声明常量）
- `src/lib/miniOrderGuide.ts`（`APPPAY_SALE_ENABLED` / `canGuideToAppSale` / App 下载凭证）
- `src/components/MiniOrderGuide.tsx`（双渠道引导）· `src/pages/PaywallSheet.tsx`（渠道门改开关+isAndroid）
- `src/pages/PricingSheet.tsx` · `src/content/membership.ts` · `src/content/legal.ts`（§六 Android 条 + §四 SDK 清单门控）
- `src/lib/payment/{types,checkout,wechatPay,alipay}.ts` · `src/lib/api.ts`（Android 核销分支）
- `server/lib/config.mjs`（APP 支付配置 + 校验）· `server/lib/app.mjs`（apppay 路由装配 + 限流豁免）
- `mini/src/content/legal.ts` · `tools/web-no-payment.test.ts` · `tools/gateway-selftest.mjs`（配齐基线加 APP 支付凭据）
- `.env.example`（两个构建开关说明）· `deploy/gateway/gateway.env.template`（APP 支付 9 env 段）
- `docs/Web端定价展示与小程序下单-现状梳理与改造方案-2026-11-07.md`（历史快照补注）

---

## 九、未决 / 后续

- 🟠 **开启收款**：待微信开放平台移动应用审核 + 商户号 APP 支付权限 + 支付宝企业应用 + App 备案下证 + 软著。资质到位前开关保持 `false`。
- 🟠 **legal `LEGAL_UPDATED` 是否刷新**：开卖会改 SDK 清单与 Android 条，刷新则全体老用户重弹同意窗——产品决策，未擅自改。
- 🟠 **iOS 包需 Mac 重打**才含 A-5 真删号 + 本轮改动（外部资质链，见 iOS 上线依赖全景文档）。
- 📌 本文与两份 11-09 文档的关系：本文 = 当前权威；两份旧文档正文按历史快照保留，仅在头部加横幅指向本文（不改正文，保决策溯源）。
