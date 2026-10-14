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

import { isNative } from './platform'

export interface TakePhotoOptions {
  /** 是否优先唤起相机（原生端映射为 CameraSource.Camera）；Web 端即 capture 属性 */
  preferCamera?: boolean
  /** 是否允许多选（仅 Web 端生效，原生端后续单独实现） */
  multiple?: boolean
}

/**
 * 以编程方式唤起系统相机/相册，返回用户选中的文件。
 *
 * 返回 null 表示用户取消（原生端会走这个分支；Web 端 <input> 取消时不一定触发回调，
 * 所以 Web 场景仍推荐用 pickPhotoInput() 的受控方式）。
 */
export async function takePhoto(opts: TakePhotoOptions = {}): Promise<File | null> {
  if (isNative()) {
    // ── 原生分支占位 ──────────────────────────────────────────────
    // 接入 @capacitor/camera 后在此实现：
    //   const photo = await Camera.getPhoto({
    //     quality: 82, resultType: CameraResultType.Uri, source: CameraSource.Camera,
    //   })
    //   再把 webPath 读成 File 返回（保证下游签名不变）。
    // 阶段 0 不改行为：原生环境尚未接入，直接落回 Web 实现。
    // ──────────────────────────────────────────────────────────────
  }
  return pickWithInput(opts)
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
