import { useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import { useLoad } from '@tarojs/taro'
import {
  todayKey,
  getProfile,
  insertMeals,
  listMealsByDate,
  addWater,
  listWaterByDate,
  addExercise,
  listExerciseByDate,
  saveWeight,
  getHoneyBalance,
  getPhotoQuota,
  type MealEntry,
  type WaterLog,
  type ExerciseLog,
} from '../../lib/api'
import './checkin.scss'

export default function Checkin() {
  const [today] = useState(todayKey())
  const [meals, setMeals] = useState<MealEntry[]>([])
  const [waters, setWaters] = useState<WaterLog[]>([])
  const [exercises, setExercises] = useState<ExerciseLog[]>([])
  const [honey, setHoney] = useState(0)
  const [quota, setQuota] = useState(0)

  // 手动录入表单
  const [foodName, setFoodName] = useState('')
  const [foodKcal, setFoodKcal] = useState('')
  const [waterMl, setWaterMl] = useState('')
  const [exName, setExName] = useState('')
  const [exMinutes, setExMinutes] = useState('')
  const [weightKg, setWeightKg] = useState('')

  const [msg, setMsg] = useState('')

  useLoad(async () => {
    await refresh()
  })

  async function refresh() {
    try {
      const [m, w, e, h, q] = await Promise.all([
        listMealsByDate(today),
        listWaterByDate(today),
        listExerciseByDate(today),
        getHoneyBalance(),
        getPhotoQuota(),
      ])
      setMeals(m)
      setWaters(w)
      setExercises(e)
      setHoney(h.balance)
      setQuota(q.totalRemaining)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '读取失败')
    }
  }

  const totalWater = waters.reduce((s, w) => s + w.amount_ml, 0)
  const totalKcal = meals.reduce((s, m) => s + m.calories, 0)

  async function onAddMeal() {
    if (!foodName.trim()) { setMsg('请输入食物名称'); return }
    const kcal = Number(foodKcal) || 0
    setMsg('')
    try {
      await insertMeals([{
        log_date: today,
        meal_type: 'snack',
        food_name: foodName.trim(),
        quantity_text: null,
        grams: null,
        calories: kcal,
        protein_g: 0,
        carb_g: 0,
        fat_g: 0,
        source: 'manual',
      }])
      setFoodName(''); setFoodKcal('')
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '保存失败')
    }
  }

  async function onAddWater() {
    const ml = Number(waterMl) || 0
    if (ml <= 0) { setMsg('请输入饮水量'); return }
    setMsg('')
    try {
      await addWater(today, ml)
      setWaterMl('')
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '保存失败')
    }
  }

  async function onAddExercise() {
    if (!exName.trim()) { setMsg('请输入运动名称'); return }
    const minutes = Number(exMinutes) || 0
    setMsg('')
    try {
      await addExercise({
        log_date: today,
        name: exName.trim(),
        minutes,
        calories: 0,
      })
      setExName(''); setExMinutes('')
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '保存失败')
    }
  }

  async function onSaveWeight() {
    const kg = Number(weightKg) || 0
    if (kg <= 0) { setMsg('请输入体重'); return }
    setMsg('')
    try {
      await saveWeight(today, kg)
      setWeightKg('')
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '保存失败')
    }
  }

  return (
    <View className='checkin'>
      <View className='summary'>
        <View className='summary-item'>
          <Text className='summary-num'>{meals.length}</Text>
          <Text className='summary-label'>今日记录</Text>
        </View>
        <View className='summary-item'>
          <Text className='summary-num'>{totalKcal}</Text>
          <Text className='summary-label'>热量 kcal</Text>
        </View>
        <View className='summary-item'>
          <Text className='summary-num'>{totalWater}</Text>
          <Text className='summary-label'>饮水 ml</Text>
        </View>
        <View className='summary-item'>
          <Text className='summary-num'>{honey}</Text>
          <Text className='summary-label'>蜜糖积分</Text>
        </View>
      </View>

      <View className='quota-bar'>
        <Text className='quota-text'>今日 AI 拍照识别剩余：{quota} 次</Text>
      </View>

      {msg ? <Text className='msg'>{msg}</Text> : null}

      <View className='form-card'>
        <Text className='form-title'>手动记饮食</Text>
        <View className='form-row'>
          <Input className='input' placeholder='食物名称' value={foodName} onInput={(e) => setFoodName(e.detail.value)} />
          <Input className='input' type='number' placeholder='热量 kcal' value={foodKcal} onInput={(e) => setFoodKcal(e.detail.value)} />
        </View>
        <Button className='btn' onClick={onAddMeal}>记录饮食</Button>
      </View>

      <View className='form-card'>
        <Text className='form-title'>记录饮水</Text>
        <View className='form-row'>
          <Input className='input' type='number' placeholder='饮水量 ml' value={waterMl} onInput={(e) => setWaterMl(e.detail.value)} />
        </View>
        <Button className='btn' onClick={onAddWater}>记录饮水</Button>
      </View>

      <View className='form-card'>
        <Text className='form-title'>记录运动</Text>
        <View className='form-row'>
          <Input className='input' placeholder='运动名称' value={exName} onInput={(e) => setExName(e.detail.value)} />
          <Input className='input' type='number' placeholder='分钟' value={exMinutes} onInput={(e) => setExMinutes(e.detail.value)} />
        </View>
        <Button className='btn' onClick={onAddExercise}>记录运动</Button>
      </View>

      <View className='form-card'>
        <Text className='form-title'>记录体重</Text>
        <View className='form-row'>
          <Input className='input' type='digit' placeholder='体重 kg' value={weightKg} onInput={(e) => setWeightKg(e.detail.value)} />
        </View>
        <Button className='btn' onClick={onSaveWeight}>保存体重</Button>
      </View>
    </View>
  )
}
