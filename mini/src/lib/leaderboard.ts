import { cloud } from './cloud'
import { zh } from './errmsg'

/**
 * 站内轻榜单（P2-1，小程序端）。
 * 与主工程 src/lib/leaderboard.ts 对齐，共用同一 leaderboard() RPC。
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
