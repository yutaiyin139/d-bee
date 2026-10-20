import { useEffect, useState } from 'react'
import { Sheet } from '../components/Sheet'
import { getLeaderboard } from '../lib/leaderboard'
import type { LeaderboardData } from '../lib/leaderboard'
import { errText } from '../lib/errmsg'

/**
 * 站内轻榜单（P2-1）。
 *
 * 两个榜单 + 我的排名，数据来自后端 leaderboard() RPC，昵称已脱敏。
 * 自律榜按连续打卡天数降序；邀请榜按本月成功邀请人数降序。
 * 只展示、不可点击、不含头像 / 完整昵称，保护隐私、不碰 UGC 审核。
 */

type TabKey = 'discipline' | 'invite'

interface LeaderboardSheetProps {
  onClose: () => void
}

const TABS: { key: TabKey; label: string; unit: string }[] = [
  { key: 'discipline', label: '自律榜', unit: '天' },
  { key: 'invite', label: '邀请榜', unit: '人' },
]

export function LeaderboardSheet({ onClose }: LeaderboardSheetProps) {
  const [tab, setTab] = useState<TabKey>('discipline')
  const [data, setData] = useState<LeaderboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void getLeaderboard()
      .then((d) => {
        if (!alive) return
        setData(d)
      })
      .catch((e) => {
        if (!alive) return
        setError(errText(e, '读取榜单失败'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const list = tab === 'discipline' ? data?.self_discipline ?? [] : data?.invite ?? []
  const myValue = tab === 'discipline' ? data?.my.streak ?? 0 : data?.my.invites ?? 0
  const unit = tab === 'discipline' ? '天' : '人'

  // 我的排名：在榜单里找同名不可能（昵称已脱敏），这里用「我的值」给一个保守的
  // 参考位次：统计榜单里比我高的人数 + 1；若我未入榜则显示「未上榜」。
  const myRank = (() => {
    if (!data) return null
    const mine = myValue
    if (tab === 'discipline') {
      if (mine < 3) return null
      const higher = data.self_discipline.filter((e) => (e.streak ?? 0) > mine).length
      return higher + 1
    }
    if (mine <= 0) return null
    const higher = data.invite.filter((e) => (e.invites ?? 0) > mine).length
    return higher + 1
  })()

  return (
    <Sheet title="自律榜单" onClose={onClose}>
      {/* Tab 切换 */}
      <div className="lb-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`lb-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 我的排名卡 */}
      <div className="lb-my">
        <div className="lb-my-label">我的{tab === 'discipline' ? '连续打卡' : '本月邀请'}</div>
        <div className="lb-my-value">
          <b>{myValue}</b> {unit}
          {myRank != null && <span className="lb-my-rank">当前第 {myRank} 名</span>}
        </div>
        {myRank == null && (
          <div className="lb-my-hint">
            {tab === 'discipline' ? '连续打卡满 3 天即可上榜' : '本月成功邀请好友后即可上榜'}
          </div>
        )}
      </div>

      {/* 榜单列表 */}
      {loading ? (
        <div className="lb-skeleton">榜单加载中…</div>
      ) : error ? (
        <div className="notice err">{error}</div>
      ) : list.length === 0 ? (
        <div className="lb-empty">还没有人上榜，快来抢占第一名 🏆</div>
      ) : (
        <ol className="lb-list">
          {list.map((e, i) => (
            <li key={`${e.name}-${i}`} className={`lb-row ${i < 3 ? 'top3' : ''}`}>
              <span className={`lb-rank rank-${i + 1}`}>{i + 1}</span>
              <span className="lb-name">{e.name}</span>
              <span className="lb-score">
                {tab === 'discipline' ? e.streak : e.invites}
                <em>{unit}</em>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="helper" style={{ textAlign: 'center', marginTop: 12, fontSize: 12 }}>
        昵称已脱敏展示 · 榜单每日更新 · 连续打卡满 3 天方可入自律榜
      </div>
    </Sheet>
  )
}
