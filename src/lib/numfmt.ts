/**
 * 数值舍入与展示格式化的入口 —— **实现已下沉到 `@dbee/shared`**（2026-11-03，P1-A）。
 *
 * 🔴 本文件现在是纯 re-export，**不要再在这里写实现**。
 *   单一真相源 = `packages/shared/src/numfmt.ts`（所有设计理由、toFixed vs Math.round
 *   的三个缺陷、精度口径、使用纪律都记在那里的文件头注释）。
 *
 * 为什么下沉：小程序 `mini/` 是独立 Taro 工程，只能拿 `@dbee/shared`，取不到本目录。
 *   下沉前 mini 端自行写 `Math.round(n*10)/10`（1 位小数）与主端 `roundTo(n,2)`
 *   （2 位小数）分叉，同一餐跨端显示不同数字。下沉后两端 import 同一实现。
 *
 * 为什么保留本文件而不是让调用方直接 import `@dbee/shared`：
 *   ① 既有 import 点（ai.ts / api.ts / validate.ts / nutrition.ts / report.ts /
 *      foodInsight.ts / tools/numfmt.test.ts）**零改动**，避免一次性大面积改 import 引入回归；
 *   ② 与 `src/lib/entitlement.ts`、`src/lib/photoGuard.ts` 的既有下沉模式一致
 *      （那两个文件同样是 `export * from '@dbee/shared'`）；
 *   ③ 主端调用方语义上仍属「src/lib 抽象层」（架构铁律 1：平台差异只走 src/lib/）。
 */

export {
  DEFAULT_DECIMALS,
  roundTo,
  fmtNum,
  pct,
  balancePercents,
} from '@dbee/shared'
