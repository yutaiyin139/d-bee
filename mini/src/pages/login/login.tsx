import { useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import { useLoad } from '@tarojs/taro'
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

  const onNativeLogin = async () => {
    setLoading(true)
    setError('')
    try {
      setSession(await signIn())
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
      <Text className='title'>登录 D-Bee</Text>
      <Text className='desc'>多端同步你的打卡数据（{platform}）</Text>

      {!session ? (
        <>
          {native ? (
            <>
              <Button className='btn' loading={loading} disabled={loading} onClick={onNativeLogin}>
                微信一键登录
              </Button>
              <View className='divider'>
                <Text className='divider-text'>或使用手机号登录</Text>
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
            {otpSent ? (
              <Button className='btn' loading={loading} disabled={loading} onClick={onPhoneLogin}>
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
