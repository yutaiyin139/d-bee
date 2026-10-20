import { View, Text, Button } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getDoc, type DocId } from '../../content/legal'
import './legal.scss'

/**
 * 法律文档页（用户协议 / 隐私政策 / 免责声明），对齐主工程 src/pages/LegalPage.tsx。
 * 三份文档共用同一个渲染器，内容来自 content/legal.ts 的 DOCS。
 * 通过路由参数 ?id=terms|privacy|disclaimer 指定文档。
 */
export default function Legal() {
  const router = useRouter()
  const raw = router.params?.id ?? 'terms'
  const id: DocId = raw === 'privacy' || raw === 'disclaimer' ? raw : 'terms'
  const doc = getDoc(id)

  function goBack() {
    Taro.navigateBack()
  }

  return (
    <View className='legal-page'>
      <View className='legal-head'>
        <Button className='btn-text legal-back' onClick={goBack}>‹ 返回</Button>
        <Text className='legal-title'>{doc.title}</Text>
        <Text className='legal-updated'>最后更新：{doc.updated}</Text>
      </View>

      <View className='legal-body'>
        <Text className='legal-intro'>{doc.intro}</Text>
        {doc.sections.map((s) => (
          <View className='legal-section' key={s.h}>
            <Text className='legal-h2'>{s.h}</Text>
            {s.p?.map((t, i) => <Text className='legal-p' key={i}>{t}</Text>)}
            {s.list ? (
              <View className='legal-list'>
                {s.list.map((t, i) => <Text className='legal-li' key={i}>{t}</Text>)}
              </View>
            ) : null}
          </View>
        ))}
      </View>

      <Button className='btn btn-ghost legal-done' onClick={goBack}>我已阅读</Button>
      <View className='bottom-space' />
    </View>
  )
}
