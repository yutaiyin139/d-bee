/**
 * 护栏 21 · 兑换码安全加固（2026-11-10 新增）。
 *
 * 锁死 0048 的三处安全加固，防止「顺手改回去」导致资金/合规风险：
 *   ① 哈希存储：核销按 code_hash（SHA-256）匹配，库内不存码明文；
 *     发码工具 INSERT code_hash 而非 code。
 *   ② 有效期：核销函数检查 expires_at，过期码返回 'bad' 且不烧码。
 *   ③ 节流：redeem_throttled 存在且核销函数调用它（60s 失败≥5 次拒）。
 *   ④ 对外契约：redeem_by_code 返回值仍只有 ok/used/bad（无新值，防前端静默降级）。
 *
 * 🔴 断言纪律（项目铁律）：
 *   · 一个 it() 只一条逻辑断言；
 *   · 匹配「实际使用」（函数体/INSERT 语句里的真实引用），不是注释/标识符出现；
 *   · 在 stripComments() 之后的代码上做（注释里出现关键字不算数）。
 *
 * 运行：npx vitest run tools/redeem-hardening.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 剥离 SQL 的 -- 行注释与 /* 块注释（保留换行，行号不变） */
function stripSqlComments(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '-' && c2 === '-') {
      // 行注释
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = ' '; i++ }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    i++
  }
  return out.join('')
}

const MIGRATION = readFileSync(join(ROOT, 'db/migrations/0048-redeem-code-hardening.sql'), 'utf8')
const TOOL = readFileSync(join(ROOT, 'tools/gen-redeem-codes.mjs'), 'utf8')

/** 从迁移里抠出 redeem_by_code 函数体（CREATE OR REPLACE ... AS $fn$ ... $fn$ 之间） */
function extractFnBody(): string {
  const m = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.redeem_by_code\(p_code text\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$;/)
  if (!m) throw new Error('未在迁移中找到 redeem_by_code 函数体')
  return stripSqlComments(m[1])
}

