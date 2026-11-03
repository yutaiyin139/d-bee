#!/usr/bin/env node
/**
 * AI 识别精度 MAPE 报告生成器（P1-C）。
 *
 * 用法：
 *   node tools/ai-mape/run-report.mjs                          # 默认读 samples-example.json
 *   node tools/ai-mape/run-report.mjs tools/ai-mape/samples-2026-11-10.json
 *   node tools/ai-mape/run-report.mjs <json> --md report.md     # 同时输出 Markdown
 *
 * 设计：内部用 esbuild 转译 mape.ts（复用项目既有 esbuild，不需额外装包，
 * 与 tools/insight-selftest.ts 的做法一致），再跑统计。
 * 这样统计口径与 vitest 测试守护的是**同一份源码**，不会出现
 * 「脚本一套算法、测试另一套算法」的漂移。
 *
 * 🔴 读报告时最重要的一行是「诊断」，不是 MAPE 数字本身：
 *   · 诊断=系统性偏差 → 改 prompt 就能救（性价比高）
 *   · 诊断=随机误差   → 需换模型/调参（改 prompt 收益有限）
 *   两者的处置成本差一个数量级，别只看 MAPE 高低就下结论。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/* ── 参数解析 ── */
const args = process.argv.slice(2)
const mdIdx = args.indexOf('--md')
let mdOut = null
if (mdIdx >= 0) {
  mdOut = args[mdIdx + 1]
  args.splice(mdIdx, 2)
}
const samplePath = args[0]
  ? resolve(process.cwd(), args[0])
  : join(HERE, 'samples-example.json')

if (!existsSync(samplePath)) {
  console.error(`✗ 样本文件不存在：${samplePath}`)
  console.error('  提示：复制 tools/ai-mape/samples-example.json 为 samples-<日期>.json 后填写')
  process.exit(1)
}

