/**
 * AI 数据处理同意状态管理（P0-3 合规）。
 *
 * 策略：
 * 1. 优先以云端 profiles.ai_consented 为真相源（跨设备一致）。
 * 2. 本地 localStorage 缓存作为降级，避免每次弹窗前都请求云端。
 * 3. 用户同意后同时写云端 + 本地缓存。
 */

import { saveProfile } from './api'
import type { Profile } from '../types'

const LOCAL_KEY = 'dbee:ai_consent'

function localConsent(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(LOCAL_KEY) === '1'
}

function setLocalConsent() {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(LOCAL_KEY, '1')
}

/** 当前用户是否已同意 AI 处理数据 */
export function hasAiConsent(profile: Profile | null): boolean {
  return Boolean(profile?.ai_consented) || localConsent()
}

/** 记录用户同意；先本地缓存，再异步同步云端（失败不抛错） */
export async function grantAiConsent(profile?: Profile | null): Promise<void> {
  setLocalConsent()
  try {
    await saveProfile({ ai_consented: true })
  } catch {
    // 本地已记录，下次读取 profile 时会补齐；不阻断用户流程
  }
}
