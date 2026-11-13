import { useMemo, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { IconCrown, IconGift } from '../../components/Icons'
import { getEntitlement, redeemByCode } from '../../lib/api'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  FREE_HONEY_PRO_ITEM,
  FREE_NO_ADS_ITEM,
  FREE_REPORT_DAYS,
  PRO_REPORT_DAYS,
  PRODUCTS,
  isPro,
  isLifetime,
  priceTag,
  proNoticeText,
  proUntilText,
  redeemSuccessText,
  type Entitlement,
  type ProductId,
} from '@dbee/shared'
import { TransparencyNotes } from '../../components/TransparencyNotes'
import { MINI_RECORDING_CAPS, quotaNotes } from '@dbee/shared'
import { REDEEM_CODE_RULE } from '../../lib/validate'
import { errText } from '../../lib/errmsg'
import { XPAY_SALE_ENABLED } from '../../lib/xpayEnabled'
import { buyProduct, hasPendingOrder, isXpaySupported, recoverPending } from '../../lib/xpay'
import './paywall.scss'

/**
 * 会员权益页（结构对齐主工程 src/pages/PaywallSheet.tsx）。
 *
 * ## 🔴 售卖能力的单一开关（2026-11-08 起）
 *
 * 本页是否展示三档价格与购买按钮，**只由 `lib/xpayEnabled.ts` 的构建期开关
 * `XPAY_SALE_ENABLED` 决定**，且该开关**同时**驱动 `content/legal.ts` 的法务口径。
 * 二者必须同源，因为微信审核会核「页面展示内容与隐私政策/用户协议是否一致」，
 * 一处卖钱一处写「免费提供」= 可判驳回项。
 *
 * 开关关闭（默认）时本页回到 2026-11-02 的整改状态：不展示任何价格、不提供任何
 * 支付入口，会员只靠兑换码解锁。开启前置条件见 xpayEnabled.ts 文件头（平台侧
 * 道具发布 / 进件 / 推送配置缺一不可，否则用户点购买会撞 -15008/-15010/-15014）。
 *
 * ## 🔴 措辞纪律：这是「预付费时长」，不是「自动续费订阅」
 *
 * 小程序虚拟支付走**道具直购**（`short_series_goods`）：用户每次主动购买一件
 * 对应时长的道具，平台**不会**到期自动扣款。故本页刻意：
 *   · 不写「自动续费 / 连续包月 / 到期前 24 小时扣款 / 取消订阅」—— 那是主端 iOS
 *     App Store 订阅（StoreKit 2 自动续期）的合规披露，照抄过来就是虚假宣传
 *     （用户会以为不取消就一直被扣钱，实际不会）；
 *   · 明确写「一次性购买，不自动续费，到期后需手动续购」。
 * 档位名沿用 shared `PRODUCTS`（月订阅 / 年订阅 / 终身买断）以保持四端一致，
 * 但在下方「购买说明」里把续费机制讲清楚，避免「订阅」二字引起误解。
 *
 * 解锁方式：微信虚拟支付购买；或兑换码（邀请/活动免费获得）。权益写入云端
 * entitlements，换设备同样生效。
 *
 * 🔴 合规红线（P1-E 调研结论，2026-11-03，见 docs/Android兑换码与内购政策调研结论-2026-11-03.md）：
 *   兑换码**必须保持「免费获得」属性**，绝不可改成「付费买码 / 加客服微信开通」。
 *   一旦变成付费获取，将同时触发：
 *     · 小米《开发者生态政策》「不得引导异常交易，包括客服引导充值或添加QQ/微信开通VIP」→ 下架级风险
 *     · 华为「切支付」（绕过官方支付渠道）→ 二级违规
 *   现在本端已有正规支付通道，兑换码更没必要、也绝不能变成付费获取渠道。
 *
 * 差异：小程序端无全局 usePlan，页内自拉取 entitlement 判断 pro/lifetime。
 */

