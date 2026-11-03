/**
 * 小程序端分享链接邀请码闭环回归测试（P1-B，2026-11-03）。
 *
 * 起因：mini 端分享卡片生成的落地链接带 `?inviter=CODE`，但**全仓没有任何
 * 读取点** —— 好友点卡片进来，邀请码在落地那一刻就被丢弃，`bind_invite`
 * 永远走不到，分享裂变实际是断的。主工程是 SPA，`App.tsx:readInviteFromUrl()`
 * 读 URL 后经 props 传给 AuthScreen 即可；小程序是多页架构，落地页（index）
 * 与登录页（login）之间只能靠 Storage 传递，故新建 `lib/inviteLink.ts`
 * 作为「解析 → 暂存 → 消费 → 绑定」的唯一真源。
 *
 * 本测试守住四件事：
 *   ① 邀请码清洗规则与主工程 `readInviteFromUrl()` 逐字符一致
 *      （大写化、只留 A-Z0-9、截断 8 位）——两端同一口径；
 *   ② 参数名兼容：新链接 `invite=`、旧版已流通卡片 `inviter=` 都要认；
 *   ③ 暂存码只在**终态**（ok/already/self）才清除；invalid/throttled
 *      等非终态保留待下次登录再试（bind_invite 有 60s/5 次失败节流，
 *      盲重试会耗风控额度，见 inviteLink.ts 文件头）；
 *   ④ 会话未就绪（getSession 无 session）时不发 RPC、不清码。
 *
 * 运行：npx vitest run tools/mini-invite-link.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ── Taro Storage 内存模拟（inviteLink 用 get/set/removeStorageSync）──
 * specifier 用相对路径直指 mini 的嵌套 node_modules：根 node_modules 没有
 * @tarojs/taro，若写裸包名 vitest 无法解析、mock 不生效（会加载真实 Taro
 * 触发 ENABLE_INNER_HTML 未定义）。相对路径解析到的绝对 id 与 inviteLink.ts
 * 内部 `import Taro from '@tarojs/taro'` 的解析结果一致，故能拦截。
 *
 * getEnterOptionsSync 用可变持有者：热启动用例要能改「本次进入」的 query。 */
const store = new Map<string, string>()
const enterOptionsHolder: {
  value: { query?: Record<string, unknown> } | null
  apiMissing?: boolean
  apiThrows?: boolean
} = { value: null }
vi.mock('../mini/node_modules/@tarojs/taro', () => ({
  default: {
    getStorageSync: (k: string) => store.get(k) ?? '',
    setStorageSync: (k: string, v: string) => { store.set(k, String(v)) },
    removeStorageSync: (k: string) => { store.delete(k) },
    // apiMissing=true 时属性本身为 undefined（低版本基础库/非微信宿主），
    // 验证 readInviteFromEnterOptions 的存在性判断与 fail-open 回退。
    get getEnterOptionsSync() {
      if (enterOptionsHolder.apiMissing) return undefined
      return () => {
        if (enterOptionsHolder.apiThrows) throw new Error('boom')
        return enterOptionsHolder.value ?? { query: {} }
      }
    },
  },
}))

/* ── 依赖 mock：bindInvite（RPC 封装）与 cloud.auth.getSession（会话探测）── */
const bindInviteMock = vi.fn()
vi.mock('../mini/src/lib/api', () => ({
  bindInvite: (code: string) => bindInviteMock(code),
}))
const getSessionMock = vi.fn()
vi.mock('../mini/src/lib/cloud', () => ({
  cloud: { auth: { getSession: () => getSessionMock() } },
}))

import {
  INVITE_CODE_MAX,
  clearPendingInvite,
  consumePendingInvite,
  getPendingInvite,
  isInviteCodeShape,
  normalizeInviteCode,
  readInviteFromEnterOptions,
  readInviteFromParams,
  setPendingInvite,
  tryBindInviteCode,
} from '../mini/src/lib/inviteLink'

beforeEach(() => {
  store.clear()
  enterOptionsHolder.value = null
  bindInviteMock.mockReset()
  getSessionMock.mockReset()
  vi.useRealTimers()
})

