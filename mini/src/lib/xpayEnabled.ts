/**
 * 小程序「虚拟支付售卖能力」的唯一开关（构建期决定）。
 *
 * ## 为什么是构建期开关，而不是运行时探测服务端
 *
 * 售卖能力一开，**付费墙展示价格**与 **legal.ts 法务口径**必须同时变
 * （见 `mini/src/content/legal.ts` §一：此前写的是「免费提供、不销售任何商品
 * 或服务、不涉及在线支付」）。微信小程序审核会核「页面展示内容与隐私政策/
 * 用户协议是否一致」，两者不同步 = 可判驳回项。
 *
 * 若用「运行时问服务端凭据配没配」来决定文案，法务文本就会随网络结果漂移：
 * 同一次构建的包，在服务端 503 时显示「免费提供」、200 时显示「收费售卖」，
 * 而用户已经同意过的那份协议是**构建时确定的字符串**。故开关必须落在构建期，
 * 让「这一个包卖不卖钱」成为不可变事实。
 *
 * ## 默认关闭（当前状态）
 *
 * 未设 `D_BEE_XPAY_ENABLED=true` 时，本模块恒返回 false：
 *   · 付费墙只展示兑换码入口，不渲染任何价格与购买按钮；
 *   · legal.ts 保持「免费提供」口径；
 *   · 与 2026-11-02 的整改状态一致，构建出的包可安全发布。
 *
 * 这与 `./backend.ts` 的 `D_BEE_SELFHOST_READY` 是同一思路：**默认安全值 +
 * 显式二次确认**，避免「以为开了其实没开 / 以为没开其实开了」的包被发出去。
 *
 * ## 🔴 开启前置条件（缺一不可，与 backend.ts 的 throw 清单同理）
 *
 * 代码侧（本仓已就绪）：
 *   ① `db/migrations/0046-wechat-xpay-settlement.sql` 已应用到生产库
 *      （session_key 密文列 + settle/revoke/log 三个 SECDEF 函数）；
 *   ② 网关已部署含 `server/lib/xpay.mjs` 的版本，路由
 *      `/.cloud/payment/wechat/{params,query,notify}` 可达；
 *   ③ 服务端 env 已配齐：`XPAY_OFFER_ID`、`XPAY_APP_KEY`（env=1 还需
 *      `XPAY_SANDBOX_APP_KEY`）、`XPAY_PUSH_TOKEN`、`XPAY_PUSH_AES_KEY`、
 *      `WECHAT_SESSION_ENC_KEY`（缺它 → params 恒 503，见 xpay.mjs 的 configured()）。
 *      🔴 加 env 一律走 `deploy/apply-vision-key-update.py` 的手术式机制，
 *      **绝不跑 `deploy/deploy-gateway.sh`**（缺 IDENT_PEPPER 会重置 → 全站身份永久失效）。
 *
 * 微信平台侧（非代码，需人工在 mp 后台操作）：
 *   ④ 小程序已开通「虚拟支付」并完成二级商户进件（否则 -15008）；
 *   ⑤ 三档道具已在「虚拟支付 → 道具管理」创建并**发布**，productId 必须与
 *      `PRODUCT_IDS` 逐字一致（dbee_pro_monthly / dbee_pro_yearly / dbee_lifetime），
 *      价格与 `payment_products.amount_cents` 一致（1800 / 12800 / 29800 分）。
 *      未发布 → -15010；刚发布未生效 → -15014（约 10 分钟）；价格不符 → -15013。
 *   ⑥ 「消息推送」已配置：URL = `https://d-bee.cn/.cloud/payment/wechat/notify`，
 *      Token/EncodingAESKey 与服务端 env 同值，数据格式与加解密方式须与
 *      `XPAY_PUSH_*` 的口径一致（明文模式验 signature，安全模式验 msg_signature + AES）。
 *      🔴 发货推送必须在后台**开启**，否则扣款成功也收不到权益发放信号。
 *
 * ④⑤⑥ 任何一条未就绪时开启本开关，用户会在点击购买后撞到 -15008/-15010/-15014
 * 这类平台错误码（`./xpay.ts` 已把它们翻译成可读文案，但仍属「功能不完整」），
 * 且法务口径已改成收费 —— 这是审核驳回 + 用户投诉的双重风险。**先配平台，再开开关。**
 */

/**
 * 是否在构建期开启了虚拟支付售卖能力。
 *
 * @param env 开关值，默认从 `process.env` 读（构建期由 `mini/config/index.ts`
 *            的 defineConstants 替换成字面量）。显式传参仅用于测试。
 */
export function isXpaySaleEnabled(
  env: { enabled?: string } = { enabled: process.env.D_BEE_XPAY_ENABLED },
): boolean {
  return (env.enabled ?? '').trim().toLowerCase() === 'true'
}

/**
 * 构建期求值的结果常量（付费墙与 legal.ts 共用同一判定，杜绝两处各算一次而漂移）。
 *
 * 🔴 顶层求值 = 构建期字面量，产物里可直接 grep 到实际开关值，便于核对
 *   「发出去的包到底卖不卖钱」（与 `BACKEND_KIND` 同理）。
 */
export const XPAY_SALE_ENABLED: boolean = isXpaySaleEnabled()
