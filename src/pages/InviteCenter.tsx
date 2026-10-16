import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sheet } from '../components/Sheet'
import { BADGES } from '../lib/badge'
import {
  getHoneyBalance,
  getMyInviteCode,
  listHoneyLedger,
  listInvitees,
  listMyBadges,
  redeemHoney,
} from '../lib/api'
import { HONEY_PRICE } from '../lib/invite'
import type { Badge, HoneyBalance, HoneyLedger } from '../types'

/**
 * 蜜糖积分中心（底部弹层）。
 * 四块：邀请码 / 积分余额 / 兑换商城（V1 占位，阶段 7 接通）/ 成就墙 + 流水。
 * 积分不可提现、不可转让，仅平台内兑换。
 */

const REASON_LABEL: Record<string, string> = {
  checkin_meal: '记一餐',
  checkin_water: '饮水达标',
  checkin_exercise: '记录运动',
  streak_milestone: '连续打卡里程碑',
  invitee_register: '注册奖励',
  invitee_checkin: '打卡达标奖励',
  inviter_register: '邀请好友注册',
  inviter_checkin: '好友打卡达标',
  redeem: '兑换消耗',
  expire: '过期失效',
  refund: '风控扣回',
}

interface InviteCenterProps {
  onClose: () => void
}

export function InviteCenter({ onClose }: InviteCenterProps) {
  const [code, setCode] = useState('')
  const [balance, setBalance] = useState<HoneyBalance | null>(null)
  const [ledger, setLedger] = useState<HoneyLedger[]>([])
  const [badges, setBadges] = useState<Badge[]>([])
  const [invitees, setInvitees] = useState(0)
  const [settled, setSettled] = useState(0)
  const [loading, setLoading] = useState(true)
  const [redeeming, setRedeeming] = useState<string | null>(null)
  const [redeemMsg, setRedeemMsg] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [c, b, l, g, inv] = await Promise.all([
          getMyInviteCode(),
          getHoneyBalance(),
          listHoneyLedger(50),
          listMyBadges(),
          listInvitees(),
        ])
        setCode(c)
        setBalance(b)
        setLedger(l)
        setBadges(g)
        setInvitees(inv.invitees)
        setSettled(inv.settled)
      } catch {
        /* 静默：积分中心读取失败不阻塞 */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function handleRedeem(kind: 'pro1Day' | 'pro30Day' | 'ai1Scan', cost: number) {
    setRedeeming(kind)
    setRedeemMsg('')
    try {
      const ok = await redeemHoney(kind)
      if (ok) {
        setRedeemMsg('兑换成功！')
        setBalance(await getHoneyBalance())
      } else {
        setRedeemMsg('积分不足或已是终身会员，无法兑换')
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

  const shareInvite = useCallback(() => {
    const text = `我在用「自律蜜蜂」记录饮食、自律打卡，用我的邀请码 ${code} 注册，一起变自律吧！`
    if (typeof navigator !== 'undefined' && navigator.share) {
      void navigator.share({ text }).catch(() => undefined)
    } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => undefined)
    }
  }, [code])

  return (
    <Sheet title="蜜糖积分" onClose={onClose}>
      {loading ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <>
          {/* 邀请码 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>我的邀请码</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: 3, fontVariantNumeric: 'tabular-nums' }}>
                {code || '———'}
              </div>
              <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={shareInvite}>
                分享
              </button>
            </div>
            <div className="helper" style={{ marginTop: 8 }}>
              好友用此码注册，双方都能获得积分 · 已邀请 {invitees} 人{settled > 0 ? `（${settled} 人已达标）` : ''}
            </div>
          </div>

          {/* 积分余额 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>可用积分</span>
              <span style={{ fontSize: 30, fontWeight: 600, color: 'var(--honey-dark)' }}>
                {balance?.balance ?? 0}
              </span>
            </div>
            <div className="helper" style={{ marginTop: 6 }}>
              累计获得 {balance?.totalEarned ?? 0} · 已消耗 {balance?.totalSpent ?? 0} · 积分不可提现，仅平台内兑换
            </div>
          </div>

          {/* 兑换商城 */}
          <div className="section-title">兑换</div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="list-line">
              <span>Pro 会员 1 天</span>
              <button
                className="btn-text"
                style={{ color: 'var(--honey-dark)' }}
                disabled={redeeming === 'pro1Day'}
                onClick={() => void handleRedeem('pro1Day', HONEY_PRICE.pro1Day)}
              >
                {redeeming === 'pro1Day' ? '兑换中…' : `${HONEY_PRICE.pro1Day} 积分`}
              </button>
            </div>
            <div className="list-line">
              <span>Pro 会员 30 天</span>
              <button
                className="btn-text"
                style={{ color: 'var(--honey-dark)' }}
                disabled={redeeming === 'pro30Day'}
                onClick={() => void handleRedeem('pro30Day', HONEY_PRICE.pro30Day)}
              >
                {redeeming === 'pro30Day' ? '兑换中…' : `${HONEY_PRICE.pro30Day} 积分`}
              </button>
            </div>
            <div className="list-line">
              <span>AI 拍照 1 次</span>
              <button
                className="btn-text"
                style={{ color: 'var(--honey-dark)' }}
                disabled={redeeming === 'ai1Scan'}
                onClick={() => void handleRedeem('ai1Scan', HONEY_PRICE.ai1Scan)}
              >
                {redeeming === 'ai1Scan' ? '兑换中…' : `${HONEY_PRICE.ai1Scan} 积分`}
              </button>
            </div>
            {redeemMsg && (
              <div className="notice" style={{ marginTop: 8, fontSize: 13 }}>{redeemMsg}</div>
            )}
          </div>

          {/* 成就墙 */}
          <div className="section-title">成就</div>
          <div className="card" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {BADGES.map((b) => {
              const unlocked = unlockedKeys.has(b.key)
              return (
                <div
                  key={b.key}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    width: 64,
                    opacity: unlocked ? 1 : 0.35,
                  }}
                  title={unlocked ? b.desc : `未解锁：${b.desc}`}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      background: unlocked ? 'var(--honey-soft, #FAEEDA)' : 'var(--line)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                    }}
                  >
                    {unlocked ? '🐝' : '·'}
                  </div>
                  <div style={{ fontSize: 11, marginTop: 4, textAlign: 'center', lineHeight: 1.2 }}>{b.name}</div>
                </div>
              )
            })}
          </div>

          {/* 积分流水 */}
          {ledger.length > 0 && (
            <>
              <div className="section-title">积分明细</div>
              <div className="card">
                {ledger.slice(0, 20).map((l) => (
                  <div className="list-line" key={l.id}>
                    <span>{REASON_LABEL[l.reason] ?? l.reason}</span>
                    <span className="val" style={{ color: l.amount >= 0 ? 'var(--honey-dark)' : 'var(--ink-3)' }}>
                      {l.amount >= 0 ? '+' : ''}{l.amount}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  )
}
