/**
 * 小程序 TextDecoder polyfill 单元测试 + 「不许被误删」护栏。
 *
 * 用宿主（Node）原生 TextDecoder 作 oracle：合法 UTF-8 在任意切块下，
 * polyfill 的 stream:true 续接 + flush 语义必须与原生逐字一致。
 * 2026-11-08 微信体验版实测缺口，见 mini/src/lib/textDecoderPolyfill.ts。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MiniTextDecoder, ensureTextDecoder } from '../mini/src/lib/textDecoderPolyfill'

const ROOT = join(__dirname, '..')

interface DecoderLike {
  decode(input?: Uint8Array | null, options?: { stream?: boolean }): string
}

type DecoderCtor = new (label?: string) => DecoderLike

const NativeTextDecoder = (globalThis as unknown as { TextDecoder: DecoderCtor }).TextDecoder

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** 按 SDK 的调用面逐块解码：stream:true 累积，最后 decode() flush。 */
function chunked(Decoder: DecoderCtor, bytes: Uint8Array, size: number): string {
  const d = new Decoder('utf-8')
  let out = ''
  for (let pos = 0; pos < bytes.length; pos += size) {
    out += d.decode(bytes.subarray(pos, pos + size), { stream: true })
  }
  out += d.decode()
  return out
}

// ASCII + 中文(3字节) + emoji(4字节) + SSE 行边界，覆盖 SDK 实际会解的内容
const SAMPLE =
  '米饭 200g，蛋白质 5.2g 🍚🐝\n' +
  'data: {"choices":[{"delta":{"content":"你好，今天吃得很均衡"}}]}\n\n' +
  'data: [DONE]\n\n'

describe('MiniTextDecoder · 与原生 TextDecoder 逐字对照', () => {
  it.each([1, 2, 3, 4, 5, 7, 16, 4096])('按 %i 字节切块的流式解码一致', (size) => {
    expect(chunked(MiniTextDecoder, utf8(SAMPLE), size)).toBe(
      chunked(NativeTextDecoder, utf8(SAMPLE), size),
    )
  })

  it('整块一次解码等于原文', () => {
    expect(new MiniTextDecoder().decode(utf8(SAMPLE))).toBe(SAMPLE)
  })

  it('跨块拆开的多字节字符不丢不乱（逐字节喂，最后 flush）', () => {
    const bytes = utf8('中🐝A')
    expect(chunked(MiniTextDecoder, bytes, 1)).toBe('中🐝A')
  })

  it('flush 时未完成的多字节序列输出替换字符', () => {
    const d = new MiniTextDecoder()
    d.decode(new Uint8Array([0xe4, 0xb8]), { stream: true }) // 「中」缺最后一字节
    expect(d.decode()).toBe('\ufffd')
  })

  it('flush 结果与原生一致', () => {
    expect(new MiniTextDecoder().decode(new Uint8Array([0xe4, 0xb8]))).toBe(
      new NativeTextDecoder('utf-8').decode(new Uint8Array([0xe4, 0xb8])),
    )
  })

  it('非法起始字节按替换字符处理，且与原生一致', () => {
    const bytes = new Uint8Array([0x61, 0xff, 0x62])
    expect(new MiniTextDecoder().decode(bytes)).toBe(new NativeTextDecoder('utf-8').decode(bytes))
  })

  it('空输入返回空串', () => {
    expect(new MiniTextDecoder().decode()).toBe('')
  })
})

describe('ensureTextDecoder() 幂等性', () => {
  it('宿主已有原生实现时不覆盖', () => {
    const g = globalThis as unknown as { TextDecoder?: unknown }
    const before = g.TextDecoder
    ensureTextDecoder()
    expect(g.TextDecoder).toBe(before)
  })
})

/** 去注释，避免护栏被注释里的同名字符串骗过（护栏断言三条铁律）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('🔴 护栏：mini/cloud.ts 必须在创建 SDK 客户端前装载 polyfill', () => {
  const code = stripComments(readFileSync(join(ROOT, 'mini/src/lib/cloud.ts'), 'utf8'))

  it('必须从 ./textDecoderPolyfill 导入 ensureTextDecoder', () => {
    expect(code).toMatch(
      /import\s*\{[^}]*ensureTextDecoder[^}]*\}\s*from\s*['"]\.\/textDecoderPolyfill['"]/,
    )
  })

  it('必须在模块顶层实际调用 ensureTextDecoder()', () => {
    expect(code.indexOf('ensureTextDecoder()')).toBeGreaterThan(-1)
  })

  it('ensureTextDecoder() 必须早于 createMiniProgramWorkBuddyCloud(', () => {
    const install = code.indexOf('ensureTextDecoder()')
    const create = code.indexOf('createMiniProgramWorkBuddyCloud(')
    expect(install >= 0 && install < create).toBe(true)
  })
})
