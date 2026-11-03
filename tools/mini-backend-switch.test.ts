/**
 * mini/src/lib/backend.ts 的 endpoint 开关测试。
 *
 * 🔴 为什么这个文件不需要 mock `@tarojs/taro`：backend.ts 被刻意设计成**零依赖**
 * （不 import 任何东西），正是为了避开 `vi.mock('@tarojs/taro')` 裸包名解析不到
 * 的坑（`@tarojs/taro` 只在 mini/node_modules 里，根 node_modules 没有）。
 * 对照 tools/mini-invite-link.test.ts —— 那个必须写相对路径 mock。
 */
import { describe, expect, it } from 'vitest'
import {
  CLOUD_HOST,
  SELFHOST_HOST,
  isSelfhostBackend,
  resolveBackendTarget,
} from '../mini/src/lib/backend'

describe('默认值：不设任何环境变量 = 当前线上行为（零改变）', () => {
  it('空对象 → cloud + WorkBuddy 云域名', () => {
    expect(resolveBackendTarget({})).toEqual({ kind: 'cloud', endpoint: CLOUD_HOST })
  })

  it('undefined → cloud（小程序运行时没有 process.env，这条必须成立）', () => {
    expect(resolveBackendTarget({ backend: undefined, selfhostReady: undefined }).kind).toBe('cloud')
  })

  it('显式 cloud → cloud', () => {
    expect(resolveBackendTarget({ backend: 'cloud' }).endpoint).toBe(CLOUD_HOST)
  })

  it('🔴 云端 endpoint 逐字锁死（被换掉会静默改变全量小程序流量走向）', () => {
    expect(CLOUD_HOST).toBe('https://zilv-mifeng.app.workbuddy.host')
  })

  it('🔴 自托管 endpoint 与主端 native-release 硬断言值逐字一致', () => {
    // src/cloudConfig.ts:19 PRODUCTION_NATIVE_ENDPOINT = 'https://d-bee.cn'
    // 两处若不一致，小程序与 App 会连到不同后端 → 数据不互通
    expect(SELFHOST_HOST).toBe('https://d-bee.cn')
  })
})

describe('大小写与空白容错（环境变量手填容易带这些）', () => {
  it('CLOUD 与前后空格 → cloud', () => {
    expect(resolveBackendTarget({ backend: '  CLOUD  ' }).kind).toBe('cloud')
  })

  it('SelfHost + READY=True → selfhost', () => {
    expect(resolveBackendTarget({ backend: 'SelfHost', selfhostReady: 'True' })).toEqual({
      kind: 'selfhost',
      endpoint: SELFHOST_HOST,
    })
  })
})

describe('🔴 selfhost 的双确认门（防误连未就绪的自托管）', () => {
  it('只设 backend=selfhost、缺 READY → throw', () => {
    expect(() => resolveBackendTarget({ backend: 'selfhost' })).toThrow(/D_BEE_SELFHOST_READY/)
  })

  it('READY 设成非 true 值 → throw（不是宽松布尔判断）', () => {
    for (const ready of ['1', 'yes', 'TRUE ', 'on', 'enabled']) {
      // 'TRUE ' 会被归一化成 'true'，故单独排除；其余都该炸
      const normalized = ready.trim().toLowerCase()
      if (normalized === 'true') {
        expect(resolveBackendTarget({ backend: 'selfhost', selfhostReady: ready }).kind).toBe('selfhost')
      } else {
        expect(() => resolveBackendTarget({ backend: 'selfhost', selfhostReady: ready })).toThrow()
      }
    }
  })

  it('throw 文案列出全部 6 项前置条件（这是给未来的自己看的，缺一项就会白跑一趟）', () => {
    let message = ''
    try {
      resolveBackendTarget({ backend: 'selfhost' })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('ICP 企业备案')
    expect(message).toContain('A 记录')
    expect(message).toContain('HTTPS')
    expect(message).toContain('request 合法域名')
    expect(message).toContain('login-wechat')
    expect(message).toContain('ident_kind')
    expect(message).toContain('legal.ts')
    expect(message).toContain('小程序回迁自托管-切换清单')
  })

  it('双确认齐备 → selfhost', () => {
    expect(resolveBackendTarget({ backend: 'selfhost', selfhostReady: 'true' })).toEqual({
      kind: 'selfhost',
      endpoint: SELFHOST_HOST,
    })
  })
})

describe('🔴 不认识的值一律 throw，绝不静默兜底成 cloud', () => {
  it.each([
    ['self-host'],
    ['self_host'],
    ['local'],
    ['dev'],
    ['production'],
    ['workbuddy'],
    ['0'],
    ['1'],
    ['false'],
  ])('backend=%s → throw', (value) => {
    expect(() => resolveBackendTarget({ backend: value })).toThrow(/无法识别的 D_BEE_BACKEND/)
  })

  it('throw 文案说明了为什么不兜底（防止后人「好心」加个 fallback）', () => {
    expect(() => resolveBackendTarget({ backend: 'self-host' })).toThrow(/以为切了其实没切/)
  })
})

describe('isSelfhostBackend()', () => {
  it('默认进程环境未设开关 → false', () => {
    // 测试进程里 D_BEE_BACKEND 未设置（若被外部设了 selfhost，resolveBackendTarget
    // 会因缺 READY 而 throw，这条断言会失败并提示环境污染 —— 是有意的）
    expect(isSelfhostBackend()).toBe(false)
  })
})
