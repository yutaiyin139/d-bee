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
import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { SITE, type DocId } from '../content/legal'
import { copyText } from '../lib/clipboard'
import './LegalLinks.scss'

/** 与主端 SiteFooter 的法律入口同一顺序。会员定价只在网页页脚，小程序不放第二份标价。 */
const LINKS: { id: DocId | 'contact'; label: string }[] = [
  { id: 'terms', label: '用户协议' },
  { id: 'privacy', label: '隐私政策' },
  { id: 'disclaimer', label: '免责声明' },
  { id: 'contact', label: '联系我们' },
]

interface LegalLinksProps {
  /** 前缀提示文案；留空则不渲染（auth gate 用默认，登录页可覆盖） */
  hint?: string
  /** 紧凑形态：字号更小、间距更紧，用于登录页底部 */
  compact?: boolean
  /**
   * 登录后的页脚，对齐主端 SiteFooter：同一行入口，外加版本、邮箱和备案号。
   * 小程序打不开政府备案站，备案号改为复制查询网址。
   */
  footer?: boolean
}

export function LegalLinks({ hint, compact, footer }: LegalLinksProps) {
  const [icpMsg, setIcpMsg] = useState('')

  function open(id: DocId | 'contact') {
    if (id === 'contact') {
      void copyContact()
      return
    }
    void Taro.navigateTo({ url: `/pages/legal/legal?id=${id}` })
  }

  async function copyContact() {
    const ok = await copyText(SITE.contactEmail)
    Taro.showToast({
      title: ok ? `邮箱已复制：${SITE.contactEmail}` : `复制失败，请手动记录：${SITE.contactEmail}`,
      icon: 'none',
      duration: ok ? 2500 : 4000,
    })
  }

  async function copyIcp() {
    const ok = await copyText(`${SITE.icpUrl} （备案号：${SITE.icp}）`)
    setIcpMsg(ok ? '查询网址与备案号已复制，请在浏览器打开核验' : '复制失败，请手动记录备案号后到浏览器查询')
  }

  const cls = ['legal-links', compact ? 'legal-links--compact' : '', footer ? 'legal-links--footer' : ''].filter(Boolean).join(' ')

  return (
    <View className={cls}>
      {!footer && hint ? <Text className='legal-links-hint'>{hint}</Text> : null}
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
      {footer ? (
        <View>
          <Text className='legal-links-meta'>{SITE.nameEn}（{SITE.name}）{SITE.version} · {SITE.contactEmail} · 营养数据仅供参考，不构成医疗建议</Text>
          {SITE.icp ? (
            <Text className='legal-links-meta legal-links-icp' onClick={() => void copyIcp()}>{SITE.icp}</Text>
          ) : null}
          {SITE.police ? (
            <Text className='legal-links-meta legal-links-icp' onClick={() => void copyIcp()}>{SITE.police}</Text>
          ) : null}
          {icpMsg ? <Text className='legal-links-meta'>{icpMsg}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}
