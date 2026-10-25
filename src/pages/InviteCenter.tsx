import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sheet } from '../components/Sheet'
import { BADGES } from '../lib/badge'
import {
  expireStaleHoney,
  getHoneyBalance,
  getMyInviteCode,
  listHoneyLedger,
  listInvitees,
  listMyBadges,
  redeemHoney,
} from '../lib/api'
import { HONEY_PRICE, formatHoneyTime } from '../lib/invite'
import { copyText } from '../lib/clipboard'
import { checkStatBadges } from '../lib/badgeCheck'
import { createShareCanvas, drawBadgeCard, drawInviteCard, canvasToBlob } from '../lib/sharecard'
import { shareImage } from '../lib/share'
import type { Badge, HoneyBalance, HoneyLedger } from '../types'
import { errText } from '../lib/errmsg'
import { usePlan } from '../state/plan'

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
  expire: '积分过期',
  refund: '删除记录收回',
}

interface InviteCenterProps {
  onClose: () => void
}

export function InviteCenter({ onClose }: InviteCenterProps) {
  const { lifetime, refresh } = usePlan()
  const [code, setCode] = useState('')
  const [balance, setBalance] = useState<HoneyBalance | null>(null)
  const [ledger, setLedger] = useState<HoneyLedger[]>([])
  const [badges, setBadges] = useState<Badge[]>([])
  const [invitees, setInvitees] = useState(0)
  const [settled, setSettled] = useState(0)
  const [redeeming, setRedeeming] = useState<string | null>(null)
  const [redeemMsg, setRedeemMsg] = useState('')
  const [shareMsg, setShareMsg] = useState('')
  const [sharingCard, setSharingCard] = useState<string | null>(null)
  const [shareCardMsg, setShareCardMsg] = useState('')
  // 分享动作面板（方案 A：一个主按钮 → 弹出选「图片卡/文字口令」）
  const [shareOpen, setShareOpen] = useState(false)
  // 分块加载：核心（邀请码/余额/邀请人数）与次要（成就/流水）独立加载，
  // 避免打开面板时整块骨架屏一次性跳变产生顿挫
  const [coreLoading, setCoreLoading] = useState(true)
  const [extraLoading, setExtraLoading] = useState(true)

  useEffect(() => {
    let alive = true
    // 核心块：邀请码 + 余额 + 邀请人数（分享/兑换依赖，优先加载）
    void (async () => {
      try {
        // 先结算过期积分（幂等），再读余额，保证余额已扣掉过期部分
        // 结算与读邀请码/人数互不依赖，并行发起，缩短首屏等待
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
    // 次要块：成就墙 + 流水（后到不影响核心操作）
    void (async () => {
      try {
        // 结算过期积分会影响统计徽章判定，先幂等结算一次再读徽章/流水，
        // 避免徽章墙先渲染旧状态、随后又被 checkStatBadges 二次刷新导致闪动
        await expireStaleHoney()
        const [l, g] = await Promise.all([listHoneyLedger(50), listMyBadges()])
        if (!alive) return
        setLedger(l)
        setBadges(g)
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
      // 终身会员不能兑换 Pro（ai1Scan 兑换不受会员档位限制）
      if (kind !== 'ai1Scan' && lifetime) {
        setRedeemMsg('已是终身会员，无需兑换')
        return
      }
      // 实时读余额，精确判断「积分不足」（不依赖后端模糊的 false）
      const bal = await getHoneyBalance().catch(() => null)
      if (bal && bal.balance < cost) {
        setRedeemMsg('积分不足')
        return
      }
      const res = await redeemHoney(kind)
      if (res.ok) {
        setRedeemMsg('兑换成功！')
        setBalance(await getHoneyBalance())
        // pro1Day / pro30Day 兑换成功后立即刷新全局权益（entitlement）：
        // 否则 usePlan.pro 仍是旧值，付费功能（生成解读 / 超 3 餐拍照）会继续按免费
        // 处理，必须重启 App 才生效。ai1Scan 只发拍照额度、不动会员档位，无需刷新权益。
        if (kind !== 'ai1Scan') void refresh()
      } else {
        // 余额已提前校验，此处 false 对 ai1Scan 而言基本是「已达每日兑换上限」，
        // 给精准提示而非笼统报错；其余档位透传具体原因。
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

  /** 复制邀请口令（文字 + 链接），适合私聊粘贴 */
  const shareInvite = useCallback(async () => {
    setShareOpen(false)
    if (!code) {
      setShareMsg('邀请码加载中，请稍候')
      return
    }
    // 邀请链接：指向当前站点，带 ?invite=CODE，好友点开自动带入邀请码注册
    const link = `${location.origin}?invite=${encodeURIComponent(code)}`
    const text = `我在用「自律蜜蜂」记录饮食、自律打卡，用我的邀请码 ${code} 注册，双方都能得积分！\n${link}`
    setShareMsg('')

    // 复制邀请口令到剪贴板（copyText 内置 http 环境兜底）
    const ok = await copyText(text)
    setShareMsg(ok ? '邀请口令已复制，去粘贴给好友吧' : '复制失败，请长按邀请码手动复制')
  }, [code])

  /** 复制纯邀请码（点击邀请码本身） */
  const copyCode = useCallback(async () => {
    if (!code) {
      setShareMsg('邀请码加载中，请稍候')
      return
    }
    const ok = await copyText(code)
    setShareMsg(ok ? '邀请码已复制' : '复制失败，请长按邀请码手动复制')
  }, [code])

  /** 分享徽章卡（解锁的徽章） */
  const shareBadge = useCallback(
    async (key: string) => {
      const b = BADGES.find((x) => x.key === key)
      if (!b) return
      setSharingCard(key)
      setShareCardMsg('')
      try {
        const canvas = createShareCanvas()
        drawBadgeCard(canvas, { name: b.name, desc: b.desc, emoji: '🏆' })
        const blob = await canvasToBlob(canvas)
        const res = await shareImage(blob, {
          filename: `d-bee-badge-${key}.png`,
          title: '自律蜜蜂 · 成就徽章',
          text: `我在「自律蜜蜂」解锁了「${b.name}」！`,
        })
        setShareCardMsg(res.message)
      } catch (e) {
        setShareCardMsg(errText(e, '生成徽章卡失败'))
      } finally {
        setSharingCard(null)
      }
    },
    [],
  )

  /** 分享邀请卡（精美邀请卡，替代纯文字口令） */
  const shareInviteCard = useCallback(async () => {
    setShareOpen(false)
    if (!code) {
      setShareCardMsg('邀请码加载中，请稍候')
      return
    }
    setSharingCard('invite')
    setShareCardMsg('')
    try {
      const link = `${location.origin}?invite=${encodeURIComponent(code)}`
      const canvas = createShareCanvas()
      drawInviteCard(canvas, { code, link })
      const blob = await canvasToBlob(canvas)
      const res = await shareImage(blob, {
        filename: `d-bee-invite-${code}.png`,
        title: '自律蜜蜂 · 邀请好友',
        text: `用我的邀请码 ${code} 注册自律蜜蜂，双方都能得积分！`,
      })
      setShareCardMsg(res.message)
    } catch (e) {
      setShareCardMsg(errText(e, '生成邀请卡失败'))
    } finally {
      setSharingCard(null)
    }
  }, [code])

  return (
    <Sheet title="蜜糖积分" onClose={onClose}>
      {coreLoading ? (
        <div className="invite-skeleton">
          <div className="sk-line" style={{ width: '38%' }} />
          <div className="sk-line sk-line-lg" style={{ width: '56%' }} />
          <div className="sk-line" style={{ width: '70%' }} />
          <div className="sk-gap" />
          <div className="sk-line" style={{ width: '28%' }} />
          <div className="sk-line sk-line-lg" style={{ width: '44%' }} />
          <div className="sk-line" style={{ width: '82%' }} />
        </div>
      ) : (
        <div className="invite-fade-in">
          {/* 邀请码 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>我的邀请码</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className="invite-code"
                style={{ fontSize: 24, fontWeight: 600, letterSpacing: 3, fontVariantNumeric: 'tabular-nums' }}
                onClick={() => void copyCode()}
                title="点击复制邀请码"
              >
                {code || '———'}
              </button>
              <span className="invite-code-hint">点击复制</span>
            </div>
            {shareMsg && (
              <div className="notice" style={{ marginTop: 8, fontSize: 13 }}>{shareMsg}</div>
            )}
            {shareCardMsg && (
              <div className="notice" style={{ marginTop: 8, fontSize: 13 }}>{shareCardMsg}</div>
            )}
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setShareOpen(true)}>
              🐝 邀请好友
            </button>
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
                style={{ color: lifetime ? 'var(--ink-3)' : 'var(--honey-dark)' }}
                disabled={redeeming === 'pro1Day' || lifetime}
                onClick={() => void handleRedeem('pro1Day', HONEY_PRICE.pro1Day)}
              >
                {lifetime ? '已是终身会员' : redeeming === 'pro1Day' ? '兑换中…' : `${HONEY_PRICE.pro1Day} 积分`}
              </button>
            </div>
            <div className="list-line">
              <span>Pro 会员 30 天</span>
              <button
                className="btn-text"
                style={{ color: lifetime ? 'var(--ink-3)' : 'var(--honey-dark)' }}
                disabled={redeeming === 'pro30Day' || lifetime}
                onClick={() => void handleRedeem('pro30Day', HONEY_PRICE.pro30Day)}
              >
                {lifetime ? '已是终身会员' : redeeming === 'pro30Day' ? '兑换中…' : `${HONEY_PRICE.pro30Day} 积分`}
              </button>
            </div>
            <div className="list-line">
              <span>AI 拍照识别 1 次（每日最多兑 2 次）</span>
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
          <div className="section-title">
            成就
            <span className="hint">点亮后点击可分享</span>
          </div>
          {extraLoading ? (
            <div className="invite-skeleton invite-skeleton-badges">
              <div className="sk-badge" />
              <div className="sk-badge" />
              <div className="sk-badge" />
              <div className="sk-badge" />
              <div className="sk-badge" />
            </div>
          ) : (
            <div className="card invite-fade-in" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {BADGES.map((b) => {
                const unlocked = unlockedKeys.has(b.key)
                return (
                  <button
                    key={b.key}
                    onClick={() => unlocked && void shareBadge(b.key)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      width: 64,
                      opacity: unlocked ? 1 : 0.35,
                      cursor: unlocked ? 'pointer' : 'default',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                    }}
                    title={unlocked ? `${b.desc}（点击分享）` : `未解锁：${b.desc}`}
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
                  </button>
                )
              })}
            </div>
          )}

          {/* 积分流水 */}
          {!extraLoading && ledger.length > 0 && (
            <>
              <div className="section-title">
                积分明细
                <span className="hint" style={{ marginLeft: 8 }}>
                  <span style={{ color: 'var(--honey-dark)' }}>+ 获得</span>
                  <span style={{ color: 'var(--ink-3)', marginLeft: 8 }}>− 消耗</span>
                </span>
              </div>
              <div className="card">
                {ledger.slice(0, 20).map((l) => (
                  <div className="list-line" key={l.id}>
                    <span style={{ fontSize: 12, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {formatHoneyTime(l.created_at)}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--ink-2)', minWidth: 0, flex: 1, textAlign: 'right' }}>
                      {REASON_LABEL[l.reason] ?? l.reason}
                    </span>
                    <span
                      className="val"
                      style={{
                        color: l.amount >= 0 ? 'var(--honey-dark)' : 'var(--ink-3)',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {l.amount >= 0 ? `+${l.amount}` : `${l.amount}`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 分享动作面板：一个主按钮 → 选图片卡 / 文字口令 */}
      {shareOpen && (
        <div className="share-panel-mask" onClick={() => setShareOpen(false)} role="presentation">
          <div className="share-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="邀请好友">
            <div className="share-panel-title">邀请好友</div>
            <button className="share-option" onClick={() => void shareInviteCard()}>
              <span className="share-option-emoji">🖼️</span>
              <span className="share-option-body">
                <span className="share-option-name">分享邀请卡片</span>
                <span className="share-option-desc">生成精美图片，适合发朋友圈 / 群</span>
              </span>
              {sharingCard === 'invite' && <span className="share-option-loading">生成中…</span>}
            </button>
            <button className="share-option" onClick={() => void shareInvite()}>
              <span className="share-option-emoji">📋</span>
              <span className="share-option-body">
                <span className="share-option-name">复制邀请口令</span>
                <span className="share-option-desc">复制文字 + 链接，适合私聊粘贴</span>
              </span>
            </button>
            <button className="share-panel-cancel" onClick={() => setShareOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
