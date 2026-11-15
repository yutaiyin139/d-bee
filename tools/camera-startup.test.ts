/**
 * 相机首次启动性能护栏（2026-11-15 新建）。
 *
 * 起因：用户反馈 iOS 首次点「拍一张这一餐的照片」到相机出现明显偏慢。
 * 根因（读 @capacitor/camera 8.2.6 的 iOS 源码确认，非猜测）：
 *   showCamera() 每次都先 AVCaptureDevice.requestAccess，首次弹系统授权框；
 *   授权后才 presentCameraPicker() 冷启动 UIImagePickerController。
 *   项目在点击后又串了一次 get_photo_quota 网络预检，且整个等待期 UI 零反馈。
 *
 * 本护栏锁住「把可消除的等待移出点击路径」这组优化不被退化：
 *   1. 原生插件预热：只查权限、绝不提前弹授权框，法务触发时机保持「点击拍照时」；
 *   2. 额度预检提前到录入层挂载时，缓存只在「明确有额度」时跳过网络，不用于拦截；
 *   3. 识别成功后用服务端原子占用返回的权威剩余额度刷新缓存；
 *   4. 开相机期间防连点 + 即时反馈（iOS 连点会重复 present 相机控制器）；
 *   5. Web 分支行为与原生画质参数零改动（本轮不碰识别画质）。
 *
 * 断言一律在 stripComments 后的代码上做：源码注释里会写「不要怎么做」的历史说明，
 * 带注释扫描会永远误报红，而一个永远红的测试等于没有测试。
 *
 * 运行：npx vitest run tools/camera-startup.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

type Lex = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

/** 注释字符替换成等长空格，保留换行与行号；字符串内容原样保留。 */
function stripComments(src: string): string {
  const out = src.split('')
  let s: Lex = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    switch (s) {
      case 'code':
        if (c === '/' && c2 === '/') {
          s = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c === '/' && c2 === '*') {
          s = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue
        }
        if (c === "'") { s = 'sq'; i++; continue }
        if (c === '"') { s = 'dq'; i++; continue }
        if (c === '`') { s = 'tpl'; i++; continue }
        i++; continue
      case 'line':
        if (c === '\n') { s = 'code'; i++; continue }
        out[i] = ' '; i++; continue
      case 'block':
        if (c === '*' && c2 === '/') {
          out[i] = ' '; out[i + 1] = ' '; s = 'code'; i += 2; continue
        }
        if (c !== '\n') out[i] = ' '
        i++; continue
      case 'sq':
        if (c === '\\') { i += 2; continue }
        if (c === "'") s = 'code'
        i++; continue
      case 'dq':
        if (c === '\\') { i += 2; continue }
        if (c === '"') s = 'code'
        i++; continue
      case 'tpl':
        if (c === '\\') { i += 2; continue }
        if (c === '`') s = 'code'
        i++; continue
    }
  }
  return out.join('')
}

const CAPTURE = stripComments(read('src/lib/capture.ts'))
const LOG = stripComments(read('src/pages/LogSheet.tsx'))

/** 按声明行缩进截取函数体到顶层的闭合花括号，避免嵌套块的缩进取错。 */
function bodyOf(code: string, header: RegExp): string {
  const i = code.search(header)
  if (i < 0) return ''
  const lineStart = code.lastIndexOf('\n', i) + 1
  const indent = code.slice(lineStart, i).match(/^\s*/)?.[0] ?? ''
  const close = '\n' + indent + '}'
  const j = code.indexOf(close, i)
  return j < 0 ? code.slice(i) : code.slice(i, j + close.length)
}

const PRIME = bodyOf(CAPTURE, /export\s+async\s+function\s+primeCamera\s*\(/)
const QUOTA_CHECK = bodyOf(LOG, /async\s+function\s+checkPhotoQuota\s*\(/)
const PICK = bodyOf(LOG, /async\s+function\s+handlePickMealPhoto\s*\(/)
const HANDLE_FILE = bodyOf(LOG, /async\s+function\s+handleFile\s*\(/)

describe('护栏 28 · iOS 相机首次启动提速', () => {
  it('capture.ts 导出 primeCamera()', () => {
    expect(/export\s+async\s+function\s+primeCamera\s*\(/.test(CAPTURE)).toBe(true)
  })

  it('primeCamera 在 isNative() 处短路，Web 端零操作', () => {
    expect(/if\s*\(!\s*isNative\(\)\s*\)\s*return/.test(PRIME)).toBe(true)
  })

  it('primeCamera 实际调用 checkPermissions() 完成插件初始化', () => {
    expect(/checkPermissions\s*\(\s*\)/.test(PRIME)).toBe(true)
  })

  it('primeCamera 绝不调用 requestPermissions（授权框仍由用户点击触发）', () => {
    expect(PRIME.includes('requestPermissions')).toBe(false)
  })

  it('primeCamera 对权限查询异常静默降级', () => {
    expect(/try\s*\{[\s\S]*catch\s*[\{(]/.test(PRIME)).toBe(true)
  })

  it('LogSheet 从 capture 模块引入 primeCamera', () => {
    expect(/import\s*\{\s*[^}]*primeCamera[^}]*\}\s*from\s*'\.\.\/lib\/capture'/.test(LOG)).toBe(true)
  })

  it('LogSheet 在录入层挂载时预热原生相机插件', () => {
    expect(/void\s+primeCamera\s*\(\s*\)/.test(LOG)).toBe(true)
  })

  it('LogSheet 在录入层挂载时预取拍照额度', () => {
    expect(/void\s+getPhotoQuota\s*\(\s*\)/.test(LOG)).toBe(true)
  })

  it('checkPhotoQuota 只在缓存明确有额度时跳过网络预检', () => {
    expect(/cached\.remaining\s*>\s*0[\s\S]{0,160}return\s+true/.test(QUOTA_CHECK)).toBe(true)
  })

  it('额度缓存带 TTL，过期缓存不会长期放行', () => {
    expect(/Date\.now\(\)\s*-\s*cached\.at\s*<\s*QUOTA_CACHE_TTL_MS/.test(QUOTA_CHECK)).toBe(true)
  })

  it('识别成功后用服务端权威剩余额度刷新缓存', () => {
    expect(/quotaCacheRef\.current\s*=\s*[\s\S]{0,120}guard\.remaining/.test(HANDLE_FILE)).toBe(true)
  })

  it('拍照入口有 openingCamera 防连点', () => {
    expect(/if\s*\(\s*openingCamera\s*\)\s*return/.test(PICK)).toBe(true)
  })

  it('拍照按钮在开相机期间被禁用', () => {
    expect(/disabled=\{openingCamera\}/.test(LOG)).toBe(true)
  })

  it('开相机期间给用户即时反馈', () => {
    expect(/openingCamera\s*&&[\s\S]{0,320}正在打开相机/.test(LOG)).toBe(true)
  })

  it('Web 端 pickWithInput 兜底分支保持不变', () => {
    expect(/return\s+pickWithInput\(opts\)/.test(CAPTURE)).toBe(true)
  })

  it('原生 getPhoto 画质参数不变（dataUrl + quality 92，不擅自缩图）', () => {
    expect(/resultType:\s*'dataUrl'/.test(CAPTURE) && /quality:\s*92/.test(CAPTURE)).toBe(true)
  })
})
