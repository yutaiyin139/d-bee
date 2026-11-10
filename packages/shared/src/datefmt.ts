/**
 * 日期展示格式化的**唯一**权威实现（多端单一真相源）。
 *
 * 🔴 为什么要有这个模块（2026-11-03，四端一致性审计）：
 *   「会员有效期至 X」这一句在两端曾有三处独立实现，全部直接调
 *   `new Date(iso).toLocaleDateString('zh-CN')`：
 *     · 主端 ProfileScreen.tsx（会员状态卡片副标题）
 *     · 主端 PaywallSheet.tsx（付费墙顶部提示条）
 *     · mini  paywall.tsx（付费墙顶部提示条）
 *   `toLocaleDateString` 的输出由 **JS 引擎的 ICU/locale 数据**决定，而
 *   web/iOS/Android（V8 + 系统 ICU）与微信小程序（各厂商 JS 引擎）的 locale
 *   支持并不同步。也就是说：同一份代码、同一个到期日，在小程序里可能给出
 *   `2026/11/30`，也可能给出 `11/30/2026` 或 `2026年11月30日`。
 *   那就不是「四端一致」，而是「碰巧一致」—— 换个基础库版本就翻车，
 *   且这类分叉**不会报错**，只会在用户眼里变成两个不同的产品。
 *
 *   故统一改为确定性实现：自己取年月日拼字符串，不依赖任何 locale 数据。
 *   输出与 Node 22（full ICU）下 `toLocaleDateString('zh-CN')` **逐字一致**
 *   （**正斜杠**分隔、月日不补零，如 `2026/11/30`、`2026/1/5`），
 *   即线上展示零变化；这条「逐字一致」由 tools/mini-profile-member.test.ts 的对拍用例锁定。
 *
 * 🔴 与 numfmt.ts 同一条纪律：新增日期展示一律走这里，禁止在页面里
 *   直接写 `toLocaleDateString` / 手工拼 `getFullYear()`。
 */

/**
 * 日期分隔符。
 *
 * ⚠️ 这里是**正斜杠 `/`（U+002F, charCode 47）**，不是横线 `-`（U+002D, charCode 45）。
 *
 * 2026-11-03 实测踩过这个坑：肉眼在终端里看 `toLocaleDateString('zh-CN')` 的输出，
 * 斜杠被字体渲染得几乎和横线一样，一度判定为「横线分隔」并按横线实现，
 * 结果把主端线上文案从 `2026/11/30` 改成了 `2026-11-30`（一次没人要求过的 UI 变更）。
 * 只有 `charCodeAt(4) === 47` 这类**布尔断言**才能定论，别凭肉眼改这个字符：
 *   node -e "console.log(new Date('2026-11-30T12:00:00+08:00')
 *     .toLocaleDateString('zh-CN').charCodeAt(4))"   // → 47
 */
const DATE_SEP = '/'

/**
 * 后端时间戳 → 中文环境日期文案（`YYYY/M/D`，**正斜杠**分隔、月日不补零）。
 *
 * 入参通常是 `entitlements.pro_until`（DB 列类型 `timestamptz`，序列化后带时区偏移，
 * 如 `2026-11-30T23:59:59+08:00` —— 注意 ISO 串本身的横线与输出用的斜杠是两回事）。
 *
 * 🔴 三个刻意的行为，改之前请先读 tools/mini-profile-member.test.ts：
 *
 *   ① **取本地时区的年月日**，不是 UTC。
 *      用 `toISOString()` / `getUTCDate()` 会让北京时间 11-30 00:30（= UTC 11-29 16:30）
 *      显示成 11-29 —— 用户凭空少一天会员。到期日是用户能感知并据以投诉的数字。
 *
 *   ② **非字符串或空串一律返回 null**，绝不返回 `1970-1-1`。
 *      这是实测踩到的真坑：`new Date(null)` **不报错**，而是返回 epoch
 *      （1970-01-01），`new Date(undefined)` 才是 Invalid Date。
 *      `pro_until` 对 lifetime 用户恒为 null（见 db/migrations/0005-membership-tiers.sql:5），
 *      少了这道守卫就会在「我的」页显示「有效期至 1970/1/1」。
 *      返回 null 让调用方退回通用文案（`全部功能已解锁`），而不是显示一个错日期。
 *
 *   ③ **不做「纯日期串按本地解析」的修正**，忠实透传 `new Date()` 的行为。
 *      ES 规范有个历史遗留的不一致：`'2026-11-30'`（纯日期）按 **UTC** 午夜解析，
 *      而 `'2026-11-30T00:00:00'`（无时区的日期时间）按**本地**解析。
 *      两者相差一个时区偏移，在 UTC 以西的地区纯日期串会少一天。
 *      这里刻意不「修」它 —— 主端旧实现（toLocaleDateString）就是这个行为，
 *      保持一致优先于自作主张；且真实入参是 timestamptz，永远带偏移，走不到这个分支。
 */
