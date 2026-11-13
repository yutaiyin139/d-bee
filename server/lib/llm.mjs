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
import { cloudError, RateLimiter } from './http.mjs'
import { withUserIdentity } from './db.mjs'
import { getTokenVersion } from './identity.mjs'

/**
 * 服务端权益闸门（0039 P0-C 修复 + 安全审计③ fail-closed）。
 *
 * 为什么必须做：此前额度校验完全依赖客户端自觉调用 consume_photo_quota —— 
 * 直接 POST /.cloud/llm/chat/completions（带合法 JWT）即可无限用 AI，
 * 白烧 API key 费用。现在**视觉请求**由数据库 llm_gate 原子核销一条当日
 * 额度占用记录（ai_quota_claims）：正常前端流程「先 consume 后调 LLM」必然
 * 有 claim 可核销；绕过前端的裸调没有 claim → 落入包装识别日配额（有界）→ 拒绝。
 *
 * 0049 起文本也走 llm_gate：recap 仅 Pro，coach 文本问答不设日上限（免费用户
 * 每分钟 3 次防刷，Pro 不限），普通文字识别仍放行（另有进程内 textLimiter 兜底）。
 * 视觉无 claim 时改打 feature=package，
 * 日限额在 ai_usage，不再靠本进程内存计数（多网关实例会各自放行）。
 *
 * 🔴 fail-closed：llm_gate 查询异常 / 返回畸形 → 503（reason=gate_unavailable），
 *   避免把数据库抖动误报成「额度用尽」诱导付费。
 */
function inferTextFeature(messages) {
  const sys = Array.isArray(messages) ? messages.find((m) => m?.role === 'system') : null
  const text = typeof sys?.content === 'string' ? sys.content : ''
  if (text.includes('[dbee-feature:recap]')) return 'recap'
  if (text.includes('[dbee-feature:coach]')) return 'coach'
  return 'text'
}

async function llmGate(deps, ownerId, feature) {
  const { cfg, logger, pool } = deps
  if (!pool || cfg.llmGateEnabled === false) return { allowed: true, gate: 'disabled', feature }
  try {
    const gate = await withUserIdentity(pool, ownerId, async (q) => {
      const r = await q('SELECT public.llm_gate($1) AS g', [feature])
      return r.rows[0]?.g ?? null
    })
    if (gate && typeof gate === 'object') return { ...gate, gate: 'db' }
    logger.error(`[llm] llm_gate 返回异常形状，feature=${feature} 按 fail-closed 拒绝（请确认 0049 已应用）`)
    return { allowed: false, gate: 'db-anomaly', reason: 'gate_unavailable', feature }
  } catch (err) {
    logger.error(`[llm] llm_gate 查询失败 feature=${feature}，按 fail-closed 拒绝: ${err?.message || err}`)
    return { allowed: false, gate: 'db-error', reason: 'gate_unavailable', feature }
  }
}

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

/** 统计图片块数量（输入限制用） */
function countImages(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const p of m.content) if (p?.type === 'image_url') n += 1
    }
  }
  return n
}

/**
 * 输入规模校验（0039 性能/安全修复）。
 * 此前 body 无任何规模约束：客户端可以塞 60 条超长消息 + 几十张 base64 大图，
 * 单请求即可烧掉大量 token 费用并长时间占用流式连接。
 * @returns {string|null} 违规原因；null = 通过
 */
