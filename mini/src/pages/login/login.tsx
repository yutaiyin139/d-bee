import { useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import { useLoad } from '@tarojs/taro'
import { IconBee } from '../../components/Icons'
import { bindInvite } from '../../lib/api'
import { cloud } from '../../lib/cloud'
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

  // 邀请码（选填）：新用户注册时填写可绑定邀请关系，双方得积分
  const [inviteCode, setInviteCode] = useState('')
  const [inviteExpanded, setInviteExpanded] = useState(false)

  const native = canNativeSignIn()
  const platform = currentPlatformName()

  useLoad(async () => {
    if (await isSignedIn()) {
      try {
        const s = await signIn()
        setSession(s)
      } catch {
        /* 静默失败，等待用户手动登录 */
      }
    }
  })

  /** 登录成功后绑定邀请码（选填，失败静默不阻断登录，对齐主工程 tryBindInvite） */
  async function tryBindInvite() {
    const codeStr = inviteCode.trim()
    if (!codeStr) return
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt))
      try {
        const { data: session } = await cloud.auth.getSession()
        if (!session) continue
        const status = await bindInvite(codeStr)
        if (status === 'ok' || status === 'already' || status === 'self') return
      } catch {
        /* 继续重试 */
      }
    }
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

            {!inviteExpanded ? (
              <Text className='invite-toggle' onClick={() => setInviteExpanded(true)}>有好友邀请码？点此填写（双方得积分）</Text>
            ) : (
              <Input
                className='input invite-input'
                placeholder='邀请码（选填）'
                value={inviteCode}
                onInput={(e) => setInviteCode(e.detail.value.toUpperCase())}
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
    </View>
  )
}
