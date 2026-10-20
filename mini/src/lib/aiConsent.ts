/**
 * AI 数据处理同意状态管理（小程序端，对齐主工程 src/lib/aiConsent.ts）。
 */

import Taro from '@tarojs/taro'
import { saveProfile } from './api'
import type { Profile } from './api'

const LOCAL_KEY = 'dbee:ai_consent'

function localConsent(): boolean {
  try {
    return Taro.getStorageSync(LOCAL_KEY) === '1'
  } catch {
    return false
  }
}

function setLocalConsent() {
  try {
    Taro.setStorageSync(LOCAL_KEY, '1')
  } catch {
    // ignore
  }
}

/** 当前用户是否已同意 AI 处理数据 */
export function hasAiConsent(profile: Profile | null): boolean {
  return Boolean(profile?.ai_consented) || localConsent()
}

/** 记录用户同意；先本地缓存，再异步同步云端 */
export async function grantAiConsent(profile?: Profile | null): Promise<void> {
  setLocalConsent()
  try {
    await saveProfile({ ai_consented: true })
  } catch {
    // ignore
  }
}