describe('0048 哈希存储：核销按 code_hash 匹配，不存明文', () => {
  const body = extractFnBody()

  it('函数体用 digest 算 hash 匹配，不再按 code 明文等值', () => {
    // 匹配「实际使用」：v_hash := encode(digest(...)) 再 WHERE code_hash = v_hash
    expect(body).toMatch(/v_hash\s*:=\s*encode\s*\(\s*digest/)
    expect(body).toMatch(/WHERE\s+code_hash\s*=\s*v_hash/)
    // 且不再出现 WHERE code =（旧明文匹配路径）
    expect(body).not.toMatch(/WHERE\s+code\s*=\s*v_norm/)
  })

  it('迁移回填 hash 后清空 code 明文列', () => {
    const noComment = stripSqlComments(MIGRATION)
    expect(noComment).toMatch(/UPDATE\s+public\.redeem_codes\s+SET\s+code\s*=\s*NULL/)
    expect(noComment).toMatch(/SET\s+code_hash\s*=\s*encode\s*\(\s*digest\s*\(\s*code\s*,/)
  })

  it('发码工具 INSERT code_hash 而非明文 code 列', () => {
    // INSERT INTO public.redeem_codes (code_hash, ...) —— 列清单首列是 code_hash
    expect(TOOL).toMatch(/INSERT INTO public\.redeem_codes \(code_hash, plan, months, note, expires_at\)/)
    // 行值里用 encode(digest(:'cN', 'sha256'), 'hex') 现算 hash（N 是模板变量）
    expect(TOOL).toMatch(/encode\(digest\(:'c\$\{i\}', 'sha256'\), 'hex'\)/)
  })
})

describe('0048 有效期：过期码返回 bad 且不烧码', () => {
  const body = extractFnBody()

  it('函数体检查 expires_at 过期后返回 bad（在标记 used 之前）', () => {
    expect(body).toMatch(/v_row\.expires_at\s+IS NOT NULL\s+AND\s+v_row\.expires_at\s*<=\s*now\(\)/)
    expect(body).toMatch(/RETURN 'bad'/)
  })

  it('过期判定位于 UPDATE 标记 used 之前（不烧码）', () => {
    const expiresIdx = body.indexOf('expires_at <= now()')
    const markUsedIdx = body.indexOf('UPDATE redeem_codes')
    expect(expiresIdx).toBeGreaterThanOrEqual(0)
    expect(markUsedIdx).toBeGreaterThan(expiresIdx)
  })
})

describe('0048 节流：redeem_throttled 存在且被核销调用', () => {
  it('迁移定义 redeem_throttled（60s 失败≥5 次拒）', () => {
    const noComment = stripSqlComments(MIGRATION)
    expect(noComment).toMatch(/CREATE OR REPLACE FUNCTION public\.redeem_throttled/)
    expect(noComment).toMatch(/v_fail\s*>=\s*5/)
    expect(noComment).toMatch(/interval '60 seconds'/)
  })

  it('核销函数体实际调用 redeem_throttled（非仅注释提及）', () => {
    const body = extractFnBody()
    expect(body).toMatch(/redeem_throttled\s*\(\s*v_uid\s*\)/)
  })
})

describe('0048 对外契约：返回值仍只有 ok/used/bad', () => {
  it('核销函数只 return ok/used/bad，无新返回值', () => {
    const body = extractFnBody()
    const returns = body.match(/RETURN\s+'([a-z]+)'/g) || []
    for (const r of returns) {
      const val = r.match(/'([a-z]+)'/)![1]
      expect(['ok', 'used', 'bad']).toContain(val)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 护栏 21b · 发码工具「明文不丢失」三处锁（2026-11-10 事故后新增）
// ───────────────────────────────────────────────────────────────────
// 事故：psql 默认对齐输出把标记行写成 " GENCODES_OK:pro:1"（行首有空格），
//   而计数正则锚定 /^INSERTED:/ → 恒 0 → 工具判「发码失败」直接 return；
//   但 INSERT 其实已成功。又因当时是「先写库、后落盘明文」，
//   码文件从未写出 → 明文永久丢失 → 库里留下只有哈希的孤儿死码行。
// 三处锁：① 顺序（明文先落盘）② psql -tA（裸值输出）③ 计数正则容忍行首空白。
// ═══════════════════════════════════════════════════════════════════════
describe('发码工具：明文先落盘，再写库（顺序不可反）', () => {
  /** 在工具源码里定位某个必需片段；找不到就抛错（防止 indexOf(-1) 造成假绿） */
  function locate(label: string, needle: string | RegExp): number {
    const idx = typeof needle === 'string' ? TOOL.indexOf(needle) : TOOL.search(needle)
    if (idx < 0) throw new Error(`未在 tools/gen-redeem-codes.mjs 中找到「${label}」`)
    return idx
  }

  it('writeFileSync(outFile) 出现在 spawnSync(dbee-ssh.py) 之前', () => {
    const writeIdx = locate('明文落盘', /writeFileSync\(outFile,\s*header \+ codes\.join/)
    const spawnIdx = locate('写库调用', /spawnSync\('python',\s*\['deploy\/dbee-ssh\.py',\s*'run'/)
    expect(spawnIdx).toBeGreaterThan(writeIdx)
  })

  it('发码失败分支明确告知「明文已安全落盘」并给出孤儿清理 SQL', () => {
    // 失败路径必须给运维两条信息：明文没丢 + 怎么查/清可能产生的孤儿哈希行。
    // 缺任一条，下一个人就会在不知情的情况下重跑，二次制造孤儿。
    const failIdx = locate('失败分支', '✗ 发码失败')
    const tail = TOOL.slice(failIdx, failIdx + 1200)
    expect(tail).toMatch(/明文已安全落盘[\s\S]*DELETE FROM redeem_codes WHERE note =/)
  })
})

describe('发码工具：psql 输出用 -tA 裸值，计数正则容忍行首空白', () => {
  it('发码用的 psql 命令带 -tA（tuples-only + unaligned）', () => {
    // 匹配「实际使用」的那条命令（-f ${sqlPath} 结尾的那条），不是注释里提到的 -tA
    expect(TOOL).toMatch(/psql -d \$\{db\} -tA -v ON_ERROR_STOP=1[\s\S]{0,80}-f \$\{sqlPath\}/)
  })

  it('SQL 的 RETURNING 标记是 GENCODES_OK（唯一、不与报错文本撞车）', () => {
    expect(TOOL).toMatch(/RETURNING 'GENCODES_OK:' \|\| plan/)
  })

  it('计数正则锚定 ^\\s*GENCODES_OK:（容忍行首空白，防对齐模式回归误判）', () => {
    // 关键在 \s*：一旦有人把 -tA 去掉，对齐输出的前导空格仍能被数到，不会再静默判 0
    expect(TOOL).toMatch(/const inserted = \(stdout\.match\(\/\^\\s\*GENCODES_OK:\/gm\)/)
  })
})
