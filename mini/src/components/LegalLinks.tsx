/**
 * 登录前的法律文档入口（用户协议 · 隐私政策 · 免责声明）。
 *
 * 🔴 为什么必须有这个组件：此前 mini 端三份文档只挂在「我的 → 关于」卡片下
 * （profile.tsx:664-676），而「我的」页只有登录后才能到达 —— 首页未登录时
 * 渲染的是 index.tsx:572 的 auth gate（仅标题 + 描述 + 登录按钮），login.tsx
 * 全页也零协议文案。结果是**用户在注册登录之前根本看不到隐私政策**，
 * 违反《个人信息保护法》第十七条「处理前应以显著方式告知」，也与微信
 * 小程序审核对「收集个人信息前须可查阅隐私政策」的要求冲突。
 * 主端 src/pages/AuthScreen.tsx:551 在登录页就渲染了 SiteFooter，两端此处
 * 属四端一致性里的「覆盖差异」（一端有一端没有），本次补齐。
 *
 * 抽成组件而非在两处各写一遍：auth gate 与 login 页是**两个独立页面**
 * （login 由 navigateTo 打开，不是同一棵渲染树），只补一处仍会留缺口；
 * 而两处各写一份文案 = 副本漂移风险（对齐护栏 4「单一真相源」的精神）。
 *
 * 📌 刻意**不做**勾选框「已阅读并同意」：微信对强制勾选有额外规范要求，
 * 且需同步改后台「用户隐私保护指引」，属独立决策项，不在本次修复范围。
 */
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { DocId } from '../content/legal'
import './LegalLinks.scss'

/** 三份文档的展示顺序与文案，与主端 SiteFooter.tsx:14-27 逐字一致。 */
const LINKS: { id: DocId; label: string }[] = [
  { id: 'terms', label: '用户协议' },
  { id: 'privacy', label: '隐私政策' },
  { id: 'disclaimer', label: '免责声明' },
]

interface LegalLinksProps {
  /** 前缀提示文案；留空则不渲染（auth gate 用默认，登录页可覆盖） */
  hint?: string
  /** 紧凑形态：字号更小、间距更紧，用于登录页底部 */
  compact?: boolean
}

export function LegalLinks({ hint, compact }: LegalLinksProps) {
  function open(id: DocId) {
    // legal 页是普通页面（非 tabBar），navigateTo 即可；与 profile.tsx 同一路径口径。
    void Taro.navigateTo({ url: `/pages/legal/legal?id=${id}` })
  }

  return (
    <View className={compact ? 'legal-links legal-links--compact' : 'legal-links'}>
      {hint ? <Text className='legal-links-hint'>{hint}</Text> : null}
      <View className='legal-links-row'>
        {LINKS.map((l, i) => (
          <View className='legal-links-item' key={l.id}>
            {i > 0 ? <Text className='legal-links-dot'>·</Text> : null}
            <Text className='legal-links-text' onClick={() => open(l.id)}>
              {l.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}
