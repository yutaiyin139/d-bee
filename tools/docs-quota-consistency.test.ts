/**
 * 护栏 24 · docs/ 额度与价格口径单一化（2026-11-12，P0.3 / 缺口 D2）
 *
 * 起因：路线图 §1.4 标了「口径漂移」，实证发现 `docs/AI成本与配额.md`
 * 仍写「免费 10 次 / FREE_DAILY_AI = 10 / 常量在 src/lib/entitlement.ts」，
 * 而 `packages/shared/src/constants/index.ts` 的现行规则是
 * 「每日 3 次免费 + 2 次积分兑换」，`entitlement.ts` 只是 re-export。
 * 这类文档会被当作运营/发版口径来读，过时数字比没有文档更危险。
 *
 * 设计（护栏断言三铁律）：
 *   ① 一个 it() 只一条断言；
 *   ② 断言匹配「实际生效的口径」而非标识符出现：动态从 shared 常量取值，
 *      再要求 docs 里存在 `¥${常量}` / `CONST = ${常量}` 的逐字快照 ——
 *      这样**改常量即变红**，逼着同步文档，而不是硬编码一份新副本；
 *   ③ 对代码/SQL 的断言一律在 stripComments() 之后做（SQL 用 `--` 行注释）。
 *
 * 另钉住 P0.2 的只读纪律：`tools/growth-report.sql` 不得含任何写操作关键字。
 *
 * 运行：npx vitest run tools/docs-quota-consistency.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  HONEY_PRICE,
  PRICE_LIFETIME,
  PRICE_PRO_MONTHLY,
  PRICE_PRO_YEARLY,
} from '../src/lib/entitlement'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DOCS = join(ROOT, 'docs')
const REPORT = join(ROOT, 'tools', 'growth-report.sql')
const QUOTA_DOC = 'AI成本与配额.md'
const DICT_DOC = '成长指标字典.md'

const docFiles = (): string[] => readdirSync(DOCS).filter((f) => f.endsWith('.md'))
const docText = (name: string): string => readFileSync(join(DOCS, name), 'utf8')
const allDocsText = (): string => docFiles().map((f) => docText(f)).join('\n')

/** 去掉块注释、// 行注释与 SQL 的 -- 行注释；断言只作用在真实代码上。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/--.*$/gm, ' ')
}

describe('护栏 24-A · docs/ 不得残留已废弃的额度口径', () => {
  const STALE = ['免费 10 次', '今日 10 次免费', 'FREE_DAILY_AI = 10', '第 11 次起']

  STALE.forEach((phrase) => {
    it(`docs/ 中不得残留「${phrase}」`, () => {
      const hits = docFiles().filter((f) => docText(f).includes(phrase))
      expect(hits, `命中文件：${hits.join(', ')}`).toEqual([])
    })
  })
})

describe('护栏 24-B · 额度/价格文档必须与 shared 常量逐字一致', () => {
  it('AI成本与配额.md 的每日免费额度与 FREE_DAILY_AI 一致', () => {
    expect(docText(QUOTA_DOC).includes(`FREE_DAILY_AI = ${FREE_DAILY_AI}`)).toBe(true)
  })

  it('AI成本与配额.md 的兑换上限与 AI_REDEEM_DAILY_LIMIT 一致', () => {
    expect(docText(QUOTA_DOC).includes(`AI_REDEEM_DAILY_LIMIT = ${AI_REDEEM_DAILY_LIMIT}`)).toBe(true)
  })

  it('AI成本与配额.md 的单次兑换积分与 HONEY_PRICE.ai1Scan 一致', () => {
    expect(docText(QUOTA_DOC).includes(`HONEY_PRICE.ai1Scan = ${HONEY_PRICE.ai1Scan}`)).toBe(true)
  })

  it('docs/ 中月订阅价快照与 PRICE_PRO_MONTHLY 一致', () => {
    expect(allDocsText().includes(`¥${PRICE_PRO_MONTHLY}`)).toBe(true)
  })

  it('docs/ 中年订阅价快照与 PRICE_PRO_YEARLY 一致', () => {
    expect(allDocsText().includes(`¥${PRICE_PRO_YEARLY}`)).toBe(true)
  })

  it('docs/ 中终身价快照与 PRICE_LIFETIME 一致', () => {
    expect(allDocsText().includes(`¥${PRICE_LIFETIME}`)).toBe(true)
  })

  it('AI成本与配额.md 明确把真相源指向 packages/shared', () => {
    expect(docText(QUOTA_DOC).includes('packages/shared/src/constants/index.ts')).toBe(true)
  })
})

describe('护栏 24-C · 度量脚本只读纪律与指标字典', () => {
  it('growth-report.sql 去注释后不含任何写操作关键字', () => {
    const code = stripComments(readFileSync(REPORT, 'utf8'))
    expect(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|COPY|GRANT|REVOKE)\b/i.test(code)).toBe(false)
  })

  it('growth-report.sql 声明使用只读账号', () => {
    expect(readFileSync(REPORT, 'utf8').includes('只读账号')).toBe(true)
  })

  it('成长指标字典声明用 psql -tA 与只读账号', () => {
    expect(docText(DICT_DOC).includes('psql "$READONLY_URL" -tA')).toBe(true)
  })

  it('成长指标字典明确标注数据面闭环前不作基线', () => {
    expect(docText(DICT_DOC).includes('草稿，不作基线')).toBe(true)
  })
})

// ── P0.7 提醒克制化：四端默认值必须一致为「关」────────────────────────
// 只改 kvGet 缺省值、不写回 kv，老用户本地已存的 '1' 保持开启（天然灰度）。
// 断言一律在 stripComments() 之后的代码上做（注释里谈过 '1' 与旧默认值）。
const NOTIF_SRCS = ['src/lib/notifications.ts', 'mini/src/lib/notifications.ts']
const PROFILE_SRCS = ['src/pages/ProfileScreen.tsx', 'mini/src/pages/profile/profile.tsx']
const srcCode = (p: string): string => stripComments(readFileSync(join(ROOT, p), 'utf8'))

describe('护栏 24-D · 提醒默认关（P0.7，四端一致 / 老用户灰度不强制关）', () => {
  NOTIF_SRCS.forEach((p) => {
    it(`${p} 的 checkin 缺省值为关`, () => {
      expect(srcCode(p).includes("kvGet('notif.checkin', '0')")).toBe(true)
    })

    it(`${p} 的 water 缺省值为关`, () => {
      expect(srcCode(p).includes("kvGet('notif.water', '0')")).toBe(true)
    })

    it(`${p} 不得残留默认开的 '1' 缺省值（禁止静默回退）`, () => {
      expect(/kvGet\('notif\.(checkin|water)', '1'\)/.test(srcCode(p))).toBe(false)
    })
  })

  PROFILE_SRCS.forEach((p) => {
    it(`${p} 的 notifCheckin 首帧为 false`, () => {
      expect(/const \[notifCheckin,[^\n]*useState\(false\)/.test(srcCode(p))).toBe(true)
    })

    it(`${p} 的 notifWater 首帧为 false`, () => {
      expect(/const \[notifWater,[^\n]*useState\(false\)/.test(srcCode(p))).toBe(true)
    })
  })
})
