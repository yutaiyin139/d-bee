/**
 * 「AI 生成」显式标识（《人工智能生成合成内容标识办法》第四条（一），2025-09-01 施行）。
 * 对齐主工程 src/components/AiLabel.tsx，Taro 版实现（View/Text，无 DOM 依赖）。
 *
 * 办法要求：提供文本生成服务的，应当在交互场景界面、文字周边添加显著的提示标识。
 * 小程序端 AI 生成内容（问问小蜜回答、报告 AI 解读、拍照识别结果、引导计划建议）
 * 统一走本组件，保证标识口径一致、样式可审计。配套的用户协议条款见
 * mini/src/content/legal.ts「四之一」节。
 *
 * 两种形态：
 *   · <AiLabel />            —— 角标式徽章，贴在生成内容旁（默认）
 *   · <AiLabel inline />     —— 整行提示「内容由 AI 生成，仅供参考」，用于区块底部
 */
import { View, Text } from '@tarojs/components'
import './AiLabel.scss'

interface AiLabelProps {
  /** 整行提示形态（区块底部）；默认是徽章形态 */
  inline?: boolean
  /** 徽章文案覆盖（默认「AI 生成」） */
  text?: string
}

export function AiLabel({ inline, text }: AiLabelProps) {
  if (inline) {
    return (
      <View className='ai-gen-note'>
        <Text className='ai-badge'>AI 生成</Text>
        <Text className='ai-gen-text'>{text ?? '内容由 AI 生成，仅供参考，请核对后再作决定。'}</Text>
      </View>
    )
  }
  return <Text className='ai-badge'>{text ?? 'AI 生成'}</Text>
}
