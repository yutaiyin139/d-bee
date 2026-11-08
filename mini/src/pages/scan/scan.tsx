/**
 * 拍照识别页 —— 保留为小程序码 / 分享直达的**兼容入口**，不再是第二套业务逻辑。
 *
 * 🔴 2026-11-08：此前本页有完整而独立的一套「额度 → 选图 → 识别 → 冲突 → 落库」
 *    实现，与首页内嵌手录弹层、原生 ActionSheet 模式选择共同构成三块割裂容器，
 *    是 mini「界面像、逻辑差」的根源。现在统一渲染 components/LogSheet 的 photo 模式，
 *    与首页「记一餐」完全共用同一业务链路（草稿、判重、hint、冲突三选一、保存、刷新）。
 *
 *    路由参数仍兼容旧直达链接：?meal=breakfast&date=2026-11-08；
 *    日期格式非法则回落今天，餐次缺失则按时间推断（与主端 Dashboard 一致）。
 */
import { View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { LogSheet } from '../../components/LogSheet'
import { guessMealType } from '../../lib/nutrition'
import { todayKey, type MealType } from '../../lib/api'
import './scan.scss'

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack']

export default function Scan() {
  const router = useRouter()
  const paramMeal = String(router.params?.meal ?? '')
  const paramDate = String(router.params?.date ?? '')
  const initialMeal: MealType = MEAL_TYPES.includes(paramMeal as MealType)
    ? paramMeal as MealType
    : guessMealType()
  const logDate = /^\d{4}-\d{2}-\d{2}$/.test(paramDate) ? paramDate : todayKey()

  /** 关闭/保存后回首页；从分享或小程序码直接进来时没有上一页，兜底 reLaunch */
  function backToIndex() {
    Taro.navigateBack({ fail: () => Taro.reLaunch({ url: '/pages/index/index' }) })
  }

  return (
    <View className='scan'>
      <LogSheet
        logDate={logDate}
        initialMeal={initialMeal}
        initialMode='photo'
        onClose={backToIndex}
        onSaved={backToIndex}
      />
    </View>
  )
}
