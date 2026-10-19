import { useState } from 'react'
import { View, Text, Button, Image } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { recognizeFoodFromImage, type DetectedFood } from '../../lib/ai'
import {
  todayKey,
  insertMeals,
  consumePhotoQuota,
  releasePhotoQuota,
  getPhotoQuota,
  getHoneyBalance,
  redeemHoney,
} from '../../lib/api'
import { photoLadderHint, quotaExhaustedReason, FREE_DAILY_AI } from '@dbee/shared'
import './scan.scss'

export default function Scan() {
  const [items, setItems] = useState<DetectedFood[]>([])
  const [imageUrl, setImageUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [honey, setHoney] = useState(0)
  const [quota, setQuota] = useState(0)

  useLoad(async () => {
    await refreshStats()
  })

  async function refreshStats() {
    try {
      const [h, q] = await Promise.all([getHoneyBalance(), getPhotoQuota()])
      setHoney(h.balance)
      setQuota(q.totalRemaining)
    } catch {
      /* 静默 */
    }
  }

  /** 临时文件路径 → base64 dataUrl */
  function toBase64(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      Taro.getFileSystemManager().readFile({
        filePath,
        encoding: 'base64',
        success: (res) => resolve(`data:image/jpeg;base64,${res.data}`),
        fail: (err) => reject(new Error(err.errMsg || '读取图片失败')),
      })
    })
  }

  async function onTakePhoto() {
    setMsg('')
    try {
      // 1. 预占额度（识别成功才扣，失败退还）
      const claim = await consumePhotoQuota()
      if (!claim.allowed) {
        setMsg(quotaExhaustedReason())
        await refreshStats()
        return
      }

      // 2. 拍照
      const chooseRes = await Taro.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['camera', 'album'],
      })
      const filePath = chooseRes.tempFilePaths[0]
      if (!filePath) { await releasePhotoQuota(claim.token); return }

      setImageUrl(filePath)
      setLoading(true)

      // 3. 转 base64 + AI 识别
      const dataUrl = await toBase64(filePath)
      const detected = await recognizeFoodFromImage(dataUrl)

      // 4. 落库（识别成功，额度已扣，无需退还）
      await insertMeals(detected.map((it) => ({
        log_date: todayKey(),
        meal_type: 'snack',
        food_name: it.food_name,
        quantity_text: it.quantity_text,
        grams: it.grams,
        calories: it.calories,
        protein_g: it.protein_g,
        carb_g: it.carb_g,
        fat_g: it.fat_g,
        sodium_mg: it.sodium_mg ?? null,
        fiber_g: it.fiber_g ?? null,
        added_sugar_g: it.added_sugar_g ?? null,
        source: 'photo',
        ai_note: it.note ?? null,
        health_score: it.health_score ?? null,
      })))

      setItems(detected)
      setMsg(`识别成功，已记录 ${detected.length} 项`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '识别失败，请重试')
    } finally {
      setLoading(false)
      await refreshStats()
    }
  }

  async function onRedeem() {
    setMsg('')
    if (honey < 50) {
      setMsg('积分不足（50 积分/次），先去打卡攒积分')
      return
    }
    try {
      const r = await redeemHoney('ai1Scan')
      setMsg(r.ok ? '兑换成功，已增加 1 次拍照识别额度' : r.message)
      await refreshStats()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '兑换失败')
    }
  }

  return (
    <View className='scan'>
      <View className='stat-bar'>
        <Text className='stat'>积分：{honey}</Text>
        <Text className='stat'>今日识别剩余：{quota} 次</Text>
      </View>

      <Button className='btn-photo' loading={loading} disabled={loading} onClick={onTakePhoto}>
        {loading ? '识别中…' : '拍照识别食物'}
      </Button>

      {imageUrl ? <Image className='photo' src={imageUrl} mode='aspectFit' /> : null}

      {msg ? <Text className='msg'>{msg}</Text> : null}

      {items.length > 0 ? (
        <View className='result-card'>
          <Text className='result-title'>识别结果</Text>
          {items.map((it, i) => (
            <View className='result-item' key={i}>
              <Text className='result-name'>{it.food_name}</Text>
              <Text className='result-meta'>
                {it.quantity_text} · {it.calories} kcal · 蛋白 {it.protein_g}g
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <View className='redeem-card'>
        <Text className='redeem-title'>积分兑换拍照额度</Text>
        <Text className='redeem-desc'>50 积分兑换 1 次 AI 拍照识别（每日最多 2 次）</Text>
        <Button className='btn-redeem' onClick={onRedeem}>兑换 1 次（50 积分）</Button>
      </View>
    </View>
  )
}
