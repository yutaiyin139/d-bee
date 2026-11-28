/**
 * 小程序「绑定手机号」。
 *
 * 点一次微信授权按钮即可。号码挂到当前微信账号上，
 * 之后用这个号码登录 App，会员和记录还在。
 */
import { useEffect, useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cloud, publicConfig } from '../lib/cloud'
import { getWechatAppId } from '../lib/auth'
import './PhoneBind.scss'

interface MeBody {
  phone?: string
  phone_number?: string
}

interface BindBody {
  ok?: boolean
  phone?: string
  message?: string
  error?: { message?: string }
}

export function PhoneBindCard() {
  const enabled = process.env.TARO_ENV === 'weapp'
  const [masked, setMasked] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      const phone = await readBoundPhone()
      if (!cancelled) {
        setMasked(phone)
        setReady(true)
      }
    })()
    return () => { cancelled = true }
  }, [enabled])

  async function onPhone(e: { detail?: { code?: string; errMsg?: string } }) {
    const code = e.detail?.code || ''
    if (!code) {
      void Taro.showToast({ title: '需要同意授权才能绑定', icon: 'none' })
      return
    }
    const appid = getWechatAppId()
    if (!appid) {
      void Taro.showToast({ title: '没有拿到小程序信息，请重开后再试', icon: 'none' })
      return
    }
    setBusy(true)
    try {
      const token = await accessToken()
      if (!token) {
        void Taro.showToast({ title: '登录已过期，请重新进入', icon: 'none' })
        return
      }
      const res = await Taro.request<BindBody>({
        url: `${publicConfig.endpoint}/.cloud/auth/v1/bind-phone`,
        method: 'POST',
        timeout: 12000,
        header: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-wb-webapp-access-key': publicConfig.publishableKey,
        },
        data: { code, appid },
      })
      const body = res.data
      if (res.statusCode === 200 && body?.ok && body.phone) {
        setMasked(body.phone)
        void Taro.showToast({ title: '已绑定，App 用这个号码登录即可', icon: 'none' })
        return
      }
      const msg = body?.message || body?.error?.message || '绑定失败，请再试一次'
      void Taro.showToast({ title: msg, icon: 'none' })
    } catch {
      void Taro.showToast({ title: '网络不好，请再试一次', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  if (!enabled || !ready) return null

  if (masked) {
    return (
      <View className='phone-bind'>
        <Text className='phone-bind-label'>手机号</Text>
        <Text className='phone-bind-val'>已绑定 {masked}</Text>
      </View>
    )
  }

  return (
    <View className='phone-bind'>
      <View className='phone-bind-copy'>
        <Text className='phone-bind-label'>绑定手机号</Text>
        <Text className='phone-bind-hint'>绑定后，用这个号码登录 App 也能使用这里的会员</Text>
      </View>
      <Button
        className='phone-bind-btn'
        openType='getPhoneNumber'
        disabled={busy}
        onGetPhoneNumber={(e) => void onPhone(e)}
      >
        {busy ? '绑定中…' : '授权绑定'}
      </Button>
    </View>
  )
}

async function accessToken(): Promise<string> {
  try {
    const { data } = await cloud.auth.getSession()
    return data?.accessToken ?? ''
  } catch {
    return ''
  }
}

async function readBoundPhone(): Promise<string> {
  try {
    const token = await accessToken()
    if (!token) return ''
    const res = await Taro.request<MeBody>({
      url: `${publicConfig.endpoint}/.cloud/auth/v1/user/me`,
      method: 'GET',
      timeout: 8000,
      header: {
        authorization: `Bearer ${token}`,
        'x-wb-webapp-access-key': publicConfig.publishableKey,
      },
    })
    if (res.statusCode !== 200) return ''
    return res.data?.phone || res.data?.phone_number || ''
  } catch {
    return ''
  }
}
