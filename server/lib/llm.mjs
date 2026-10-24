/**
 * A3 · LLM 代理（DeepSeek）。
 *
 * 端点（对齐 SDK 的 ModelsAPI / ChatCompletionsAPI）：
 *   GET  /.cloud/llm/models            → { data: [...] } 或裸数组（SDK 两者都接受）
 *   POST /.cloud/llm/chat/completions  → SSE 流式
 *
 * ── 三个必须遵守的前端契约（逆向 ai.ts + SDK 确认）────────────────────
 *  1. `pickModel(needVision)` 是 `usable.filter(m => m.supportsImages === true)`
 *     再取 `isDefault`。**缺 supportsImages 字段 → 拍照识别直接报
 *     「暂无支持图片识别的模型」**。所以 flash 必须显式标 supportsImages:true。
 *  2. 过滤条件是 `m.disabled !== true && m.enabled !== false` → 不要设这两个字段，
 *     或设成 disabled:false / enabled:true。
 *  3. SDK 的 `create()` **强制 stream:true**（非流式直接抛
 *     request_stream_required），且 `iterSSEEvents` 解析标准 SSE；
 *     流必须以 `data: [DONE]` 结束，否则 SDK 抛 gateway_stream_interrupted。
 *     前端 `collectText` 只读 `chunk.choices[0].delta.content`。
 *
 * ── DeepSeek 侧三个坑（2026-10-22 查官方文档实测，见计划文档 §A3）────
 *  1. `deepseek-chat` / `deepseek-reasoner` **已于 2026-07-24 退役**，
 *     官方只剩 `deepseek-flash` 与 `deepseek-v4-pro`。
 *  2. **只有 flash 系列接受图片**；传图给其他模型返
 *     400 "This model does not support image"。→ 文本与视觉统一用 flash。
 *  3. 峰值时段（北京时间工作日 9–12、14–18 点）价格 2 倍。成本测算见计划文档 §A3。
 */
import { verifyJwt, bearerFrom } from './jwt.mjs'
import { cloudError } from './http.mjs'

/**
 * 模型目录。id 必须是上游真实可用的模型 ID。
 *
 * 文本与视觉模型**分开暴露**：前端 `pickModel(needVision=true)` 会取
 * `supportsImages === true` 的模型，因此视觉模型单独列一条，指向视觉 provider
 * 的模型（默认 deepseek-flash，可切 qwen-vl-max）。文本模型照旧。
 */
function buildModelCatalog(cfg) {
  const textModel = cfg.llmModelText || 'deepseek-flash'
  const visionModel = cfg.llmVisionModel || cfg.llmModelVision || 'deepseek-flash'
  return [
    {
      id: textModel,
      name: 'Text',
      object: 'model',
      owned_by: 'text',
      supportsImages: false,
      isDefault: true,
      disabled: false,
      enabled: true,
      contextWindow: 128000,
      disabledMultimodal: false,
    },
    {
      id: visionModel,
      name: 'Vision',
      object: 'model',
      owned_by: 'vision',
      supportsImages: true, // ← 契约①：缺此字段拍照识别必坏
      isDefault: false,
      disabled: false,
      enabled: true,
      contextWindow: 128000,
      disabledMultimodal: false,
    },
  ]
}

/** 把 OpenAI 风格错误包装成 SDK httpError 能解析的形状 */
function llmError(res, status, message, code = null, type = 'server_error') {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: { message, type, param: null, code } }))
}

/** 判断消息里是否含图片（决定用哪个模型 + 是否要校验） */
function hasImageContent(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'),
  )
}

/**
 * 粗略 token 估算，仅用于日志与成本观测（不用于计费）。
 * 中文按 1 字 ≈ 1 token，其他按 4 字符 ≈ 1 token；每图固定 384（DeepSeek 官方上限）。
 */
function estimateTokens(messages) {
  let n = 0
  let images = 0
  for (const m of messages ?? []) {
    if (typeof m?.content === 'string') {
      n += estimateText(m.content)
    } else if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (p?.type === 'text') n += estimateText(p.text ?? '')
        else if (p?.type === 'image_url') images += 1
      }
    }
  }
  return { input: n + images * 384, images }
}
function estimateText(s) {
  if (!s) return 0
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk + Math.ceil((s.length - cjk) / 4)
}

