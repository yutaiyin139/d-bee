import { useEffect, useRef, useState } from 'react'
import { cloud } from '../cloud'
import { SiteFooter } from '../components/SiteFooter'
import { bindInvite } from '../lib/api'
import { isNative } from '../lib/platform'
import { isWechatLoginAvailable, signInWithWechatNative } from '../lib/wechat'
import { useNativeDiagnosticsEntry } from '../native/useDiagnosticsEntry'
import type { DocId } from '../content/legal'

/** 静态判断，无需随渲染变化：Web 恒可用；原生需凭据与云端接口齐备 */
const WECHAT_LOGIN_AVAILABLE = isWechatLoginAvailable()

interface AuthScreenProps {
  onSignedIn: () => void
  onOpenLegal: (id: DocId) => void
  /** 好友邀请链接带入的邀请码（?invite=CODE），预填并展示为已识别标签 */
  initialInviteCode?: string
}

type Channel = 'phone' | 'email'

export function AuthScreen({ onSignedIn, onOpenLegal, initialInviteCode = '' }: AuthScreenProps) {
  // 原生端专用：连接自检面板（懒加载；Web 端恒为 null，分包不会被加载）
  const NativeDiagnostics = useNativeDiagnosticsEntry()
  const [channel, setChannel] = useState<Channel>('phone')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 手机号
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [phoneErr, setPhoneErr] = useState('')
  const [countdown, setCountdown] = useState(0)
  const pendingPhone = useRef<{ phone: string; verificationId: string; isExistingUser: boolean } | null>(null)
  const [phoneCodeSent, setPhoneCodeSent] = useState(false)

  // 邮箱
  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [password, setPassword] = useState('')
  const pendingEmail = useRef<{ email: string; verificationId: string; isExistingUser: boolean } | null>(null)
  const [emailCodeSent, setEmailCodeSent] = useState(false)
  const [needPassword, setNeedPassword] = useState(false)

  // 邀请码（选填）：新用户注册时填写可绑定邀请关系。
  // 链接带入（?invite=CODE）时预填；手动场景默认收起，点击「有邀请码？」才展开。
  const [inviteCode, setInviteCode] = useState(initialInviteCode)
  const [inviteExpanded, setInviteExpanded] = useState(!!initialInviteCode)

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  /** 新用户注册成功后绑定邀请码（选填，失败静默不阻断登录） */
  async function tryBindInvite() {
    const code = inviteCode.trim()
    if (!code) return
    try {
      await bindInvite(code)
    } catch {
      // 绑定失败不阻断登录：邀请码无效/已用/网络异常均静默
    }
  }

  async function sendPhoneCode() {
    if (!/^1\d{10}$/.test(phone)) {
      setPhoneErr('请输入正确的 11 位手机号')
      return
    }
    setPhoneErr('')
    setError('')
    setBusy(true)
    try {
      const sent = await cloud.auth.sendOtp({ phone })
      if (sent.error) {
        setError(sent.error.message || '验证码发送失败')
        return
      }
      pendingPhone.current = {
        phone,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      }
      setPhoneCodeSent(true)
      setCountdown(60)
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证码发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function submitPhoneLogin() {
    const pending = pendingPhone.current
    if (!pending || pending.phone !== phone) {
      setError('请先获取当前手机号的验证码')
      return
    }
    setError('')
    setBusy(true)
    try {
      const completed = await cloud.auth.verifyOtp({
        phone: pending.phone,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: phoneCode,
      })
      if (completed.error) {
        setError(completed.error.message || '验证码校验失败')
        return
      }
      pendingPhone.current = null
      if (!pending.isExistingUser) await tryBindInvite()
      onSignedIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function sendEmailCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('请输入正确的邮箱地址')
      return
    }
    setError('')
    setBusy(true)
    try {
      const sent = await cloud.auth.sendOtp({ email })
      if (sent.error) {
        setError(sent.error.message || '验证码发送失败')
        return
      }
      pendingEmail.current = {
        email,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      }
      setNeedPassword(!sent.data.isExistingUser)
      setEmailCodeSent(true)
      setCountdown(60)
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证码发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function submitEmailLogin() {
    const pending = pendingEmail.current
    if (!pending || pending.email !== email) {
      setError('请先获取当前邮箱的验证码')
      return
    }
    if (!pending.isExistingUser && password.length < 6) {
      setError('首次注册需要设置至少 6 位密码')
      return
    }
    setError('')
    setBusy(true)
    try {
      const completed = await cloud.auth.verifyOtp({
        email: pending.email,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: emailCode,
        password: pending.isExistingUser ? undefined : password,
      })
      if (completed.error) {
        setError(completed.error.message || '验证失败')
        return
      }
      pendingEmail.current = null
      if (!pending.isExistingUser) await tryBindInvite()
      onSignedIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function signInWithWechat() {
    setError('')
    // 原生 App：走微信开放平台「移动应用」原生 SDK（WebView 里不能做 OAuth 跳转）
    if (WECHAT_LOGIN_AVAILABLE && isNative()) {
      setBusy(true)
      try {
        const res = await signInWithWechatNative()
        if (res.status === 'ok') {
          onSignedIn()
          return
        }
        // 用户主动取消不报错
        if (res.status === 'cancelled') return
        setError(res.message || '微信登录失败')
      } finally {
        setBusy(false)
      }
      return
    }
    // Web / PWA：走云 Relay 网页扫码登录
    try {
      const res = await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: location.origin })
      if (res.error) {
        setError(res.error.message || '微信登录发起失败')
        return
      }
      location.assign(res.data.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : '微信登录发起失败')
    }
  }

  return (
    <div className="app-shell">
      <div className="page">
        <div className="page-top" />
        <div className="hero">
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: 17,
              background: 'var(--honey-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
            }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="30" height="30">
              <ellipse cx="12" cy="14.5" rx="6" ry="5" fill="var(--honey)" />
              <path d="M8 6.2c0-1.7 1.2-2.9 2.6-2.9s2.4 1.1 2.4 2.6M16 6.4c0-1.6-1-2.7-2.3-2.7" stroke="var(--honey-dark)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M6 12.5h12M6 16.5h12" stroke="rgba(74,50,8,.45)" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </div>
          <h1>
            D-Bee<span className="brand-cn">自律蜜蜂</span>
          </h1>
          <p>拍一张照片，就知道这餐吃了多少热量。</p>
        </div>

        {error && <div className="notice err">{error}</div>}

        <div className="segment" style={{ marginTop: 8 }}>
          <button className={channel === 'phone' ? 'active' : ''} onClick={() => { setChannel('phone'); setError('') }}>
            手机号
          </button>
          <button className={channel === 'email' ? 'active' : ''} onClick={() => { setChannel('email'); setError('') }}>
            邮箱
          </button>
        </div>

        {inviteCode ? (
          <div className="card" style={{ marginTop: 14, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>已识别好友邀请码</span>
              <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: 2, color: 'var(--honey-dark)' }}>{inviteCode}</span>
              <button className="btn-text" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-3)' }} onClick={() => { setInviteCode(''); setInviteExpanded(false) }}>
                清除
              </button>
            </div>
            <div className="helper" style={{ marginTop: 6 }}>注册成功后自动绑定，双方都能获得积分</div>
          </div>
        ) : inviteExpanded ? (
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="invite-code">邀请码（选填）</label>
            <input
              id="invite-code"
              type="text"
              placeholder="好友邀请你时可填写，注册后不可改"
              value={inviteCode}
              maxLength={8}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            />
            <div className="helper">填写好友的邀请码，双方都能获得积分奖励</div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button className="btn-text" style={{ fontSize: 13, color: 'var(--ink-3)' }} onClick={() => setInviteExpanded(true)}>
              有好友邀请码？点此填写
            </button>
          </div>
        )}

        {channel === 'phone' ? (
          <>
            <div className="field">
              <label htmlFor="phone">手机号</label>
              <input
                id="phone"
                type="tel"
                inputMode="numeric"
                placeholder="请输入 11 位手机号"
                value={phone}
                maxLength={11}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, ''))
                  setPhoneErr('')
                }}
              />
              {phoneErr && <div className="err">{phoneErr}</div>}
            </div>

            <div className="field">
              <label htmlFor="phone-code">验证码</label>
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  id="phone-code"
                  type="text"
                  inputMode="numeric"
                  placeholder="6 位验证码"
                  value={phoneCode}
                  maxLength={6}
                  onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ''))}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: 118, flexShrink: 0, fontSize: 14 }}
                  disabled={busy || countdown > 0}
                  onClick={sendPhoneCode}
                >
                  {countdown > 0 ? `${countdown}s` : phoneCodeSent ? '重新获取' : '获取验证码'}
                </button>
              </div>
            </div>

            <button className="btn" disabled={busy || phoneCode.length < 4} onClick={submitPhoneLogin}>
              {busy ? <span className="spinner" /> : '登录 / 注册'}
            </button>
            <div className="helper" style={{ textAlign: 'center', marginTop: 10 }}>
              未注册的手机号将自动创建账号
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">邮箱</label>
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value.trim())}
              />
            </div>

            <div className="field">
              <label htmlFor="email-code">验证码</label>
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  id="email-code"
                  type="text"
                  inputMode="numeric"
                  placeholder="6 位验证码"
                  value={emailCode}
                  maxLength={6}
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: 118, flexShrink: 0, fontSize: 14 }}
                  disabled={busy || countdown > 0}
                  onClick={sendEmailCode}
                >
                  {countdown > 0 ? `${countdown}s` : emailCodeSent ? '重新获取' : '获取验证码'}
                </button>
              </div>
            </div>

            {needPassword && (
              <div className="field">
                <label htmlFor="password">设置密码</label>
                <input
                  id="password"
                  type="password"
                  placeholder="至少 6 位，用于以后登录"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div className="helper">首次使用该邮箱，需要设置一个密码</div>
              </div>
            )}

            <button className="btn" disabled={busy || emailCode.length < 4} onClick={submitEmailLogin}>
              {busy ? <span className="spinner" /> : '登录 / 注册'}
            </button>
          </>
        )}

        {WECHAT_LOGIN_AVAILABLE && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0 16px' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>或</span>
              <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            </div>

            <button className="btn btn-ghost" disabled={busy} onClick={signInWithWechat}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M9.2 3.4C5.2 3.4 2 6.1 2 9.4c0 1.9 1.1 3.6 2.8 4.7l-.7 2.1 2.4-1.2c.8.2 1.7.4 2.7.4h.5a5.6 5.6 0 01-.2-1.5c0-3.2 3.1-5.8 6.9-5.8h.4C15.9 5.1 12.9 3.4 9.2 3.4z"
                  fill="#3f9463"
                />
                <path
                  d="M22 14c0-2.8-2.8-5-6.2-5s-6.2 2.2-6.2 5 2.8 5 6.2 5c.7 0 1.4-.1 2.1-.3l1.9 1-.5-1.7C20.8 16.9 22 15.5 22 14z"
                  fill="#3f9463"
                  opacity="0.78"
                />
              </svg>
              微信登录
            </button>
          </>
        )}

        <div className="helper" style={{ textAlign: 'center', marginTop: 18, lineHeight: 1.7 }}>
          登录后，你的饮食记录会同步到云端，换手机也不会丢。
        </div>

        {NativeDiagnostics && <NativeDiagnostics />}

        <SiteFooter onOpen={onOpenLegal} />
      </div>
    </div>
  )
}
