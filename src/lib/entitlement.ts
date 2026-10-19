/**
 * 会员与配额的核心规则（薄壳转发层）。
 *
 * 所有常量、纯函数、类型已迁至 `@dbee/shared`（多端单一真相源）：
 *  - 常量：FREE_DAILY_AI / AI_REDEEM_DAILY_LIMIT / FREE_REPORT_DAYS / PRO_REPORT_DAYS
 *          / STREAK_BONUS_* / NEWBIE_BONUS_AMOUNT / BONUS_TTL_DAYS / SCAN_FEATURE
 *          / PRICE_* / PRODUCT_IDS / HONEY_PRICE
 *  - 函数：isPro / isLifetime / effectivePlan / mondayOf / normalizeCode
 *          / proUntilFromMonths / quotaExhaustedReason / photoLadderHint
 *          / isDuplicatePhoto / summarizePhoto
 *  - 类型：UserPlan / Entitlement / Product / ProductId / HoneyRewardKind / LadderHint ...
 *
 * 本文件只做 re-export，保证现有 `import { ... } from '../lib/entitlement'`
 * 的调用点零改动。若需修改规则，请改 `packages/shared/src/`，不要在这里改。
 */
export * from '@dbee/shared'
