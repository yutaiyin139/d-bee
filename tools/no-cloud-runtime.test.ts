/**
 * 🔴 护栏 10：运行时代码零云端库残留（2026-11-08 云端库彻底废弃）。
 *
 * ## 为什么需要一道「全仓扫描」护栏
 *
 * 只把 mini 的开关翻成 selfhost 是不够的：云库域名还散落在**多个彼此无关的运行时点**——
 * 主端 DEV / native-internal 的回退常量、OriginProxy 注入的 Origin 头、iOS/Android
 * 原生插件各自的 defaultOrigin、诊断脚本里的探测 URL、`.env.example` 的配置示例。
 * 任何一处被「好心」加回去，都会让某一端又连上已废弃的云库，而其它测试只盯自己那一块，
 * 发现不了。故用一道跨目录扫描把所有运行时代码收进同一射程。
 *
 * ## 三条护栏铁律的落实
 *
 * ① 一个 `it()` 只一条断言 → 用 `it.each(文件)` 逐文件一条。
 * ② 匹配「实际使用」而非「标识符出现」→ 查的是**云端域名字符串 / 旧常量名**，
 *    这是能回连云库的唯一方式；变量名恰好含 CLOUD（如 VITE_CLOUD_ENDPOINT）不算。
 * ③ 断言在 `stripComments()` 后的代码上做 → 历史背景注释（说明「当年为何这样」）
 *    有追溯价值，不应因为写了一句旧域名就让构建变红；但**可执行代码**里不允许出现。
 *
 * ## 明确不在射程内
 *
 * `docs/**`（历史快照，按纪律只加横幅不改正文）、`tools/**`（测试与已归档的双库补丁
 * 脚本）、`db/cloud-patch-0039/**`（历史留档）、`deploy/nginx.conf.example`
 * （已标注「⚠️已废弃·仅存档」且不被任何脚本渲染，deploy.sh 另有守卫校验）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..')

/** 去掉块注释 / `//` 行注释 / `#` 行注释；`https://` 里的 `//` 因前导 `:` 被排除。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*#.*$/gm, '')
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage'])
const SCAN_DIRS = ['src', 'mini/src', 'mini/config', 'native-plugins', 'deploy']
const EXT = /\.(ts|tsx|js|mjs|java|swift|sh|example|conf)$/
const ARCHIVED = new Set(['deploy/nginx.conf.example'])

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(join(dir, ent.name), out)
    } else if (EXT.test(ent.name)) {
      const rel = relative(ROOT, join(dir, ent.name)).replace(/\\/g, '/')
      if (!ARCHIVED.has(rel)) out.push(rel)
    }
  }
  return out
}

/** 参与扫描的运行时 / 构建期 / 部署期代码（相对项目根，正斜杠）。 */
const RUNTIME_FILES = [
  ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  'vite.config.ts',
  '.env.example',
].sort()

/** 出现在可执行代码里即视为「仍可回连云库」。 */
const FORBIDDEN = [
  'zilv-mifeng.app.workbuddy.host',
  'workbuddy.host',
  'CLOUD_HOST',
  'CLOUD_ORIGIN',
  'CLOUD_UPSTREAM',
  'VITE_ALLOW_CLOUD_NATIVE',
  'D_BEE_BACKEND=cloud',
]

describe('护栏 10 · 运行时代码零云端库残留（2026-11-08 彻底废弃）', () => {
  it('扫描面非空（防止目录改名 / 匹配式写错后护栏空跑＝假绿）', () => {
    expect(RUNTIME_FILES.length).toBeGreaterThan(20)
  })

  it.each(RUNTIME_FILES)('%s → 可执行代码零云端库残留', (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'))
    expect(FORBIDDEN.filter((needle) => code.includes(needle))).toEqual([])
  })
})

/**
 * 🔴 四端一致性：endpoint 与注入的 Origin 头必须同源。
 * 只保证「不含云库」不够 —— 将来若有人把某一端改成另一个自建域名，
 * 同样会造成「四端数据不互通」，故正向钉死五处常量的值。
 */
const ENDPOINT_ANCHORS: Array<[string, string]> = [
  ['src/cloudConfig.ts', 'PRODUCTION_NATIVE_ENDPOINT'],
  ['src/lib/originProxy.ts', 'SELFHOST_ORIGIN'],
  ['mini/src/lib/backend.ts', 'SELFHOST_HOST'],
  [
    'native-plugins/dbee-origin-proxy/ios/Sources/OriginProxyPlugin/OriginProxyPlugin.swift',
    'defaultOrigin',
  ],
  [
    'native-plugins/dbee-origin-proxy/android/src/main/java/com/dbee/originproxy/OriginProxyPlugin.java',
    'DEFAULT_ORIGIN',
  ],
]

describe('🔴 四端 endpoint / Origin 常量同源', () => {
  it.each(ENDPOINT_ANCHORS)('%s 的 %s = https://d-bee.cn', (rel, name) => {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'))
    const hit = code.match(new RegExp(`${name}\\s*[:=]\\s*["']([^"']+)["']`))
    expect(hit?.[1]).toBe('https://d-bee.cn')
  })
})

/**
 * 🔴 护栏 10b（2026-11-08 B1 完成后补）：小程序运行时零 WorkBuddy 平台域名。
 *
 * 微信合法域名是按「实际发请求的域名」逐个配的。旧版 `cloud.ts` 给 SDK 传了
 * `oauthRelayBaseUrl: https://www.workbuddy.cn/...`，虽只服务网页扫码登录
 * （`signInWithOAuth`）、小程序走 `signInWithWechat` 用不到，但产物里留着这个域名
 * 会让「只需配一个 request 合法域名」变成靠推断而非可验证的事实。
 * 本断言把它钉死为「mini 侧绝不能出现」。
 *
 * ⚠️ 射程**只限 mini/**：主工程 `src/cloudConfig.ts` 仍保留该字段（网页扫码登录
 * 可能用到），全仓禁止会误伤 Web 端。同样在 `stripComments()` 后的代码上做。
 */
const MINI_FILES = RUNTIME_FILES.filter((rel) => rel.startsWith('mini/'))
const MINI_FORBIDDEN = [
  'www.workbuddy.cn',
  'oauthRelayBaseUrl',
  'genie-baas/oauth',
]

describe('护栏 10b · 小程序运行时零 WorkBuddy 平台域名', () => {
  it('扫描面非空（防止 mini 目录改名后护栏空跑＝假绿）', () => {
    expect(MINI_FILES.length).toBeGreaterThan(10)
  })

  it.each(MINI_FILES)('%s → 无平台 OAuth relay 残留', (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'))
    expect(MINI_FORBIDDEN.filter((needle) => code.includes(needle))).toEqual([])
  })
})
