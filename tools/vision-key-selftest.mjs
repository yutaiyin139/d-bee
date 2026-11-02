/**
 * 视觉模型 API Key 连通性自测（真实打上游，非 mock）。
 *
 * ── 为什么不能复用 gateway-selftest.mjs ──────────────────────────────
 * 那套是**离线 mock**（自述「不需真数据库、不需网络」），视觉断言只到
 * 「502（到达上游）」，且用 1×1 假图 `data:image/png;base64,iVBORw0KGgo=`。
 * 它能验协议与闸门，**验不了 apikey 是否可用**：假图 + 不真发请求 = 密钥错了也过。
 *
 * ── 本脚本的做法 ─────────────────────────────────────────────────────
 * 复用网关**自己的配置解析**（loadDotEnv/loadConfig）与**自己的请求形状**
 * （stream:true + stream_options.include_usage + enable_thinking + image detail），
 * 直连视觉 provider 打一次真图，因此「测的就是线上实际会走的路径」。
 * 与 llm.mjs:333-366 的 upstreamBody 逐字段对齐；如那边改了，这里要跟改。
 *
 * 用含已知文字的截图作测试图：不只看「密钥能过认证」，还验证模型**真的看懂了**
 * （回答里应出现图中实际存在的关键词），避免「200 但返回空/乱码」被误判为可用。
 *
 * 🔒 密钥纪律：全程只打印掩码（长度 + 前 4 + 后 3），绝不输出完整 key。
 *
 * 运行：node tools/vision-key-selftest.mjs [图片路径]
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadDotEnv } from '../server/lib/config.mjs'

const mask = (s) =>
  typeof s === 'string' && s.length >= 8 ? `${s.slice(0, 4)}…${s.slice(-3)}（len=${s.length}）` : '(空)'

let passed = 0
let failed = 0
const assert = (label, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n== ${t} ==`)

// ── 1) 配置加载（与网关同源：process.env 优先，其次项目根 .env）──────
// ⚠️ 刻意**不调** loadConfig()：它会校验 JWT_SECRET / 数据库等一整套必填项，
//    而本脚本只需要视觉三个键，跑全套校验会因缺 JWT_SECRET 直接抛错退出。
//    下面按 config.mjs:200-221 的**同一条回落链**取值，语义与网关一致：
//      llmVisionBaseUrl = LLM_VISION_BASE_URL || LLM_BASE_URL || deepseek
//      llmVisionApiKey  = LLM_VISION_API_KEY  || LLM_API_KEY
//      llmVisionModel   = LLM_VISION_MODEL    || LLM_MODEL_VISION || deepseek-flash
section('1 · 配置加载（复用 config.mjs 的 .env 解析与回落链）')
const envInfo = loadDotEnv()
assert('根 .env 存在并被解析', envInfo.applied > 0 || existsSync(envInfo.path), envInfo.path)
const E = process.env
const t = (v) => (typeof v === 'string' ? v.trim() : '')
const baseUrl = (t(E.LLM_VISION_BASE_URL) || t(E.LLM_BASE_URL) || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
const apiKey = t(E.LLM_VISION_API_KEY) || t(E.LLM_API_KEY) || ''
const model = t(E.LLM_VISION_MODEL) || t(E.LLM_MODEL_VISION) || 'deepseek-flash'
const cfg = {
  llmVisionBaseUrl: baseUrl,
  llmBaseUrl: baseUrl,
  llmVisionApiKey: apiKey,
  llmVisionModel: model,
  llmImageDetail: (t(E.LLM_IMAGE_DETAIL) || 'high').toLowerCase(),
  llmVisionEnableThinking: /^(1|true|yes|on)$/i.test(t(E.LLM_VISION_ENABLE_THINKING)),
  llmTimeoutMs: Number.parseInt(t(E.LLM_TIMEOUT_MS), 10) || 120000,
}

console.log(`  · 视觉 base url : ${baseUrl}`)
console.log(`  · 视觉 model    : ${model}`)
console.log(`  · 视觉 api key  : ${mask(apiKey)}`)
console.log(`  · key 来源      : ${t(E.LLM_VISION_API_KEY) ? 'LLM_VISION_API_KEY（独立视觉密钥）' : 'LLM_API_KEY（回落文本密钥）'}`)
console.log(`  · image detail  : ${cfg.llmImageDetail}`)
console.log(`  · enable_thinking: ${cfg.llmVisionEnableThinking === true}`)
assert('视觉 base url 非空', typeof baseUrl === 'string' && baseUrl.startsWith('http'))
assert('视觉 api key 已配置（缺则网关会返 503 vision_not_configured）', !!apiKey)
assert('视觉 model 非空', typeof model === 'string' && model.length > 0)

// ── 2) 测试图（默认用含中文文字的隐私政策截图）──────────────────────
section('2 · 测试图准备')
const DEFAULT_IMG = resolve('deploy/screenshots/legal-150.158.51.106-隐私政策.png')
const imgPath = resolve(process.argv[2] || DEFAULT_IMG)
if (!existsSync(imgPath)) {
  console.log(`  ✗ 测试图不存在：${imgPath}`)
  console.log('    用法：node tools/vision-key-selftest.mjs <图片路径>')
  process.exit(1)
}
const imgB64 = readFileSync(imgPath).toString('base64')
const dataUrl = `data:image/png;base64,${imgB64}`
console.log(`  · 图片：${imgPath}`)
console.log(`  · 原始 ${(imgB64.length * 0.75 / 1024).toFixed(0)} KB → base64 ${(imgB64.length / 1024).toFixed(0)} KB`)
// llm.mjs:141 maxTokens 默认 32000；每图固定按 384 token 估（estimateTokens），
// 但 base64 体积过大仍可能拖慢/超限，这里给个软上限提示。
assert('base64 体积在可用范围（<5 MB）', imgB64.length < 5 * 1024 * 1024, `${(imgB64.length / 1024).toFixed(0)} KB`)

// ── 3) 真实请求（请求体与 llm.mjs 的 upstreamBody 逐字段对齐）────────
section('3 · 真实上游调用（stream + include_usage）')
const upstreamBody = {
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张截图里出现的中文标题是什么？只回答标题本身，不要解释。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ],
  stream: true,
  temperature: 0.2,
  stream_options: { include_usage: true },
}
// 与 llm.mjs:345-357 一致：detail 仅在非 auto 时注入
if (cfg.llmImageDetail && cfg.llmImageDetail !== 'auto') {
  upstreamBody.messages[0].content[1].image_url.detail = cfg.llmImageDetail
}
// 与 llm.mjs:364-366 一致：视觉请求总是注入 enable_thinking（默认 false）
upstreamBody.enable_thinking = cfg.llmVisionEnableThinking === true

const startedAt = Date.now()
let res
try {
  res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(cfg.llmTimeoutMs || 120000),
  })
} catch (err) {
  console.log(`  ✗ 请求发出即失败：${err?.name || ''} ${err?.message || err}`)
  console.log('    可能原因：网络/代理不通、DNS 解析失败、base url 写错、TLS 握手失败')
  console.log(`\n结果：通过 ${passed} · 失败 ${failed + 1}`)
  process.exit(1)
}
const elapsed = Date.now() - startedAt
console.log(`  · HTTP ${res.status} ${res.statusText} · 耗时 ${(elapsed / 1000).toFixed(1)}s`)

if (!res.ok) {
  const text = await res.text()
  // 上游错误体可能回显请求内容，只截前 600 字，且掩掉可能出现的 key
  const safe = text.slice(0, 600).split(apiKey).join(mask(apiKey))
  console.log(`  ✗ 上游返回非 2xx：\n${safe}`)
  const hint = {
    401: '🔴 API Key 无效或已被吊销（401）—— 这是本次要测的核心结论',
    403: '🔴 Key 有效但无权限（403）：常见于工作空间不匹配、模型未开通、或欠费',
    404: '🔴 模型 ID 或 base url 不对（404）：核对 LLM_MODEL_VISION / LLM_VISION_BASE_URL',
    429: '🟡 限流（429）：Key 大概率可用，稍后重试或查配额',
    400: '🟡 请求体不被接受（400）：可能是模型名/参数不兼容，看下方错误详情',
  }[res.status]
  if (hint) console.log(`  ${hint}`)
  console.log(`\n结果：通过 ${passed} · 失败 ${failed + 1}`)
  process.exit(1)
}
assert('HTTP 2xx（密钥通过认证）', true)

// ── 4) 解析 SSE 流：取回答文本 + usage（与网关一样消费流式响应）──────
section('4 · 响应内容校验（不只看 200，要确认模型真看懂了）')
const raw = await res.text()
const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'))
let answer = ''
let usage = null
let reasoning = 0
let finishReason = null
for (const line of lines) {
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') continue
  let json
  try {
    json = JSON.parse(payload)
  } catch {
    continue
  }
  const delta = json?.choices?.[0]?.delta
  if (typeof delta?.content === 'string') answer += delta.content
  // 思考链单独计数：若 reasoning_tokens 占比很高，说明 enable_thinking 没生效
  const rt = json?.choices?.[0]?.delta?.reasoning_content
  if (typeof rt === 'string') reasoning += rt.length
  if (json?.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason
  if (json?.usage) usage = json.usage
}

console.log(`  · SSE 分片：${lines.length} 个`)
console.log(`  · finish_reason：${finishReason ?? '(未回传)'}`)
console.log(`  · 模型回答：${JSON.stringify(answer.trim().slice(0, 200))}`)
if (usage) {
  console.log(`  · usage：prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`)
  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    console.log(`  · reasoning_tokens：${usage.completion_tokens_details.reasoning_tokens}`)
  }
}

assert('流里有内容分片', lines.length > 0)
assert('回答非空（200 但空回答 = 不可用）', answer.trim().length > 0)
// 图中确实存在的文字：文件名与页面标题都含「隐私政策」
assert('回答命中图中实际关键词「隐私」→ 模型真的看懂了图', /隐私/.test(answer), answer.trim().slice(0, 80))
assert('finish_reason 正常结束（非 length 截断）', finishReason !== 'length', String(finishReason))
// 11-01 生产修复过「识别超 1 分钟」：思考占比过高说明 enable_thinking=false 未生效
if (usage?.completion_tokens_details?.reasoning_tokens !== undefined) {
  const rt = usage.completion_tokens_details.reasoning_tokens
  const ct = usage.completion_tokens || 1
  assert('reasoning 占比不高（enable_thinking=false 已生效）', rt / ct < 0.5, `${rt}/${ct}`)
}

section('结果')
console.log(`  通过 ${passed} · 失败 ${failed} · 耗时 ${(elapsed / 1000).toFixed(1)}s`)
process.exit(failed === 0 ? 0 : 1)
