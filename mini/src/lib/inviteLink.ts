/**
 * 分享链接邀请码：解析 / 暂存 / 消费 / 绑定（小程序端 P1-B）。
 *
 * ── 为什么需要这个模块 ─────────────────────────────────────────────
 * 微信分享卡片落地的是小程序首页，邀请码只能通过**页面 query** 传入
 * （`/pages/index/index?invite=CODE`）。但小程序的登录页是独立页面，
 * 且「点分享卡片进来时用户往往还没登录」，于是邀请码必须跨越
 * 「落地页 → 登录页 → 登录成功回调」三跳才能完成绑定。
 *
 * 此前 mini 端只生成了带码链接、却从未读取过落地参数（全仓零读取点），
 * 邀请码在落地那一刻就被丢弃 —— 分享裂变实际是断的。主工程用
 * `App.tsx:readInviteFromUrl()` + `AuthScreen` 的 `initialInviteCode`
 * 走内存 props 传递即可（单页应用，App 是 AuthScreen 的父组件）；
 * 小程序是多页架构，页面间无法传对象，故用 Storage 作为跨页载体。
 *
 * ── 与 lib/invite.ts 的分工 ────────────────────────────────────────
 * `invite.ts` 是纯常量与判定（积分数额、打卡达标判定），无任何副作用；
 * 本模块只管「邀请码从哪来、存哪、什么时候绑」，含 Storage 读写。
 * 刻意分开，避免把副作用塞进那个被广泛 import 的纯模块。
 *
 * ── 绑定策略：只在登录成功那一刻绑一次 ─────────────────────────────
 * `bind_invite` RPC（db/functions.sql:92）的语义决定了不能盲重试：
 *   · `auth.uid()` 为空 → 返回 'invalid'，且**发生在写 invite_attempts 之前**，
 *     所以「会话未就绪」的重试不会计入爆破风控；
 *   · 码真不存在 → 返回 'invalid' 并**记一次失败尝试**，
 *     60 秒内失败 ≥5 次即被 `invite_throttled` 拦成 'throttled'。
 * 因此：会话未就绪重试安全，错码重试有害。`consumePendingInvite` 取到码后
 * 交给 `tryBindInviteCode`（登录流程内已有会话，含 3 次退避重试），
 * 拿到**终态**才清码；拿不到终态则保留，下次登录再试 —— 而不是
 * 在首页用 setTimeout 盲轮询（那会把风控额度耗在注定失败的调用上）。
 *
 * 绑定是幂等的：`profiles.invited_by` 非空时 RPC 直接返回 'already'，
 * 老用户重复点分享卡片不会改绑、也不会重复发积分（`ON CONFLICT DO NOTHING`）。
 * 这也是「取到码即绑、不必先判断是否新用户」的依据。
 */

import Taro from '@tarojs/taro'
import { bindInvite } from './api'
import { cloud } from './cloud'

/** 待绑定邀请码的 Storage key（命名对齐 aiConsent.ts 的 `dbee:` 前缀） */
const PENDING_KEY = 'dbee:pending_invite'

/**
 * 邀请码字符规则，对齐主工程 `src/lib/validate.ts` 的 INVITE_CODE_RULE
 * （min 4 / max 8 / 仅大写字母与数字）。
 *
 * 这里独立声明而非跨端 import：mini 只允许依赖 `@dbee/shared`，
 * 而该规则目前住在主工程 `src/lib/validate.ts`（含 DOM 无关但未被下沉）。
 * 常量重复的风险由 `tools/mini-invite-link.test.ts` 的格式用例兜住。
 */
export const INVITE_CODE_MAX = 8
const INVITE_CODE_MIN = 4

/** bind_invite 的终态：绑定关系已确定，无需（也不该）再试 */
type BindTerminal = 'ok' | 'already' | 'self'

/**
 * 清洗邀请码：去空白 → 转大写 → 只保留 A-Z0-9 → 截断到 8 位。
 * 与主工程 `readInviteFromUrl()` 的处理完全一致。
 *
 * 清洗放在最前面（而非只信 encode）是必要的：query 参数完全由外部
 * 构造（好友改链接、扫码工具、朋友圈 query 拼接都可能塞进任意字符），
 * 直接透传给 RPC 等于把未过滤输入交给数据库函数。
 */
export function normalizeInviteCode(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, INVITE_CODE_MAX)
}

/** 是否为形状合法的邀请码（长度 + 字符集） */
export function isInviteCodeShape(raw: unknown): boolean {
  const code = normalizeInviteCode(raw)
  return code.length >= INVITE_CODE_MIN && code.length <= INVITE_CODE_MAX
}