describe('mini inviteLink · normalizeInviteCode（与主工程 readInviteFromUrl 同口径）', () => {
  it('小写转大写、过滤非法字符', () => {
    expect(normalizeInviteCode('ab12')).toBe('AB12')
    expect(normalizeInviteCode('a b-1_2!')).toBe('AB12')
  })

  it('截断到 8 位（INVITE_CODE_RULE.max）', () => {
    expect(normalizeInviteCode('ABCDEFGH1234')).toBe('ABCDEFGH')
    expect(normalizeInviteCode('ABCDEFGH1234')).toHaveLength(INVITE_CODE_MAX)
  })

  it('非字符串输入安全归空（query 参数可能是数组/undefined）', () => {
    expect(normalizeInviteCode(undefined)).toBe('')
    expect(normalizeInviteCode(null)).toBe('')
    expect(normalizeInviteCode(['AB12'])).toBe('')
    expect(normalizeInviteCode(1234 as unknown)).toBe('')
  })

  it('形状校验：4-8 位 A-Z0-9', () => {
    expect(isInviteCodeShape('AB12')).toBe(true)
    expect(isInviteCodeShape('ab12')).toBe(true) // 先 normalize 再判
    expect(isInviteCodeShape('AB1')).toBe(false) // 短于 min=4
    expect(isInviteCodeShape('')).toBe(false)
    expect(isInviteCodeShape(undefined)).toBe(false)
  })
})

describe('mini inviteLink · readInviteFromParams（落地参数解析）', () => {
  it('🔴 读取 invite=（新规范名，与主工程 ?invite=CODE 对齐）', () => {
    expect(readInviteFromParams({ invite: 'AB12CD' })).toBe('AB12CD')
  })

  it('🔴 兼容 inviter=（旧版分享卡片已在用户手里流通，不能因改名失效）', () => {
    expect(readInviteFromParams({ inviter: 'AB12CD' })).toBe('AB12CD')
  })

  it('两名同现时 invite 优先', () => {
    expect(readInviteFromParams({ invite: 'AAAA', inviter: 'BBBB' })).toBe('AAAA')
  })

  it('URL 转义值容错解码（getLaunchOptionsSync 冷启动路径可能给原始串）', () => {
    expect(readInviteFromParams({ invite: 'AB%312CD' })).toBe('AB12CD')
  })

  it('非法转义序列不抛异常，按原串过滤', () => {
    expect(readInviteFromParams({ invite: 'AB%zz12' })).toBe('ABZZ12')
  })

  it('形状非法的码直接丢弃（防脏 query 进 Storage/RPC）', () => {
    expect(readInviteFromParams({ invite: 'AB' })).toBe('')
    expect(readInviteFromParams({ invite: '!!!' })).toBe('')
    expect(readInviteFromParams({ invite: '' })).toBe('')
  })

  it('空/缺失参数安全归空', () => {
    expect(readInviteFromParams(null)).toBe('')
    expect(readInviteFromParams(undefined)).toBe('')
    expect(readInviteFromParams({})).toBe('')
    expect(readInviteFromParams({ other: 'x' })).toBe('')
  })
})

describe('mini inviteLink · readInviteFromEnterOptions（热启动可靠来源）', () => {
  it('🔴 读到本次进入的 query —— 热启动（后台时点新卡片）唯一可靠来源', () => {
    // 场景：小程序在后台，用户在聊天里点了第二张卡片（新邀请码）。
    // 此时 onLoad 不重跑、页面 router.params 仍是首次冷启动的旧值，
    // 只有 getEnterOptionsSync 返回「本次进入」的参数。
    enterOptionsHolder.value = { query: { invite: 'ZZZZ9999' } }
    expect(readInviteFromEnterOptions()).toBe('ZZZZ9999')
  })

  it('热启动的码覆盖此前暂存的旧码（以最近点的卡片为准）', () => {
    setPendingInvite('AAAA1111') // 首次冷启动落地
    enterOptionsHolder.value = { query: { invite: 'ZZZZ9999' } } // 后台点新卡片
    const entered = readInviteFromEnterOptions()
    setPendingInvite(entered)
    expect(getPendingInvite()).toBe('ZZZZ9999')
  })

  it('兼容 inviter= 与 URL 转义（与 readInviteFromParams 同一套清洗）', () => {
    enterOptionsHolder.value = { query: { inviter: 'ab%312cd' } }
    expect(readInviteFromEnterOptions()).toBe('AB12CD')
  })

  it('形状非法的码直接丢弃', () => {
    enterOptionsHolder.value = { query: { invite: 'AB' } }
    expect(readInviteFromEnterOptions()).toBe('')
  })

  it('query 缺失/为空 → 归空（不抛）', () => {
    enterOptionsHolder.value = { query: {} }
    expect(readInviteFromEnterOptions()).toBe('')
    enterOptionsHolder.value = null // 模拟 getEnterOptionsSync 返回空对象
    expect(readInviteFromEnterOptions()).toBe('')
  })

  it('fail-open：API 不存在（低版本基础库/非微信宿主）→ 归空，由调用方回退 router params', () => {
    enterOptionsHolder.apiMissing = true
    expect(readInviteFromEnterOptions()).toBe('')
    enterOptionsHolder.apiMissing = false
  })

  it('fail-open：API 抛异常 → 归空，不冒泡（读不到码只是少绑一次邀请，不阻断落地页）', () => {
    enterOptionsHolder.apiThrows = true
    expect(readInviteFromEnterOptions()).toBe('')
    enterOptionsHolder.apiThrows = false
  })
})

