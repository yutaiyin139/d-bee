import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cloud } from '../cloud'
import {
  consumePhotoQuota,
  getEntitlement,
  getPhotoQuota,
  grantHoney,
  grantPhotoBonus,
  redeemByCode,
  releasePhotoQuota,
} from '../lib/api'
import {
  BONUS_TTL_DAYS,
  FREE_DAILY_AI,
  NEWBIE_BONUS_AMOUNT,
  STREAK_BONUS_AMOUNT,
  isLifetime,
  isPro,
} from '../lib/entitlement'
import type { Entitlement } from '../types'

/**
 * 会员状态与配额的全局状态。
 * 配额每次都读云端 ai_usage，避免本地可被清缓存绕过，也能跨设备一致。
 * 占用额度走数据库函数原子完成（见 lib/api.ts 的 consumeAiQuota）。
 */

interface PlanContextValue {
  ready: boolean
  pro: boolean
  lifetime: boolean
  entitlement: Entitlement | null
  /** 今日剩余拍照次数（基础+奖励）；Pro 返回 null（无限） */
  aiRemaining: number | null
  /** 奖励额度剩余（连续打卡/新手奖励，带 7 天有效期） */
  bonusRemaining: number
  /** 原子占用一次「拍照识别」额度：allowed=false 表示已用完，调用方应弹付费墙并中止 */
  claimAiQuota: () => Promise<{ allowed: boolean; remaining: number | null }>
  /** 识别失败（模糊/非食物/报错）时退还刚占用的额度 */
  refundAiQuota: () => Promise<void>
  redeem: (code: string) => Promise<'ok' | 'used' | 'bad'>
  /** 完善身体数据后发放新手奖励（一次性，防重复） */
  grantNewbieBonus: () => Promise<boolean>
  /** 连续打卡达成后发放奖励（按达成日期防重复） */
  grantStreakBonus: (dateKey: string) => Promise<boolean>
  paywall: { open: boolean; reason: string }
  openPaywall: (reason?: string) => void
  closePaywall: () => void
  refresh: () => Promise<void>
}

const PlanContext = createContext<PlanContextValue | null>(null)

export function PlanProvider({ children }: { children: ReactNode }) {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [ready, setReady] = useState(false)
  const [photoQuota, setPhotoQuota] = useState({ base: 0, bonus: 0, total: FREE_DAILY_AI })
  const [paywall, setPaywall] = useState({ open: false, reason: '' })

  const refresh = useCallback(async () => {
    // 先看登录态：未登录不请求云端。
    // 数据库表权限只授予 authenticated（anon 已 REVOKE），匿名请求会拿到 401，
    // 而这个 401 无法被下面的 try/catch 消除（网络层报错先于 JS 捕获）。
    const { data: session } = await cloud.auth.getSession()
    if (!session) {
      setEntitlement(null)
      setPhotoQuota({ base: 0, bonus: 0, total: FREE_DAILY_AI })
      setReady(true)
      return
    }
    try {
      const ent = await getEntitlement()
      setEntitlement(ent)
      if (isPro(ent)) {
        setPhotoQuota({ base: 0, bonus: 0, total: FREE_DAILY_AI })
      } else {
        const q = await getPhotoQuota()
        setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
      }
    } catch {
      // 读不到权益不阻塞使用，按免费档处理
      setEntitlement(null)
      setPhotoQuota({ base: FREE_DAILY_AI, bonus: 0, total: FREE_DAILY_AI })
    } finally {
      setReady(true)
    }
  }, [])

  /**
   * 权益状态跟随登录态。
   * SDK 在订阅时会立即回放一次 INITIAL_SESSION，所以这一个 effect 同时承担
   * 「首次加载」与「登录 / 登出后刷新」两件事 —— 原先只在挂载时读一次，
   * 用户登录后权益不会刷新（必须整页刷新才生效，是个既存缺陷）。
   */
  useEffect(() => {
    const off = cloud.auth.onAuthStateChange((event, session) => {
      if (!session) {
        // 未登录 / 已登出：按免费档重置，不发任何数据请求
        setEntitlement(null)
        setPhotoQuota({ base: 0, bonus: 0, total: FREE_DAILY_AI })
        setReady(true)
        return
      }
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') void refresh()
    })
    return off
  }, [refresh])

  const pro = useMemo(() => isPro(entitlement), [entitlement])
  const lifetime = useMemo(() => isLifetime(entitlement), [entitlement])
  const aiRemaining = pro ? null : Math.max(0, photoQuota.total)
  const bonusRemaining = photoQuota.bonus

  // 最近一次成功占用的预占 token，供识别失败退还时精确释放（ref 避免额外渲染）
  const lastTokenRef = useRef<string | null>(null)

  const claimAiQuota = useCallback(async (): Promise<{ allowed: boolean; remaining: number | null }> => {
    if (pro) return { allowed: true, remaining: null }
    const res = await consumePhotoQuota()
    if (res.allowed && res.token) lastTokenRef.current = res.token
    // 消耗后重读额度，拿到准确的剩余（基础+奖励）
    const q = await getPhotoQuota().catch(() => null)
    if (q) setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
    else setPhotoQuota((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }))
    return { allowed: res.allowed, remaining: q ? q.totalRemaining : Math.max(0, photoQuota.total - 1) }
  }, [pro, photoQuota.total])

  const refundAiQuota = useCallback(async () => {
    if (pro) return
    const token = lastTokenRef.current
    lastTokenRef.current = null
    await releasePhotoQuota(token)
    const q = await getPhotoQuota().catch(() => null)
    if (q) setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
  }, [pro])

  const redeem = useCallback(
    async (code: string): Promise<'ok' | 'used' | 'bad'> => {
      // 服务端核销：兑换码已不在前端硬编码，翻包拿不到明文码。
      const res = await redeemByCode(code)
      if (res === 'ok') {
        // 核销成功后刷新权益（entitlements 已由 RPC 写入 lifetime）
        const ent = await getEntitlement().catch(() => null)
        if (ent) setEntitlement(ent)
      }
      return res
    },
    [],
  )

  const openPaywall = useCallback((reason = '') => setPaywall({ open: true, reason }), [])
  const closePaywall = useCallback(() => setPaywall({ open: false, reason: '' }), [])

  /** 完善身体数据后发放新手奖励（一次性，防重复）—— 发蜜糖积分，不再发识别次数 */
  const grantNewbieBonus = useCallback(async (): Promise<boolean> => {
    const ok = await grantHoney('newbie', 'newbie', NEWBIE_BONUS_AMOUNT, BONUS_TTL_DAYS)
    return ok
  }, [])

  /** 连续打卡每满 7 天发放识别次数奖励（7/14/21…各送 2 次；按达成日期防重复） */
  const grantStreakBonus = useCallback(async (dateKey: string): Promise<boolean> => {
    const ok = await grantPhotoBonus('streak7', dateKey, STREAK_BONUS_AMOUNT)
    if (ok) {
      const q = await getPhotoQuota().catch(() => null)
      if (q) setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
    }
    return ok
  }, [])

  const value: PlanContextValue = {
    ready,
    pro,
    lifetime,
    entitlement,
    aiRemaining,
    bonusRemaining,
    claimAiQuota,
    refundAiQuota,
    redeem,
    grantNewbieBonus,
    grantStreakBonus,
    paywall,
    openPaywall,
    closePaywall,
    refresh,
  }

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>
}

export function usePlan(): PlanContextValue {
  const ctx = useContext(PlanContext)
  if (!ctx) throw new Error('usePlan 必须在 PlanProvider 内使用')
  return ctx
}