function validateInput(messages, est, cfg) {
  const maxMessages = cfg.llmMaxMessages || 60
  const maxImages = cfg.llmMaxImages || 4
  const maxTokens = cfg.llmMaxInputTokens || 32000
  if (messages.length > maxMessages) return `消息条数超限（>${maxMessages}）`
  const images = countImages(messages)
  if (images > maxImages) return `图片数量超限（${images}>${maxImages}）`
  if (est.input > maxTokens) return `输入规模超限（≈${est.input}>${maxTokens} token）`
  return null
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
  const { cfg, logger, gatewayPool } = deps
  const catalog = buildModelCatalog(cfg)
  // 在途流式请求计数（进程级）。SSE 长连接同时占用网关内存与上游并发额度，
  // 超过上限直接 429，避免慢请求堆积成雪崩。
  let activeStreams = 0
  // 🔴 安全审计③：文本独立日限额器（与视觉 usageLimiter 分开）。
  //   文字描述/计划走 llm_gate(text) 放行，若无此闸 = 免费通用 LLM 代理。
  const textLimiter = new RateLimiter({
    windowMs: 86_400_000,
    limit: Math.max(1, cfg.llmTextDailyCapPerUser || 50),
    maxKeys: 200_000,
  })
  // 文本问答不设每日次数。免费用户每分钟 3 次，与客户端 Coach 页一致；Pro 不走这里。
  const coachMinuteLimiter = new RateLimiter({
    windowMs: 60_000,
    limit: 3,
    maxKeys: 200_000,
  })

  async function authOwnerId(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    if (!v) return null
    const sub = v.payload?.sub
    if (typeof sub !== 'string' || !sub) return null
    // 🔴 安全审计①：token_version 校验（登出/改密后旧 access token 立即失效）
    if (gatewayPool && Number.isInteger(v.payload.ver)) {
      try {
        const cur = await getTokenVersion(gatewayPool, sub)
        if (cur == null || cur !== v.payload.ver) return null
      } catch (err) {
        logger.error(`[llm] token_version 查询失败，跳过版本校验: ${err?.message || err}`)
      }
    }
    return sub
  }

  return {
    catalog,

    /** GET /.cloud/llm/models */
    async listModels(req, res) {
      // 模型目录不含秘密，但仍要求登录：避免被当成公开探针刷
      const ownerId = await authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthenticated')
      if (!cfg.llmApiKey) return llmError(res, 503, 'LLM 未配置（缺 LLM_API_KEY）', 'llm_not_configured')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      // SDK 两种形状都接受：`Array.isArray(parsed) ? parsed : parsed.data`
      res.end(JSON.stringify({ object: 'list', data: catalog }))
    },

    /** POST /.cloud/llm/chat/completions —— 必须 SSE 流式 */
    async chatCompletions(req, res, body) {
      const ownerId = await authOwnerId(req)
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

      // ── 输入规模限制（0039：防超长 prompt / 多图烧钱）──────────
      const est = estimateTokens(body.messages)
      const violation = validateInput(body.messages, est, cfg)
      if (violation) {
        logger.warn(`[llm] owner=${ownerId} 输入超限被拒: ${violation}`)
        return llmError(res, 400, violation, 'input_too_large', 'invalid_request_error')
      }

      // ── 并发流上限（进程级）──────────────────────────────
      const maxStreams = cfg.llmMaxConcurrentStreams || 32
      if (activeStreams >= maxStreams) {
        res.setHeader('retry-after', '5')
        return llmError(res, 429, 'AI 服务当前繁忙，请稍后重试', 'too_many_streams')
      }

      // ── 每日用量兜底闸 ──────────────────────────────────
      // 数据库里另有 consume_ai_quota 做业务额度（3 免费 + 2 兑换）；
      // 这里是防「绕过业务额度直接打网关」的第二层。
      // 🔴 安全审计③：文本与视觉**分开限额**——文本不经过 llm_gate 业务额度，
      //   若共用宽松的 200/日，等于开放免费通用 LLM 代理；故文本走独立 textLimiter
      //   （默认 50/日），视觉才走 usageLimiter（默认 200/日）。
      const wantVisionReq = wantVision
      const textFeature = wantVisionReq ? '' : inferTextFeature(body.messages)
      // 问答不计入文字描述的每日兜底（默认 50）。否则付费墙写「不限次数」，第 51 次仍会被拒。
      if (textFeature !== 'coach') {
        const dayLimiter = wantVisionReq ? deps.usageLimiter : textLimiter
        if (dayLimiter) {
          const u = dayLimiter.hit(`llm:${ownerId}:${dayKey()}`)
          if (!u.ok) {
            res.setHeader('retry-after', String(u.retryAfterSec))
            return llmError(res, 429, '今日 AI 调用次数已达上限', 'rate_limited')
          }
        }
      }

      // ── 服务端权益闸门（0039 scan + 0049 分功能）───────────────
      // 视觉：先核销拍照 claim；没有 claim 再走 package 日限额（库内 ai_usage）。
      // 文本：按 system 标记 recap / coach / text 分别闸门。
      let gate
      if (wantVision) {
        gate = await llmGate(deps, ownerId, 'scan')
        if (!gate.allowed && gate.reason === 'quota_not_claimed') {
          gate = await llmGate(deps, ownerId, 'package')
        }
      } else {
        gate = await llmGate(deps, ownerId, textFeature)
      }
      if (textFeature === 'coach' && gate.allowed && !gate.pro) {
        const u = coachMinuteLimiter.hit(`coach:${ownerId}`)
        if (!u.ok) {
          res.setHeader('retry-after', String(u.retryAfterSec))
          return llmError(res, 429, '问得太快啦，请稍后再提问（免费版每分钟最多 3 次）', 'rate_limited')
        }
      }
      if (!gate.allowed) {
        if (gate.reason === 'gate_unavailable') {
          logger.error(`[llm] owner=${ownerId} 权益闸门不可用 feature=${gate.feature || '?'} fail-closed 拒绝`)
          return llmError(res, 503, 'AI 服务暂不可用，请稍后重试', 'gate_unavailable')
        }
        if (gate.reason === 'pro_required') {
          logger.info(`[llm] owner=${ownerId} 闸门拒绝 recap/Pro feature=${gate.feature}`)
          return llmError(res, 402, '该功能属于 Pro 会员，升级后可使用', 'pro_required')
        }
        logger.warn(`[llm] owner=${ownerId} 闸门拒绝 reason=${gate.reason || 'unknown'} feature=${gate.feature || '?'}`)
        if (gate.feature === 'package') {
          return llmError(res, 402, '今日包装识别次数已用完，请明日再试或升级 Pro', 'quota_exhausted')
        }
        return llmError(res, 402, '今日识别额度已用尽，请明日再试或升级 Pro', 'quota_exhausted')
      }

      activeStreams += 1
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

      // 🔴 视觉请求关闭上游「深度思考」（2026-11-01 生产实测修复「识别超 1 分钟」）。
      //   qwen3.8-max 默认开思考：实测 completion 3221 token 里 reasoning 占 3105（96%），
      //   单张餐食识别被拖到 30–60s+。看图报菜名不需要推理链，关思考后延迟与成本双降。
      //   enable_thinking 是百炼 OpenAI 兼容模式的 body 顶层参数；DeepSeek 上游会忽略它。
      //   仅视觉请求注入：文本走 DeepSeek，没有该参数概念，保持请求体最小集。
      if (wantVision) {
        upstreamBody.enable_thinking = cfg.llmVisionEnableThinking === true
      }

      const ac = new AbortController()
      // 耗时观测：识别慢的定性依据（2026-11-01「超 1 分钟」即缺此字段，只能靠 usage 反推）
      const startedAt = Date.now()
      // 客户端断开（用户切页/取消）→ 立刻取消上游请求，否则白烧 token
      const onClose = () => ac.abort()
      res.on('close', onClose)
      // 🔴 修复：旧代码 fetch 用的是 AbortSignal.timeout()，与 ac 完全独立 ——
      //    客户端断连后上游继续跑到超时，token 照烧。现在用 any() 合并：
      //    任一触发（断连 / 超时）都取消上游。
      const upstreamSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(cfg.llmTimeoutMs)])

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
          signal: upstreamSignal,
        })
      } catch (err) {
        res.off('close', onClose)
        activeStreams -= 1
        if (ac.signal.aborted) return // 客户端已走，无需回应
        logger.error(`[llm] 上游请求失败: ${err?.message || err}`)
        return llmError(res, 502, 'AI 服务暂不可用，请稍后重试', 'llm_upstream_error')
      }

      if (!upstreamRes.ok) {
        res.off('close', onClose)
        activeStreams -= 1
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
        activeStreams -= 1
      }

      // SDK 硬性要求：流必须以 [DONE] 结束，否则抛 gateway_stream_interrupted
      if (!ac.signal.aborted) {
        res.write('data: [DONE]\n\n')
        res.end()
      }

      logger.info(
        `[llm] owner=${ownerId} model=${model} 图=${est.images} 入≈${est.input}tok ` +
        `块=${chunks} 出≈${completionText}tok 耗时=${Date.now() - startedAt}ms` +
        `${usage ? ` usage=${JSON.stringify(usage)}` : ''}`,
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
