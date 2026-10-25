import { useState } from 'react'
import { View, Text, Button, Image, Input } from '@tarojs/components'
import Taro, { useLoad, useDidShow } from '@tarojs/taro'
import { recognizeFoodFromImage, type DetectedFood } from '../../lib/ai'
import {
  todayKey,
  insertMeals,
  consumePhotoQuota,
  releasePhotoQuota,
  getPhotoQuota,
  getHoneyBalance,
  redeemHoney,
  getEntitlement,
  getTodayPhotoCount,
  getProfile,
  saveRecipe,
  type Profile,
} from '../../lib/api'
import { checkStatBadges } from '../../lib/badgeCheck'
import { photoLadderHint, quotaExhaustedReason, isPro, FREE_DAILY_AI, HONEY_PRICE, AI_REDEEM_DAILY_LIMIT } from '@dbee/shared'
import { AiConsent } from '../../components/AiConsent'
import { grantAiConsent, hasAiConsent } from '../../lib/aiConsent'
import { shouldShowUpsell, markUpsellShown, dismissUpsell } from '../../lib/upsell'
import './scan.scss'

export default function Scan() {
  const [items, setItems] = useState<DetectedFood[]>([])
  const [imageUrl, setImageUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [honey, setHoney] = useState(0)
  const [quota, setQuota] = useState(0)
  const [pro, setPro] = useState(false)
  const [todayPhotoCount, setTodayPhotoCount] = useState(0)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [aiConsentOpen, setAiConsentOpen] = useState(false)
  const [upsellVisible, setUpsellVisible] = useState(false)
  // 保存食谱（P2-2）：识别结果一键存为自定义食谱
  const [recipeName, setRecipeName] = useState('')
  const [recipeInputOpen, setRecipeInputOpen] = useState(false)
  const [savingRecipe, setSavingRecipe] = useState(false)

  // profile 只需首屏拉一次（不随页面返回变化），留在 useLoad。
  useLoad(async () => {
    try { setProfile(await getProfile()) } catch { /* ignore */ }
  })

  // 从邀请中心兑换 Pro / 兑换拍照额度后返回本页时，onShow 会再次触发，
  // 重新拉取权益与额度（useLoad 只在首次加载触发，页面返回不重拉 → 兑换后不生效）。
  // 🔴 性能修复：此前 useLoad 里也调了一次 refreshStats()，而 Taro 首次进入
  //   同样会触发 useDidShow（onLoad → onShow → onReady），导致权益/额度/积分/
  //   今日拍照数 4 个请求被拉两遍。改为只在 useDidShow 拉。
  useDidShow(() => {
    void refreshStats()
  })

  async function refreshStats() {
    try {
      const [h, q, ent, n] = await Promise.all([getHoneyBalance(), getPhotoQuota(), getEntitlement(), getTodayPhotoCount()])
      setHoney(h.balance)
      setQuota(q.totalRemaining)
      setPro(isPro(ent))
      setTodayPhotoCount(n)
    } catch {
      /* 静默 */
    }
  }

  /** 只读额度预检：Pro 无限次；免费额度用完则按阶梯引导（对齐主工程 checkPhotoQuota） */
  async function checkPhotoQuota(): Promise<boolean> {
    if (pro) return true
    setMsg('')
    const quota = await getPhotoQuota().catch(() => null)
    const totalRemaining = quota ? quota.totalRemaining : FREE_DAILY_AI
    if (totalRemaining > 0) return true

    const bal = await getHoneyBalance().catch(() => null)
    const balance = bal ? bal.balance : 0
    const ladder = photoLadderHint(todayPhotoCount, balance)
    if (ladder.kind === 'redeem') {
      setMsg(`今日 ${FREE_DAILY_AI} 次免费识别已用完，可用 ${HONEY_PRICE.ai1Scan} 积分兑 1 次（每日最多兑 ${AI_REDEEM_DAILY_LIMIT} 次），你还有 ${balance} 积分。`)
    } else if (ladder.kind === 'inviteOrPro') {
      setMsg(`今日 ${FREE_DAILY_AI} 次免费识别已用完。邀请好友赚积分可兑换识别（每日最多 ${AI_REDEEM_DAILY_LIMIT} 次），或升级 Pro 无限次识别。`)
    } else {
      setMsg(quotaExhaustedReason())
    }
    return false
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
    if (!hasAiConsent(profile)) {
      setAiConsentOpen(true)
      return
    }
    setMsg('')
    try {
      // 0. 额度预检：Pro 无限次；免费额度用完直接提示（对齐主工程 checkPhotoQuota）
      const ok = await checkPhotoQuota()
      if (!ok) {
        await refreshStats()
        return
      }

      // 1. 预占额度（Pro 会员跳过占用；识别成功才扣，失败退还）
      let claim: { allowed: boolean; token?: string | null; remaining?: number } | null = null
      if (!pro) {
        const c = await consumePhotoQuota()
        if (!c.allowed) {
          setMsg(quotaExhaustedReason())
          await refreshStats()
          return
        }
        claim = c
      }

      // 2. 拍照
      const chooseRes = await Taro.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['camera', 'album'],
      })
      const filePath = chooseRes.tempFilePaths[0]
      if (!filePath) { if (claim) await releasePhotoQuota(claim.token ?? null); return }

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

      // 转化钩子：免费用户本次拍照后用尽额度 → 轻提示升级（克制：每周 1 次 + 可永久关闭）
      if (!pro && claim) {
        void (async () => {
          const show = await shouldShowUpsell(pro, claim.remaining ?? null)
          if (show) {
            await markUpsellShown()
            setUpsellVisible(true)
          }
        })()
      }
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

  /** 把当前识别结果存为自定义食谱（P2-2） */
  async function onSaveRecipe() {
    const name = recipeName.trim()
    if (!name) return
    setSavingRecipe(true)
    setMsg('')
    try {
      await saveRecipe(name, items.map((it) => ({
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
      })))
      setMsg(`已存为食谱「${name}」，下次可在「我的食谱」一键复记`)
      setRecipeName('')
      setRecipeInputOpen(false)
      // 创建食谱后重算统计类徽章（recipe_3 等，幂等）
      void checkStatBadges()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '保存食谱失败，请重试')
    } finally {
      setSavingRecipe(false)
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

      {upsellVisible && (
        <View className='upsell-notice'>
          <Text className='upsell-text'>今天拍得顺手吗？升级 Pro 可无限次拍照识别、解锁完整报告。</Text>
          <View className='upsell-actions'>
            <Text
              className='upsell-link'
              onClick={() => { setUpsellVisible(false); Taro.navigateTo({ url: '/pages/paywall/paywall' }) }}
            >
              去看看
            </Text>
            <Text
              className='upsell-link upsell-dismiss'
              onClick={() => { setUpsellVisible(false); void dismissUpsell() }}
            >
              不再提醒
            </Text>
          </View>
        </View>
      )}


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

          {/* 存为食谱（P2-2）：识别结果一键收藏为常吃食谱 */}
          {recipeInputOpen ? (
            <View className='recipe-save'>
              <Input
                className='recipe-input'
                value={recipeName}
                placeholder='给食谱起个名字，如「家常午饭」'
                placeholderStyle='color: #a39c90'
                onInput={(e) => setRecipeName(e.detail.value)}
              />
              <View className='recipe-save-actions'>
                <Button className='btn-text' disabled={savingRecipe || !recipeName.trim()} onClick={() => void onSaveRecipe()}>
                  {savingRecipe ? '保存中…' : '确认保存'}
                </Button>
                <Button className='btn-text cancel' onClick={() => { setRecipeInputOpen(false); setRecipeName('') }}>
                  取消
                </Button>
              </View>
            </View>
          ) : (
            <Button className='btn-recipe-save' onClick={() => setRecipeInputOpen(true)}>
              存为食谱
            </Button>
          )}
        </View>
      ) : null}

      <View className='redeem-card'>
        <Text className='redeem-title'>积分兑换拍照额度</Text>
        <Text className='redeem-desc'>50 积分兑换 1 次 AI 拍照识别（每日最多 2 次）</Text>
        <Button className='btn-redeem' onClick={onRedeem}>兑换 1 次（50 积分）</Button>
      </View>

      {aiConsentOpen && (
        <AiConsent
          kind='photo'
          onAgree={async () => {
            await grantAiConsent(profile)
            setProfile((p) => (p ? { ...p, ai_consented: true } : p))
            setAiConsentOpen(false)
          }}
          onDecline={() => setAiConsentOpen(false)}
        />
      )}
    </View>
  )
}
