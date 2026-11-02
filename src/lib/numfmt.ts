/**
 * 数值舍入与展示格式化的**唯一**权威实现。
 *
 * 为什么需要这个文件（2026-11-02）：
 *   「饮食体检」页曾显示 `11.666666666666666 g/100g`。根因是份量换算
 *   `r = 100 / grams` 产生无限循环小数后被直接模板插值。而全仓当时只有
 *   5 处 toFixed、2 个互不复用的小工具（validate.ts 的 formatNum、
 *   nutrition.ts 的 round），没有统一口径，所以每个新展示点都可能重新踩一遍。
 *
 * 🔴 为什么用 toFixed 而不是 `Math.round(n * 10**d) / 10**d`：
 *   后者（本仓原 round/formatNum 的写法）有三个实测缺陷：
 *     ① 乘法溢出精度：Math.round(1e21*100)/100 = 999999999999999900000
 *     ② 负数 .5 方向与展示不一致：Math.round(-2.5) = -2（向 +∞），
 *        而 (-2.5).toFixed(0) = -3（远离零）—— 同一份数据在计算层与展示层会给出不同结果
 *     ③ 乘法误差会「凑巧」得到符合直觉的答案，掩盖逻辑错误：
 *        2.675 的 double 真实值是 2.6749999999999998224，正确舍入应为 2.67；
 *        但 2.675*100 = 267.5 恰好落在 .5 边界，Math.round 给出 2.68。
 *        答案看着对，推理路径是错的 —— 换个数值就翻车。
 *   toFixed 按 IEEE754 double 的**真实值**做十进制定点舍入、tie 远离零、
 *   且对 |n| >= 1e21 自动退化为指数形式（Number() 再解析回来仍是精确值）。
 *
 * ⚠️ 关于「1.005 舍入到 2 位得 1.00 而不是 1.01」：
 *   这不是 bug。1.005 在 double 里的真实值是 1.0049999999999998934，
 *   它本来就小于 1.005。要「十进制直觉上的四舍五入」需引入 decimal 库，
 *   对营养数值（1–4 位有效数字）属于过度工程。本模块选择忠于 double 真实值。
 *
 * 🔴 使用纪律（这条比实现更重要）：
 *   **计算层保持全精度，只在展示层舍入。**
 *   绝不允许「先舍入再参与后续计算」—— 那会累积误差。
 *   反例见 report.ts 的供能比：曾用已舍入的日均蛋白/碳水/脂肪算比例，
 *   导致 24%+24%+53% = 101%（≠100%），且比例本身也偏了。
 *   同理 foodInsight.ts 的 protein/fiber 既用于阈值判断（protein >= 20）
 *   又用于展示，必须**只在插值处**调 fmtNum，不能在源头把值改掉。
 */

/** 默认小数位：营养素类数据统一保留 2 位 */
export const DEFAULT_DECIMALS = 2

/** toFixed 的合法入参区间（ECMA-262 规定 0–100） */
function clampDecimals(d: number): number {
  if (!Number.isInteger(d)) return DEFAULT_DECIMALS
  return Math.max(0, Math.min(100, d))
}

/**
 * 计算层舍入：返回**数值**，最多 `decimals` 位小数（去掉无法表示的尾数）。
 *
 * 用于「这个值要写库 / 要参与比较 / 要再被计算」的场合。
 * 注意结果仍是 double，例如 roundTo(1.005, 2) === 1，String 化后是 "1" 而非 "1.00"。
 * 若要展示成字符串请用 {@link fmtNum}。
 *
 * 异常值：null / undefined / NaN / ±Infinity 一律返回 0，
 * 以免 NaN 传染下游求和（一处 NaN 会让整列统计变 NaN）。
 *
 * @example
 *   roundTo(11.666666666666666)  // 11.67
 *   roundTo(5.833333333333333)   // 5.83
 *   roundTo(542)                 // 542（整数不变）
 *   roundTo(2.5, 0)              // 3（tie 远离零）
 *   roundTo(-2.5, 0)             // -3（与展示层一致，不像 Math.round 给 -2）
 */
