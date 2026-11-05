import { useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import { useLoad } from '@tarojs/taro'
import { IconBee } from '../../components/Icons'
import { LegalLinks } from '../../components/LegalLinks'
import { bindInvite } from '../../lib/api'
import { cloud } from '../../lib/cloud'
import {
  INVITE_CODE_MAX, clearPendingInvite, getPendingInvite, normalizeInviteCode,
} from '../../lib/inviteLink'
import {
  signIn,
  sendPhoneOtp,
  signInWithPhone,
  signOut,
  isSignedIn,
  canNativeSignIn,
  currentPlatformName,
  type MiniSession,
} from '../../lib/auth'
import './login.scss'

export default function Login() {
  const [session, setSession] = useState<MiniSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 手机号登录态
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [verificationId, setVerificationId] = useState('')
  const [isExistingUser, setIsExistingUser] = useState(false)
  const [otpSent, setOtpSent] = useState(false)
  const [sending, setSending] = useState(false)

  // 邀请码（选填）：新用户注册时填写可绑定邀请关系，双方得积分。
  // 初值来自分享卡片落地时暂存的码（P1-B）—— 好友点分享进来无需手输。
  const [inviteCode, setInviteCode] = useState('')
  const [inviteExpanded, setInviteExpanded] = useState(false)
  // 邀请码是否来自分享链接。只有链接带入才显示「已识别」卡片；手动展开的
  // 输入框不受 inviteCode 是否为空影响，避免输入第一个字符后输入框被顶掉。
  // （与主工程 AuthScreen 的 fromLink 同构）
  const [fromLink, setFromLink] = useState(false)

  const native = canNativeSignIn()
  const platform = currentPlatformName()

  useLoad(async () => {
    // 分享卡片落地的邀请码：预填并标记为「已识别」（对齐主工程 initialInviteCode）
    const pending = getPendingInvite()
    if (pending) {
      setInviteCode(pending)
      setInviteExpanded(true)
      setFromLink(true)
    }

    if (await isSignedIn()) {
      try {
        const s = await signIn()
        setSession(s)
      } catch {
        /* 静默失败，等待用户手动登录 */
      }
    }
  })

  /**
   * 登录成功后绑定邀请码（选填，失败静默不阻断登录，对齐主工程 tryBindInvite）。
   *
   * 终态（ok / already / self）才清掉暂存码；invalid / throttled / daily_limit
   * 视为未确定，保留待下次登录再试 —— 详见 lib/inviteLink.ts 文件头的风控说明。
   */
  async function tryBindInvite() {
    const codeStr = inviteCode.trim()
    if (!codeStr) return
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt))
      try {
        const { data: session } = await cloud.auth.getSession()
        if (!session) continue
        const status = await bindInvite(codeStr)
        if (status === 'ok' || status === 'already' || status === 'self') {
          if (fromLink) clearPendingInvite()
          return
        }
      } catch {
        /* 继续重试 */
      }
    }
    // 三次仍未拿到终态：不清暂存码，下次登录可再试（不阻断登录）
  }

  /**
   * 手动输入邀请码：只做 normalize（转大写 + 过滤非法字符）。
   *
   * 刻意**不**写入 Storage —— 暂存码的语义是「分享卡片落地带入」，
   * 手动输入若也写进去，用户下次进登录页会被误标成「已识别好友邀请码」，
   * 且退出登录后码还残留。手动码只活在本次会话的 state 里。
   */
  function onInviteInput(value: string) {
    setInviteCode(normalizeInviteCode(value))
  }

  /** 清除链接带入的码（对齐主工程 AuthScreen 的「清除」按钮） */
  function clearInviteFromLink() {
    setInviteCode('')
    setFromLink(false)
    setInviteExpanded(false)
    clearPendingInvite()
  }

  const onNativeLogin = async () => {
    setLoading(true)
    setError('')
    try {
      setSession(await signIn())
      await tryBindInvite()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const onSendOtp = async () => {
    if (!/^1\d{10}$/.test(phone)) {
      setError('请输入正确的 11 位手机号')
      return
    }
    setSending(true)
    setError('')
    try {
      const { verificationId: vid, isExistingUser: existing } = await sendPhoneOtp(phone)
      setVerificationId(vid)
      setIsExistingUser(existing)
      setOtpSent(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送验证码失败')
    } finally {
      setSending(false)
    }
  }

  const onPhoneLogin = async () => {
    if (!code) {
      setError('请输入验证码')
      return
    }
    setLoading(true)
    setError('')
    try {
      setSession(await signInWithPhone(phone, code, verificationId, isExistingUser))
      await tryBindInvite()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const onLogout = async () => {
    await signOut()
    setSession(null)
    setOtpSent(false)
    setCode('')
  }

  return (
    <View className='login'>
      <View className='brand'>
        <View className='brand-logo'>
          <IconBee size={54} />
        </View>
        <Text className='title'>自律蜜蜂</Text>
        <Text className='tagline'>拍一张照片，就知道这餐吃了多少热量。</Text>
        <Text className='desc'>多端同步你的打卡数据（{platform}）</Text>
      </View>

      {!session ? (
        <>
          {native ? (
            <>
              <Button className='btn-primary' loading={loading} disabled={loading} onClick={onNativeLogin}>
                微信一键登录
              </Button>
              <View className='divider'>
                <View className='divider-line' />
                <Text className='divider-text'>或使用手机号登录</Text>
                <View className='divider-line' />
              </View>
            </>
          ) : null}

          <View className='form'>
            <Input
              className='input'
              type='number'
              placeholder='手机号'
              value={phone}
              onInput={(e) => setPhone(e.detail.value)}
            />
            <View className='code-row'>
              <Input
                className='input code-input'
                type='number'
                placeholder='验证码'
                value={code}
                onInput={(e) => setCode(e.detail.value)}
              />
              <Button className='send-btn' loading={sending} disabled={sending} onClick={onSendOtp}>
                {otpSent ? '重新发送' : '获取验证码'}
              </Button>
            </View>

            {fromLink && inviteCode ? (
              <View className='invite-link-card'>
                <View className='invite-link-row'>
                  <Text className='invite-link-label'>已识别好友邀请码</Text>
                  <Text className='invite-link-code'>{inviteCode}</Text>
                  <Text className='invite-link-clear' onClick={clearInviteFromLink}>清除</Text>
                </View>
                <Text className='invite-link-helper'>注册成功后自动绑定，双方都能获得积分</Text>
              </View>
            ) : !inviteExpanded ? (
              <Text className='invite-toggle' onClick={() => setInviteExpanded(true)}>有好友邀请码？点此填写（双方得积分）</Text>
            ) : (
              <Input
                className='input invite-input'
                placeholder='邀请码（选填）'
                value={inviteCode}
                maxlength={INVITE_CODE_MAX}
                onInput={(e) => onInviteInput(e.detail.value)}
              />
            )}

            {otpSent ? (
              <Button className='btn-login' loading={loading} disabled={loading} onClick={onPhoneLogin}>
                登录 / 注册
              </Button>
            ) : null}
          </View>

          {error ? <Text className='error'>{error}</Text> : null}
        </>
      ) : (
        <>
          <View className='session-card'>
            <Text className='session-label'>已登录（云端会话已建立）</Text>
            <Text className='session-uid'>UID：{session.uid}</Text>
            <Text className='session-uid'>OpenID：{session.openid}</Text>
          </View>
          <Button className='btn-ghost' onClick={onLogout}>
            退出登录
          </Button>
        </>
      )}

      {/*
        🔴 登录前法律文档入口（合规必修，2026-11-05）。刻意放在 !session 三元**之外**：
        本页既服务未登录（微信一键登录 / 手机号验证码），也会显示已登录会话卡片，
        两种状态都应能查阅协议与隐私政策。放进任一分支都会留缺口。
        与 index.tsx auth gate 复用同一个 LegalLinks 组件（单一真相源），
        避免两处各写一份文案日后漂移。
      */}
      <LegalLinks compact hint='注册或登录前，请阅读以下协议与政策' />
    </View>
  )
}
