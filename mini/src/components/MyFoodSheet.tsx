import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import {
  MY_FOOD_TITLE, MY_FOOD_HINT, MY_FOOD_EMPTY, MY_FOOD_UNIT_COUNT, MY_FOOD_UNIT_KCAL,
  HEALTH_RECORD_LOADING, HEALTH_RECORD_LOAD_ERROR,
  buildMyFoodViewCore, type MyFoodView,
} from '@dbee/shared'
import { listRecipes } from '../lib/api'
import './MyPageSheets.scss'

/** 「我的食物」：只读 recipes 表，与主端同构。 */
export function MyFoodSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [rows, setRows] = useState<MyFoodView[]>([])

  useEffect(() => {
    let alive = true
    void listRecipes().then((r) => {
      if (!alive) return
      setRows(buildMyFoodViewCore(r))
      setState('ok')
    }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [])

  return (
    <View className='mp-mask' onClick={onClose}>
      <View className='mp-sheet' onClick={(e) => e.stopPropagation()}>
        <View className='mp-head'>
          <Text className='mp-title'>{MY_FOOD_TITLE}</Text>
          <View className='mp-close' onClick={onClose}><Text>×</Text></View>
        </View>
        <View className='mp-body'>
          <Text className='mp-helper'>{MY_FOOD_HINT}</Text>
          {state === 'loading' ? <Text className='mp-helper'>{HEALTH_RECORD_LOADING}</Text> : null}
          {state === 'error' ? <Text className='mp-helper'>{HEALTH_RECORD_LOAD_ERROR}</Text> : null}
          {state === 'ok' && rows.length === 0 ? <Text className='mp-helper'>{MY_FOOD_EMPTY}</Text> : null}
          {state === 'ok' && rows.length > 0 ? (
            <View className='mp-card'>
              {rows.map((r, i) => (
                <View className='mp-line' key={`${r.name}-${i}`}>
                  <Text>{r.name}</Text>
                  <Text className='mp-val'>{r.itemCount} {MY_FOOD_UNIT_COUNT} · {r.calories} {MY_FOOD_UNIT_KCAL}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  )
}
