import Taro from '@tarojs/taro'
import { cloud, publicConfig } from './cloud'

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
  let accessToken = ''
  try {
    const { data } = await cloud.auth.getSession()
    accessToken = data?.accessToken ?? ''
  } catch {
    accessToken = ''
  }
  if (!accessToken) throw new LlmFeatureError('请先登录', 'unauthenticated')

  let res: Taro.request.SuccessCallbackResult<string | { error?: { message?: string; code?: string }; message?: string }>
  try {
    res = await Taro.request({
      url: `${publicConfig.endpoint}/.cloud/llm/features/${feature}`,
      method: 'POST',
      timeout: 60000,
      dataType: 'text',
      responseType: 'text',
      header: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      data: payload,
    })
  } catch {
    throw new LlmFeatureError('AI 服务暂不可用，请稍后重试', 'gate_unavailable')
  }

  const status = res?.statusCode ?? 0
  const raw = res?.data
  const text = typeof raw === 'string' ? raw : ''
  if (status < 200 || status >= 300 || !text.includes('data:')) {
    let parsed: { error?: { message?: string; code?: string }; message?: string } | null = null
    if (raw && typeof raw === 'object') parsed = raw
    else if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = null }
    }
    const code = parsed?.error?.code || (status === 402 ? 'pro_required' : status === 503 || status === 0 ? 'gate_unavailable' : 'llm_error')
    const message = parsed?.error?.message || parsed?.message || 'AI 服务暂不可用，请稍后重试'
    throw new LlmFeatureError(message, code)
  }
  return parseSse(text, onDelta)
}
