/**
 * 蜜糖积分中心（对齐主工程 src/pages/InviteCenter.tsx）。
 *
 * 四块：邀请码 / 积分余额 / 兑换商城 / 成就墙 + 流水。
 * 差异点（小程序端能力诚实降级）：
 *  - 分享卡片（canvas 绘制）→ 降级为「复制邀请口令」
 *  - 徽章分享卡 → 降级为「复制徽章名」
 *  - 会员兑换（pro1Day/pro30Day）在小程序端暂不支持支付，仍走 redeem_honey RPC
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { BADGES } from '../../lib/badge'
import { checkStatBadges } from '../../lib/badgeCheck'
import {
  expireStaleHoney, getHoneyBalance, getMyInviteCode,
  listHoneyLedger, listInvitees, listMyBadges, redeemHoney,
  type HoneyBalance, type HoneyLedger, type Badge,
} from '../../lib/api'
import { HONEY_PRICE, formatHoneyTime, REASON_LABEL } from '../../lib/invite'
import { copyText } from '../../lib/clipboard'
import './invite.scss'

export default function InvitePage() {
  const [code, setCode] = useState('')
  const [balance, setBalance] = useState<HoneyBalance | null>(null)
  const [ledger, setLedger] = useState<HoneyLedger[]>([])
  const [badges, setBadges] = useState<Badge[]>([])
  const [invitees, setInvitees] = useState(0)
  const [settled, setSettled] = useState(0)
  const [redeeming, setRedeeming] = useState<string | null>(null)
  const [redeemMsg, setRedeemMsg] = useState('')
  const [shareMsg, setShareMsg] = useState('')
  const [coreLoading, setCoreLoading] = useState(true)
  const [extraLoading, setExtraLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [c, inv] = await Promise.all([getMyInviteCode(), listInvitees(), expireStaleHoney()])
        const b = await getHoneyBalance()
        if (!alive) return
        setCode(c)
        setBalance(b)
        setInvitees(inv.invitees)
        setSettled(inv.settled)
      } catch {
        /* 静默 */
      } finally {
        if (alive) setCoreLoading(false)
      }
    })()
    void (async () => {
      try {
        await expireStaleHoney()
        const [l, g] = await Promise.all([listHoneyLedger(50), listMyBadges()])
        if (!alive) return
        setLedger(l)
        setBadges(g)
        // 打开积分中心时批量检查统计类徽章（对齐主工程，幂等）
        void checkStatBadges().then((fresh) => {
          if (!alive || fresh.length === 0) return
          void listMyBadges().then((updated) => {
            if (alive) setBadges(updated)
          })
        })
      } catch {
        /* 静默 */
      } finally {
        if (alive) setExtraLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  async function handleRedeem(kind: 'pro1Day' | 'pro30Day' | 'ai1Scan', cost: number) {
    setRedeeming(kind)
    setRedeemMsg('')
    try {
      const bal = await getHoneyBalance().catch(() => null)
      if (bal && bal.balance < cost) {
        setRedeemMsg('积分不足')
        return
      }
      const res = await redeemHoney(kind)
      if (res.ok) {
        setRedeemMsg('兑换成功！')
        setBalance(await getHoneyBalance())
      } else {
        setRedeemMsg(kind === 'ai1Scan' ? '今日兑换次数已用完（每日最多 2 次），明天再试' : res.message)
      }
    } catch {
      setRedeemMsg('兑换失败，请稍后重试')
    } finally {
      setRedeeming(null)
    }
  }

  const unlockedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const b of badges) s.add(b.badge_key)
    return s
  }, [badges])

  // 小程序右上角「转发」与「分享到朋友圈」基础适配（P0-4）
  useShareAppMessage(() => {
    const title = code
      ? `我在用「自律蜜蜂」自律打卡，邀请码 ${code}，注册双方得积分`
      : '我在用「自律蜜蜂」记录饮食、自律打卡，一起变自律吧！'
    const path = code ? `/pages/index/index?inviter=${encodeURIComponent(code)}` : '/pages/index/index'
    return { title, path }
  })

  useShareTimeline(() => {
    const title = code
      ? `我在用「自律蜜蜂」自律打卡，邀请码 ${code}，注册双方得积分`
      : '我在用「自律蜜蜂」记录饮食、自律打卡，一起变自律吧！'
    const query = code ? `inviter=${encodeURIComponent(code)}` : ''
    return { title, query }
  })

  const copyCode = useCallback(async () => {
    if (!code) {
      setShareMsg('邀请码加载中，请稍候')
      return
    }
    const ok = await copyText(code)
    setShareMsg(ok ? '邀请码已复制' : '复制失败，请长按邀请码手动复制')
  }, [code])

  const shareInvite = useCallback(async () => {
    if (!code) {
      setShareMsg('邀请码加载中，请稍候')
      return
    }
    const text = `我在用「自律蜜蜂」记录饮食、自律打卡，用我的邀请码 ${code} 注册，双方都能得积分！`
    setShareMsg('')
    const ok = await copyText(text)
    setShareMsg(ok ? '邀请口令已复制，去粘贴给好友吧' : '复制失败，请长按邀请码手动复制')
  }, [code])

  const shareBadge = useCallback(async (key: string) => {
    const b = BADGES.find((x) => x.key === key)
    if (!b) return
    const ok = await copyText(`我在「自律蜜蜂」解锁了「${b.name}」！`)
    setShareMsg(ok ? `「${b.name}」分享文案已复制` : '复制失败')
  }, [])

  return (
    <View className='page invite'>
      <View className='hero'>
        <Text className='hero-title'>蜜糖积分</Text>
      </View>

      {coreLoading ? (
        <View className='skeleton' style={{ height: 200 }} />
      ) : (
        <>
          {/* 邀请码 */}
          <View className='card'>
            <Text className='card-label'>我的邀请码</Text>
            <View className='code-row'>
              <Button className='invite-code' onClick={() => void copyCode()}>{code || '———'}</Button>
              <Text className='code-hint'>点击复制</Text>
            </View>
            {shareMsg ? <View className='notice'><Text>{shareMsg}</Text></View> : null}
            <Button className='btn' onClick={() => void shareInvite()}>🐝 邀请好友</Button>
            <Text className='helper'>
              好友用此码注册，双方都能获得积分 · 已邀请 {invitees} 人{settled > 0 ? `（${settled} 人已达标）` : ''}
            </Text>
          </View>

          {/* 积分余额 */}
          <View className='card'>
            <View className='balance-row'>
              <Text className='balance-label'>可用积分</Text>
              <Text className='balance-num'>{balance?.balance ?? 0}</Text>
            </View>
            <Text className='helper'>
              累计获得 {balance?.totalEarned ?? 0} · 已消耗 {balance?.totalSpent ?? 0} · 积分不可提现，仅平台内兑换
            </Text>
          </View>

          {/* 兑换商城 */}
          <View className='section-title'><Text>兑换</Text></View>
          <View className='card'>
            <View className='list-line'>
              <Text className='line-label'>Pro 会员 1 天</Text>
              <Button
                className='btn-text'
                disabled={redeeming === 'pro1Day'}
                onClick={() => void handleRedeem('pro1Day', HONEY_PRICE.pro1Day)}
              >
                {redeeming === 'pro1Day' ? '兑换中…' : `${HONEY_PRICE.pro1Day} 积分`}
              </Button>
            </View>
            <View className='list-line'>
              <Text className='line-label'>Pro 会员 30 天</Text>
              <Button
                className='btn-text'
                disabled={redeeming === 'pro30Day'}
                onClick={() => void handleRedeem('pro30Day', HONEY_PRICE.pro30Day)}
              >
                {redeeming === 'pro30Day' ? '兑换中…' : `${HONEY_PRICE.pro30Day} 积分`}
              </Button>
            </View>
            <View className='list-line'>
              <Text className='line-label'>AI 拍照识别 1 次（每日最多兑 2 次）</Text>
              <Button
                className='btn-text'
                disabled={redeeming === 'ai1Scan'}
                onClick={() => void handleRedeem('ai1Scan', HONEY_PRICE.ai1Scan)}
              >
                {redeeming === 'ai1Scan' ? '兑换中…' : `${HONEY_PRICE.ai1Scan} 积分`}
              </Button>
            </View>
            {redeemMsg ? <View className='notice'><Text>{redeemMsg}</Text></View> : null}
          </View>

          {/* 成就墙 */}
          <View className='section-title'>
            <Text>成就</Text>
            <Text className='hint'>点亮后点击可分享</Text>
          </View>
          {extraLoading ? (
            <View className='skeleton' style={{ height: 120 }} />
          ) : (
            <View className='badge-grid'>
              {BADGES.map((b) => {
                const unlocked = unlockedKeys.has(b.key)
                return (
                  <Button
                    key={b.key}
                    className={`badge-item ${unlocked ? 'unlocked' : ''}`}
                    onClick={() => unlocked && void shareBadge(b.key)}
                  >
                    <View className='badge-circle'>{unlocked ? '🐝' : '·'}</View>
                    <Text className='badge-name'>{b.name}</Text>
                  </Button>
                )
              })}
            </View>
          )}
        </>
      )}

      {/* 积分流水 */}
      {!extraLoading && ledger.length > 0 ? (
        <>
          <View className='section-title'>
            <Text>积分明细</Text>
            <Text className='hint'>
              <Text className='gain'>+ 获得</Text>
              <Text className='spend'>− 消耗</Text>
            </Text>
          </View>
          <View className='card'>
            {ledger.slice(0, 20).map((l) => (
              <View className='list-line' key={l.id}>
                <Text className='ledger-time'>{formatHoneyTime(l.created_at)}</Text>
                <Text className='ledger-reason'>{REASON_LABEL[l.reason] ?? l.reason}</Text>
                <Text className={`ledger-amount ${l.amount >= 0 ? 'gain' : 'spend'}`}>
                  {l.amount >= 0 ? `+${l.amount}` : `${l.amount}`}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <View className='bottom-space' />
    </View>
  )
}
