/**
 * 蜜糖积分余额：FEFO（First-Expired-First-Out，先到期先消费）口径的纯函数真源。
 *
 * 背景（2026-11-17 生产取证发现的双扣缺陷）：
 *   旧口径 = GREATEST(0, SUM(amount) FILTER (amount<0 OR expires_at IS NULL OR expires_at>now()))。
 *   它同时做了两件互相打架的事：
 *     ① 把「已过期的正流水」排除（当作没发过）；
 *     ② 又把物理冲正流水 reason='expire'（负）计入余额。
 *   当一笔积分「先被消费、后过期」时（新手 150 分花掉 100、30 天后到期），
 *   expire_stale_honey() 按【整笔】插入 -150 冲正（而非未消费的 50），
 *   于是 ① 排除了 +150、② 又计入了 -150 → 同一笔被扣两次；叠加整笔冲正多扣的 100，
 *   用户实际应有 34 分却显示 0（生产账户 179325... 实证）。
 *
 * FEFO 正解（本函数）：
 *   - 积分是同质池，但「过期」按批次（每笔正流水有自己的 expires_at）。
 *   - 消费时优先冲抵最早到期的批次 → 已花掉的部分不再随整笔过期被重复作废。
 *   - 物理冲正流水 reason='expire' 一律忽略（FEFO 在查询期重算，不依赖它）。
 *   - balance = Σ(未过期批次中尚未被消费的剩余)。
 *
 * 无环境依赖：纯函数，四端（Web/iOS/Android 共用 src + 独立 mini）与服务端 SQL
 * 必须实现同一口径。服务端镜像见 db/migrations/0054-honey-balance-fefo.sql。
 */

export interface HoneyLedgerRow {
  amount: number
  reason: string
  expires_at: string | null
  /** 时间顺序仅用于调试/稳定排序；FEFO 归属按到期时间，不按消费时间 */
  created_at?: string
  id?: number
}

export interface HoneyBalanceResult {
  balance: number
  totalEarned: number
  totalSpent: number
}

/** 物理过期冲正的 reason 标记：FEFO 下忽略，避免与重算结果叠加成双扣 */
export const HONEY_REASON_EXPIRE = 'expire'

/**
 * 按 FEFO 口径从流水重算积分余额。
 *
 * @param rows 该用户全部积分流水（含已过期、含 reason='expire' 冲正）
 * @param nowMs 当前时间（毫秒），注入以便测试确定性
 */
export function computeHoneyBalance(
  rows: readonly HoneyLedgerRow[],
  nowMs: number = Date.now(),
): HoneyBalanceResult {
  // 正流水 = 获得，按到期时间升序；expires_at 为空视为永不过期（排最后）
  const lots: Array<{ remain: number; expiresMs: number | null }> = []
  let totalEarned = 0
  let totalSpent = 0

  for (const r of rows) {
    const amt = Number(r.amount) || 0
    if (amt > 0) {
      totalEarned += amt
      const expMs = r.expires_at ? new Date(r.expires_at).getTime() : NaN
      lots.push({ remain: amt, expiresMs: Number.isNaN(expMs) ? null : expMs })
    } else if (amt < 0 && r.reason !== HONEY_REASON_EXPIRE) {
      // 真实消费（redeem / 其他负向调整）；物理过期冲正不算「消费」
      totalSpent += -amt
    }
    // reason='expire' 的负流水：FEFO 下完全忽略
  }

  // FEFO：把消费总额按「先到期先扣」分摊到各批次。
  // 用两遍：先算净消费总额（totalSpent），再按到期顺序冲抵。
  let toConsume = totalSpent
  for (const lot of lots) {
    if (toConsume <= 0) break
    const used = Math.min(lot.remain, toConsume)
    lot.remain -= used
    toConsume -= used
  }

  // 已到期批次的剩余一律作废；未到期批次剩余计入可用余额
  let balance = 0
  for (const lot of lots) {
    if (lot.expiresMs === null || lot.expiresMs > nowMs) {
      balance += lot.remain
    }
  }

  return {
    balance: Math.max(0, balance),
    totalEarned,
    totalSpent,
  }
}