const FREE_ITEMS = [
  `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别（识别成功才扣次数）`,
  `积分可再兑换拍照识别，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（50 积分/次）`,
  FREE_HONEY_PRO_ITEM,
  '文字描述识别、手动录入、体重饮水运动记录全部免费',
  'AI 问答不限次数（每分钟限 3 次防刷）',
  `饮食报告看近 ${FREE_REPORT_DAYS} 天`,
  '连续打卡 7 天再送拍照次数',
  FREE_NO_ADS_ITEM,
]
// 与主工程 PaywallSheet 的差异（2026-11-08 复核，只剩余一条）：
//  · 「文字描述识别」已补回 —— 11-08 统一录入层 LogSheet 已提供 text 模式
//    （parseFoodFromText + 草稿核对），旧注释「无 UI 入口」已过时，属真实分叉。
//  · 「扫条码」仍不写 —— mini LogSheet 4 模式无 barcode，且 Open Food Facts
//    需新增 request 合法域名；写上去会构成宣传与功能不符。待补齐后同步恢复，
//    这是端能力差异，不是免费 / 订阅权益逻辑分叉。
// 🔴 P0-C（2026-11-03）：「完善资料再送拍照次数」删去——两端代码均无此发放逻辑
//   （grantPhotoBonus 只有 'streak7' 一种 reason），属虚假承诺。「手动录入」保留——
//   P0-D 已在首页补齐真实入口（「记一餐」→ 手动录入），承诺自此为真。

const PRO_ITEMS = [
  'AI 拍照识别不限次数',
  'AI 问答不限流',
  '长文本 AI 复盘（本期解读）无限次',
  `饮食报告扩展到 ${PRO_REPORT_DAYS} 天`,
]
// 🔴 2026-11-13 与主端同步：删去未独立上线的「长期膳食规划」「宏量营养素深度分析」。
// 注：与主工程 PaywallSheet 相比，本端刻意去掉「+ 数据导出」——导出尚未实装
// （mini/src/lib/share.ts 的 isExportAvailable=false 是单一真源），宣传即为不符，
// 且与 legal.ts §五「当前版本暂不可用」冲突。11-08 已在「我的」页补齐 Pro 门控
// （与主端一致）；待导出实装后，仅改 share.ts 一处即可同步恢复本条文案。

/** entitlements.source 的展示名（跨端购买来源，不展示原始枚举值给用户） */
const SOURCE_LABELS: Record<string, string> = {
  redeem: '兑换码',
  apple: 'iOS App 内购',
  wechat: '微信支付',
  alipay: '支付宝',
  google: 'Google Play',
}

