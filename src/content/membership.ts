import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  FREE_HONEY_PRO_ITEM,
  FREE_NO_ADS_ITEM,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
} from '../lib/entitlement'

/**
 * 会员权益清单（免费版 / Pro·终身）的**唯一文案真源**（2026-11-08 抽出）。
 *
 * 为什么抽出来：付费墙（`pages/PaywallSheet.tsx`，登录后可见）与公开定价页
 * （`pages/PricingSheet.tsx`，未登录也可见）要展示**同一份**权益清单。
 * 两份相似数组必然漂移 —— 而权益文案漂移的后果是「宣传的权益与实际不符」，
 * 属《广告法》第 4 条的虚假宣传风险，不是排版问题。
 *
 * 🔴 数字一律插值自 `@dbee/shared` 的配额常量（FREE_DAILY_AI / PRO_REPORT_DAYS 等），
 * 禁止在这里写死数字：写死 = 又多一份副本，改配额时必漏改。
 */

/** 免费版权益。逐条对应实际实现，新增/收回功能时必须同步改这里。 */
export const FREE_ITEMS = [
  `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别（识别成功才扣次数）`,
  `积分可再兑换拍照识别，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（50 积分/次）`,
  FREE_HONEY_PRO_ITEM,
  '扫条码不限次数永久免费',
  '文字描述识别、手动录入、体重饮水运动记录全部免费',
  'AI 问答不限次数（每分钟限 3 次防刷）',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  '连续打卡 7 天再送拍照次数',
  FREE_NO_ADS_ITEM,
]
// 🔴 「完善资料再送拍照次数」删去（2026-11-03，P2-D 同步小程序端 P0-C 结论）：
//   完善资料实际发的是**蜜糖积分**而非识别次数 —— src/state/plan.tsx:185
//   `grantHoney('newbie', 'newbie', NEWBIE_BONUS_AMOUNT, ...)`，代码注释原文
//   「发蜜糖积分，不再发识别次数」。全仓 `grantPhotoBonus(` 仅 'streak7' 一处调用，
//   签名里的 'newbie' 分支从无调用方。原文案属虚假承诺，且小程序端已于 P0-C
//   （commit 07a46ca）删除同一句，此处为主端漏改导致的四端文案分叉。
//   新手积分本身已由上面「积分可再兑换拍照识别」一条如实覆盖。

/** Pro / 终身会员权益。 */
export const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  'AI 问答不限流',
  '长文本 AI 复盘（本期解读）无限次',
  '个性化完整膳食计划、长期 AI 膳食规划',
  '宏量营养素深度分析',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天 + 数据导出`,
]
