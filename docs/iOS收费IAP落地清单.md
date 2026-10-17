# iOS 收费（IAP）落地清单与当前状态

> 更新：2026-10-17（V1.6.1 前核查）
> 状态：Apple 开发者账号申请中，收费链路「代码骨架就绪，真实支付未启用」

---

## 一、当前状态（诚实结论）

| 层 | 状态 | 说明 |
|---|---|---|
| 前端 payment 模块 | ✅ 骨架就绪 | `src/lib/payment/`（types / checkout / iosIap）已写好 |
| 原生 StoreKit 2 插件 | ✅ 骨架就绪 | `native-plugins/dbee-iap/DbeeIapPlugin.swift` |
| 服务端订单表/RPC | ✅ 已上云 | `payment_products` + `payment_orders` + 两个 RPC |
| 付费墙 UI 接入 | ❌ 未接入 | PaywallSheet 商品卡片仍是「纯展示」，走兑换码 |
| 凭证验签 | ❌ 未实现 | `verify_payment_order` 骨架默认拒绝 |
| **整体结论** | ⚠️ **不可用** | 真实支付全链路尚未打通，当前唯一解锁方式是兑换码 |

**为什么没接入 UI**：`verify_payment_order` 的服务端验签（verifyReceipt）需要 Apple 开发者账号才能联调，
在此之前硬接 UI 会让用户「点购买一直失败」，体验比现状更差。故保持「兑换码可用 + 商品展示 + 接入中提示」。

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
1. 登录 App Store Connect → 我的 App → 创建 App（Bundle ID `com.dbee.app`）
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
