/**
 * 护栏：蜜糖积分 FEFO 口径（修双扣，2026-11-17）。
 *
 * 生产取证（owner 179325... / 手机 18611114399）实证：
 *   当前 FILTER=0（错） / 朴素 SUM=-66（错） / FEFO=34（正解）。
 * 根因：expire 整笔冲正 + FILTER 排除过期正流水，双重扣减。
 *
 * 本护栏：
 *   1) computeHoneyBalance() 用【真实账户流水】断言 balance=34
 *      —— 若有人改回旧 FILTER 口径会立刻变红（退化验证见文件尾）。
 *   2) 边界：无过期 / 全过期 / 永不过期 / 纯消费 / expire 流水被忽略。
 *   3) 四端一致性：两端 api.ts 回退路径都调用 computeHoneyBalance；
 *      shared 导出；0054 迁移含 FEFO 实现。
 *
 * 断言纪律（护栏四铁律）：一个 it() 一条断言；匹配「实际使用」；
 * 在 stripComments 后做；「两端都包含」用 every()。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeHoneyBalance, HONEY_REASON_EXPIRE, type HoneyLedgerRow } from '../packages/shared/src/honeyLedger'

const NOW = new Date('2026-11-17T15:00:00+08:00').getTime()

/** 生产只读取证的真实流水（11 条，owner 179325...） */
const REAL_ROWS: HoneyLedgerRow[] = [
  { id: 283, amount: 150, reason: 'newbie', expires_at: '2026-11-05T13:00:00+08:00' },
  { id: 287, amount: 2, reason: 'checkin_exercise', expires_at: '2027-11-02T10:00:00+08:00' },
  { id: 290, amount: 5, reason: 'checkin_meal', expires_at: '2027-11-02T16:00:00+08:00' },
  { id: 293, amount: -100, reason: 'redeem', expires_at: null },
  { id: 370, amount: 5, reason: 'checkin_meal', expires_at: '2027-11-09T08:00:00+08:00' },
  { id: 371, amount: -150, reason: 'expire', expires_at: null },
  { id: 388, amount: 5, reason: 'checkin_meal', expires_at: '2027-11-10T11:00:00+08:00' },
  { id: 469, amount: 5, reason: 'checkin_meal', expires_at: '2027-11-12T20:00:00+08:00' },
  { id: 507, amount: 5, reason: 'checkin_meal', expires_at: '2027-11-14T22:00:00+08:00' },
  { id: 659, amount: 5, reason: 'checkin_meal', expires_at: '2027-11-17T14:00:00+08:00' },
  { id: 667, amount: 2, reason: 'checkin_exercise', expires_at: '2027-11-17T14:00:00+08:00' },
]

describe('FEFO 余额：真实账户回归（双扣取证）', () => {
  it('真实账户 balance=34（旧 FILTER 会得 0，此处钉死正解）', () => {
    expect(computeHoneyBalance(REAL_ROWS, NOW).balance).toBe(34)
  })
  it('真实账户 totalEarned=184', () => {
    expect(computeHoneyBalance(REAL_ROWS, NOW).totalEarned).toBe(184)
  })
  it('真实账户 totalSpent=100（排除 expire 冲正，非虚高的 250）', () => {
    expect(computeHoneyBalance(REAL_ROWS, NOW).totalSpent).toBe(100)
  })
})

describe('FEFO 余额：边界语义', () => {
  it('无过期：全部正流水计入（10）', () => {
    const rows: HoneyLedgerRow[] = [
      { amount: 10, reason: 'checkin_meal', expires_at: null },
    ]
    expect(computeHoneyBalance(rows, NOW).balance).toBe(10)
  })
  it('全过期：余额为 0', () => {
    const rows: HoneyLedgerRow[] = [
      { amount: 10, reason: 'newbie', expires_at: '2026-01-01T00:00:00+08:00' },
    ]
    expect(computeHoneyBalance(rows, NOW).balance).toBe(0)
  })
  it('先到期先消费：100 花在最早到期的 150 上，剩 50 过期作废 + 未过期 7 → 7', () => {
    const rows: HoneyLedgerRow[] = [
      { amount: 150, reason: 'newbie', expires_at: '2026-11-05T00:00:00+08:00' },
      { amount: 2, reason: 'checkin_exercise', expires_at: '2027-11-02T00:00:00+08:00' },
      { amount: 5, reason: 'checkin_meal', expires_at: '2027-11-02T00:00:00+08:00' },
      { amount: -100, reason: 'redeem', expires_at: null },
    ]
    expect(computeHoneyBalance(rows, NOW).balance).toBe(7)
  })
  it('expire 冲正流水被忽略（不应二次扣减）', () => {
    const base: HoneyLedgerRow[] = [
      { amount: 150, reason: 'newbie', expires_at: '2027-11-05T00:00:00+08:00' },
    ]
    const withExpire: HoneyLedgerRow[] = [...base, { amount: -150, reason: HONEY_REASON_EXPIRE, expires_at: null }]
    expect(computeHoneyBalance(withExpire, NOW).balance).toBe(computeHoneyBalance(base, NOW).balance)
  })
  it('永不过期（expires_at=null）排在到期批次之后消费', () => {
    const rows: HoneyLedgerRow[] = [
      { amount: 10, reason: 'checkin_meal', expires_at: null },
      { amount: 10, reason: 'newbie', expires_at: '2026-11-20T00:00:00+08:00' },
      { amount: -10, reason: 'redeem', expires_at: null },
    ]
    // 先扣 11-20 到期的 10（最早到期），永不过期的 10 保留 → 10
    expect(computeHoneyBalance(rows, NOW).balance).toBe(10)
  })
  it('负数余额截断为 0', () => {
    const rows: HoneyLedgerRow[] = [
      { amount: 5, reason: 'checkin_meal', expires_at: null },
      { amount: -20, reason: 'redeem', expires_at: null },
    ]
    expect(computeHoneyBalance(rows, NOW).balance).toBe(0)
  })
})

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}
const root = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8')

describe('四端一致性：FEFO 口径落地', () => {
  const webApi = stripComments(read('src/lib/api.ts'))
  const miniApi = stripComments(read('mini/src/lib/api.ts'))
  const sharedIndex = stripComments(read('packages/shared/src/index.ts'))
  const migration = read('db/migrations/0054-honey-balance-fefo.sql')

  it('web api.ts 回退调用 computeHoneyBalance', () => {
    expect(webApi.includes('computeHoneyBalance(rows_')).toBe(true)
  })
  it('mini api.ts 回退调用 computeHoneyBalance', () => {
    expect(miniApi.includes('computeHoneyBalance(rs')).toBe(true)
  })
  it('两端都 select reason 字段（FEFO 需忽略 expire 冲正）', () => {
    expect([webApi, miniApi].every((s) => /select\([^)]*reason/.test(s))).toBe(true)
  })
  it('shared index 导出 honeyLedger', () => {
    expect(sharedIndex.includes("export * from './honeyLedger'")).toBe(true)
  })
  it('0054 迁移重写 honey_balance()', () => {
    expect(migration.includes('CREATE OR REPLACE FUNCTION public.honey_balance()')).toBe(true)
  })
  it('0054 迁移忽略 reason=expire 物理冲正', () => {
    expect(/reason\s*<>\s*'expire'/.test(migration)).toBe(true)
  })
})