export function createLlmHandlers(deps) {
  const { cfg, logger } = deps
  const catalog = buildModelCatalog(cfg)

  function authOwnerId(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    return typeof v?.payload?.sub === 'string' && v.payload.sub ? v.payload.sub : null
  }

  return {
    catalog,

    /** GET /.cloud/llm/models */
    async listModels(req, res) {
      // 模型目录不含秘密，但仍要求登录：避免被当成公开探针刷
      const ownerId = authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthenticated')
      if (!cfg.llmApiKey) return llmError(res, 503, 'LLM 未配置（缺 LLM_API_KEY）', 'llm_not_configured')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      // SDK 两种形状都接受：`Array.isArray(parsed) ? parsed : parsed.data`
      res.end(JSON.stringify({ object: 'list', data: catalog }))
    },

    /** POST /.cloud/llm/chat/completions —— 必须 SSE 流式 */
    async chatCompletions(req, res, body) {
      const ownerId = authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthenticated')
      if (!cfg.llmApiKey) return llmError(res, 503, 'LLM 未配置（缺 LLM_API_KEY）', 'llm_not_configured')

      // body 由 app.mjs 的 wrap() 统一读取并解析后作为第三参传入。
      // ⚠️ 不要在这里再次 readBody(req)：请求流已被 wrap 消费并 'end'，
      //    二次读取等不到任何 data/end 事件 → Promise 永不 resolve → 挂死。
      if (!body || typeof body !== 'object') body = {}

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return llmError(res, 400, 'messages 不能为空', 'invalid_request', 'invalid_request_error')
      }

      // ── 模型名白名单校验 + 视觉/文本 provider 路由 ──────────
      // 客户端传来的 model 必须在目录里。放行任意 model 等于把 API key
      // 变成「可调上游全部模型（含贵价模型）」的开放代理。
      const wantVision = hasImageContent(body.messages)
      const allowed = new Set(catalog.map((m) => m.id))
      // 前端可能传缓存里的旧模型名（zm_model_cache）；不在白名单就回落到目录默认模型，
      // 而不是报错 —— 否则改一次模型配置会让所有老客户端的拍照功能挂掉。
      let model = typeof body.model === 'string' && allowed.has(body.model) ? body.model : catalog[0].id

      // 视觉请求走独立的视觉 provider（base url + key + model），文本走默认 provider。
      // 这样视觉识别可单独切到更强的 Qwen-VL，而文本仍走 DeepSeek flash。
      let upstreamBaseUrl = cfg.llmBaseUrl
      let upstreamApiKey = cfg.llmApiKey
      if (wantVision) {
        const visionModel = catalog.find((m) => m.supportsImages === true)?.id
        if (!visionModel) return llmError(res, 503, '服务端未配置支持图片的模型', 'no_vision_model')
        model = visionModel
        upstreamBaseUrl = cfg.llmVisionBaseUrl || cfg.llmBaseUrl
        upstreamApiKey = cfg.llmVisionApiKey || cfg.llmApiKey
        if (!upstreamApiKey) return llmError(res, 503, '视觉模型未配置（缺 API Key）', 'vision_not_configured')
      }

      // ── 每日用量兜底闸 ──────────────────────────────────
      // 数据库里另有 consume_ai_quota 做业务额度（3 免费 + 2 兑换）；
      // 这里是防「绕过业务额度直接打网关」的第二层，阈值宽松（默认 200/日）。
      if (deps.usageLimiter) {
        const u = deps.usageLimiter.hit(`llm:${ownerId}:${dayKey()}`)
        if (!u.ok) {
          res.setHeader('retry-after', String(u.retryAfterSec))
          return llmError(res, 429, '今日 AI 调用次数已达上限', 'rate_limited')
        }
      }

      const est = estimateTokens(body.messages)
      const upstreamBody = {
        model,
        messages: body.messages,
        stream: true, // 上游也开流，逐块透传，避免网关侧缓冲整个响应
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
        ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
        // 让上游回 usage，便于成本观测
        stream_options: { include_usage: true },
      }

      // 视觉请求：给图片块加 detail 控制（Qwen-VL 支持 low/high/original）。
      // 食物识别需看清细节，默认 high；高并发/省钱场景可经 LLM_IMAGE_DETAIL=low 降级。
      if (wantVision && cfg.llmImageDetail && cfg.llmImageDetail !== 'auto') {
        const detail = cfg.llmImageDetail
        const withDetail = body.messages.map((m) => {
          if (!Array.isArray(m?.content)) return m
          const content = m.content.map((p) =>
            p?.type === 'image_url' && p?.image_url && typeof p.image_url === 'object'
              ? { ...p, image_url: { ...p.image_url, detail } }
              : p,
          )
          return { ...m, content }
        })
        upstreamBody.messages = withDetail
      }

      const ac = new AbortController()
      // 客户端断开（用户切页/取消）→ 立刻取消上游请求，否则白烧 token
      const onClose = () => ac.abort()
      res.on('close', onClose)

      let upstreamRes
      try {
        upstreamRes = await fetch(`${upstreamBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${upstreamApiKey}`,
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(cfg.llmTimeoutMs),
        })
      } catch (err) {
        res.off('close', onClose)
        if (ac.signal.aborted) return // 客户端已走，无需回应
        logger.error(`[llm] 上游请求失败: ${err?.message || err}`)
        return llmError(res, 502, 'AI 服务暂不可用，请稍后重试', 'llm_upstream_error')
      }

      if (!upstreamRes.ok) {
        res.off('close', onClose)
        const text = await upstreamRes.text().catch(() => '')
        // 把上游的真实原因记进日志（DeepSeek 的 400 常含「模型不支持图片」这类关键信息）
        logger.error(`[llm] 上游 ${upstreamRes.status} model=${model}: ${text.slice(0, 500)}`)
        let msg = 'AI 服务返回错误'
        try {
          msg = JSON.parse(text)?.error?.message || msg
        } catch { /* 保持默认文案 */ }
        // 不透传上游原文给客户端：可能含账号/计费信息
        return llmError(res, upstreamRes.status >= 500 ? 502 : upstreamRes.status, msg, 'llm_error')
      }

      // ── SSE 透传 ────────────────────────────────────────
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx 侧还需 proxy_buffering off（见 deploy/nginx.conf.example），
        // 这个头是告诉中间的 X-Accel 层别缓冲
        'x-accel-buffering': 'no',
      })

      let chunks = 0
      let completionText = 0
      let usage = null
      try {
        const reader = upstreamRes.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // 按 SSE 事件边界（空行）切分；保留最后不完整的一段等下一轮
          let sep
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const rawEvent = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            const out = forwardEvent(rawEvent)
            if (out === null) continue
            chunks += 1
            completionText += out
            res.write(rawEvent.endsWith('\n') ? `${rawEvent}\n` : `${rawEvent}\n\n`)
          }
        }
        // 冲刷尾部
        if (buf.trim()) {
          const out = forwardEvent(buf)
          if (out !== null) {
            chunks += 1
            completionText += out
            res.write(buf.endsWith('\n') ? buf : `${buf}\n\n`)
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) logger.error(`[llm] 流式读取中断: ${err?.message || err}`)
      } finally {
        res.off('close', onClose)
      }

      // SDK 硬性要求：流必须以 [DONE] 结束，否则抛 gateway_stream_interrupted
      if (!ac.signal.aborted) {
        res.write('data: [DONE]\n\n')
        res.end()
      }

      logger.info(
        `[llm] owner=${ownerId} model=${model} 图=${est.images} 入≈${est.input}tok ` +
        `块=${chunks} 出≈${completionText}tok${usage ? ` usage=${JSON.stringify(usage)}` : ''}`,
      )

      /**
       * 处理单个 SSE 事件：
       *  · `data: [DONE]` → 不重复转发（网关自己在末尾补发，避免两个 DONE）
       *  · `event: error` → 转成 SDK 能识别的错误事件
       *  · 普通 chunk → 统计 delta.content 长度
       * @returns {number|null} 本事件贡献的文本长度；null = 不转发
       */
      function forwardEvent(rawEvent) {
        const lines = rawEvent.split('\n')
        let dataStr = ''
        for (const line of lines) {
          if (line.startsWith('data:')) dataStr += line.slice(5).trim()
        }
        if (!dataStr) return 0
        if (dataStr === '[DONE]') return null // 网关末尾统一补发
        try {
          const obj = JSON.parse(dataStr)
          if (obj?.usage) usage = obj.usage
          const delta = obj?.choices?.[0]?.delta?.content
          return typeof delta === 'string' ? delta.length : 0
        } catch {
          return 0
        }
      }
    },
  }
}

/** Asia/Shanghai 的日期键，与数据库 todayKey() 口径一致（额度按北京时间算） */
function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}
