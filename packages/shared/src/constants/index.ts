/**
 * 会员与配额的核心常量（多端共用真相源）。
 *
 * 这是「单一真相源」：任何端（Web / iOS / Android / 微信 / 支付宝 / 抖音）
 * 都从这里引用同一份数值，禁止在各自工程里硬编码副本。
 */

/** 免费用户每日 AI 拍照识别基础次数 */
export const FREE_DAILY_AI = 3

/** 免费用户每日可用积分兑换的「AI 拍照识别」次数上限（50 积分/次） */
export const AI_REDEEM_DAILY_LIMIT = 2

/** 免费用户饮食报告可回看天数 */
export const FREE_REPORT_DAYS = 7

/** 会员饮食报告可回看天数 */
export const PRO_REPORT_DAYS = 30

/* ── 奖励规则 ───────────────────────────────────────────── */
// 产品规则（2026-10-19 调整）：每日严格「3 次免费识别 + 2 次积分兑换」。
//   - 新手完善资料 → 发 150 蜜糖积分（积分只能兑换识别，受每日 2 次上限约束）。
//   - 连续打卡 7 天 → 直接送 2 次识别（每满 7 天循环发放，7/14/21…各送 2 次），
//     少一次「兑换」点击，直接到账。
export const STREAK_BONUS_DAYS = 7 // 连续打卡每满 N 天触发一次奖励
export const STREAK_BONUS_AMOUNT = 2 // 连续打卡每满 7 天送的识别次数
export const NEWBIE_BONUS_AMOUNT = 150 // 完善资料新手奖励积分（= 3 次识别）
export const BONUS_TTL_DAYS = 7 // 识别次数奖励有效期（防囤积）

/** 消耗额度的 feature 标识（ai_usage.feature） */
export const SCAN_FEATURE = 'scan'

/* ── 免费版权益文案（P2-D，多端付费墙共用）───────────────── */
/**
 * 「永久无广告」—— 把竞品当作付费权益的东西，D-Bee 当免费卖点。
 *
 * 🔴 这是**对外承诺**，不是营销修辞。成立的依据（2026-11-03 全仓核实）：
 *   · 两端 package.json / project.config.json / src/ / mini/src/ 中
 *     admob|pangle|穿山甲|gdt|优量汇|unityads|adsense 以及小程序
 *     createRewardedVideoAd/createInterstitialAd/createBannerAd **零命中**；
 *   · mini/src/content/legal.ts 已公示「不含广告、不诱导付费、无隐藏扣费」；
 *   · src/content/legal.ts:222 已公示开源组件「不含广告追踪与用户画像能力」。
 * 将来若真要接入任何广告变现，**必须先删掉这条常量并同步改法务文本**，
 * 否则构成虚假宣传（且小程序端会与 legal.ts 公示直接冲突）。
 */
export const FREE_NO_ADS_ITEM = '永久无广告、无隐藏扣费'

/* ── 定价（单位：元；最终以支付平台商品为准）────────────────── */
export const PRICE_PRO_MONTHLY = 18
export const PRICE_PRO_YEARLY = 128
export const PRICE_LIFETIME = 298

/** 订阅档位商品 ID 约定（App 内购 / 微信 / 支付宝共用） */
export const PRODUCT_IDS = {
  proMonthly: 'dbee_pro_monthly',
  proYearly: 'dbee_pro_yearly',
  lifetime: 'dbee_lifetime',
} as const

export type ProductId = keyof typeof PRODUCT_IDS

/* ── 蜜糖积分兑换价格表（单位：分）────────────────────────────── */
export const HONEY_PRICE = {
  pro1Day: 100, // 100 分 = Pro 1 天
  pro30Day: 2600, // 2600 分 = Pro 30 天
  ai1Scan: 50, // 50 分 = AI 拍照 1 次
} as const

export type HoneyRewardKind = keyof typeof HONEY_PRICE

/* ── 免费版权益文案（P2-C，多端付费墙共用）────────────────────── */
/**
 * 「积分可兑 Pro 天数」—— 对标薄荷「打卡送会员时长」的转化钩子。
 *
 * 🔴 P2-C 真实缺口定位（2026-11-03 复核，修正审计文档措辞）：
 *   审计原文写「pro1Day/pro30Day 已实现但**缺入口**」，此判断**不准确** ——
 *   两端邀请页均有完整兑换 UI 且可用：
 *     · 主端 src/pages/InviteCenter.tsx:290-313（Pro 1 天 / Pro 30 天 / AI 1 次）
 *     · 小程序 mini/src/pages/invite/invite.tsx:190-208（同三项，走 redeem_honey RPC）
 *   真正缺的是**付费墙侧的曝光**：用户在付费墙看到三档价格时，完全不知道
 *   「不花钱也能靠打卡/邀请攒分换 Pro」，而这条正是最强的付费墙转化缓冲。
 *   故本项落点在付费墙 FREE_ITEMS，而非邀请页补入口。
 *
 * 🔴 文案用模板字符串**从 HONEY_PRICE 取值**，不硬编码数字：调价时文案自动跟随，
 *   杜绝「UI 写 2600 实际 3200」的价格失配（历史上 O-4 就提议过调价）。
 *   ⚠️ 因是模块顶层求值，本常量**必须声明在 HONEY_PRICE 之后**，否则 TDZ 报错。
 *
 * 诚实边界：只陈述「可兑」与价格，不承诺「容易攒到」。真实攒分速率（记餐+5/
 *   饮水+2/运动+2、邀请+250、新手+150）由邀请页与打卡页各自公示，
 *   付费墙不重复渲染具体数值，避免又造一份需同步维护的副本。
 *
 * 🔴 入口名用「蜜糖积分」而非「邀请中心」：后者只存在于代码注释，用户实际看到的
 *   标签两端一致为「蜜糖积分」（主端 InviteCenter.tsx:236 `<Sheet title="蜜糖积分">`；
 *   小程序 invite.config.ts `navigationBarTitleText: '蜜糖积分'`）。写「邀请中心」
 *   会让用户在界面上找不到同名入口，属导航死链式文案。
 */
export const FREE_HONEY_PRO_ITEM =
  `蜜糖积分可兑 Pro 天数（${HONEY_PRICE.pro1Day} 分兑 1 天、${HONEY_PRICE.pro30Day} 分兑 30 天），在「蜜糖积分」页兑换`

/* ── 推送通知（P1-4）────────────────────────────────────────── */
// 通知类型枚举（多端共用真相源）
export const NOTIFY_KIND = {
  checkin: 'checkin', // 打卡提醒：每日 20:00
  water: 'water', // 饮水提醒：每 2 小时（9:00~21:00），仅当日未达标
} as const

export type NotifyKind = (typeof NOTIFY_KIND)[keyof typeof NOTIFY_KIND]

/** 打卡提醒默认触发时刻（24h，本地通知用） */
export const CHECKIN_REMINDER_HOUR = 20
export const CHECKIN_REMINDER_MINUTE = 0

/** 饮水提醒：起始/结束时刻（本地通知用） */
export const WATER_REMINDER_START_HOUR = 9
export const WATER_REMINDER_END_HOUR = 21
export const WATER_REMINDER_INTERVAL_HOURS = 2