export function roundTo(n: number | null | undefined, decimals: number = DEFAULT_DECIMALS): number {
  if (n == null || !Number.isFinite(n)) return 0
  return Number(n.toFixed(clampDecimals(decimals)))
}

/**
 * 展示层格式化：返回**字符串**，最多 `decimals` 位小数，去掉多余的尾随零。
 *
 * 为什么去尾零：UI 上 `542 kcal/100g` 比 `542.00 kcal/100g` 干净，
 * 且沿用本仓既有惯例（validate.ts 的 formatNum 也是去 .0）。
 * 「保留两位小数」在此实现为「**不超过**两位」—— 既根治长小数，又不给整数硬加 .00。
 * 需要固定位数（如财务报表对齐）时传 `{ padZero: true }`。
 *
 * 无数据时返回占位符（默认 '—'），避免 UI 上出现 "NaN" / "undefined" / "null"。
 *
 * @example
 *   fmtNum(11.666666666666666)  // '11.67'
 *   fmtNum(5.833333333333333)   // '5.83'
 *   fmtNum(542)                 // '542'
 *   fmtNum(1.5)                 // '1.5'
 *   fmtNum(1.5, 2, { padZero: true })  // '1.50'
 *   fmtNum(null)                // '—'
 *   fmtNum(NaN)                 // '—'
 */
export function fmtNum(
  n: number | null | undefined,
  decimals: number = DEFAULT_DECIMALS,
  opts: { padZero?: boolean; placeholder?: string } = {},
): string {
  const { padZero = false, placeholder = '—' } = opts
  if (n == null || !Number.isFinite(n)) return placeholder
  const d = clampDecimals(decimals)
  const s = n.toFixed(d)
  // 🔴 负零归一：toFixed 会把 -0.003 输出成 "-0.0"，去尾零后变成 "-0"。
  //    这个 "-0" 会直接显示在 UI 上（实测 -0.003 → "-0"），必须归一成 "0"。
  //    注意 padZero 分支同样受影响，所以放在前面统一处理。
  if (Number(s) === 0) return padZero ? (0).toFixed(d) : '0'
  if (padZero) return s
  // 去尾随零：'542.00' → '542'，'1.50' → '1.5'。
  // 只对含小数点的结果做，避免把 '1e+21' 这类指数形式改坏。
  if (!s.includes('.')) return s
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' || trimmed === '-' ? '0' : trimmed
}

/**
 * 百分比展示：把**已经是百分数**的值格式化（不再乘 100）。
 * 乘 100 交给调用方，避免「这个参数到底要不要再乘一次」的歧义。
 *
 * @example pct(23.456)  // '23%'
 *          pct(23.456, 1)  // '23.5%'
 */
export function pct(n: number | null | undefined, decimals = 0): string {
  return `${fmtNum(n, decimals)}%`
}

/**
 * 把一组百分比配平到合计恰好 100（最大余数法 / Hamilton method）。
 *
 * 为什么需要：三项供能比各自 Math.round 后合计可能是 99 或 101
 * （实测 24+24+53=101）。UI 上「占比合计不等于 100%」会被当成数据错误。
 * 修法不是调某一项凑数，而是标准做法：先取整，再把差额按小数余数大小分配。
 *
 * @param values 原始（未舍入）数值，内部自行求占比 —— 🔴 不要传已舍入的值
 * @param total  合计目标，默认 100
 * @returns 与入参等长的整数数组，合计 === total（入参全 0 时返回全 0）
 *
 * @example balancePercents([33, 33, 34])  // [23, 23, 54] 合计 100
 */
export function balancePercents(values: number[], total = 100): number[] {
  const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const sum = safe.reduce((a, b) => a + b, 0)
  if (sum <= 0) return safe.map(() => 0)

  // 精确占比（浮点），拆成整数部分 + 余数
  const exact = safe.map((v) => (v / sum) * total)
  const floors = exact.map((v) => Math.floor(v))
  let rest = total - floors.reduce((a, b) => a + b, 0)

  // 余数从大到小分配剩余的 1（rest 必然落在 [0, n) 内）
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = [...floors]
  for (let k = 0; k < rest && k < order.length; k += 1) out[order[k].i] += 1
  return out
}