/**
 * 从页面 query 读取邀请码。
 *
 * 兼容两种参数名：
 *   · `invite`  —— 当前生成侧使用的名字，与主工程 `?invite=CODE` 对齐；
 *   · `inviter` —— 旧版本分享卡片已在用户手里流通，不能因为改名就失效。
 * `invite` 优先（新链接的规范名）。
 *
 * Taro 的 `useRouter().params` 已对 value 做过 decodeURIComponent，
 * 但 `getLaunchOptionsSync().query` 在部分冷启动路径下是原始串，
 * 故这里对两种来源都再做一次容错解码。
 */
export function readInviteFromParams(params: Record<string, unknown> | null | undefined): string {
  if (!params || typeof params !== 'object') return ''
  const raw = params.invite ?? params.inviter ?? ''
  let decoded = String(raw ?? '')
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      /* 非法转义序列：按原串继续，交给 normalize 过滤 */
    }
  }
  const code = normalizeInviteCode(decoded)
  return isInviteCodeShape(code) ? code : ''
}

/**
 * 从「本次进入小程序」的启动参数读邀请码（热启动可靠来源）。
 *
 * 为什么不能只靠页面的 `useRouter().params`：小程序**热启动**（在后台时
 * 用户点了新的分享卡片）只触发 App/Page 的 `onShow`，`onLoad` 不重跑，
 * `useRouter()` 返回的是**首次冷启动**的旧 query —— 于是「聊天里连点两张
 * 不同邀请码的卡片」这类高频场景下，第二张卡的码会被丢掉。
 *
 * `Taro.getEnterOptionsSync()`（对应 `wx.getEnterOptionsSync`）返回的永远是
 * **当前这次进入**的 path/scene/query，冷启动与热启动都准确。
 * 因此落地读码优先级：enter options（本次进入）> 页面 router params（兜底）。
 *
 * 该 API 在部分基础库/非微信宿主下可能不存在，故做存在性判断，缺失时返回空
 * 让调用方回退到 router params（fail-open：读不到码只是少绑一次邀请，不阻断）。
 */
export function readInviteFromEnterOptions(): string {
  try {
    const get = (Taro as unknown as { getEnterOptionsSync?: () => { query?: unknown } }).getEnterOptionsSync
    if (typeof get !== 'function') return ''
    const opts = get()
    return readInviteFromParams((opts?.query ?? {}) as Record<string, unknown>)
  } catch {
    return ''
  }
}


/** 暂存待绑定邀请码（后到的码覆盖先到的：以用户最近点的那张卡片为准） */
export function setPendingInvite(code: string): void {
  const normalized = normalizeInviteCode(code)
  if (!isInviteCodeShape(normalized)) return
  try {
    Taro.setStorageSync(PENDING_KEY, normalized)
  } catch {
    // Storage 写失败（配额满/隐私限制）：静默放弃，不阻断落地页渲染
  }
}

/** 读取待绑定邀请码（不做形状校验，交给调用方；异常返回空串） */
export function getPendingInvite(): string {
  try {
    return normalizeInviteCode(Taro.getStorageSync(PENDING_KEY))
  } catch {
    return ''
  }
}

/** 清除待绑定邀请码 */
export function clearPendingInvite(): void {
  try {
    Taro.removeStorageSync(PENDING_KEY)
  } catch {
    // ignore
  }
}

/**
 * 用给定邀请码尝试绑定（登录成功后调用）。
 *
 * 与主工程 `AuthScreen.tryBindInvite()` 同构：先等云会话建立，再对非终态
 * 做有限次退避重试。返回是否已确定终态 —— 调用方据此决定是否清码。
 *
 * @param code 已 normalize 的邀请码
 * @param attempts 最大尝试次数（默认 3，与主工程一致）
 */
export async function tryBindInviteCode(code: string, attempts = 3): Promise<boolean> {
  const normalized = normalizeInviteCode(code)
  if (!isInviteCodeShape(normalized)) return true // 形状非法：视为终态，别再试

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt))
    try {
      // 会话未建立时 bind_invite 的 auth.uid() 为 null，会在写 attempts 前
      // 直接返回 invalid（不计风控）。这里先探一次会话，避免无谓调用。
      const { data: session } = await cloud.auth.getSession()
      if (!session) continue
      const status: BindTerminal | string = await bindInvite(normalized)
      if (status === 'ok' || status === 'already' || status === 'self') return true
      // invalid / throttled / daily_limit：可能是会话时序或风控，留待重试
    } catch {
      // 网络/鉴权异常：继续重试
    }
  }
  return false
}

/**
 * 消费暂存的邀请码：绑定成功（终态）则清码，否则保留待下次登录再试。
 * @returns 是否已确定终态（调用方可据此刷新积分展示）
 */
export async function consumePendingInvite(): Promise<boolean> {
  const code = getPendingInvite()
  if (!code) return false
  const done = await tryBindInviteCode(code)
  if (done) clearPendingInvite()
  return done
}
