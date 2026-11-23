# B11 · Android 真机 1 分钱验收 Runbook（用户本人执行 · 铁律 #13 最终清偿）

> 目标链：支付宝 App 支付单渠道（微信 APP 支付并行慢办，未就绪时按钮自动隐藏＝诚实降级）
> 目标包：**vc32**（须 B9 重打后生成；本文件不预设 sha256，打完包从基线 `apk` 段逐字抄入）
> 前置：**B2 迁移 0046→0047 已应用 + B3 网关 5 文件已部署 + B8 三键已配 + B9 vc32 已重打 + B10 selftest 已跑过**
> 🔴 **本文是验收清单，零生产变更**。任一 FAIL 都不要自行改代码/改库，先记录现象回来定位。
> 判据口径全部对齐 `server/lib/apppay.mjs`、`db/migrations/0047-app-payment-settlement.sql`、`tools/apppay-selftest.mjs`，不自造语义。

---

## 〇、为什么是 7 项判据（缺一不可）

| # | 判据 | 防的是什么事故 | 代码依据 |
|---|---|---|---|
| 1 | 下单返 `orderStr` 且可用**应用公钥**验签 | 私钥配错/签名串被篡改 → 下单静默失败 | `apppay-selftest.mjs:466` |
| 2 | 原生收银台**真的弹出** | vc32 dex 未含 `com/dbee/alipay` 或 `com/alipay/sdk` → 按钮点了没反应 | `alipay.ts` `getPlugin()` |
| 3 | 支付宝异步通知**验签通过**并落 `success` | `ALIPAY_PUBLIC_KEY` 填成应用公钥 → 验签必失败＝**付了钱拿不到会员（资损级）** | `apppay.mjs:616-636` |
| 4 | 权益到账且金额/商品一致 | 金额被篡改仍发货、商品串档 | `0047` `verify_payment_order` |
| 5 | 退款 → `revoke_app_payment` 生效 | 只发货不撤销 → 退款后白嫖会员 | `0047:289-335` |
| 6 | 重复回调**不重复顺延** | 幂等键错 → 会员时长被翻倍顺延 | `apppay-selftest.mjs:591` |
| 7 | `8000`/`WAIT_BUYER_PAY` **绝不报 error** | 处理中态可能已扣款，误报失败会诱导用户重复支付 | `apppay-selftest.mjs:759-760` |

---

## 一、执行前准备（PC，5 分钟）

### 1.1 装包前校验（防装错包）
```bash
cd /c/Users/yuty/WorkBuddy/2026-10-13-09-29-42/zilv-mifeng
sha256sum release/<vc32 文件名>          # 判据：逐字等于 tools/apk-distribution.baseline.json 的 apk.sha256
stat -c%s release/<vc32 文件名>           # 判据：逐字等于 apk.bytes
```
🔴 `release/` 与 `dist-release/` 有多个归档包，**只有基线 `apk.file` 登记的那个可装**。装错包＝整轮作废。

### 1.2 确认生产状态（只读，不改任何东西）
```bash
# ① 端点已部署且凭据已配：期望 200/业务响应，绝不能再是 404 或 503
curl -sS -o /dev/null -w "apppay/prepay -> HTTP %{http_code}\n" \
  -X POST https://d-bee.cn/.cloud/payment/apppay/prepay -d '{}'

# ② 迁移已应用（SSH 到生产后执行）
#    sudo -n -u postgres psql -d dbee -Atc \
#      "SELECT version,status FROM public.schema_migrations WHERE version IN ('0046','0047') ORDER BY version;"
#    期望两行 0046|applied / 0047|applied

# ③ env 键齐备（只看键名，绝不 cat 值）
#    sudo -n grep -oE '^[A-Z_]+=' /etc/dbee/gateway.env | grep -E 'ALIPAY|PUBLIC_BASE'
#    期望 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY 三键全在
```

### 1.3 测试账号与金额
- 用**真实手机号 + 真实支付宝**的小额账号，不要用生产主账号。
- 🔴 **1 分钱必须走「沙箱/测试商品」或临时改价，不要动 `payment_products` 生产三档价**（`1800/12800/29800` 是权威值，改了必须改回并复核）。
- 若无法改价，则按 ¥18 月卡实付，验完立刻走退款（判据 5 本就要验退款）。

---

## 二、真机 7 步验收（逐项打勾，任一 FAIL 即停）

