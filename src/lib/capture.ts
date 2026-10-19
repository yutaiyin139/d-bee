/**
 * 拍照 / 选图抽象。
 *
 * 现状（Web）：页面里用 `<input type="file" accept="image/*" capture="environment">`，
 * 移动端浏览器会拉起相机或相册。这套行为在 Web 上工作正常，阶段 0 必须**保持不变**。
 *
 * 未来（原生）：WebView 的 `<input capture>` 在 iOS 上体验不稳定（无法控制压缩、
 * 可能一次性把 4800 万像素原图读进内存导致 OOM），届时改为调用 @capacitor/camera，
 * 由原生侧完成压缩后返回 Uri/Base64。
 *
 * 本模块把「选图」这一步统一成 takePhoto()，业务代码拿到的始终是一个 File，
 * 因此原生分支接入后，下游的 compressImage / AI 识别逻辑完全不用改。
 */

import { isNative, isWechatMiniProgram } from './platform'

export interface TakePhotoOptions {
  /** 是否优先唤起相机（原生端映射为 CameraSource.Camera）；Web 端即 capture 属性 */
  preferCamera?: boolean
  /** 是否允许多选（仅 Web 端生效，原生端后续单独实现） */
  multiple?: boolean
}

/**
 * 以编程方式唤起系统相机/相册，返回用户选中的文件。
 *
 * - 原生（iOS/Android）：走 @capacitor/camera 的原生相机，绕开 WebView 对
 *   `<input capture>` 的厂商兼容差异（华为 EMUI/HarmonyOS 会忽略 capture 属性）。
 * - Web：临时创建隐藏 input，程序化点击（与改造前行为一致）。
 *
 * 返回 null 表示用户取消或相机不可用；业务代码拿到的始终是 File。
 */
export async function takePhoto(opts: TakePhotoOptions = {}): Promise<File | null> {
  if (isNative()) {
    const camera = getCameraPlugin()
    if (camera) {
      try {
        const photo = await camera.getPhoto({
          resultType: 'DataUrl',
          source: 'CAMERA',
          quality: 82,
          correctOrientation: true,
        })
        const dataUrl = photo.dataUrl
        if (!dataUrl) return null
        const resp = await fetch(dataUrl)
        const blob = await resp.blob()
        return new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })
      } catch {
        // 用户取消（Camera 抛 'User cancelled photos app'）或相机不可用 → 返回 null
        return null
      }
    }
    // 插件未注入（旧包 / 未同步）：落回 Web input 实现，保证不白屏
  }

  // 微信小程序：无 DOM，走 wx.chooseImage（规划中接入）。当前返回 null，
  // 不影响现有三端（小程序环境本就不会命中原生/Web 分支）。
  if (isWechatMiniProgram()) {
    return null
  }

  return pickWithInput(opts)
}

/** @capacitor/camera 插件的最小接口（鸭子类型探测，不 import 包，Web 零新增依赖） */
interface CameraPluginLike {
  getPhoto: (options: {
    resultType?: 'Uri' | 'Base64' | 'DataUrl'
    source?: 'PROMPT' | 'CAMERA' | 'PHOTOS'
    quality?: number
    correctOrientation?: boolean
  }) => Promise<{ dataUrl?: string; base64String?: string; path?: string; webPath?: string }>
}

function getCameraPlugin(): CameraPluginLike | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.Camera
  if (!p || typeof p !== 'object') return null
  const c = p as Partial<CameraPluginLike>
  if (typeof c.getPhoto !== 'function') return null
  return c as CameraPluginLike
}

/** Web 端实现：临时创建一个隐藏 input，程序化点击 */
function pickWithInput(opts: TakePhotoOptions): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (opts.preferCamera !== false) input.setAttribute('capture', 'environment')
    if (opts.multiple) input.multiple = true
    input.style.display = 'none'

    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      window.removeEventListener('focus', onFocus, true)
      resolve(file)
    }
    // 用户取消时不会触发 change，靠窗口重新获得焦点来兜底
    const onFocus = () => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null)
      }, 400)
    }

    input.addEventListener('change', () => {
      const f = input.files?.[0] ?? null
      finish(f)
    })

    document.body.appendChild(input)
    input.click()
    window.addEventListener('focus', onFocus, true)
  })
}

/**
 * 从 input 的 change 事件里安全取出文件。
 *
 * 典型的受控用法（推荐，与改造前的行为完全一致）：
 *   <input type="file" accept="image/*" capture="environment"
 *          onChange={(e) => { const f = pickFileFromInput(e); if (f) void handleFile(f) }} />
 *
 * 之所以要做成函数而不是让每个页面各写一遍：改造前三个 input 都重复了
 * 「取 files[0] → 清空 value」这两步，清空 value 是为了让用户连续选同一张图时
 * 仍能触发 change，漏掉会导致「第二次选同一张图没反应」。
 */
export function pickFileFromInput(
  e: { currentTarget: HTMLInputElement; target: EventTarget | null },
): File | null {
  const input = (e.currentTarget ?? e.target) as HTMLInputElement | null
  if (!input) return null
  const file = input.files?.[0] ?? null
  // 必须重置，否则同一文件二次选择不触发 change
  input.value = ''
  return file
}

/** 供 JSX 复用的 input 属性集合，避免各页面各写一份魔术字符串 */
export const PHOTO_INPUT_PROPS = {
  type: 'file',
  accept: 'image/*',
  capture: 'environment',
  style: { display: 'none' },
} as const
