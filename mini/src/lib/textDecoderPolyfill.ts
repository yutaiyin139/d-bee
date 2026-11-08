/**
 * 小程序环境 TextDecoder polyfill（2026-11-08 体验版实测补缺）。
 *
 * ## 为什么需要
 *
 * `@tencent-ai/workbuddy-cloud-sdk/miniprogram` 的 SSE 解析链是：
 *   `chat.completions.create({ stream: true })`（mini/src/lib/ai.ts:81）
 *     → `iterSSEEvents()` → `new LineDecoder()` → `new TextDecoder('utf-8')`。
 * SDK 自带 `ensureMiniProgramPolyfills()` 只装了 `Headers` 与 `ReadableStream`，
 * **没有装 TextDecoder**。微信体验版跑在纯 JSCore 里，没有这个 Web API，
 * 于是所有流式 AI 功能（记一餐 / 拍照识别 / 报告解读 / 饮食助手 / 计划）
 * 在解析第一个 SSE chunk 时就抛 `TextDecoder is not defined`。
 * 登录与数据面不走 SSE，所以不受影响。
 *
 * 真机调试时微信开发者工具会注入部分 Web API，故该缺口只在上架/体验版暴露
 * —— 这正是「真机调试通过 != 体验版通过」的典型差异，别再靠真机调试兜底。
 *
 * ## 用法
 *
 * 本模块在 `mini/src/lib/cloud.ts` 顶部被 side-effect import，加载即安装。
 * 只实现 SDK 实际用到的调用面：`decode(bytes, { stream: true })` 的跨块续接
 * 与 `decode()` / `decode(bytes, { stream: false })` 的 flush。幂等：宿主若已有
 * 原生实现（开发者工具 / 未来基础库补齐）则不覆盖。
 *
 * 🔴 不要改 node_modules 里的 SDK：升级依赖会冲掉；也不要为了绕开它把
 * `stream: true` 改成 false —— 那会丢掉「思考链路」实时渲染，且属于产品决策。
 */

/** UTF-8 解码器，接口对齐 SDK 用到的 TextDecoder 子集。 */
export class MiniTextDecoder {
  readonly encoding = 'utf-8'
  readonly fatal = false
  readonly ignoreBOM = false

  /** 上一次 decode 结尾留下的不完整多字节序列（仅 stream:true 时保留）。 */
  private pending: number[] = []

  decode(
    input?: Uint8Array | ArrayBuffer | null,
    options?: { stream?: boolean },
  ): string {
    const stream = options?.stream === true
    let bytes: number[] = []
    if (input instanceof Uint8Array) {
      bytes = Array.from(input)
    } else if (input instanceof ArrayBuffer) {
      bytes = Array.from(new Uint8Array(input))
    }

    const buf = this.pending.length > 0 ? this.pending.concat(bytes) : bytes
    this.pending = []

    let out = ''
    let i = 0
    while (i < buf.length) {
      const b0 = buf[i]
      let need = 0
      let cp = 0
      if (b0 <= 0x7f) {
        cp = b0
      } else if (b0 >= 0xc2 && b0 <= 0xdf) {
        cp = b0 & 0x1f
        need = 1
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        cp = b0 & 0x0f
        need = 2
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        cp = b0 & 0x07
        need = 3
      } else {
        // 孤立续字节 / 非法起始字节
        out += '\ufffd'
        i += 1
        continue
      }

      if (i + need >= buf.length) {
        if (stream) {
          this.pending = buf.slice(i)
          break
        }
        // flush 时序列仍不完整 → 替换字符
        out += '\ufffd'
        break
      }

      let valid = true
      for (let k = 1; k <= need; k++) {
        const bk = buf[i + k]
        if (bk < 0x80 || bk > 0xbf) {
          valid = false
          break
        }
        cp = (cp << 6) | (bk & 0x3f)
      }
      if (!valid) {
        out += '\ufffd'
        i += 1
        continue
      }

      const minCp = need === 0 ? 0 : need === 1 ? 0x80 : need === 2 ? 0x800 : 0x10000
      if (cp < minCp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        out += '\ufffd'
        i += need + 1
        continue
      }

      if (cp <= 0xffff) {
        out += String.fromCharCode(cp)
      } else {
        const v = cp - 0x10000
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
      }
      i += need + 1
    }

    return out
  }
}

/** 幂等安装：宿主已有原生 TextDecoder 时不覆盖。 */
export function ensureTextDecoder(): void {
  const g = globalThis as unknown as { TextDecoder?: unknown }
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = MiniTextDecoder
  }
}

// side-effect：模块一加载就装好，必须早于任何 SSE 请求。
ensureTextDecoder()
