/**
 * 原生分享通道 + 邀请链接护栏（2026-11-12 新建，护栏 19）。
 *
 * ## 防的是什么
 *
 * 2026-11-12 用户实测：iOS 连续打卡后点「分享我的自律」→ 分享给微信拉不起微信；
 * 分享给钉钉能拉起，但分享出去的「链接」在钉钉里打不开。根因有两层：
 *
 *  1. `src/lib/share.ts` 曾把 PNG 的 base64 塞进 Capacitor Share 的 `url` 参数。
 *     `url` 的语义是「一条链接」：iOS SharePlugin.swift 用 URL(string:) 转成 NSURL
 *     塞进 UIActivityViewController（微信不认 data: scheme → 拉不起），
 *     Android SharePlugin.java 更直接对非 file/http 的 url 抛 "Unsupported url"。
 *     正确通道是 Filesystem 写 Cache 文件 + `Share.share({ files: [fileUri] })`。
 *  2. `InviteCenter.tsx` 曾直接用 `location.origin` 拼邀请链接。原生壳里它是
 *     `capacitor://localhost` / `https://localhost`，印在卡片上或复制进口令后
 *     发到微信/钉钉，好友点开必然打不开。统一走 `lib/shareLink.ts` 的公网站点。
 *
 * 这两条一旦被「顺手」改回去，症状是「分享按钮看起来点了、对方却什么也收不到」，
 * 极难靠人工回归发现（必须在真机 + 目标 App 里验），故落成机器护栏。
 *
 * 🔴 与 four-end-consistency.test.ts 同款约束：剥离注释后再扫描、一个 it() 一条断言、
 *    匹配「实际使用」而非「标识符出现」。内置反例 fixture 做红验证，确保护栏不会恒真。
 *
 * 运行：npx vitest run tools/share-consistency.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildInviteLink, publicSiteOrigin, PUBLIC_SITE_ORIGIN } from '../src/lib/shareLink'
import { sanitizeShareFilename } from '../src/lib/share'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

/** 剥离块注释与行注释；`https://` 中的 // 前是冒号，不会被误删 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;])\/\/[^\n]*/g, '$1')
}

/** 抓出所有 capShare.share({...}) 调用的参数体（匹配实际调用，不是标识符出现） */
function shareOptionBodies(code: string): string[] {
  const out: string[] = []
  const re = /capShare\.share\(\{([\s\S]*?)\}\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.push(m[1])
  return out
}

/** 合规判定：每一处原生分享调用都必须用 files，且不得用 url */
function nativeShareUsesFiles(code: string): boolean {
  const bodies = shareOptionBodies(stripComments(code))
  return bodies.length > 0 && bodies.every((b) => b.includes('files:') && !/\burl\s*:/.test(b))
}

const SHARE_SRC = read('src/lib/share.ts')
const INVITE_SRC = read('src/pages/InviteCenter.tsx')
const CAP_CONFIG = read('capacitor.config.ts')
const PKG = read('package.json')

/** 红验证反例：把图片 base64 塞回 url 的旧实现 */
const BAD_FIXTURE = `
async function badShare(blob, base64) {
  await capShare.share({
    title: '自律蜜蜂',
    text: '一起变自律吧',
    url: 'data:image/png;base64,' + base64,
    dialogTitle: '分享到',
  })
}
`

describe('原生图片/文件分享通道（护栏 19）', () => {
  it('所有 capShare.share 调用都用 files 而非 url', () => {
    expect(nativeShareUsesFiles(SHARE_SRC)).toBe(true)
  })

  it('红验证：把 base64 塞进 url 的旧实现会被判定为不合规', () => {
    expect(nativeShareUsesFiles(BAD_FIXTURE)).toBe(false)
  })

  it('剥离注释后的源码不含 data:image/png;base64 字面量', () => {
    expect(stripComments(SHARE_SRC)).not.toContain('data:image/png;base64')
  })

  it('至少有两处原生分享调用（exportFile 与 shareImage）', () => {
    expect(shareOptionBodies(stripComments(SHARE_SRC)).length).toBeGreaterThanOrEqual(2)
  })

  it('分享文件写入 Cache 目录', () => {
    expect(stripComments(SHARE_SRC)).toContain('directory: CAP_CACHE_DIR')
  })

  it('通过 getUri 解析出 file:// URI 再交给分享面板', () => {
    expect(stripComments(SHARE_SRC)).toContain('fs.getUri(')
  })

  it('package.json 声明 @capacitor/filesystem 依赖', () => {
    expect(PKG).toContain('"@capacitor/filesystem"')
  })

  it('Android 插件白名单纳入 @capacitor/filesystem', () => {
    const line = CAP_CONFIG.split('\n').find((l) => l.trim().startsWith('includePlugins:') && l.includes('@capgo/capacitor-wechat'))
    expect(line).toContain('@capacitor/filesystem')
  })

  it('iOS 插件白名单纳入 @capacitor/filesystem', () => {
    const lines = CAP_CONFIG.split('\n').filter((l) => l.trim().startsWith('includePlugins:'))
    const iosLine = lines.find((l) => !l.includes('@capgo/capacitor-wechat'))
    expect(iosLine).toContain('@capacitor/filesystem')
  })
})

describe('对外邀请链接（护栏 19）', () => {
  it('iOS 原生壳 origin 回落到公网站点', () => {
    expect(buildInviteLink('ABC123', 'capacitor://localhost')).toBe('https://d-bee.cn/?invite=ABC123')
  })

  it('Android 原生壳 origin 回落到公网站点', () => {
    expect(buildInviteLink('ABC123', 'https://localhost')).toBe('https://d-bee.cn/?invite=ABC123')
  })

  it('Web 线上 origin 生成同域链接', () => {
    expect(buildInviteLink('ABC123', 'https://d-bee.cn')).toBe('https://d-bee.cn/?invite=ABC123')
  })

  it('本地开发 origin 不外泄到分享内容', () => {
    expect(buildInviteLink('ABC123', 'http://127.0.0.1:5173')).toBe('https://d-bee.cn/?invite=ABC123')
  })

  it('邀请码中的特殊字符被编码', () => {
    expect(buildInviteLink('A B/1', 'https://d-bee.cn')).toBe('https://d-bee.cn/?invite=A%20B%2F1')
  })

  it('空 origin 回落到公网站点', () => {
    expect(publicSiteOrigin('')).toBe(PUBLIC_SITE_ORIGIN)
  })

  it('非 http(s) scheme 回落到公网站点', () => {
    expect(publicSiteOrigin('file:///var/mobile')).toBe(PUBLIC_SITE_ORIGIN)
  })

  it('InviteCenter 不再直接用 location.origin 拼邀请链接', () => {
    expect(stripComments(INVITE_SRC)).not.toContain('${location.origin}?invite=')
  })

  it('InviteCenter 统一调用 buildInviteLink', () => {
    expect(stripComments(INVITE_SRC)).toContain('buildInviteLink(code)')
  })
})

describe('分享文件名安全（护栏 19）', () => {
  it('路径穿越字符被清理', () => {
    expect(sanitizeShareFilename('../../evil.png')).toBe('_.._evil.png')
  })

  it('纯点号文件名回落到安全默认值', () => {
    expect(sanitizeShareFilename('...')).toBe('share.png')
  })
})
