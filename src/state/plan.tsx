import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { cloud } from '../cloud'
import { consumeAiQuota, getEntitlement, getUsage, releaseAiQuota, saveEntitlement } from '../lib/api'
import {
  FREE_DAILY_AI,
  FREE_INSIGHT_PER_WEEK,
  INSIGHT_FEATURE,
  SCAN_FEATURE,
  codeIsValid,
  isPro,
  mondayOf,
  normalizeCode,
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
  entitlement: Entitlement | null
  /** 今日剩余 AI 次数；Pro 返回 null（无限） */
  aiRemaining: number | null
  /** 原子占用一次 AI 额度：allowed=false 表示今日已用完，调用方应弹付费墙并中止 */
  claimAiQuota: () => Promise<{ allowed: boolean; remaining: number | null }>
  /** AI 调用失败（报错 / 超时）时退还刚占用的额度，避免用户白扣次数 */
  refundAiQuota: () => Promise<void>
  /** 周洞察配额：原子占用，false 表示本周已用过 */
  claimInsightQuota: () => Promise<boolean>
  refundInsightQuota: () => Promise<void>
  redeem: (code: string) => Promise<'ok' | 'bad'>
  paywall: { open: boolean; reason: string }
  openPaywall: (reason?: string) => void
  closePaywall: () => void
  refresh: () => Promise<void>
}

const PlanContext = createContext<PlanContextValue | null>(null)

export function PlanProvider({ children }: { children: ReactNode }) {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [ready, setReady] = useState(false)
  const [usedToday, setUsedToday] = useState(0)
  const [paywall, setPaywall] = useState({ open: false, reason: '' })

  const refresh = useCallback(async () => {
    // 先看登录态：未登录不请求云端。
    // 数据库表权限只授予 authenticated（anon 已 REVOKE），匿名请求会拿到 401，
    // 而这个 401 无法被下面的 try/catch 消除（网络层报错先于 JS 捕获）。
    const { data: session } = await cloud.auth.getSession()
    if (!session) {
      setEntitlement(null)
      setUsedToday(0)
      setReady(true)
      return
    }
    try {
      const ent = await getEntitlement()
      setEntitlement(ent)
      setUsedToday(await getUsage(todayKey(), SCAN_FEATURE))
    } catch {
      // 读不到权益不阻塞使用，按免费档处理
      setEntitlement(null)
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
        setUsedToday(0)
        setReady(true)
        return
      }
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') void refresh()
    })
    return off
  }, [refresh])

  const pro = useMemo(() => isPro(entitlement), [entitlement])
  const aiRemaining = pro ? null : Math.max(0, FREE_DAILY_AI - usedToday)

  const claimAiQuota = useCallback(async (): Promise<{ allowed: boolean; remaining: number | null }> => {
    if (pro) return { allowed: true, remaining: null }
    const res = await consumeAiQuota(todayKey(), SCAN_FEATURE, FREE_DAILY_AI)
    setUsedToday(res.used)
    return { allowed: res.allowed, remaining: res.remaining }
  }, [pro])

  const refundAiQuota = useCallback(async () => {
    if (pro) return
    await releaseAiQuota(todayKey(), SCAN_FEATURE)
    setUsedToday((prev) => Math.max(0, prev - 1))
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
        plan: 'pro',
        pro_until: null,
        redeemed_code: normalizeCode(code),
      })
      setEntitlement(saved)
      return 'ok'
    },
    [],
  )

  const openPaywall = useCallback((reason = '') => setPaywall({ open: true, reason }), [])
  const closePaywall = useCallback(() => setPaywall({ open: false, reason: '' }), [])

  const value: PlanContextValue = {
    ready,
    pro,
    entitlement,
    aiRemaining,
    claimAiQuota,
    refundAiQuota,
    claimInsightQuota,
    refundInsightQuota,
    redeem,
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