export default function Paywall() {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // 🔴 ok 存**文案**而非布尔：购买成功与兑换码成功的提示语不同
  //   （兑换码 0044 起支持月/年/终身三档，购买也可能是月/年），共用一句
  //   「终身会员已生效」会让买了月卡的用户看到与事实不符的确认信息。
  //   空串 = 无成功提示。档位文案一律由 shared 生成（redeemSuccessText /
  //   PRODUCTS[].name），本页不再出现第二份档位判断副本。
  const [okMsg, setOkMsg] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // ── 虚拟支付相关状态（仅 XPAY_SALE_ENABLED 时渲染对应 UI）──
  const [selectedId, setSelectedId] = useState<ProductId | null>(null)
  const [payingId, setPayingId] = useState<ProductId | null>(null)
  const [hint, setHint] = useState('')          // settling / pending 的温和提示（非错误）
  const [payUnsupported, setPayUnsupported] = useState('') // 宿主不支持 / 服务端未配凭据

  // 对齐主端 openPaywall(reason)：免费功能被拦下时把原因带进付费墙，
  // 而不是「点了没反应 / 只有一句 toast」。
  // manage=1 由 openManageSubscriptions() 从「我的」页带入，切到「会员与订阅」标题。
  const router = useRouter()
  const params = router.params as Record<string, string | undefined>
  const manageMode = params?.manage === '1'
  const reason = useMemo(() => {
    const raw = params?.reason
    if (!raw) return ''
    try { return decodeURIComponent(raw) } catch { return raw }
  }, [params])

  useLoad(() => {
    void refresh()
    // 🔴 进入付费墙即自愈：把上次「已扣款但权益未到账」的订单再查一遍。
    //   这是推送丢失 + 用户没等轮询完就退出场景下，用户拿回权益的唯一客户端路径
    //   （服务端另有对账兜底，但客户端主动查一次能让用户当场看到结果）。
    //   recoverPending 保证不 reject，失败静默。
    if (XPAY_SALE_ENABLED) {
      void (async () => {
        const hadPending = await hasPendingOrder()
        if (!hadPending) return // 绝大多数用户走这条：零提示、零请求
        setHint('检测到有一笔支付正在到账，正在为你确认…')
        const n = await recoverPending(() => refresh())
        if (n > 0) {
          setHint('')
          setOkMsg('会员权益已到账 🐝')
          return
        }
        // 仍未到账：保留温和提示，绝不当错误（钱已扣，报错误只会引发投诉与退款）
        setHint('支付已完成，会员权益正在到账（通常 1 分钟内）。稍后可点「刷新权益」确认。')
      })()
    }
  })

  // 🔴 刻意**不**让 refresh() 返回权益：它被当作 OnGranted 传给 buyProduct /
  //   recoverPending（3 处），改签名会破坏 `() => Promise<void> | void` 契约。
  //   需要拿到刷新结果的地方（submitCode）自己调 getEntitlement，与主端
  //   plan.tsx redeem() 的 `getEntitlement().catch(() => null)` 同一写法。
  async function refresh(): Promise<void> {
    try {
      const ent = await getEntitlement()
      setEntitlement(ent)
    } catch {
      setEntitlement(null)
    }
  }

  /** 对齐主端 restorePurchases(refresh)：重新拉取云端权益，失败给可读提示而非静默 */
  async function handleRefresh() {
    setRefreshing(true)
    try {
      // 顺带再自愈一次待核销订单（用户手动点刷新 = 明确想知道到账没）
      if (XPAY_SALE_ENABLED) await recoverPending(() => refresh())
      const ent = await getEntitlement()
      setEntitlement(ent)
      Taro.showToast({ title: '权益已刷新', icon: 'none' })
    } catch {
      Taro.showToast({ title: '暂时读不到权益，请稍后重试', icon: 'none' })
    } finally {
      setRefreshing(false)
    }
  }

  const pro = useMemo(() => isPro(entitlement), [entitlement])
  const lifetime = useMemo(() => isLifetime(entitlement), [entitlement])

  /**
   * 发起购买（完整闭环见 lib/xpay.ts）。
   * 🔴 结果分流纪律（P1-D §二 决策 A）：
   *   · ok          → 成功提示 + 刷新 + 返回
   *   · cancelled   → 用户主动取消，**静默**（不弹错误，取消是正常行为）
   *   · settling    → 已扣款但权益在路上：显示温和 hint，**绝不报错**
   *   · unsupported → 宿主/服务端不支持：显示提示引导兑换码，不报错
   *   · error       → 才是真正的错误
   */
  async function handleBuy(id: ProductId) {
    if (payingId) return
    setErr('')
    setHint('')
    setPayUnsupported('')
    setOkMsg('')
    setPayingId(id)
    try {
      const res = await buyProduct(id, () => refresh())
      if (res.status === 'ok') {
        // 🔴 文案按所买档位给：买月卡却提示「终身会员已生效」= 向用户谎报
        //   他买到了什么，事后极易被当成欺诈投诉。名称取 shared PRODUCTS（单一真相源）。
        const name = PRODUCTS.find((p) => p.id === id)?.name ?? '会员'
        const msg = `${name}已开通，权益已生效 🐝`
        setOkMsg(msg)
        // 🔴 与 submitCode 同一处置：页内提示在顶部、用户视线在底部购买按钮，
        //   且 1.4s 后 navigateBack 会销毁本页。应用级 toast 才能在返回后仍被看见
        //   （duration 3000 → 返回后还有约 1.6s 读完档位文案）。
        Taro.showToast({ title: msg, icon: 'none', duration: 3000 })
        setTimeout(() => { setOkMsg(''); Taro.navigateBack() }, 1400)
        return
      }
      if (res.status === 'cancelled') return // 静默
      if (res.status === 'settling') { setHint(res.message); return }
      if (res.status === 'unsupported') { setPayUnsupported(res.message); return }
      setErr(res.message)
    } catch (e) {
      setErr(errText(e, '支付失败，请重试'))
    } finally {
      setPayingId(null)
    }
  }

  // 售卖开关 + 宿主能力双重判定：只在两者都满足时渲染购买入口。
  // isXpaySupported() 为 false（低版本基础库 / 非微信端）时，即便开关开着也降级为
  // 「引导兑换码 / iOS App」，而不是让用户点了报「不支持」—— 与主端 noPayChannel 同思路。
  const canBuy = XPAY_SALE_ENABLED && isXpaySupported()


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
      // 🔴 文案按**真实档位**生成（2026-11-11，用户实测反馈「兑换成功却没有提示」）：
      //   0044 起兑换码支持月/年/终身三档，旧代码写死「终身会员已生效」对月卡用户
      //   就是谎报他买到了什么。刷新失败（ent=null）时 redeemSuccessText 退回不指明
      //   档位的通用确认 —— RPC 已返回 'ok'（码已核销），绝不能反过来报失败。
      const ent = await getEntitlement().catch(() => null)
      if (ent) setEntitlement(ent)
      const msg = redeemSuccessText(ent)
      setOkMsg(msg)
      setCode('')
      // 🔴 同时弹 toast：页内提示条渲染在**页面顶部**，而用户的手指和视线都在底部的
      //   「兑换」按钮上；且 1.4s 后 navigateBack 会连带销毁本页 → 提示条根本没机会
      //   被看见（这就是「点了没反应、实际已成功」的直接原因）。
      //   wx.showToast 是**应用级**的，返回上一页后仍会把剩余时长显示完，故 duration
      //   取 3000：navigateBack 后还有约 1.6s 能读完带有效期的长文案（2000 只剩 0.6s）。
      //   icon 必须用 'none'：'success' 图标下 title 只展示前 7 个汉字，
      //   会把「会员有效期至 2026/12/11」截断成「兑换成功，会员有」。
      Taro.showToast({ title: msg, icon: 'none', duration: 3000 })
      setTimeout(() => {
        setOkMsg('')
        Taro.navigateBack()
      }, 1400)
    } catch (e) {
      setErr(errText(e, '兑换失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const title = manageMode ? '会员与订阅' : lifetime ? 'D-Bee 终身会员' : pro ? 'D-Bee Pro' : '升级 D-Bee'

  return (
    <View className='paywall'>
      <View className='paywall-head'>
        <Text className='paywall-title'>{title}</Text>
      </View>

      {reason ? (
        <View className='notice tip'><Text>{reason}</Text></View>
      ) : null}

      {/* 🔴 提示区一律全局渲染（不埋在下方任何条件区块内）。
          这是主端 PaywallSheet.tsx 2026-11-07 修过的同一缺陷：err/ok 原先只写在
          「兑换码」区块里，而该区块在某些分支被隐藏 → 购买失败静默无任何提示。
          本端引入支付后同理会犯：`{!pro}` 之外的状态（Pro 用户续费、manage 模式）
          也需要看到 settling / 错误。提示与支付链路无关，必须永远可见。 */}
      {hint ? (
        <View className='notice info'><Text>{hint}</Text></View>
      ) : null}
      {payUnsupported ? (
        <View className='notice info'><Text>{payUnsupported}</Text></View>
      ) : null}
      {err ? (
        <View className='notice err-box'><Text>{err}</Text></View>
      ) : null}
      {okMsg ? (
        <View className='notice ok'><Text>{okMsg}</Text></View>
      ) : null}

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

      {/* P1.5：次数怎么算。🔴 必须用 MINI_RECORDING_CAPS —— 本端无扫码/包装识别，
          写「条码扫码不占额度」会构成宣传与功能不符（护栏 19 钉住的端能力差异）。 */}
      <TransparencyNotes title='次数怎么算' notes={quotaNotes(MINI_RECORDING_CAPS)} />

      {/* 「管理订阅」区块：对齐主端 PaywallSheet.tsx:342-355 的 3.1.2 纪律 ——
          🔴 刻意放在 {!pro} 之外 = 免费 / Pro / 终身三种状态都可达，
          审核员用非订阅态演示账户时也必须看得见。小程序无系统订阅可取消，
          对应语义是「查看档位 / 有效期 / 解锁来源 + 刷新权益」，见 manageSubscription.ts。 */}
      <View className='pay-card manage-card'>
        <View className='pay-badge'><Text>会员与订阅</Text></View>
        <View className='manage-row'>
          <Text className='manage-k'>当前档位</Text>
          <Text className='manage-v'>{lifetime ? '终身会员' : pro ? 'Pro 会员' : '免费版'}</Text>
        </View>
        <View className='manage-row'>
          <Text className='manage-k'>权益状态</Text>
          <Text className='manage-v'>
            {lifetime ? '全部功能永久解锁' : pro ? proUntilText(entitlement?.pro_until) : '免费版永久可用'}
          </Text>
        </View>
        <View className='manage-row'>
          <Text className='manage-k'>解锁来源</Text>
          <Text className='manage-v'>
            {entitlement?.redeemed_code
              ? `兑换码 ${entitlement.redeemed_code}`
              : entitlement?.source
                ? (SOURCE_LABELS[entitlement.source] ?? entitlement.source)
                : '暂无解锁记录'}
          </Text>
        </View>
        <Button className='btn btn-ghost manage-btn' disabled={refreshing} onClick={() => void handleRefresh()}>
          {refreshing ? '刷新中…' : '刷新权益'}
        </Button>
        {/* 🔴 tip 文案随售卖开关走（法务口径同源，见文件头）。
            「无自动续费」在开启售卖后**必须**写明 —— 道具直购本就是一次性购买，
            写清既是事实，也能挡住用户「怎么取消订阅」的困惑与投诉。 */}
        <Text className='manage-tip'>
          {XPAY_SALE_ENABLED
            ? '会员为一次性购买对应时长，不自动续费、无需取消；到期后可在本页重新购买。权益通过购买或兑换码解锁，云端同步，换设备登录同一账号同样生效。若你在 iOS App 内购买了订阅，请到 iPhone「设置 → 你的头像 → 订阅」管理。'
            : '本小程序免费提供、不涉及在线支付。权益通过兑换码或跨设备同步自动生效；若你在 iOS App 内购买了订阅，请到 iPhone「设置 → 你的头像 → 订阅」管理。'}
        </Text>
      </View>

      {!pro ? (
        <>
          {/* ── 三档售卖（仅 XPAY_SALE_ENABLED 且宿主支持时渲染）──
              🔴 价格走 shared PRODUCTS + priceTag()：全仓定价单一真相源，
                绝不在本页写死 ¥18/¥128/¥298（历史上主端曾因第三份硬编码价
                导致「商店价与展示价不符」的价格欺诈风险，见 priceTag 注释）。
              🔴 开关关闭时整块不渲染 —— 与 legal.ts「免费提供、不销售任何商品
                或服务、不涉及在线支付」保持一致（两者同开关，见 xpayEnabled.ts）。 */}
          {XPAY_SALE_ENABLED ? (
            canBuy ? (
              <>
                <View className='pay-card buy-card'>
                  <View className='pay-badge'><Text>选择档位</Text></View>
                  <View className='pay-grid'>
                    {PRODUCTS.map((p) => (
                      <View
                        key={p.id}
                        className={`pay-option ${p.highlight ? 'is-hl' : ''} ${selectedId === p.id ? 'is-sel' : ''} ${payingId !== null ? 'is-disabled' : ''}`}
                        onClick={() => {
                          if (payingId) return
                          setSelectedId(p.id)
                          setErr('')
                          setHint('')
                        }}
                      >
                        {p.highlight ? <View className='pay-option-tag'><Text>最划算</Text></View> : null}
                        <Text className='pay-option-name'>{p.name}</Text>
                        {/* priceTag 已含均摊月价（如「¥128 / 年（约 ¥10.7/月）」），
                            与主端同源，帮用户横向比较 —— 微信虚拟支付无 App Store
                            3.1.2 那套商店披露义务，但比价清晰对用户是实打实的好处。 */}
                        <Text className='pay-option-price'>{priceTag(p)}</Text>
                      </View>
                    ))}
                  </View>

                  {selectedId ? (
                    <Button
                      className='btn buy-btn'
                      disabled={payingId !== null}
                      onClick={() => void handleBuy(selectedId)}
                    >
                      {payingId === selectedId
                        ? '处理中…'
                        : `微信支付购买${PRODUCTS.find((p) => p.id === selectedId)?.name ?? ''}`}
                    </Button>
                  ) : (
                    <Text className='buy-hint'>请先选择一个档位</Text>
                  )}

                  {/* 🔴 购买说明（诚实披露，措辞纪律见文件头）：
                      道具直购 = 一次性购买对应时长，**不自动续费**。
                      绝不可照抄主端 iOS 的「到期前 24 小时自动续订扣款 / 取消路径」——
                      那是 StoreKit 订阅的合规披露，本端并无自动扣款，写上就是虚假宣传
                      （用户会以为不取消就一直被扣钱）。 */}
                  <View className='buy-note'>
                    <Text className='buy-note-title'>购买说明</Text>
                    <Text className='buy-note-body'>
                      {'· 月会员有效期 1 个月，年会员有效期 12 个月，终身会员永久有效\n· 一次性购买，不自动续费、不自动扣款，无需取消；到期后可自行重新购买\n· 已是会员时再次购买月/年档位，有效期从当前到期日往后顺延（提前续费不吃亏）\n· 支付由微信虚拟支付（财付通）完成，权益云端同步，换设备登录同一账号同样生效\n· 支付成功后若权益未立即到账，请点上方「刷新权益」；仍异常可联系客服并提供订单号\n· 虚拟商品一经购买成功即完成交付，如需退款请联系客服处理'}
                    </Text>
                  </View>
                </View>
              </>
            ) : (
              /* 开关开着但宿主不支持（低版本基础库 / 非微信端）：诚实降级，
                 不给「点了必失败」的按钮，引导走兑换码或 iOS App。
                 与主端 noPayChannel 分支同一处置。 */
              <View className='notice info'>
                <Text>当前微信版本暂不支持在线购买。你可升级微信后重试，或在 iOS App 内开通会员；也可在下方输入兑换码解锁（同样立即生效）。</Text>
              </View>
            )
          ) : null}

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
            {/* 🔴 err/ok 已提到页面顶部全局渲染（见上），此处不再重复渲染：
                同一状态渲染两处会让用户看到两遍同样的话，且其中一处会被条件区块藏起来。 */}
          </View>

          {/* helper 与「我们的承诺」随售卖开关走 —— 这两段是 legal.ts §一口径的
              页面级复述，若与 legal.ts 不同步即构成「展示内容与协议不符」。 */}
          {XPAY_SALE_ENABLED ? (
            <View className='helper'>
              <Text>会员为可选购买项，免费版功能永久可用。购买通过微信虚拟支付完成，价格以本页面展示为准；也可通过兑换码解锁（兑换码由邀请、活动等渠道免费获得）。</Text>
            </View>
          ) : (
            <View className='helper'>
              <Text>本小程序当前免费提供，不销售任何商品或服务，不涉及在线支付。会员权益可通过兑换码解锁（兑换码由邀请、活动等渠道免费获得）。</Text>
            </View>
          )}

          <View className='card promise-card'>
            <Text className='promise-title'>我们的承诺</Text>
            {/* 🔴 用 {'\n'} 显式换行：JSX 多行文本在编译期会被折叠成单个空格，
                直接写在标签里的换行不生效，.promise-body 的 white-space: pre-line
                也就拿不到换行符（原实现即有此缺陷，本次一并修正）。
                🔴 开启售卖后措辞必须改：原文「不含广告、不诱导付费、无隐藏扣费」
                在收费场景下前半句仍真（本端确无广告），但「不诱导付费」与
                「正在售卖」并存会让人怀疑文案真实性。改为陈述**可核验的事实**：
                免费版永久可用、无广告、无自动扣费。这三条在收费后依然为真。 */}
            <Text className='promise-body'>
              {XPAY_SALE_ENABLED
                ? '免费版永久可用，记录能力不打折\n全程无广告、无弹窗轰炸\n会员不自动续费、不自动扣款\n价格页面明示，无隐藏收费'
                : '本小程序内免费提供完整记录能力\n不含广告、不诱导付费、无隐藏扣费\n免费版永久可用，不逼你付费'}
            </Text>
          </View>
        </>
      ) : null}

      <View className='bottom-space' />
    </View>
  )
}