/* ── esbuild 转译 mape.ts → 临时 mjs ── */
const esbuildPath = join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')
if (!existsSync(esbuildPath)) {
  console.error('✗ 未找到 esbuild（node_modules/esbuild）。请先 npm install')
  process.exit(1)
}
const esbuild = (await import(pathToFileURL(esbuildPath).href)).default
const tmpFile = join(HERE, '.mape-bundle.mjs')
await esbuild.build({
  entryPoints: [join(HERE, 'mape.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tmpFile,
  // 🔴 刻意**不**把 @dbee/shared 外部化：该包 dist/index.js 内部用了无扩展名的
  // 目录导入（如 `from './constants'`），Node ESM 不支持目录导入，会在运行期抛
  // ERR_UNSUPPORTED_DIR_IMPORT。交给 esbuild 在构建期解析并内联即可
  // （vite/vitest 走的也是这条路径，所以既有测试没遇到这个问题）。
  absWorkingDir: ROOT,
  logLevel: 'error',
})

const mape = await import(pathToFileURL(tmpFile).href)

/* ── 读样本 ── */
const raw = JSON.parse(readFileSync(samplePath, 'utf8'))
const samples = Array.isArray(raw) ? raw : raw.samples
if (!Array.isArray(samples) || samples.length === 0) {
  console.error('✗ 样本为空：请检查 JSON 的 samples 数组')
  process.exit(1)
}

/* ── 统计 ── */
const allStats = mape.computeAllStats(samples)
const bands = mape.computeBandStats(samples)

/* ── 控制台报告 ── */
const L = []
const line = (s = '') => L.push(s)

line('═'.repeat(78))
line(`AI 识别精度实测报告（P1-C）`)
line(`样本文件：${samplePath}`)
line(`样本条数：${samples.length}`)
line(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)
line('═'.repeat(78))
line()

line('【一】各维度误差统计')
line()
const hdr = ['指标', 'n', 'MAPE%', 'WMAPE%', 'MAE', 'Bias', 'Bias%', '中位AE', '最差APE%']
line(hdr.join('\t'))
line('─'.repeat(78))
for (const s of allStats) {
  line([
    mape.METRIC_LABEL[s.metric],
    `${s.n}${s.excluded ? `(排除${s.excluded})` : ''}`,
    s.n ? s.mape.toFixed(2) : '—',
    s.n ? s.wmape.toFixed(2) : '—',
    s.n ? s.mae : '—',
    s.n ? `${s.bias > 0 ? '+' : ''}${s.bias}` : '—',
    s.n ? `${s.biasPct > 0 ? '+' : ''}${s.biasPct.toFixed(2)}` : '—',
    s.n ? s.medianAe : '—',
    s.n ? `${s.maxApe.toFixed(1)}${s.worstFood ? `(${s.worstFood})` : ''}` : '—',
  ].join('\t'))
}
line()

line('【二】诊断：改 prompt 还是换模型？')
line()
for (const s of allStats) {
  const d = mape.diagnose(s)
  const tag = { ok: '✅ 达标', systematic: '🔧 系统性偏差', random: '🔴 随机误差', insufficient: '⚠️ 样本不足' }[d.kind]
  line(`  ${tag}  ${mape.METRIC_LABEL[s.metric]}`)
  line(`       ${d.reason}`)
  line()
}

line('【三】按真值热量分档（定位哪类餐不准）')
line()
for (const b of bands) {
  line(`  ${b.label.padEnd(28)} n=${String(b.n).padStart(3)}  热量MAPE=${b.n ? b.mape.toFixed(2) + '%' : '—'}`)
}
line()

/* ── 决策建议（对齐审计计划 P1-C 的 15% 阈值）──
 * 🔴 不能只看 MAPE 是否 ≤15% 就下「达标」结论：热量系统性低估对减脂产品
 * 比随机误差危险得多（用户长期少记、减脂失败且归因不到工具）。
 * 故这里复用 diagnose()，与【二】保持同一判据，避免报告自相矛盾。 */
const kcal = allStats.find((s) => s.metric === 'calories')
const kcalDiag = kcal ? mape.diagnose(kcal) : null
line('【四】决策结论')
line()
if (!kcal || kcal.n === 0) {
  line('  ⚠️ 无有效热量样本，无法给出结论。请检查 samples 的 truth.calories 是否填写。')
} else if (kcalDiag.kind === 'insufficient') {
  line(`  ⚠️ ${kcalDiag.reason}`)
} else if (kcalDiag.kind === 'ok') {
  line(`  ✅ 热量 MAPE ${kcal.mape.toFixed(2)}% ≤ ${mape.THRESHOLDS.mapeOk}%，且 Bias ${kcal.biasPct.toFixed(2)}% 未超警戒线，达标。`)
  line(`     可用于营销表述，但**只能用 MAE**（平均差 ${kcal.mae} kcal）而非 MAPE ——`)
  line(`     「平均误差 ±${kcal.mae} kcal」是可核验的诚实说法，「精度 ${(100 - kcal.mape).toFixed(0)}%」不严谨。`)
} else if (kcalDiag.kind === 'systematic') {
  const mapeOk = kcal.mape <= mape.THRESHOLDS.mapeOk
  line(`  🔧 热量 MAPE ${kcal.mape.toFixed(2)}%${mapeOk ? '（≤15%，看似达标）' : `（> ${mape.THRESHOLDS.mapeOk}%，超标）`}，但存在系统性偏差：`)
  line(`     ${kcalDiag.reason}`)
  if (mapeOk) {
    line(`     ⚠️ 此状态下**不建议**做精度类营销：MAPE 达标掩盖了方向一致的偏移。`)
  } else {
    line(`     ⚠️ 未达标，**禁止**营销侧宣传「精准」。`)
  }
  line(`     处置：先调 prompt（明确纠正${kcal.biasPct > 0 ? '偏高' : '偏低'}倾向），复测后再决定是否换模型。`)
} else {
  line(`  🔴 热量 MAPE ${kcal.mape.toFixed(2)}% > ${mape.THRESHOLDS.mapeOk}%，且为随机误差，**未达标，禁止营销侧宣传「精准」**。`)
  line(`     ${kcalDiag.reason}`)
}
line()
line('═'.repeat(78))
line('口径说明：')
line('  · MAPE 排除真值为 0 的项（除零无定义），排除数已在 n 列括号中显式标出，未静默丢弃')
line('  · WMAPE = Σ|误差|/Σ真值，按量级加权，抗「小真值放大误差」，回答「这餐总热量差多少」')
line('  · Bias 是**有符号**均值，用于识别系统性偏差 —— MAPE 取绝对值会掩盖它')
line('  · MAE/Bias 含真值为 0 的样本（「AI 报 3g 而真值 0」是实打实的误差，不该消失）')
line('═'.repeat(78))

const report = L.join('\n')
console.log(report)

if (mdOut) {
  const mdPath = resolve(process.cwd(), mdOut)
  const md = [
    `# AI 识别精度实测报告（P1-C）`,
    '',
    `- 样本文件：\`${samplePath}\``,
    `- 样本条数：${samples.length}`,
    `- 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    '',
    '## 各维度误差统计',
    '',
    '| 指标 | n（排除） | MAPE% | WMAPE% | MAE | Bias | Bias% | 中位AE | 最差APE%（菜名） |',
    '| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |',
    ...allStats.map((s) =>
      `| ${mape.METRIC_LABEL[s.metric]} | ${s.n}${s.excluded ? `（${s.excluded}）` : ''} | ${s.n ? s.mape.toFixed(2) : '—'} | ${s.n ? s.wmape.toFixed(2) : '—'} | ${s.n ? s.mae : '—'} | ${s.n ? (s.bias > 0 ? '+' : '') + s.bias : '—'} | ${s.n ? (s.biasPct > 0 ? '+' : '') + s.biasPct.toFixed(2) : '—'} | ${s.n ? s.medianAe : '—'} | ${s.n ? s.maxApe.toFixed(1) + (s.worstFood ? `（${s.worstFood}）` : '') : '—'} |`,
    ),
    '',
    '## 诊断',
    '',
    ...allStats.map((s) => {
      const d = mape.diagnose(s)
      const tag = { ok: '✅ 达标', systematic: '🔧 系统性偏差（改 prompt）', random: '🔴 随机误差（换模型）', insufficient: '⚠️ 样本不足' }[d.kind]
      return `- **${mape.METRIC_LABEL[s.metric]}** ${tag}\n  - ${d.reason}`
    }),
    '',
    '## 按真值热量分档',
    '',
    '| 热量档 | 样本数 | 热量 MAPE% |',
    '| ---- | ---- | ---- |',
    ...bands.map((b) => `| ${b.label} | ${b.n} | ${b.n ? b.mape.toFixed(2) : '—'} |`),
    '',
    '## 口径说明',
    '',
    '- MAPE 排除真值为 0 的项（除零无定义），排除数显式报告，未静默丢弃。',
    '- WMAPE = Σ|误差|/Σ真值，按量级加权，抗小真值放大误差。',
    '- Bias 为**有符号**均值，用于识别系统性偏差（MAPE 取绝对值会掩盖它）。',
    '- 营销表述只能用 MAE（「平均误差 ±X kcal」），不可用「精度 X%」。',
    '',
  ].join('\n')
  writeFileSync(mdPath, md, 'utf8')
  console.log(`\n📄 Markdown 已写入：${mdPath}`)
}
