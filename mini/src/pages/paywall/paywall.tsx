import { useMemo, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { IconCrown, IconGift } from '../../components/Icons'
import { getEntitlement, redeemByCode } from '../../lib/api'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
  PRODUCTS,
  isPro,
  isLifetime,
  type Entitlement,
} from '@dbee/shared'
import { REDEEM_CODE_RULE } from '../../lib/validate'
import { errText } from '../../lib/errmsg'
import './paywall.scss'

/**
 * 付费墙（对齐主工程 src/pages/PaywallSheet.tsx）。
 * 三档：免费 / Pro（月·年订阅）/ 终身买断。
 * 真实支付（微信 / 支付宝 / App 内购）待企业资质就绪后接入；当前用兑换码解锁，
 * 权益写入云端 entitlements，换设备同样生效。
 * 差异：小程序端无全局 usePlan，页内自拉取 entitlement 判断 pro/lifetime。
 */

const FREE_ITEMS = [
  `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别（识别成功才扣次数）`,
  `积分可再兑换拍照识别，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（50 积分/次）`,
  '扫条码不限次数永久免费',
  '文字描述识别、手动录入、体重饮水运动记录全部免费',
  'AI 问答不限次数（每分钟限 3 次防刷）',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  '连续打卡 7 天、完善资料再送拍照次数',
]

const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  'AI 问答不限流',
  '长文本 AI 复盘（本期解读）无限次',
  '个性化完整膳食计划、长期 AI 膳食规划',
  '宏量营养素深度分析',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天 + 数据导出`,
]

const PRICE_TAG: Record<string, string> = {
  proMonthly: '¥18 / 月',
  proYearly: '¥128 / 年（约 ¥10.7/月）',
  lifetime: '¥328 永久',
}

export default function Paywall() {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)

  useLoad(() => {
    void refresh()
  })

  async function refresh() {
    try {
      const ent = await getEntitlement()
      setEntitlement(ent)
    } catch {
      setEntitlement(null)
    }
  }

  const pro = useMemo(() => isPro(entitlement), [entitlement])
  const lifetime = useMemo(() => isLifetime(entitlement), [entitlement])

  async function submitCode() {
    if (!code.trim()) return
    setBusy(true)
    setErr('')
    try {
      const res = await redeemByCode(code)
      if (res === 'bad') {
        setErr('兑换码不对，检查一下大小写和连字符。')
        return
      }
      if (res === 'used') {
        setErr('该兑换码已被使用。')
        return
      }
      setOk(true)
      await refresh()
      setTimeout(() => {
        setOk(false)
        setCode('')
        Taro.navigateBack()
      }, 1400)
    } catch (e) {
      setErr(errText(e, '兑换失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const title = lifetime ? 'D-Bee 终身会员' : pro ? 'D-Bee Pro' : '升级 D-Bee'

  return (
    <View className='paywall'>
      <View className='paywall-head'>
        <Text className='paywall-title'>{title}</Text>
      </View>

      {pro ? (
        <View className='notice ok'>
          <Text>
            {lifetime
              ? '你已是终身会员，全部功能永久解锁。'
              : entitlement?.pro_until
                ? `你已是 Pro 会员，有效期至 ${new Date(entitlement.pro_until).toLocaleDateString('zh-CN')}。`
                : '你已是 Pro 会员，所有功能已解锁。'}
          </Text>
        </View>
      ) : null}

      {/* 三档权益对比 */}
      <View className='pay-card pay-card-pro'>
        <View className='pay-badge'>
          <IconCrown color='#6b4a08' size={16} />
          <Text>Pro / 终身</Text>
        </View>
        {PRO_ITEMS.map((t) => (
          <View className='pay-line' key={t}>
            <Text className='tick'>✓</Text>
            <Text className='pay-line-text'>{t}</Text>
          </View>
        ))}
      </View>

      <View className='pay-card'>
        <View className='pay-badge pay-badge-free'>
          <Text>免费版</Text>
        </View>
        {FREE_ITEMS.map((t) => (
          <View className='pay-line muted' key={t}>
            <Text className='tick'>·</Text>
            <Text className='pay-line-text'>{t}</Text>
          </View>
        ))}
      </View>

      {!pro ? (
        <>
          {/* 商品选择（真实支付接入前为展示） */}
          <View className='pay-grid'>
            {PRODUCTS.map((p) => (
              <View key={p.id} className={`pay-option ${p.highlight ? 'is-hl' : ''}`}>
                <Text className='pay-option-name'>{p.name}</Text>
                <Text className='pay-option-price'>{PRICE_TAG[p.id]}</Text>
                {p.highlight ? <Text className='pay-option-tag'>最划算</Text> : null}
              </View>
            ))}
          </View>

          <View className='field'>
            <Text className='field-label'>兑换码</Text>
            <View className='field-row'>
              <Input
                className='field-input'
                placeholder='输入兑换码'
                maxlength={REDEEM_CODE_RULE.max}
                value={code}
                onInput={(e) => {
                  setCode(e.detail.value)
                  setErr('')
                }}
              />
              <Button
                className='btn btn-ghost field-btn'
                disabled={busy || !code.trim()}
                onClick={() => void submitCode()}
              >
                {busy ? '兑换中…' : '兑换'}
              </Button>
            </View>
            {err ? <Text className='err'>{err}</Text> : null}
            {ok ? <Text className='ok-msg'>兑换成功，终身会员已生效 🐝</Text> : null}
          </View>

          <View className='helper'>
            <Text>在线支付（微信 / 支付宝 / 应用商店内购）正在接入中，上线前可先用兑换码体验完整功能。</Text>
          </View>

          {/* 透明定价承诺 */}
          <View className='card promise-card'>
            <Text className='promise-title'>我们的承诺</Text>
            <Text className='promise-body'>
              统一定价，对所有人一样，永不杀熟
              订阅可随时取消，无隐藏扣费、无自动续费陷阱
              免费版永久可用，不逼你付费
            </Text>
          </View>
        </>
      ) : null}

      <View className='bottom-space' />
    </View>
  )
}