describe('mini inviteLink · 暂存（跨页载体）', () => {
  it('set → get 回环，且存入的是 normalize 后的码', () => {
    setPendingInvite('ab-12')
    expect(getPendingInvite()).toBe('AB12')
  })

  it('形状非法的码拒存（不污染 Storage）', () => {
    setPendingInvite('AB')
    expect(getPendingInvite()).toBe('')
    setPendingInvite('!!!')
    expect(getPendingInvite()).toBe('')
  })

  it('后到的码覆盖先到的（以用户最近点的卡片为准）', () => {
    setPendingInvite('AAAA')
    setPendingInvite('BBBB')
    expect(getPendingInvite()).toBe('BBBB')
  })

  it('clear 后为空', () => {
    setPendingInvite('AB12')
    clearPendingInvite()
    expect(getPendingInvite()).toBe('')
  })
})

describe('mini inviteLink · tryBindInviteCode（风控感知的重试策略）', () => {
  it('会话就绪 + ok → 终态 true，恰好一次 RPC', async () => {
    getSessionMock.mockResolvedValue({ data: { uid: 'u1' } })
    bindInviteMock.mockResolvedValue('ok')
    await expect(tryBindInviteCode('AB12')).resolves.toBe(true)
    expect(bindInviteMock).toHaveBeenCalledTimes(1)
    expect(bindInviteMock).toHaveBeenCalledWith('AB12')
  })

  it('already / self 也是终态（老用户重复点卡片幂等，不改绑不重发）', async () => {
    getSessionMock.mockResolvedValue({ data: { uid: 'u1' } })
    bindInviteMock.mockResolvedValue('already')
    await expect(tryBindInviteCode('AB12')).resolves.toBe(true)
    bindInviteMock.mockResolvedValue('self')
    await expect(tryBindInviteCode('AB12')).resolves.toBe(true)
    expect(bindInviteMock).toHaveBeenCalledTimes(2)
  })

  it('🔴 会话未就绪 → 不发 RPC（auth.uid() 为 null 必然 invalid，省一次调用）', async () => {
    getSessionMock.mockResolvedValue({ data: null })
    await expect(tryBindInviteCode('AB12')).resolves.toBe(false)
    expect(bindInviteMock).not.toHaveBeenCalled()
  })

  it('非终态（invalid/throttled）→ 有限次重试后返回 false', async () => {
    getSessionMock.mockResolvedValue({ data: { uid: 'u1' } })
    bindInviteMock.mockResolvedValue('throttled')
    await expect(tryBindInviteCode('AB12', 2)).resolves.toBe(false)
    expect(bindInviteMock).toHaveBeenCalledTimes(2)
  })

  it('形状非法的码视为终态（不调 RPC 白耗风控额度）', async () => {
    await expect(tryBindInviteCode('AB')).resolves.toBe(true)
    expect(bindInviteMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
  })

  it('RPC 抛异常不冒泡（绑定失败不阻断登录）', async () => {
    getSessionMock.mockResolvedValue({ data: { uid: 'u1' } })
    bindInviteMock.mockRejectedValue(new Error('network'))
    await expect(tryBindInviteCode('AB12', 1)).resolves.toBe(false)
  })
})

describe('mini inviteLink · consumePendingInvite（终态才清码）', () => {
  it('🔴 ok → 清码（下次登录不再重复绑）', async () => {
    setPendingInvite('AB12')
    getSessionMock.mockResolvedValue({ data: { uid: 'u1' } })
    bindInviteMock.mockResolvedValue('ok')
    await expect(consumePendingInvite()).resolves.toBe(true)
    expect(getPendingInvite()).toBe('')
  })

  it('🔴 非终态 → 保留码（会话时序问题下次登录可再试，不丢邀请关系）', async () => {
    setPendingInvite('AB12')
    getSessionMock.mockResolvedValue({ data: { uid: 'u1' } })
    bindInviteMock.mockResolvedValue('invalid')
    await expect(consumePendingInvite()).resolves.toBe(false)
    expect(getPendingInvite()).toBe('AB12')
  })

  it('无暂存码 → 直接 false，零 RPC', async () => {
    await expect(consumePendingInvite()).resolves.toBe(false)
    expect(bindInviteMock).not.toHaveBeenCalled()
  })
})
