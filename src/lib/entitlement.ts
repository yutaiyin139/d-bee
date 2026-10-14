import type { Entitlement } from '../types'

/**
 * P4 会员与配额的核心规则（纯函数，便于测试与复用）。
 *
 * 免费档：每日 10 次 AI 调用（拍照 / 文字 / 包装识别 / AI 问答共用），
 * 报告只看近 7 天，AI 周解读每周 1 次，不能导出数据。
 * Pro：全部解锁。
 *
 * 真实支付（微信 / 支付宝 / App 内购）待接入；在此之前用兑换码直接解锁，
 * 权益状态存在云端 entitlements 表，换设备也生效。
 *
 * 注：该额度由前端常量传参给云端 consume_ai_quota(p_limit)，改这里即生效，
 * 数据库侧不存字面量、无需迁移。
 */

export const FREE_DAILY_AI = 10
export const FREE_INSIGHT_PER_WEEK = 1
export const FREE_REPORT_DAYS = 7

export const SCAN_FEATURE = 'scan'
export const INSIGHT_FEATURE = 'insight'

/** 演示期兑换码（客户端校验；接入真实支付后此列表下线） */
export const REDEEM_CODES = ['DBEE-PRO-2026', 'MIFENG-VIP', 'BEE2026']

export function isPro(ent: Entitlement | null | undefined): boolean {
  if (!ent) return false
  if (ent.plan !== 'pro') return false
  if (ent.pro_until) return new Date(ent.pro_until).getTime() > Date.now()
  return true
}

/** 本周一（用于周配额：usage_date 存周一日期） */
export function mondayOf(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const shift = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - shift)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

export function codeIsValid(raw: string): boolean {
  return REDEEM_CODES.includes(normalizeCode(raw))
}

/**
 * 免费 AI 额度用尽时的统一提示。
 * 必须同时讲清三件事，否则用户会误以为「整个应用不能用了」：
 * 1）什么时候恢复（按本地自然日计，次日 0 点自动重置）
 * 2）额度是怎么算的（拍照 / 文字 / 包装兜底 / AI 问答共用一个池子）
 * 3）哪些功能不受影响（手动记录与报告都不消耗 AI 次数）
 */
export function quotaExhaustedReason(): string {
  return (
    `今日 ${FREE_DAILY_AI} 次免费 AI 已用完（拍照识别、文字解析、包装识别与 AI 问答共用），` +
    `明天 0 点自动重置。升级 Pro 可不限次数。` +
    `手动添加食物、扫条码、记录饮水体重运动、查看近 ${FREE_REPORT_DAYS} 天报告都不受影响。`
  )
}
