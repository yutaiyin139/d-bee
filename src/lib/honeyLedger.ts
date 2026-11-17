/**
 * 蜜糖积分余额口径的入口 —— **实现已下沉到 `@dbee/shared`**（2026-11-17）。
 *
 * 🔴 本文件是纯 re-export，**不要在这里写实现**。
 *   单一真相源 = `packages/shared/src/honeyLedger.ts`（FEFO 口径的设计理由与算法）。
 *   服务端 SQL 镜像 = `db/migrations/0054-honey-balance-fefo.sql`。
 */
export {
  computeHoneyBalance,
  HONEY_REASON_EXPIRE,
  type HoneyLedgerRow,
  type HoneyBalanceResult,
} from '@dbee/shared'
