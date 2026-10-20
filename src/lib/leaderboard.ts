import { cloud } from '../cloud'
import { zh } from './errmsg'

/**
 * 站内轻榜单（P2-1）。
 *
 * 后端 leaderboard() RPC 一次返回两个榜单 + 我的排名：
 *   - self_discipline：自律榜 Top50（按当前连续打卡天数降序，≥3 天才入榜）
 *   - invite：邀请榜 Top50（按本月成功邀请人数降序）
 *   - my：我的自律天数 / 本月邀请数
 *
 * 昵称已由后端脱敏为「首字 + *」，前端只做展示，不做任何身份推断。
 */

interface QueryResult {
  data: unknown
  error: { message?: string } | null
}

export interface LeaderboardEntry {
  name: string
  streak?: number
  invites?: number
}

export interface LeaderboardData {
  self_discipline: LeaderboardEntry[]
  invite: LeaderboardEntry[]
  my: {
    streak: number
    invites: number
  }
}

function callRpc(fn: string, args: Record<string, unknown>): PromiseLike<QueryResult> {
  return (cloud.database as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => PromiseLike<QueryResult>
  }).rpc(fn, args)
}

/** 拉取站内轻榜单（自律榜 + 邀请榜 + 我的排名） */
export async function getLeaderboard(): Promise<LeaderboardData> {
  const { data, error } = await callRpc('leaderboard', {})
  if (error) throw new Error(zh(error.message, '读取榜单失败'))
  const d = (Array.isArray(data) ? data[0] : data) as Partial<LeaderboardData> | null
  return {
    self_discipline: Array.isArray(d?.self_discipline) ? d.self_discipline : [],
    invite: Array.isArray(d?.invite) ? d.invite : [],
    my: {
      streak: Number(d?.my?.streak ?? 0) || 0,
      invites: Number(d?.my?.invites ?? 0) || 0,
    },
  }
}
