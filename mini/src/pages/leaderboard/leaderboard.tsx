/**
 * 站内轻榜单（P2-1，小程序端，对齐主工程 LeaderboardSheet）。
 *
 * 两个榜单 + 我的排名，数据来自后端 leaderboard() RPC，昵称已脱敏。
 * 自律榜按连续打卡天数降序；邀请榜按本月成功邀请人数降序。
 */
import { useEffect, useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { getLeaderboard, type LeaderboardData } from '../../lib/leaderboard'
import './leaderboard.scss'

type TabKey = 'discipline' | 'invite'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'discipline', label: '自律榜' },
  { key: 'invite', label: '邀请榜' },
]

export default function LeaderboardPage() {
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
      .catch(() => {
        if (!alive) return
        setError('读取榜单失败，请稍后重试')
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

  const myRank = (() => {
    if (!data) return null
    const mine = myValue
    if (tab === 'discipline') {
      if (mine < 3) return null
      return data.self_discipline.filter((e) => (e.streak ?? 0) > mine).length + 1
    }
    if (mine <= 0) return null
    return data.invite.filter((e) => (e.invites ?? 0) > mine).length + 1
  })()

  // 分享到好友 / 朋友圈基础适配（对齐 invite 页）
  useShareAppMessage(() => ({
    title: '看看自律蜜蜂的自律榜单，一起坚持打卡吧！',
    path: '/pages/leaderboard/leaderboard',
  }))
  useShareTimeline(() => ({
    title: '自律蜜蜂 · 自律榜单',
    query: '',
  }))

  return (
    <View className='page leaderboard'>
      <View className='hero'>
        <Text className='hero-title'>自律榜单</Text>
      </View>

      {/* Tab 切换 */}
      <View className='lb-tabs'>
        {TABS.map((t) => (
          <Button
            key={t.key}
            className={`lb-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </View>

      {/* 我的排名卡 */}
      <View className='lb-my'>
        <Text className='lb-my-label'>我的{tab === 'discipline' ? '连续打卡' : '本月邀请'}</Text>
        <Text className='lb-my-value'>
          <Text className='lb-my-num'>{myValue}</Text> {unit}
          {myRank != null ? <Text className='lb-my-rank'>当前第 {myRank} 名</Text> : null}
        </Text>
        {myRank == null ? (
          <Text className='lb-my-hint'>
            {tab === 'discipline' ? '连续打卡满 3 天即可上榜' : '本月成功邀请好友后即可上榜'}
          </Text>
        ) : null}
      </View>

      {/* 榜单列表 */}
      {loading ? (
        <View className='lb-skeleton'><Text>榜单加载中…</Text></View>
      ) : error ? (
        <View className='notice'><Text>{error}</Text></View>
      ) : list.length === 0 ? (
        <View className='lb-empty'><Text>还没有人上榜，快来抢占第一名 🏆</Text></View>
      ) : (
        <View className='lb-list'>
          {list.map((e, i) => (
            <View key={`${e.name}-${i}`} className={`lb-row ${i < 3 ? 'top3' : ''}`}>
              <Text className={`lb-rank rank-${i + 1}`}>{i + 1}</Text>
              <Text className='lb-name'>{e.name}</Text>
              <Text className='lb-score'>
                {tab === 'discipline' ? e.streak : e.invites}
                <Text className='lb-unit'>{unit}</Text>
              </Text>
            </View>
          ))}
        </View>
      )}

      <View className='helper' style={{ textAlign: 'center', marginTop: 24 }}>
        <Text>昵称已脱敏展示 · 榜单每日更新 · 连续打卡满 3 天方可入自律榜</Text>
      </View>

      <View className='bottom-space' />
    </View>
  )
}