| 步 | 操作 | ✅ 判据 | ❌ FAIL 时记什么 |
|---|---|---|---|
| **1** | 打开 App → 登录 → 进入定价页 → 点「¥18 月卡」 | 网络面板可见 `POST /apppay/prepay` 返回 **200** 且 body 含非空 `orderStr`；用应用公钥验签通过 | HTTP 码、body 前 200 字、是否 503（env 半配）|
| **2** | 观察是否弹出**支付宝收银台**（不是浏览器页、不是 App 内 H5） | 原生收银台出现，商户名/金额显示正确；`adb logcat` 无 `DbeeAlipay not found` | 是否完全无反应、logcat 关键行 |
| **3** | 在支付宝完成付款（1 分钱或 ¥18） | 服务端日志出现 `alipay/notify` 且响应 `success`；`app_payment_notifications` 落一行 `event=pay_notify` | 是否 400/验签失败、平台重试次数 |
| **4** | 回到 App → 刷新会员状态 | 会员生效、到期日 = 购买日 + 1 月；`app_payment_transactions` 落一行且 `total_amount`/`product_id` 与订单一致 | 金额不符＝立即中止（可能资损）|
| **5** | 在支付宝商户后台对这笔单**发起退款** | `revoke_app_payment` 生效：交易行 `revoked=true` / `revoked_reason='refund'`，订单 `status='refunded'`，会员回落 free | 未回落＝严重缺陷，别再继续 |
| **6** | 让平台**重发同一笔回调**（或用 selftest 的重复推送用例） | `settle` 幂等键 = `out_trade_no`；到期时间**未被二次顺延**（before==after） | 顺延了＝金额/时长错乱 |
| **7** | 构造 `8000` / `WAIT_BUYER_PAY` 态（支付宝「处理中」或 selftest 用例） | 前端**不弹 error**、显示「处理中/待确认」；服务端留痕 `event=WAIT_BUYER_PAY`、回 `success`、**零 settle** | 报 error／诱导重复支付＝阻断上线 |

🔴 **判据 7 是资损红线**：`8000`（支付宝「正在处理中」）可能已经扣款，前端若当作失败并允许用户重试，会造成**重复扣款**。代码口径见 `apppay.mjs:636`「只处理交易成功；WAIT_BUYER_PAY / TRADE_CLOSED 留痕回 success（不重试）」。

---

## 三、B10 服务端自测（真机前后各跑一次，留证）

```bash
cd /c/Users/yuty/WorkBuddy/2026-10-13-09-29-42/zilv-mifeng
node tools/apppay-selftest.mjs 2>&1 | tee /tmp/apppay-selftest-$(date +%Y%m%d).log
```
- 判据：**全绿**，尤其 C 节「重复回调幂等」、D 节「WAIT_BUYER_PAY 零 settle」、E 节「退款订单再下单 → 409」。
- 🔴 **`npm test` 只收 `*.test.ts`，`.mjs` 门禁覆盖为 0** —— 必须手工跑并把输出贴进当日 memory（铁律 #13 留证）。

---

## 四、留证回写模板（贴进 `.workbuddy/memory/YYYY-MM-DD.md`）

```
## B11 真机 1 分钱验收（<日期> <时间>）
- 包：<vc32 文件名> / sha256 <值> / bytes <值> / versionCode 32
- 设备：<机型> / Android <版本>；支付宝 <版本>
- 订单号 out_trade_no：<值>；实付：<金额>
- 判据 1 下单 orderStr：PASS/FAIL（证据：<HTTP 码 + 验签结果>）
- 判据 2 原生收银台：PASS/FAIL（证据：<截图/logcat>）
- 判据 3 回调验签落痕：PASS/FAIL（证据：<通知表行数 + event>）
- 判据 4 权益到账金额一致：PASS/FAIL（证据：<交易行 + 会员到期日>）
- 判据 5 退款撤销：PASS/FAIL（证据：<revoked/status/plan_now>）
- 判据 6 重复回调幂等：PASS/FAIL（证据：<before==after>）
- 判据 7 8000 不报 error：PASS/FAIL（证据：<前端文案 + 留痕 event>）
- B10 selftest：<全绿/失败项>
- 结论：可开 B12 总闸 / 阻断（原因）
```

---

## 五、通过后才能做 B12

🔴 7 项全绿 + B10 全绿后，才可把 `D_BEE_APPPAY_ENABLED=true` 并**Web + Android 两端同批发版**（该开关同时决定「Android 出按钮」与「Web 定价页引导去 App 购买」，不同批＝虚假宣传）。

🔴 未通过前一律保持 `false`，前端诚实降级不产假按钮 —— 这是项目铁律，不是缺陷。

---

## 六、红线（继承，一条不减）

- 🔴 绝不跑 `deploy-gateway.sh`（缺 `IDENT_PEPPER` → 全站身份永久失效）。
- 🔴 `ALIPAY_PUBLIC_KEY` 是**支付宝公钥**，不是应用公钥；填错＝资损级。
- 🔴 凭据只进 `/etc/dbee/gateway.env`，不入库、不进日志、不下发前端、不写进本文档。
- 🔴 本机 `node --check` / selftest 绿 ≠ 生产绿 ≠ 真机绿，三层证据都要留。
- 🔴 任何 FAIL 先记录现象，不要自行改代码或手工改库补权益（会破坏幂等证据链）。
