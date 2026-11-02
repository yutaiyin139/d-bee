#!/usr/bin/env node
/**
 * 用「项目当前配置的视觉模型」读取任意本地图片并输出描述。
 *
 * 为什么存在：会话所用模型可能收不到图（ViewImage 报 cannot receive images），
 * 而项目本身已配好一把可用的 Qwen-VL 密钥 —— 直接复用它，既解决读图需求，
 * 也顺带验证「这把密钥在真实业务图片上是否好用」。
 *
 * 与 vision-key-selftest.mjs 的分工：
 *   selftest  = 断言式自检（固定图 + 固定关键词，判通过/失败）
 *   describe  = 自由读图（任意图 + 自定义提示词，输出模型原文）
 *
 * 配置来源与 server/lib/config.mjs:200-206 的回落链**逐字对齐**，
 * 刻意不调用 loadConfig()：它会校验 JWT_SECRET 等全套必填项，读图用不着。
 *
 * 用法：
 *   node tools/vision-describe.mjs <图片路径> [提示词]
 *   node tools/vision-describe.mjs shot.png "转录所有文字"
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { loadDotEnv } from '../server/lib/config.mjs'

loadDotEnv()
const E = process.env
const t = (v) => (typeof v === 'string' ? v.trim() : '')

const baseUrl = (t(E.LLM_VISION_BASE_URL) || t(E.LLM_BASE_URL) || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
const apiKey = t(E.LLM_VISION_API_KEY) || t(E.LLM_API_KEY) || ''
const model = t(E.LLM_VISION_MODEL) || t(E.LLM_MODEL_VISION) || 'deepseek-flash'
const detail = (t(E.LLM_IMAGE_DETAIL) || 'high').toLowerCase()

if (!apiKey) {
  console.error('[x] 未配置 LLM_VISION_API_KEY / LLM_API_KEY')
  process.exit(2)
}

const imgPath = resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(imgPath)) {
  console.error(`[x] 图片不存在：${imgPath || '(未提供路径)'}`)
  console.error('用法：node tools/vision-describe.mjs <图片路径> [提示词]')
  process.exit(2)
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}
const mime = MIME[extname(imgPath).toLowerCase()] || 'image/png'
const b64 = readFileSync(imgPath).toString('base64')

const prompt = process.argv[3]
  || '请详细描述这张图片：逐字转录所有可见文字（保留原始层级与标点），并说明界面元素、布局、报错信息或配置项。'

console.error(`· 图片 ${imgPath}`)
console.error(`· ${Math.round(b64.length / 1024)} KB(base64) · model=${model} · detail=${detail}`)
console.error(`· base url=${baseUrl}`)
console.error(`· api key=${apiKey.slice(0, 4)}…${apiKey.slice(-3)}（len=${apiKey.length}，已掩码）`)
console.error('· 调用中…')

const t0 = Date.now()
// 请求体与 server/lib/llm.mjs:333-366 逐字段对齐（含 enable_thinking=false，
// 避免混合思考模型把「看图」拖成 30-60s，见 config.mjs 的 11-01 血泪注释）
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail } },
      ],
    }],
  }),
})

if (!res.ok) {
  const body = (await res.text()).slice(0, 800)
  console.error(`[x] HTTP ${res.status} ${res.statusText}\n${body}`)
  process.exit(1)
}

let answer = ''
let usage = null
let finishReason = null
for (const line of (await res.text()).split(/\r?\n/)) {
  if (!line.startsWith('data:')) continue
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') continue
  let json
  try { json = JSON.parse(payload) } catch { continue }
  const d = json?.choices?.[0]?.delta
  if (typeof d?.content === 'string') answer += d.content
  if (json?.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason
  if (json?.usage) usage = json.usage
}

console.error(`· HTTP 200 · ${((Date.now() - t0) / 1000).toFixed(1)}s · finish=${finishReason ?? '?'}`
  + (usage ? ` · tokens prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}` : ''))
if (!answer.trim()) {
  console.error('[x] 回答为空 —— 密钥可能过了认证但模型没产出')
  process.exit(1)
}
console.error('─'.repeat(60))
console.log(answer.trim())
