/**
 * 对外分享链接的单一真源。
 *
 * 🔴 为什么不能用 `location.origin` 直接拼：
 *   在 Capacitor 原生壳里 `location.origin` 是 `capacitor://localhost`（iOS）
 *   或 `https://localhost`（Android，server.androidScheme=https）。拼出来的邀请链接
 *   印在分享卡上、或复制进口令发到微信/钉钉后，好友点开必然打不开 —— 它指向的是
 *   好友自己设备上的一个不存在的本地地址。Web 端 `location.origin` 恰好是公网域名，
 *   所以这个缺陷只在原生端暴露，很容易漏测。
 *
 * 口径与 `src/cloudConfig.ts` 的 PRODUCTION_NATIVE_ENDPOINT 同源（https://d-bee.cn）。
 * 这里刻意独立声明而非 import cloudConfig：后者带运行时环境校验副作用，
 * 分享链接只是纯展示数据，不该被拉进启动链路。
 */

/** 本站对外可访问的公网源（唯一权威） */
export const PUBLIC_SITE_ORIGIN = 'https://d-bee.cn'

/**
 * 把运行时 origin 归一化为「对外可用」的源。
 * 仅 http(s) 且非本机/内网地址的 origin 才保留；其余一律回落到公网站点。
 */
export function publicSiteOrigin(origin: string | null | undefined): string {
  if (!origin) return PUBLIC_SITE_ORIGIN
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return PUBLIC_SITE_ORIGIN
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return PUBLIC_SITE_ORIGIN
  const host = u.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  ) {
    return PUBLIC_SITE_ORIGIN
  }
  return u.origin
}

/**
 * 生成邀请链接：`https://d-bee.cn/?invite=CODE`。
 * @param code 邀请码（调用侧已生成，本函数只负责编码）
 * @param origin 运行时 location.origin；不传时自动读取（Web 与原生壳都适用）
 */
export function buildInviteLink(code: string, origin?: string | null): string {
  const runtimeOrigin =
    origin !== undefined && origin !== null
      ? origin
      : typeof window !== 'undefined'
        ? window.location.origin
        : ''
  return `${publicSiteOrigin(runtimeOrigin)}/?invite=${encodeURIComponent(code)}`
}
