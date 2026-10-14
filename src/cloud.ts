import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'
import { publicConfig } from './cloudConfig'

/**
 * 全局唯一的云服务客户端。
 * endpoint / publishableKey / oauthRelayBaseUrl 全部来自 publicConfig，禁止硬编码或改写。
 * Auth / Database / Storage / LLM 四个模块共用这一个实例。
 */
export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
})
