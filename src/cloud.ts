import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'
import { publicConfig } from './cloudConfig'
import { createNativeFetch } from './lib/originProxy'

/**
 * 原生端专属的 fetch 注入（方案 B）。
 *
 * 云端按 Origin 精确匹配校验客户端，而浏览器不允许 JS 设置 Origin 请求头
 * （forbidden header name，实测会被 Request 构造过滤），原生端又没有 Nginx
 * 代为覆写 —— 所以让云 SDK 的请求经 OriginProxy 插件在**原生层**转发，
 * 由原生 HTTP 栈补上 Origin/Referer。详见 src/lib/originProxy.ts。
 *
 * Web 端 `createNativeFetch()` 返回 undefined，SDK 用默认全局 fetch，
 * 请求路径、产物体积、行为**完全不变**。
 */
const nativeFetch = createNativeFetch()

/**
 * 全局唯一的云服务客户端。
 * endpoint / publishableKey / oauthRelayBaseUrl 全部来自 publicConfig，禁止硬编码或改写。
 * Auth / Database / Storage / LLM 四个模块共用这一个实例。
 */
export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
  ...(nativeFetch ? { fetch: nativeFetch } : {}),
})
