/**
 * 原生端连接自检面板（仅原生 App 渲染）。
 *
 * 为什么需要它：阶段 1 的成败判定点是「登录后首页能否读到云端数据」。
 * 一旦读不到，现象只有一个「加载失败」，而可能的原因有五六种
 * （fetch 未被 Capacitor 接管 / endpoint 取错 / 证书与 ATS / 无网络 / apikey 被 CORS 拦…），
 * 只能连 USB 翻 logcat 逐个排除，成本极高。
 *
 * 本面板把这几层状态一次性摊开在屏幕上，并把结构化结果同时写进 console
 * （Capacitor 的 Console 插件会转发到 logcat，标签 `Capacitor/Console`），
 * 因此既能用肉眼看，也能用 `adb logcat | grep d-bee-diag` 机器读。
 *
 * ⚠️ 本模块通过动态 import 加载：Web 端永不执行，主包体积与行为都不受影响。
 */

import { useCallback, useEffect, useState } from 'react'
import { publicConfig, CLOUD_UPSTREAM } from '../cloudConfig'
import { cloud } from '../cloud'
import { isNative, platformName } from '../lib/platform'

/* ────────────────────────── 检查项 ────────────────────────── */

type Level = 'ok' | 'warn' | 'bad'

interface Check {
  key: string
  label: string
  level: Level
  value: string
  hint?: string
}

/** Capacitor 的 fetch 补丁会先把原 fetch 存到这个全局变量上，据此可判定补丁是否真的生效 */
interface DiagWindow {
  CapacitorWebFetch?: unknown
  Capacitor?: {
    getPlatform?: () => string
    Plugins?: Record<string, unknown>
  }
}

const ICON: Record<Level, string> = { ok: '✅', warn: '⚠️', bad: '❌' }
const COLOR: Record<Level, string> = { ok: '#2f7d4f', warn: '#a9761a', bad: '#b3261e' }

