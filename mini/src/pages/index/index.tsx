import { View, Text, Button } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import {
  FREE_DAILY_AI,
  AI_REDEEM_DAILY_LIMIT,
  HONEY_PRICE,
  PRODUCTS,
  photoLadderHint,
  isPro,
  quotaExhaustedReason,
} from '@dbee/shared'
import './index.scss'

export default function Index() {
  useLoad(() => {
    console.log('Page loaded.')
  })

  // 用真实共享规则做冒烟：验证 @dbee/shared 跨端引用闭环
  const ladder = photoLadderHint(3, 100) // 第 4 次拍照、100 积分
  const proState = isPro(null)

  const goLogin = () => {
    Taro.navigateTo({ url: '/pages/login/login' })
  }

  const goCheckin = () => {
    Taro.navigateTo({ url: '/pages/checkin/checkin' })
  }

  const goScan = () => {
    Taro.navigateTo({ url: '/pages/scan/scan' })
  }

  return (
    <View className='index'>
      <Text className='title'>D-Bee 多端小程序</Text>
      <Text className='desc'>微信 / 支付宝 / 抖音 · 三端骨架已就绪</Text>

      <View className='btn-row'>
        <Button className='login-btn' onClick={goLogin}>登录</Button>
        <Button className='checkin-btn' onClick={goCheckin}>打卡</Button>
        <Button className='scan-btn' onClick={goScan}>拍照</Button>
      </View>

      <View className='rule-card'>
        <Text className='rule-title'>额度规则（来自 @dbee/shared）</Text>
        <Text className='rule-line'>每日免费 AI 拍照：{FREE_DAILY_AI} 次</Text>
        <Text className='rule-line'>积分兑换上限：{AI_REDEEM_DAILY_LIMIT} 次（{HONEY_PRICE.ai1Scan} 积分/次）</Text>
        <Text className='rule-line'>第 4 次拍照阶梯：{ladder.kind}（可兑换 {ladder.redeemCount} 次）</Text>
        <Text className='rule-line'>未登录会员态：{proState ? '会员' : '免费'}</Text>
        <Text className='rule-line'>付费商品数：{PRODUCTS.length} 档</Text>
      </View>

      <View className='rule-card'>
        <Text className='rule-title'>额度用尽提示</Text>
        <Text className='rule-text'>{quotaExhaustedReason()}</Text>
      </View>
    </View>
  )
}
