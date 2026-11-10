/**
 * 护栏 23 · 已吊销兑换码不得出现在任何被 git 跟踪的文件里（2026-11-10 新增）。
 *
 * ─── 为什么需要这条护栏（真实事故，不是假想）────────────────────────────
 *   2026-11-10 实测发现：3 张 **终身** 兑换码在 0012 时代被硬编码进前端
 *   （`src/lib/entitlement.ts` + `src/pages/PaywallSheet.tsx`），10-16 已从前端移除
 *   （commit `43e966a` / `2a87d80`），当时被判定为「已修复」。
 *
 *   🔴 但「删文件 ≠ 删历史」：本仓库 `github.com/yutaiyin139/d-bee` 实测是
 *   **public**（GitHub API `private: false`），任何人都能免费拉取历史 commit 拿到明文：
 *     curl https://raw.githubusercontent.com/yutaiyin139/d-bee/f99a2c5/src/lib/entitlement.ts
 *   → HTTP 200，正文含三张码。而线上库实测 `unused=3 used=0`（三张全未使用）
 *   → 等于「公开赠送终身会员」，任何人可白拿。
 *
 *   当天已按用户授权 DELETE 止损（线上实测 `total=0 unused=0 used=0`）。
 *   本护栏防止同类事故重演：**任何被跟踪文件里再出现这三张码（或其同形新码）即红**。
 *
 * ─── 🔴 本文件刻意不含码明文（否则护栏自己就成了泄露源）──────────────────
 *   吊销码只以 **SHA-256 哈希** 形式钉在这里。扫描时对每个候选 token 现算哈希再比对，
 *   所以「命中」这个判定不需要、也不会把明文写进仓库任何地方。
 *   明文留证副本在 `release/REVOKED-legacy-hardcoded-codes-20261110.txt`
 *   （`release/` 已被 .gitignore:84 忽略）。
 *
 * ─── 断言纪律（项目铁律）──────────────────────────────────────────────
 *   · 一个 it() 只一条逻辑断言；
 *   · 扫的是 **git 实际跟踪的文件**（`git ls-files`），不是「磁盘上有什么」——
 *     未跟踪/gitignored 的文件不会进公开仓库，不在本护栏职责内；
 *   · 新增护栏必须红验证（本文件已做：临时把吊销码写入一个 `-N` 标记文件 → 红；
 *     删除后 → 绿）。
 *
 * 运行：npx vitest run tools/revoked-codes-not-tracked.test.ts
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 2026-11-10 已吊销的 3 张泄露终身码 —— 只存哈希，不存明文。
 * 哈希由 `db/backups/full-export/redeem_codes.json`（gitignored 本地副本）现算得出。
 */
const REVOKED_CODE_HASHES = new Set<string>([
  // id=1（13 字符，含连字符）
  '0b563f858b528c0d002d8e2bdac7c9be3a21fb8b5ddc40e5ae087f89f1cf4837',
  // id=2（10 字符，含连字符）
  'f187e63133856b32c605b15a55480fd4ddadf9380a639931c2bdb0ae52c5a129',
  // id=3（7 字符，无连字符）
  'fbece63c305c882762a8b254ad645f96291a25faeb781a73a4908fd1074266e0',
])

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** 列出 git 跟踪的文件（`-z` NUL 分隔，兼容含空格/中文路径）。仓库无文件时返回空数组。 */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(Boolean)
}

/**
 * 码形状候选 token：大写字母/数字开头，长度 ≥7，允许内部连字符与下划线。
 * 三张吊销码的形态：7 字符无连字符 / 10 字符含 1 个连字符 / 13 字符含 2 个连字符
 * （🔴 刻意不写出码本身 —— 本文件是被 git 跟踪的，写明文就等于护栏自己再泄露一次；
 *   实测踩过：初版注释里顺手抄了三个码，被本护栏自己判红）。
 * 宽松取词是有意的：误取无害（只是多算几次哈希），漏取才是真风险。
 */
const TOKEN_RE = /[A-Z0-9][A-Z0-9_-]{6,}/g

/** 单文件最大读取字节数，防超大二进制/产物拖垮测试（跟踪文件里没有合法的大二进制码文件） */
const MAX_BYTES = 8 * 1024 * 1024

/** 明显不是文本的扩展名，直接跳过（避免二进制里偶然字节命中） */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.apk', '.aab', '.ipa',
  '.bundle', '.zip', '.gz', '.tar', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3',
  '.wav', '.pdf', '.jar', '.keystore', '.jks', '.p8', '.p12', '.pem', '.bin', '.dat',
  '.node', '.wasm', '.so', '.dll', '.exe', '.map',
])

interface Leak { file: string; token: string }

/** 扫描全部被跟踪文件，返回命中的吊销码（token 以掩码形式返回，绝不回显完整明文） */
function scanForRevokedCodes(): Leak[] {
  const leaks: Leak[] = []
  for (const rel of trackedFiles()) {
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    const abs = join(ROOT, rel)
    let st
    try { st = statSync(abs) } catch { continue }   // 已删除但仍在 index 里（-N / 暂存删除）
    if (!st.isFile() || st.size > MAX_BYTES) continue
    let text: string
    try { text = readFileSync(abs, 'utf8') } catch { continue }
    if (text.includes('\u0000')) continue          // 含 NUL = 当二进制处理，跳过
    for (const tok of text.match(TOKEN_RE) ?? []) {
      // 原样与 upper() 归一两种形态都比对：RPC 用 upper() 归一，
      // 而仓库里可能以任意大小写书写 —— 只要用户能拿去兑换成功就算泄露。
      if (REVOKED_CODE_HASHES.has(sha256(tok)) || REVOKED_CODE_HASHES.has(sha256(tok.toUpperCase()))) {
        leaks.push({ file: rel, token: `${tok.slice(0, 4)}…${tok.slice(-2)}(len${tok.length})` })
      }
    }
  }
  return leaks
}

describe('🔴 护栏 23 · 已吊销的泄露兑换码不得出现在被跟踪文件里（public 仓库 = 全世界可读）', () => {
  it('钉住的吊销码哈希集合本身是自洽的（3 张，无重复，均为 64 位十六进制）', () => {
    expect(REVOKED_CODE_HASHES.size).toBe(3)
    for (const h of REVOKED_CODE_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('仓库确实有被跟踪文件（防止 git 不可用时扫到空集合 = 假绿）', () => {
    expect(trackedFiles().length).toBeGreaterThan(100)
  })

  it('全部被跟踪文件中不含任何已吊销的泄露兑换码', () => {
    const leaks = scanForRevokedCodes()
    // 命中即列出「文件 + 掩码 token」，方便定位但不二次泄露明文
    expect(leaks, `发现已吊销码仍被跟踪：${JSON.stringify(leaks, null, 2)}`).toEqual([])
  })
})
