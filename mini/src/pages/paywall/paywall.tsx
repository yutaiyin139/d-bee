import { useMemo, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { IconCrown, IconGift } from '../../components/Icons'
import { getEntitlement, redeemByCode } from '../../lib/api'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  FREE_HONEY_PRO_ITEM,
  FREE_NO_ADS_ITEM,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
  isPro,
  isLifetime,
  proNoticeText,
  type Entitlement,
} from '@dbee/shared'
import { REDEEM_CODE_RULE } from '../../lib/validate'
import { errText } from '../../lib/errmsg'
import './paywall.scss'

/**
 * 会员权益页（结构对齐主工程 src/pages/PaywallSheet.tsx，**口径按小程序合规要求独立收敛**）。
 *
 * 🔴 本端刻意**不展示任何价格、不提供任何支付入口**（2026-11-02 整改）：
 *   `mini/src/content/legal.ts` §一 已向用户声明「本服务由北京迪蜂科技有限公司开发并
 *   运营，当前在本小程序内免费提供，不销售任何商品或服务，不涉及在线支付」。此前本页
 *   仍展示三档定价（¥18/¥128/¥298）与「在线支付正在接入中」提示，与该声明直接冲突 ——
 *   微信小程序审核会核「页面展示内容与隐私政策/用户协议是否一致」，属可判驳回项，
 *   且展示不可购买的价格本身也构成「功能不完整」风险。
 *   真实支付待企业资质（商户号）就绪后，须**同步改 legal.ts 口径 + 走小程序虚拟支付
 *   合规要求**再上线，不能只把价格加回来。
 *
 * 解锁方式：兑换码（邀请/活动免费获得，非售卖）；权益写入云端 entitlements，换设备同样生效。
 *
 * 🔴 合规红线（P1-E 调研结论，2026-11-03，见 docs/Android兑换码与内购政策调研结论-2026-11-03.md）：
 *   兑换码**必须保持「免费获得」属性**，绝不可改成「付费买码 / 加客服微信开通」。
 *   一旦变成付费获取，将同时触发：
 *     · 小米《开发者生态政策》「不得引导异常交易，包括客服引导充值或添加QQ/微信开通VIP」→ 下架级风险
 *     · 华为「切支付」（绕过官方支付渠道）→ 二级违规
 *   华为官方明确认可的是「运营人员**免费**发码、用户输入后获得权益」的自建赠送码表，
 *   其合规前提正是「非售卖」。这条线是本兑换码机制能存在的根基，不是可选项。
 *
 * 差异：小程序端无全局 usePlan，页内自拉取 entitlement 判断 pro/lifetime。
 */

const FREE_ITEMS = [
  `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别（识别成功才扣次数）`,
  `积分可再兑换拍照识别，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（50 积分/次）`,
  FREE_HONEY_PRO_ITEM,
  '手动录入、体重饮水运动记录全部免费',
  'AI 问答不限次数（每分钟限 3 次防刷）',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  '连续打卡 7 天再送拍照次数',
  FREE_NO_ADS_ITEM,
]
// 注：与主工程 PaywallSheet 相比，本端刻意去掉「扫条码」「文字描述识别」两条——
// 小程序端当前没有这两个功能（无 scanCode 调用、parseFoodFromText 无 UI 入口），
// 文案如实反映端能力，避免宣传与功能不符（2026-10-25 四端一致性梳理修正）。
// 🔴 P0-C（2026-11-03）：「完善资料再送拍照次数」删去——两端代码均无此发放逻辑
//   （grantPhotoBonus 只有 'streak7' 一种 reason），属虚假承诺。「手动录入」保留——
//   P0-D 已在首页补齐真实入口（「记一餐」→ 手动录入），承诺自此为真。

const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  'AI 问答不限流',
  '长文本 AI 复盘（本期解读）无限次',
  '个性化完整膳食计划、长期 AI 膳食规划',
  '宏量营养素深度分析',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天`,
]
// 注：与主工程 PaywallSheet 相比，本端刻意去掉「数据导出」——mini/src/content/legal.ts
// §五 已声明「数据导出功能正在接入小程序端，当前版本暂不可用」，此处宣传即为不符
// （与去掉「扫条码」「文字描述识别」同一处置原则，2026-11-02 补齐）。

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
            {/* 2026-11-03 四端一致性：整句收到 shared proNoticeText，与主端
                PaywallSheet.tsx 共用同一实现（此前两端各写一份逐字相同的文案，
                且日期格式化依赖各端 JS 引擎的 locale 数据，输出不保证一致）。 */}
            {lifetime ? '你已是终身会员，全部功能永久解锁。' : proNoticeText(entitlement?.pro_until)}
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
          {/* 🔴 刻意不渲染价格档位（PRODUCTS + priceTag）：与 legal.ts「免费提供、
              不销售任何商品或服务、不涉及在线支付」保持一致。见文件头注释。 */}
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
            <Text>本小程序当前免费提供，不销售任何商品或服务，不涉及在线支付。会员权益可通过兑换码解锁（兑换码由邀请、活动等渠道免费获得）。</Text>
          </View>

          {/* 透明定价承诺：去掉「订阅可随时取消/无自动续费」表述——本端无订阅售卖，
              保留即与「不涉及在线支付」自相矛盾 */}
          <View className='card promise-card'>
            <Text className='promise-title'>我们的承诺</Text>
            {/* 🔴 用 {'\n'} 显式换行：JSX 多行文本在编译期会被折叠成单个空格，
                直接写在标签里的换行不生效，.promise-body 的 white-space: pre-line
                也就拿不到换行符（原实现即有此缺陷，本次一并修正） */}
            <Text className='promise-body'>
              {'本小程序内免费提供完整记录能力\n不含广告、不诱导付费、无隐藏扣费\n免费版永久可用，不逼你付费'}
            </Text>
          </View>
        </>
      ) : null}

      <View className='bottom-space' />
    </View>
  )
}
