import { cloud } from '../cloud'
import { publicConfig } from '../cloudConfig'
import { createNativeFetch } from './originProxy'

export type LlmFeatureName = 'meal' | 'recap' | 'plan' | 'coach'

export class LlmFeatureError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'LlmFeatureError'
    this.code = code
  }
}

function parseSse(raw: string, onDelta?: (delta: string) => void): string {
  let text = ''
  for (const block of raw.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') continue
    try {
      const delta = JSON.parse(data)?.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) {
        text += delta
        onDelta?.(delta)
      }
    } catch {
      /* 忽略非 JSON 事件 */
    }
  }
  return text
}

/** 调网关自有功能路由。提示词由服务端拼，客户端只传数字和短字段。 */
export async function completeFeature(
  feature: LlmFeatureName,
  payload: Record<string, unknown>,
  onDelta?: (delta: string) => void,
): Promise<string> {
  const { data: session } = await cloud.auth.getSession()
  const accessToken = session?.accessToken
  if (!accessToken) throw new LlmFeatureError('请先登录', 'unauthenticated')

  const doFetch = createNativeFetch() ?? fetch
  const resp = await doFetch(`${publicConfig.endpoint}/.cloud/llm/features/${feature}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })

  const ctype = resp.headers.get('content-type') || ''
  if (!resp.ok || !ctype.includes('text/event-stream')) {
    const data = (await resp.json().catch(() => null)) as { error?: { message?: string; code?: string }; message?: string } | null
    const code = data?.error?.code || (resp.status === 402 ? 'pro_required' : resp.status === 503 ? 'gate_unavailable' : 'llm_error')
    const message = data?.error?.message || data?.message || 'AI 服务暂不可用，请稍后重试'
    throw new LlmFeatureError(message, code)
  }
  return parseSse(await resp.text(), onDelta)
}
