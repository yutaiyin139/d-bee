/**
 * 小程序调自建网关端点的公共请求器（WX-2，2026-11-17）。
 *
 * 从 mini/src/lib/xpay.ts 的 post() 范式抽出，供微信运动同步等**新增**端点复用，
 * 避免每接一个端点就复制一遍「Bearer + Taro.request + 错误归一」。
 * 🔴 刻意**不改** xpay.ts —— 支付链路已在生产验证，零回归原则下不动它；
 *   本模块是并联的新工具，两条链路共用同一 cloud/publicConfig 真相源。
 */
import Taro from '@tarojs/taro'
import { cloud, publicConfig } from './cloud'

/** 网关 CloudError 形状（server/lib/http.mjs cloudError） */
export interface GatewayErrorBody {
  message?: string
  error?: string
}

export class GatewayError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 单次网关请求超时（ms） */
const HTTP_TIMEOUT_MS = 12_000

async function accessToken(): Promise<string> {
  try {
    const { data } = await cloud.auth.getSession()
    return data?.accessToken ?? ''
  } catch {
    return ''
  }
}

/**
 * POST 到自建网关端点（带 Bearer）。
 * @throws GatewayError（4xx/5xx 或网络异常均转成它，调用方按 code/status 分流）
 */
export async function gatewayPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await accessToken()
  if (!token) throw new GatewayError(401, 'unauthorized', '未登录或登录已过期')

  let res: Taro.request.SuccessCallbackResult<GatewayErrorBody | T>
  try {
    res = await Taro.request<GatewayErrorBody | T>({
      url: `${publicConfig.endpoint}${path}`,
      method: 'POST',
      timeout: HTTP_TIMEOUT_MS,
      header: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      data: body,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new GatewayError(0, 'network', `网络连接失败，请检查网络后重试（${msg.slice(0, 40)}）`)
  }

  const status = res?.statusCode ?? 0
  if (status >= 200 && status < 300) return res.data as T

  const errBody = (res?.data ?? {}) as GatewayErrorBody
  throw new GatewayError(
    status,
    typeof errBody.error === 'string' && errBody.error ? errBody.error : 'http_error',
    typeof errBody.message === 'string' && errBody.message ? errBody.message : `请求失败（${status}）`,
  )
}
