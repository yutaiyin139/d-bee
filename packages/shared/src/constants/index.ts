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

/* ── 备案信息（法律要求每页公示的**公开**信息，非密钥）────────────── */
/**
 * ICP 备案号 —— 自律蜜蜂（d-bee.cn）。2026-11-06 下证。
 *
 * 🔴🔴 **两个备案号必须与域名一一对应，填错即合规违规**（同一主体下两个站点）：
 *   · 京ICP备2026075565号-**2** = 自律蜜蜂，域名 **d-bee.cn** ← 本项目（Web/Android/iOS/小程序）
 *   · 京ICP备2026075565号-**1** = 北京迪蜂科技有限公司门户网站，域名 **d-bee.com.cn**
 *     （官网不在本仓库，本仓库**任何**地方都不该出现 -1）
 *
 * 为什么放在 shared 而不是 .env：
 *   · 备案号是《非经营性互联网信息服务备案管理办法》要求**在网站每页底部公示**的公开信息，
 *     不是密钥，没有理由藏进被 gitignore 的 .env；
 *   · `.env` 不入库 → 换机器/CI 构建会因读不到该键而产出**没有备案号的页面**（合规违规），
 *     且这类失败是静默的（页脚那行直接不渲染，构建 exit 0）；
 *   · 放 shared 则四端同源同值，与 `FREE_NO_ADS_ITEM` 等文案常量同类。
 * 主端仍保留 `VITE_ICP_BEIAN` 作为**覆盖口**（`env(...) || ICP_BEIAN_D_BEE_CN`），
 * 用于紧急改号时无需改代码；但常态下不需要配，配了也必须与本常量一致。
 *
 * ⚠️ 改这里 = 四端页脚/法律页同时变。`deploy/verify-legal.mjs` 第 3 项会读**本文件**
 * 作为期望值做双向校验（页面必须逐字出现该号，且不得出现别的号），所以改了不部署会 FAIL。
 */
export const ICP_BEIAN_D_BEE_CN = '京ICP备2026075565号-2'

/** 工信部备案查询入口（备案号须做成指向此站的可点击链接，管局要求可核验） */
export const ICP_QUERY_URL = 'https://beian.miit.gov.cn/'

/**
 * 公安联网备案号。🔴 2026-11-06 仍为空 —— ICP 下证后 **30 日内**须办公安联网备案
 * （依据《计算机信息网络国际联网安全保护管理办法》第 12 条，即 2026-12-06 前）。
 * 拿到后填这里，两端页脚会自动多渲染一行（渲染逻辑已就绪，见 SiteFooter.tsx:61）。
 * 未拿到前保持空串 —— 展示假备案号属违规，与 ICP 同理。
 */
export const POLICE_BEIAN = ''

/** 公安联网备案查询入口 */
export const POLICE_QUERY_URL = 'https://beian.mps.gov.cn/'

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

/* ── 健康 / 热量口径（四端单一真相源，2026-11-08 下沉）───────────── */
/**
 * 活动消耗计入「可吃回」额度的比例（50%）。
 * 依据：手环/步数普遍高估消耗 20% 左右，100% 回补会让人越减越肥；50% 为安全折中。
 * 此前主端在 src/lib/health/index.ts、mini 在 pages/index/index.tsx 各写一份 0.5 副本。
 */
export const ACTIVITY_EATBACK_RATIO = 0.5

/** 每日步数目标默认值（用户未在「我的」里自定义时使用） */
export const DEFAULT_STEP_GOAL = 6000

/**
 * 健康数据自动同步间隔（ms）。已连接健康数据源后按此频率拉当天步数 / 活动能量。
 * 🔴 2026-11-08 下沉：此前主端 Dashboard 与小程序首页各写一份 60_000 副本，
 *    四端同步节奏必须同源，改一处漏一处会让「步数刷新速度」出现端间差异。
 */
export const HEALTH_SYNC_INTERVAL_MS = 60_000
