/**
 * AI 数据处理显式同意弹窗（小程序端，对齐主工程 src/components/AiConsent.tsx）。
 */

import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import './AiConsent.scss'

interface AiConsentProps {
  kind: 'photo' | 'coach'
  onAgree: () => void
  onDecline: () => void
}

const BODY: Record<AiConsentProps['kind'], { title: string; desc: string }> = {
  photo: {
    title: 'AI 拍照识别说明',
    desc: '使用「拍照识别」时，你所拍摄的食物照片会上传至视觉大模型进行分析，以返回热量与营养估算。识别完成后照片不会被长期保存。',
  },
  coach: {
    title: 'AI 饮食助手说明',
    desc: '使用「问问小蜜」时，你的提问与今日饮食记录摘要会发送至大模型，以生成个性化建议。对话内容不会被用于模型训练。',
  },
}

export function AiConsent({ kind, onAgree, onDecline }: AiConsentProps) {
  const [busy, setBusy] = useState(false)
  const body = BODY[kind]

  return (
    <View className='ai-consent-mask' onClick={onDecline}>
      <View className='ai-consent-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='ai-consent-head'>
          <Text className='ai-consent-title'>{body.title}</Text>
          <Button className='ai-consent-close' onClick={onDecline}>×</Button>
        </View>
        <View className='ai-consent-body'>
          <Text className='ai-consent-desc'>{body.desc}</Text>
          <Text className='ai-consent-hint'>不同意仍可继续使用手动记录、文字录入、扫条码等非 AI 功能。</Text>
        </View>
        <View className='ai-consent-foot'>
          <Button className='btn btn-ghost' onClick={onDecline} disabled={busy}>不同意</Button>
          <Button
            className='btn btn-primary'
            onClick={() => {
              setBusy(true)
              onAgree()
            }}
            disabled={busy}
          >
            {busy ? '保存中…' : '同意并继续'}
          </Button>
        </View>
      </View>
    </View>
  )
}
