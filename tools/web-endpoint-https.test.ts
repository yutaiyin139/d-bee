/**
 * src/cloudConfig.ts · resolveWebOrigin 回归护栏
 *
 * 🔴 为什么必须有这个测试（2026-11-06 生产登录故障）：
 *   用户手机访问 http://d-bee.cn（HTTP），SPA 的 window.location.origin 就是 http。
 *   点登录 → POST http://d-bee.cn/.cloud/auth/v1/verification
 *     → certbot 注入的 `return 301 https://$host$request_uri`
 *     → 浏览器对 301 的历史兼容行为 = **POST 降级为 GET**
 *     → 网关只注册了 POST（app.mjs:79 `${A}/verification`）→ 404「未知端点」
 *   access.log 铁证（同一秒三连）：
 *     POST /.cloud/auth/v1/verification → 301
 *     OPTIONS …                         → 204
 *     GET  /.cloud/auth/v1/verification → 404
 *   curl 复现：`--data -L http://…` → 404「未知端点」；https 直连 → 401 invalid access key（路由在）。
 *
 *   修法 = Web endpoint 强制 https（请求直连 443、不经重定向，方法不被降级）。
 *   这是「改一行就静默退回」的逻辑，故用测试钉死。
 *
 * 断言纪律（本项目铁律）：一个 it() 只放一条断言 —— 多断言时首条失败即抛出，
 * 后续根本不执行，会表现成「通过了」却从未验证。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWebOrigin } from '../src/cloudConfig'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 取 cloudConfig.ts 中某个顶层函数的函数体（到顶格 `}` 为止），用于源码级断言。 */
function fnBody(name: string): string {
  const src = readFileSync(join(ROOT, 'src', 'cloudConfig.ts'), 'utf8')
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`cloudConfig.ts 中找不到 function ${name}`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`无法定位 function ${name} 的结束花括号`)
  return src.slice(start, end)
}

/** 生产域名：http 页面必须被升级为 https */
const PROD = { origin: 'http://d-bee.cn', protocol: 'http:', hostname: 'd-bee.cn' }

describe('🔴 生产 web 强制 https（登录 POST 被 301 降级为 GET 的根治）', () => {
  it('http://d-bee.cn → https://d-bee.cn（本次故障的精确场景）', () => {
    expect(resolveWebOrigin(PROD)).toBe('https://d-bee.cn')
  })

  it('升级后不残留 http: 前缀', () => {
    expect(resolveWebOrigin(PROD)).not.toContain('http://')
  })

  it('带端口的 http origin 同样升级（保留端口）', () => {
    expect(
      resolveWebOrigin({ origin: 'http://d-bee.cn:8080', protocol: 'http:', hostname: 'd-bee.cn' }),
    ).toBe('https://d-bee.cn:8080')
  })

  it('www 子域同样升级', () => {
    expect(
      resolveWebOrigin({
        origin: 'http://www.d-bee.cn',
        protocol: 'http:',
        hostname: 'www.d-bee.cn',
      }),
    ).toBe('https://www.d-bee.cn')
  })

  it('已经是 https 时原样返回（不重复升级、不改写）', () => {
    expect(
      resolveWebOrigin({ origin: 'https://d-bee.cn', protocol: 'https:', hostname: 'd-bee.cn' }),
    ).toBe('https://d-bee.cn')
  })
})

describe('本地开发场景必须保留 http（dev server 没有 TLS，升级会让开发环境全挂）', () => {
  it('localhost → null（回退自建网关，见 cloudConfig.ts resolveEndpoint 末行）', () => {
    expect(
      resolveWebOrigin({ origin: 'http://localhost:5173', protocol: 'http:', hostname: 'localhost' }),
    ).toBeNull()
  })

  it('127.0.0.1 → null', () => {
    expect(
      resolveWebOrigin({ origin: 'http://127.0.0.1:5173', protocol: 'http:', hostname: '127.0.0.1' }),
    ).toBeNull()
  })

  it('局域网 IP（192.168.x）→ null', () => {
    expect(
      resolveWebOrigin({ origin: 'http://192.168.1.7:5173', protocol: 'http:', hostname: '192.168.1.7' }),
    ).toBeNull()
  })

  it('.local 主机名 → null', () => {
    expect(
      resolveWebOrigin({ origin: 'http://mbp.local:5173', protocol: 'http:', hostname: 'mbp.local' }),
    ).toBeNull()
  })
})

describe('异常输入不得抛错（模块级求值，抛错 = 整个应用白屏）', () => {
  it('origin 缺失 → null', () => {
    expect(resolveWebOrigin({ protocol: 'http:', hostname: 'd-bee.cn' })).toBeNull()
  })

  it('protocol 缺失 → null', () => {
    expect(resolveWebOrigin({ origin: 'http://d-bee.cn', hostname: 'd-bee.cn' })).toBeNull()
  })

  it('hostname 缺失 → null', () => {
    expect(resolveWebOrigin({ origin: 'http://d-bee.cn', protocol: 'http:' })).toBeNull()
  })

  it('空对象 → null', () => {
    expect(resolveWebOrigin({})).toBeNull()
  })

  it('非 http(s) 协议（如 file:）→ null', () => {
    expect(
      resolveWebOrigin({ origin: 'null', protocol: 'file:', hostname: 'd-bee.cn' }),
    ).toBeNull()
  })
})

describe('🔴 Web 数据面兜底必须指向自建网关（云库释放前置，2026-11-06 用户批准）', () => {
  /**
   * 为什么用源码级断言：resolveEndpoint() 的兜底分支只在**本地开发/无 window**时命中，
   * 测试里无法真实触发（vitest 下 window.location 存在且 hostname=localhost → resolveWebOrigin
   * 返回 null 后才走到兜底，但 import 时求值一次、无法按用例切换）。
   * 「改一行就静默退回云库」的逻辑只能钉在源码文本上。
   *
   * 📌 口径刻意只限 **Web**：resolveNativeEndpoint() 里的 CLOUD_HOST 是 DEV 与
   *   native-internal+VITE_ALLOW_CLOUD_NATIVE 两个**显式内测口子**（cloudConfig.ts 头部双后端口径），
   *   属于刻意保留，不在本护栏射程内 —— 故断言只扫 resolveEndpoint 的函数体。
   */
  it('resolveEndpoint() 兜底分支返回 PRODUCTION_NATIVE_ENDPOINT，不再返回 CLOUD_HOST', () => {
    expect(fnBody('resolveEndpoint')).toContain('return PRODUCTION_NATIVE_ENDPOINT')
  })

  it('resolveEndpoint() 函数体内零处 CLOUD_HOST 引用', () => {
    expect(fnBody('resolveEndpoint')).not.toContain('CLOUD_HOST')
  })

  it('兜底改动必须留说明注释（解释为何回退自建网关 + CORS 依赖）', () => {
    const src = readFileSync(join(ROOT, 'src', 'cloudConfig.ts'), 'utf8')
    expect(/不再回退 WorkBuddy 云库/.test(src)).toBe(true)
  })

  it('生产网关 CORS 仍放行 localhost（兜底方案的前提，收紧白名单会让本地开发登录失败）', async () => {
    // 📌 这是对**生产侧**的断言：本地开发回退 d-bee.cn 属跨域，依赖网关白名单。
    //   若哪天 CORS_ALLOWED_ORIGINS 收紧掉 localhost，这条会先红并指出根因，
    //   而不是让人面对「本地开发登录 403」摸不着头脑。
    const res = await fetch('https://d-bee.cn/.cloud/auth/v1/verification', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  }, 20_000)
})
