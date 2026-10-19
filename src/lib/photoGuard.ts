/**
 * 拍照额度阶梯 + 反复拍照判定（薄壳转发层）。
 *
 * 判定逻辑已迁至 `@dbee/shared`（多端单一真相源）：
 *  - photoLadderHint：按「单日总拍照次数」分阶梯提示
 *  - isDuplicatePhoto：相邻两次拍照识别结果是否「基本一致」（反复拍照）
 *  - summarizePhoto：识别结果汇总成 PhotoSummary
 *  - 常量：FREE_DAILY_AI / LADDER_* / DUP_*
 *
 * 本文件只做 re-export，保证现有 `import { ... } from '../lib/photoGuard'`
 * 的调用点零改动。若需修改判定规则，请改 `packages/shared/src/rules/`。
 */
export {
  photoLadderHint,
  isDuplicatePhoto,
  summarizePhoto,
  FREE_DAILY_AI,
  LADDER_REDEEM_MIN,
  LADDER_REDEEM_MAX,
  LADDER_PRO_START,
  DUP_NAME_OVERLAP,
  DUP_KCAL_DELTA,
} from '@dbee/shared'
export type { LadderKind, LadderHint, PhotoSummary } from '@dbee/shared'
