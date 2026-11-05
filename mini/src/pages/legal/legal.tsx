import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getDoc, SITE, type DocId } from '../../content/legal'
import { copyText } from '../../lib/clipboard'
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

  // 备案号复制结果提示（P1-F）
  const [icpMsg, setIcpMsg] = useState('')

  function goBack() {
    Taro.navigateBack()
  }

  /**
   * 复制备案号查询网址（P1-F）。
   *
   * 与主工程 SiteFooter 的差异：主端用 `<a href target="_blank">` 直接跳
   * beian.miit.gov.cn；小程序**打不开任意外链**（须先在 mp 后台把域名加进
   * businessDomain 白名单，而政府站点不可能为我们配置校验文件），
   * 故改为「复制网址 + 文字指引用户自行到浏览器打开」。
   * 备案号文本本身也一并复制，便于用户在查询页粘贴核验。
   */
  async function copyIcpQuery() {
    const ok = await copyText(`${SITE.icpUrl} （备案号：${SITE.icp}）`)
    setIcpMsg(ok
      ? '查询网址与备案号已复制，请在浏览器打开核验'
      : '复制失败，请手动记录备案号后到浏览器查询')
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

      {/*
        备案信息（P1-F）。渲染逻辑对齐主工程 src/components/SiteFooter.tsx:35-49：
        **留空则整块不渲染** —— 备案审核期间展示假备案号属违规，
        故 SITE.icp 为空串时这里什么都不出现（当前即此状态，备案号未下证）。

        🔴 备案号下证后的操作：只需改 mini/src/content/legal.ts 的
           `icp: ''` → `icp: '京ICP备2026XXXXXX号-1'`（以及 police），
           本页无需再改。主端走 VITE_ICP_BEIAN 构建期环境变量，
           本端因小程序无 import.meta.env 而用常量（见 legal.ts 文件头说明）。

        ⚠️ 历史记录：本页曾**刻意不渲染** SITE.version，理由是「该字段在 mini 是死代码
           且值陈旧（写死 '1.6.9'，既非 mini/package.json 的 0.1.0 也非主端 1.7.3），
           没有单一真源，渲染出来等于向用户展示错误版本号」。
           当时的判断是对的 —— 显示错版本号比不显示更糟。
           🔴 2026-11-05 已根治：版本改为构建期注入（mini/config/index.ts 的
           __APP_VERSION__，与主端 vite.config.ts:64 同名同源，都取项目根
           package.json 的 version），SITE.version 自此有唯一真相源，
           故下方恢复渲染，与主端 SiteFooter.tsx:29 口径一致（名称 + 版本号同一行）。
      */}
      {SITE.icp ? (
        <View className='legal-icp'>
          <Text className='legal-icp-num' onClick={() => void copyIcpQuery()}>
            {SITE.icp}
          </Text>
          {SITE.police ? (
            <Text className='legal-icp-num' onClick={() => void copyIcpQuery()}>
              {SITE.police}
            </Text>
          ) : null}
          <Text className='legal-icp-hint'>点击复制查询网址，可在浏览器核验备案信息</Text>
          {icpMsg ? <Text className='legal-icp-msg'>{icpMsg}</Text> : null}
        </View>
      ) : null}

      <View className='legal-meta'>
        {/* 名称 + 版本号同一行，与主端 SiteFooter.tsx:29 逐字对齐。 */}
        <Text className='legal-meta-line'>{SITE.nameEn}（{SITE.name}）{SITE.version}</Text>
        <Text className='legal-meta-line'>营养数据仅供参考，不构成医疗建议</Text>
      </View>

      <Button className='btn btn-ghost legal-done' onClick={goBack}>我已阅读</Button>
      <View className='bottom-space' />
    </View>
  )
}