/** 带超时的探活：返回 HTTP 状态码；网络层失败时返回错误类型名 */
async function probe(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number | null; ms: number; error: string | null }> {
  const t0 = performance.now()
  const ac = new AbortController()
  const timer = window.setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: ac.signal })
    return { status: res.status, ms: Math.round(performance.now() - t0), error: null }
  } catch (e) {
    return {
      status: null,
      ms: Math.round(performance.now() - t0),
      error: e instanceof Error ? e.name || e.message : String(e),
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/** 把探活结果翻译成人话：拿到状态码就说明 HTTP 链路是通的 */
function describeProbe(r: { status: number | null; ms: number; error: string | null }): { level: Level; value: string } {
  if (r.status === null) {
    return {
      level: 'bad',
      value: `${r.error ?? '失败'}（${r.ms}ms）`,
    }
  }
  const tail = `${r.status} · ${r.ms}ms`
  if (r.status >= 200 && r.status < 300) return { level: 'ok', value: tail }
  // 401/403 是「服务器在、路径对、只是没带有效凭据」——对连通性检查而言这是**成功**
  if (r.status === 401 || r.status === 403) return { level: 'ok', value: `${tail}（服务器已应答）` }
  if (r.status === 404) return { level: 'warn', value: `${tail}（路径可能已变更）` }
  if (r.status >= 500) return { level: 'bad', value: `${tail}（服务端错误）` }
  return { level: 'warn', value: tail }
}

async function runChecks(): Promise<Check[]> {
  const out: Check[] = []
  const w = window as unknown as DiagWindow

  /* 1. 平台探测 */
  const platform = platformName()
  const native = isNative()
  out.push({
    key: 'platform',
    label: '运行环境',
    level: native ? 'ok' : 'bad',
    value: `platform=${platform} · isNative=${native}`,
    hint: native ? undefined : '未检出 Capacitor 容器：说明 native-bridge.js 未注入，后续所有原生分支都不会生效',
  })

  /* 2. WebView 来源 */
  out.push({
    key: 'origin',
    label: 'WebView 来源',
    level: 'ok',
    value: `${location.origin}（${location.protocol}）`,
    hint: '原生端应为 capacitor://localhost 或 https://localhost；来源本身绝不能当作 endpoint',
  })

  /* 3. endpoint */
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(publicConfig.endpoint)
  out.push({
    key: 'endpoint',
    label: '接口地址',
    level: isLocalOrigin ? 'bad' : 'ok',
    value: publicConfig.endpoint,
    hint: isLocalOrigin ? 'endpoint 指向本地来源 = 请求会打到 WebView 自己身上，必然失败' : `云端上游：${CLOUD_UPSTREAM}`,
  })

  /* 4. 原生 HTTP 通道（成败关键） */
  const patched = typeof w.CapacitorWebFetch === 'function' && window.fetch !== w.CapacitorWebFetch
  out.push({
    key: 'http',
    label: '原生 HTTP 通道',
    level: patched ? 'ok' : 'bad',
    value: patched ? 'fetch 已被 CapacitorHttp 接管' : 'fetch 未被接管',
    hint: patched
      ? '跨域请求将由原生层代发，绕过 WebView CORS 预检，apikey 才能生效'
      : '检查 capacitor.config.ts 的 plugins.CapacitorHttp.enabled 是否为 true，并重新 cap sync',
  })

  /* 5. Capacitor 桥与插件 */
  const plugins = w.Capacitor?.Plugins ? Object.keys(w.Capacitor.Plugins) : []
  out.push({
    key: 'bridge',
    label: 'Capacitor 桥',
    level: w.Capacitor ? 'ok' : 'bad',
    value: w.Capacitor ? `getPlatform()=${w.Capacitor.getPlatform?.() ?? '?'} · 插件 [${plugins.join(', ') || '无'}]` : 'window.Capacitor 不存在',
  })

  /* 6. 云端根可达 */
  const root = await probe(`${publicConfig.endpoint}/`)
  const rootDesc = describeProbe(root)
  out.push({
    key: 'root',
    label: '云端可达',
    level: rootDesc.level,
    value: rootDesc.value,
    hint: root.status === null ? 'DNS / TLS / 网络层失败：检查网络与证书是否被拦截' : undefined,
  })

  /* 7. 数据接口可达（带 apikey 的真实请求） */
  const db = await probe(`${publicConfig.endpoint}/.cloud/database/rest/v1/`, {
    apikey: publicConfig.publishableKey,
  })
  const dbDesc = describeProbe(db)
  out.push({
    key: 'db',
    label: '数据接口',
    level: dbDesc.level,
    value: dbDesc.value,
    hint: '带上 apikey 请求云端数据库接口。拿到任何 HTTP 状态码都说明链路通（401=未登录属正常）',
  })

  /* 7.5 原生 Origin 转发通道（方案 B）——云端按 Origin 校验客户端，原生端靠它过关 */
  const proxy = (w.Capacitor?.Plugins?.OriginProxy ?? null) as
    | { request: (o: unknown) => Promise<{ status: number; data: string }> }
    | null
  const hasProxy = !!proxy && typeof proxy.request === 'function'
  out.push({
    key: 'proxy',
    label: 'Origin 转发',
    level: hasProxy ? 'ok' : 'bad',
    value: hasProxy ? '插件已就绪 · 云端请求由原生层带 Origin 转发' : '插件缺失',
    hint: hasProxy
      ? '等价于 Web 端 Nginx 的 Origin 覆写；是否被云端接受由登录环节最终判定'
      : '检查 native-plugins/dbee-origin-proxy 是否已随包编译（npm i + cap sync + 重新构建）',
  })
  if (hasProxy) {
    const t0 = performance.now()
    try {
      const r = await proxy.request({
        url: `${publicConfig.endpoint}/.cloud/database/rest/v1/`,
        method: 'GET',
        headers: { apikey: publicConfig.publishableKey },
      })
      out.push({
        key: 'proxyProbe',
        label: '转发实测',
        level: r.status > 0 && r.status < 500 ? 'ok' : 'warn',
        value: `${r.status} · ${Math.round(performance.now() - t0)}ms（原生层直发）`,
        hint: '拿到任何状态码都说明原生转发链路通；Origin 是否被云端接受，以登录结果为准',
      })
    } catch (e) {
      out.push({
        key: 'proxyProbe',
        label: '转发实测',
        level: 'bad',
        value: e instanceof Error ? e.message : '转发失败',
        hint: '网络层失败：DNS / TLS / 超时，与 Origin 无关',
      })
    }
  }

  /* 8. 本地存储 */
  let lsOk = false
  let ssOk = false
  try {
    localStorage.setItem('__d_bee_diag__', '1')
    localStorage.removeItem('__d_bee_diag__')
    lsOk = true
  } catch {
    /* 忽略 */
  }
  try {
    sessionStorage.setItem('__d_bee_diag__', '1')
    sessionStorage.removeItem('__d_bee_diag__')
    ssOk = true
  } catch {
    /* 忽略 */
  }
  out.push({
    key: 'storage',
    label: '本地存储',
    level: lsOk && ssOk ? 'ok' : 'warn',
    value: `localStorage=${lsOk ? '可写' : '不可写'} · sessionStorage=${ssOk ? '可写' : '不可写'}`,
  })

  /* 9. 登录态 */
  try {
    const { data: session, error } = await cloud.auth.getSession()
    out.push({
      key: 'session',
      label: '登录态',
      level: session ? 'ok' : 'warn',
      value: session ? '已有会话（登录成功）' : `无会话${error ? ` · ${error.message}` : ''}`,
    })
  } catch (e) {
    out.push({
      key: 'session',
      label: '登录态',
      level: 'warn',
      value: e instanceof Error ? e.message : '读取失败',
    })
  }

  return out
}

/** 自检结果的结构化形式——供 logcat 机器读取 */
function toLogPayload(checks: Check[]) {
  return {
    tag: 'd-bee-diag',
    platform: checks.find((c) => c.key === 'platform')?.value,
    endpoint: checks.find((c) => c.key === 'endpoint')?.value,
    httpPatched: checks.find((c) => c.key === 'http')?.level === 'ok',
    originProxy: checks.find((c) => c.key === 'proxy')?.value,
    proxyProbe: checks.find((c) => c.key === 'proxyProbe')?.value,
    root: checks.find((c) => c.key === 'root')?.value,
    db: checks.find((c) => c.key === 'db')?.value,
    session: checks.find((c) => c.key === 'session')?.value,
    bad: checks.filter((c) => c.level === 'bad').map((c) => c.key),
  }
}

/* ────────────────────────── 面板 ────────────────────────── */

export function NativeDiagnostics() {
  const [open, setOpen] = useState(false)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    setRunning(true)
    try {
      const next = await runChecks()
      setChecks(next)
      // 同时打到 console → Capacitor Console 插件会转发到 logcat
      console.log(`[d-bee-diag] ${JSON.stringify(toLogPayload(next))}`)
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    if (open && !checks) void run()
  }, [open, checks, run])

  const bad = checks?.filter((c) => c.level === 'bad').length ?? 0
  const warn = checks?.filter((c) => c.level === 'warn').length ?? 0
  const summary = !checks ? '' : bad > 0 ? `${bad} 项异常` : warn > 0 ? `${warn} 项提醒` : '全部正常'

  return (
    <div style={{ marginTop: 22, border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '12px 14px',
          background: 'transparent',
          border: 'none',
          fontSize: 13,
          color: 'var(--ink-2)',
          cursor: 'pointer',
        }}
      >
        <span>🔍 连接自检（原生端专用）</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {summary && (
            <span style={{ fontSize: 12, color: bad > 0 ? COLOR.bad : warn > 0 ? COLOR.warn : COLOR.ok }}>
              {summary}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{open ? '收起' : '展开'}</span>
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--line)' }}>
          {running && !checks && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '12px 0' }}>正在检测…</div>
          )}

          {checks?.map((c) => (
            <div key={c.key} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                <span style={{ flexShrink: 0 }}>{ICON[c.level]}</span>
                <span style={{ flexShrink: 0, color: 'var(--ink-3)', fontSize: 12, minWidth: 78 }}>{c.label}</span>
                <span style={{ color: COLOR[c.level], wordBreak: 'break-all', lineHeight: 1.5 }}>{c.value}</span>
              </div>
              {c.hint && (
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4, marginLeft: 22, lineHeight: 1.6 }}>
                  {c.hint}
                </div>
              )}
            </div>
          ))}

          <button
            type="button"
            className="btn btn-ghost"
            disabled={running}
            onClick={() => void run()}
            style={{ width: '100%', marginTop: 12, fontSize: 13 }}
          >
            {running ? '检测中…' : '重新检测'}
          </button>

          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 10, lineHeight: 1.7 }}>
            结果同时写入调试日志，可用 <code>adb logcat | grep d-bee-diag</code> 读取。
          </div>
        </div>
      )}
    </div>
  )
}
