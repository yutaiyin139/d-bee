import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { cloud } from '../cloud'
import {
  consumeAiQuota,
  consumePhotoQuota,
  getEntitlement,
  getPhotoQuota,
  grantPhotoBonus,
  releaseAiQuota,
  releasePhotoQuota,
  saveEntitlement,
} from '../lib/api'
import {
  FREE_DAILY_AI,
  FREE_INSIGHT_PER_WEEK,
  INSIGHT_FEATURE,
  NEWBIE_BONUS_AMOUNT,
  SCAN_FEATURE,
  STREAK_BONUS_AMOUNT,
  codeIsValid,
  isLifetime,
  isPro,
  mondayOf,
  normalizeCode,
  proUntilFromMonths,
} from '../lib/entitlement'
import { todayKey } from '../lib/nutrition'
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
  /** 周洞察配额：原子占用，false 表示本周已用过 */
  claimInsightQuota: () => Promise<boolean>
  refundInsightQuota: () => Promise<void>
  redeem: (code: string) => Promise<'ok' | 'bad'>
  /**
   * 购买/激活一个商品档位。真实支付未接入前由兑换码或后台直达触发；
   * 接入支付后由支付回调调用，写入云端 entitlements。
   */
  activate: (plan: 'pro' | 'lifetime', months?: number) => Promise<void>
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

  const claimAiQuota = useCallback(async (): Promise<{ allowed: boolean; remaining: number | null }> => {
    if (pro) return { allowed: true, remaining: null }
    const res = await consumePhotoQuota()
    // 消耗后重读额度，拿到准确的剩余（基础+奖励）
    const q = await getPhotoQuota().catch(() => null)
    if (q) setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
    else setPhotoQuota((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }))
    return { allowed: res.allowed, remaining: q ? q.totalRemaining : Math.max(0, photoQuota.total - 1) }
  }, [pro, photoQuota.total])

  const refundAiQuota = useCallback(async () => {
    if (pro) return
    await releasePhotoQuota()
    const q = await getPhotoQuota().catch(() => null)
    if (q) setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
  }, [pro])

  const claimInsightQuota = useCallback(async (): Promise<boolean> => {
    if (pro) return true
    const res = await consumeAiQuota(mondayOf(todayKey()), INSIGHT_FEATURE, FREE_INSIGHT_PER_WEEK)
    return res.allowed
  }, [pro])

  const refundInsightQuota = useCallback(async () => {
    if (pro) return
    await releaseAiQuota(mondayOf(todayKey()), INSIGHT_FEATURE)
  }, [pro])

  const redeem = useCallback(
    async (code: string): Promise<'ok' | 'bad'> => {
      if (!codeIsValid(code)) return 'bad'
      const saved = await saveEntitlement({
        plan: 'lifetime',
        pro_until: null,
        redeemed_code: normalizeCode(code),
        source: 'redeem',
      })
      setEntitlement(saved)
      return 'ok'
    },
    [],
  )

  /**
   * 激活一个档位（pro 订阅 / lifetime 买断）。
   * 真实支付接入后，由支付成功回调调用；当前由兑换码或后台直达触发。
   */
  const activate = useCallback(
    async (plan: 'pro' | 'lifetime', months?: number) => {
      const patch: Partial<Entitlement> =
        plan === 'lifetime'
          ? { plan: 'lifetime', pro_until: null, redeemed_code: null, source: 'apple' }
          : { plan: 'pro', pro_until: proUntilFromMonths(months ?? 1), redeemed_code: null, source: 'apple' }
      const saved = await saveEntitlement(patch as Parameters<typeof saveEntitlement>[0])
      setEntitlement(saved)
    },
    [],
  )

  const openPaywall = useCallback((reason = '') => setPaywall({ open: true, reason }), [])
  const closePaywall = useCallback(() => setPaywall({ open: false, reason: '' }), [])

  /** 完善身体数据 → 一次性赠送新手奖励（grant_key 固定 'newbie'，防重复） */
  const grantNewbieBonus = useCallback(async (): Promise<boolean> => {
    const ok = await grantPhotoBonus('newbie', 'newbie', NEWBIE_BONUS_AMOUNT)
    if (ok) {
      const q = await getPhotoQuota().catch(() => null)
      if (q) setPhotoQuota({ base: q.baseRemaining, bonus: q.bonusRemaining, total: q.totalRemaining })
    }
    return ok
  }, [])

  /** 连续打卡 7 天 → 奖励（grant_key 用达成日期，同一天不重复发） */
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
    claimInsightQuota,
    refundInsightQuota,
    redeem,
    activate,
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
