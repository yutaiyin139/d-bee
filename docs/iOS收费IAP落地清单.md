# iOS 收费（IAP）落地清单与当前状态

> 更新：2026-10-23（V1.7.0，Apple 个人开发者账号已通过）
> 状态：**服务端验签已在 Node 网关落地**（0029 pg_net 方案作废，10-22 决策 #6）；
> 剩 Mac 侧硬步骤 + 0037 迁移执行 + 网关 env 配置。

---

## 一、当前状态（诚实结论）

| 层 | 状态 | 说明 |
|---|---|---|
| 前端 payment 模块 | ✅ 就绪 | `src/lib/payment/`（types / checkout / iosIap）已写好，含 `restorePurchases` |
| 前端核销通道 | ✅ 已切网关 | `api.ts verifyPaymentOrder`：iOS 优先 `POST /.cloud/payment/apple/verify`（Bearer），网关不可用回退 RPC |
| 原生 StoreKit 2 插件 | ✅ 骨架就绪 | `native-plugins/dbee-iap/DbeeIapPlugin.swift`（未在 Mac 编译验证） |
| 服务端订单表/RPC | ✅ 已上云 | `payment_products` + `payment_orders` + 下单 RPC |
| 付费墙 UI 接入 | ✅ 已接线（2026-10-20） | PaywallSheet 商品卡片可点击接 `checkout`，iOS 加「恢复购买」 |
| 凭证验签 | ✅ **网关已实现** | `server/lib/iap.mjs`（verifyReceipt 沙盒/生产自动切换 + bundle_id 钉扎 + transaction_id 全服幂等）；落库走 0037 definer 函数 |
| 订阅 webhook | ✅ **V2 端点已实现** | `/.cloud/payment/apple/notifications`（x5c 证书链钉扎；SUBSCRIBED/DID_RENEW 续订、REFUND/REVOKE 撤销、全量留痕） |
| 自测 | ✅ 41 项全过 | `tools/iap-selftest.mjs`（mock pool + mock Apple + 注入式 JWS 验签，真 HTTP 报文断言） |
| **整体结论** | ⚠️ **代码链路完整，待部署** | 上线前置：服务器执行 0037 + 网关 env 配 `APPLE_BUNDLE_ID`/`APPLE_SHARED_SECRET` + Mac 侧硬步骤（见发布梳理文档 §九B） |

**2026-10-23 进展**：Apple 验签从数据库迁到 Node 网关。0029（pg_net 外呼）因服务器
PG17.11 无 pg_net 扩展**永久作废**（schema_migrations 已标 void）。替代实现：
网关 `server/lib/iap.mjs` 负责与 Apple 对话（验签/JWS 证书链），数据库迁移
`0037-apple-iap-settlement.sql` 负责与钱有关的状态（`apple_transactions` 幂等表 +
`apple_notifications` 留痕表 + `settle/revoke/log` 三个 definer 函数，EXECUTE 仅授
dbee_app，前端角色三层全堵）。客户端 `verifyPaymentOrder` 在 iOS 上改走网关端点。

---

## 二、Apple 开发者账号下来后，按顺序做 5 步

### 第 1 步：Mac mini 上编译两个 Swift 插件
```
cd zilv-mifeng
npm install            # 拉 @dbee/iap、@dbee/health 本地依赖
npx cap sync ios       # 同步 web 资源 + 插件到 iOS 工程
```
用 Xcode 打开 `ios/App`，确认 `dbee-iap`、`dbee-health` 两个 SPM 包编译通过。
（这两个插件当前只在 Windows 上写了骨架，从未编译，首次构建大概率要修编译错误。）

### 第 2 步：App Store Connect 配商品
1. 登录 App Store Connect → 我的 App → 创建 App（Bundle ID `cn.dbeehealth.app`，与工程 `capacitor.config.ts` 一致；⚠️ 原 `com.dbee.app` 已被抢注弃用，2026-10-25 更正）
2. **订阅组 + 商品**：配置 3 个商品，Product ID 必须与代码一致：
   - `dbee_pro_monthly`（自动续期订阅，¥18）
   - `dbee_pro_yearly`（自动续期订阅，¥128）
   - `dbee_lifetime`（非消耗型买断，¥328）
3. **协议、税务、银行**：填银行收款信息（收款的硬前提，不填无法测真支付）

### 第 3 步：Xcode 开启 In-App Purchase capability
- Signing & Capabilities → 添加 `In-App Purchase`（与已加的 HealthKit 并列）
- 选正确的 Team（开发者账号）

### 第 4 步：服务端填 verifyReceipt（核心，当前唯一的「拒绝」）
在 `verify_payment_order` RPC 里补 `provider = 'apple'` 分支：
- 用 App Store 的 `verifyReceipt` 接口校验收据（receipt base64）
- 校验通过 → 标记订单 paid + 写 entitlements（pro 顺延 / lifetime 买断）
- 校验失败 → 返回 false（不写权益）
- 需存 App Store Connect 的 `sharedSecret`（订阅专用）

### 第 5 步：前端把 checkout 接到 PaywallSheet
- 商品卡片从「纯展示」改为可点击，点击 → `checkout(productId, refresh)`
- 走「下单 → StoreKit 购买 → 回传凭证核销 → 刷新权益」四步
- 订阅需处理「恢复购买 restore」入口

---

## 三、订阅特有的服务端工作（iOS 独有，其他端没有）

订阅有续期/过期/退款，苹果会**异步推送**给你服务器，需要单独接收端：

| 通知类型 | 处理 |
|---|---|
| SUBSCRIBED / DID_RENEW | 发权益 / 顺延 pro_until |
| EXPIRED / DID_FAIL_TO_RENEW | 到期回落 free |
| REFUND | 回收权益 |

这是 `App Store Server Notifications V2`，需要一个新的 webhook 接收函数，是唯一不能靠统一核销覆盖的部分。

---

## 四、合规红线（提审前必看）

1. **Apple 3.1.1**：iOS 数字商品（会员）必须走 IAP，**兑换码方案提审前要删除**（3.1.1 禁止绕过 IAP 的兑换码）。
2. 抽成：首年 30%，次年 / 中小开发者 15%。
3. 订阅必须提供「恢复购买」和「管理订阅」入口（否则 2.1 / 3.1.2 被拒）。