export function formatCnDate(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string') return null
  if (iso.trim() === '') return null
  const d = new Date(iso)
  const t = d.getTime()
  if (!Number.isFinite(t)) return null
  // 月日不补零：这是 zh-CN locale 的行为（`2026/1/5` 而非 `2026/01/05`），
  // 补零会与主端历史输出不一致。数字直接转字符串，无需 numfmt（不是营养数值）。
  // 分隔符见 DATE_SEP 注释 —— 是斜杠不是横线，别凭肉眼改。
  return `${d.getFullYear()}${DATE_SEP}${d.getMonth() + 1}${DATE_SEP}${d.getDate()}`
}

/**
 * 「有效期至 X」整句。抽出成函数是因为它在两端各有 2 处调用点，
 * 且**必须与 null 回退文案成对出现** —— 只复用 formatCnDate 的话，
 * 每个调用点都要自己记得写回退分支，漏一个就是「有效期至 null」。
 *
 * 用于会员状态卡片的副标题：主端 src/pages/ProfileScreen.tsx 与
 * mini/src/pages/profile/profile.tsx（两者现均经 rules 的 memberSubText 间接调用）。
 *
 * @param iso      pro_until
 * @param fallback pro_until 缺失/非法时的通用文案（默认「全部功能已解锁」）
 */
export function proUntilText(iso: string | null | undefined, fallback = '全部功能已解锁'): string {
  const until = formatCnDate(iso)
  return until ? `有效期至 ${until}` : fallback
}

/**
 * 付费墙顶部「你已是 Pro 会员」提示条的整句。
 *
 * 这句话在主端 src/pages/PaywallSheet.tsx 与 mini/src/pages/paywall/paywall.tsx
 * 曾各写一份（逐字相同），属于典型的「移植后各自演化」隐患 —— 改一边的文案、
 * 或一边的 null 回退，另一边不会跟着变，且不会报错。故收到这里。
 *
 * 整句 UI 文案放 shared 是本仓既有做法（见 rules 的 photoLadderHint /
 * quotaExhaustedReason），不是新增的例外。
 *
 * 🔴 注意 lifetime 分支不在本函数内：两端 lifetime 文案相同且无日期插值，
 *    留在页面里更易读（`lifetime ? '...' : proNoticeText(...)`）。
 */
export function proNoticeText(iso: string | null | undefined): string {
  const until = formatCnDate(iso)
  return until ? `你已是 Pro 会员，有效期至 ${until}。` : '你已是 Pro 会员，所有功能已解锁。'
}

/**
 * 距 Pro 到期还剩多少天（整数，向下取整到整天）。
 *
 * 用于「续费提醒」触点：临到期（如 ≤7 天）时在首页/Dashboard 展示续费入口，
 * 把「一次性卖」转成「持续收」。这属于转化触点，非会员判定 —— 会员是否有效
 * 仍由 rules 的 isPro() 以 `pro_until > now` 为准，本函数只做「还剩几天」的展示计算。
 *
 * @param iso  pro_until（lifetime 恒为 null）
 * @returns    距到期整天数；iso 缺失/非法/已过期返回 null（调用方据此不展示提醒）
 */
export function proDaysLeft(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const diff = t - Date.now()
  if (diff <= 0) return null // 已过期（或恰在到期瞬间）：不展示「还剩 X 天」
  return Math.floor(diff / 86_400_000)
}
