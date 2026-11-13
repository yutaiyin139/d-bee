/**
 * 护栏 22 · 阶段 B 会员软门升到服务端（2026-11-13）。
 *
 * 锁死 0049 + 网关 + 两端调用，防止「只改前端、服务端仍可抓包」回潮：
 *   ① list_meals_between / export_user_bundle / llm_gate 分 feature 写在 0049
 *   ② 数字与 shared 常量同源（7/30、package 8、recap 0）；问答不设日上限
 *   ③ 主端 / mini 走 RPC，不再用 meal_entries 全字段跨日直查做报告/导出
 *   ④ 网关文本也调 llm_gate；视觉无 claim 改打 package，不靠进程内存限额
 *
 * 运行：npx vitest run tools/membership-server-gates.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function stripComments(src: string): string {
  const out = src.split('')
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === "'") mode = 'sq'
      else if (c === '"') mode = 'dq'
      else if (c === '`') mode = 'tpl'
      i++
      continue
    }
    if (mode === 'line') {
      if (c === '\n') mode = 'code'
      else out[i] = ' '
      i++
      continue
    }
    if (mode === 'block') {
      out[i] = c === '\n' ? '\n' : ' '
      if (c === '*' && n === '/') { out[i + 1] = ' '; mode = 'code'; i += 2; continue }
      i++
      continue
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      if (c !== '\\') mode = 'code'
    }
    i++
  }
  return out.join('')
}

const MIG = stripComments(read('db/migrations/0049-membership-server-gates.sql'))
const SHARED = stripComments(read('packages/shared/src/constants/index.ts'))
const LLM = stripComments(read('server/lib/llm.mjs'))
const MAIN_API = stripComments(read('src/lib/api.ts'))
const MINI_API = stripComments(read('mini/src/lib/api.ts'))
const MAIN_AI = stripComments(read('src/lib/ai.ts'))
const MINI_AI = stripComments(read('mini/src/lib/ai.ts'))

describe('护栏 22-A · 0049 RPC 与库内限额', () => {
  it('list_meals_between 按 report_window_days 截断', () => {
    expect(/CREATE OR REPLACE FUNCTION public\.list_meals_between\(p_start date, p_end date\)/.test(MIG) && /v_days := public\.report_window_days\(\)/.test(MIG)).toBe(true)
  })

  it('export_user_bundle 非 Pro 返回 pro_required 且不 json_agg 饮食表', () => {
    expect(/code', 'pro_required'/.test(MIG) && /IF NOT public\.entitlement_is_pro\(\)/.test(MIG)).toBe(true)
  })

  it('llm_gate 含 recap / coach / package 分支', () => {
    expect(/v_feature = 'recap'/.test(MIG) && /v_feature = 'package'/.test(MIG) && /v_feature = 'coach'/.test(MIG)).toBe(true)
  })

  it('包装日限额 8 与 shared 一致，问答不设日上限', () => {
    const pack = SHARED.match(/FREE_PACKAGE_DAILY\s*=\s*(\d+)/)?.[1]
    const coachOpen = /v_feature = 'coach'[\s\S]{0,180}allowed', true/.test(MIG)
    expect(pack === '8' && /v_limit := 8/.test(MIG) && !/v_limit := 20/.test(MIG) && !/FREE_COACH_DAILY/.test(SHARED) && coachOpen).toBe(true)
  })

  it('llm_gate 仍不授 authenticated', () => {
    expect(/REVOKE ALL ON FUNCTION public\.llm_gate\(text\) FROM PUBLIC, anon, authenticated/.test(MIG)).toBe(true)
  })
})

describe('护栏 22-B · 两端走 RPC', () => {
  it('主端 listMealsBetween 调用 list_meals_between', () => {
    expect(/export async function listMealsBetween[\s\S]{0,500}callRpc\('list_meals_between'/.test(MAIN_API)).toBe(true)
  })

  it('mini listMealsBetween 调用 list_meals_between', () => {
    expect(/callRpc\('list_meals_between'/.test(MINI_API)).toBe(true)
  })

  it('两端 exportAllData 走 export_user_bundle', () => {
    expect(/callRpc\('export_user_bundle'/.test(MAIN_API) && /callRpc\('export_user_bundle'/.test(MINI_API)).toBe(true)
  })
})

describe('护栏 22-C · 网关分功能 + fail-closed', () => {
  it('网关按 system 标记识别 recap/coach', () => {
    expect(/\[dbee-feature:recap\]/.test(LLM) && /\[dbee-feature:coach\]/.test(LLM)).toBe(true)
  })

  it('视觉无 claim 改打 llm_gate package，不 hit 内存 fallbackLimiter', () => {
    expect(/llmGate\(deps, ownerId, 'package'\)/.test(LLM) && !/fallbackLimiter/.test(LLM)).toBe(true)
  })

  it('闸门异常返回 gate_unavailable', () => {
    expect(/reason: 'gate_unavailable'/.test(LLM)).toBe(true)
  })

  it('问答只保留每分钟防刷，不出现日次数用尽文案', () => {
    expect(/coachMinuteLimiter/.test(LLM) && /windowMs: 60_000/.test(LLM) && /limit: 3/.test(LLM) && !/今日问答次数已用完/.test(LLM)).toBe(true)
  })

  it('两端本期解读 / 问答 system 带 feature 标记', () => {
    expect(
      /\[dbee-feature:recap\]/.test(MAIN_AI) &&
        /\[dbee-feature:recap\]/.test(MINI_AI) &&
        /\[dbee-feature:coach\]/.test(MAIN_AI) &&
        /\[dbee-feature:coach\]/.test(MINI_AI),
    ).toBe(true)
  })
})
