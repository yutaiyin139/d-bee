import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import { useLoad } from '@tarojs/taro'
import { signIn, signOut, isSignedIn, type MiniSession } from '../../lib/auth'
import './login.scss'

export default function Login() {
  const [session, setSession] = useState<MiniSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useLoad(async () => {
    // 回显已有登录态
    if (await isSignedIn()) {
      // 尝试直接恢复（有内存缓存则复用，无则提示重新登录）
      try {
        const s = await signIn()
        setSession(s)
      } catch {
        /* 静默失败，等待用户手动登录 */
      }
    }
  })

  const onLogin = async () => {
    setLoading(true)
    setError('')
    try {
      const s = await signIn()
      setSession(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const onLogout = async () => {
    await signOut()
    setSession(null)
  }

  return (
    <View className='login'>
      <Text className='title'>登录 D-Bee</Text>
      <Text className='desc'>用小程序账号一键登录，多端同步你的打卡数据</Text>

      {!session ? (
        <>
          <Button className='btn' loading={loading} disabled={loading} onClick={onLogin}>
            微信一键登录
          </Button>
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
