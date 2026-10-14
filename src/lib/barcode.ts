/**
 * 条码解码。
 *
 * 两段式策略：
 * 1. 优先用浏览器原生 BarcodeDetector（Android Chrome 自带，零依赖、省电、逐帧快）；
 * 2. 不支持时（如 iOS Safari）动态加载 zxing-wasm 兜底。wasm 由本包自带并通过
 *    `locateFile` 指向本地资源，不依赖任何 CDN，保证国内网络可用。
 *
 * 解码器体积接近 1MB，因此所有 zxing 相关代码都走动态 import，只有真正用到扫码的
 * 用户才会下载，不影响主包体积。
 */

import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

/** 零售商品常见码制 */
const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar']
const ZXING_FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code-128', 'Code-39', 'ITF', 'Codabar']

interface DetectedBarcodeLike {
  rawValue: string
  format: string
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcodeLike[]>
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike

function getDetectorCtor(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  return typeof w.BarcodeDetector === 'function' ? w.BarcodeDetector : null
}

/** 是否原生支持（仅用于给用户提示，不决定功能可用性） */
export function hasNativeDetector(): boolean {
  return getDetectorCtor() !== null
}

/** 把解码结果规整成商品条码；非零售码（二维码等）返回 null */
export function normalizeCode(text: string): string | null {
  const digits = text.replace(/\D/g, '')
  // EAN-8 / UPC-E 到 EAN-13 / UPC-A 的常见长度
  if (digits.length >= 8 && digits.length <= 14) return digits
  return null
}

/* ────────────────────────── zxing 兜底 ────────────────────────── */

type ZxingReader = Awaited<typeof import('zxing-wasm/reader')>
let zxingPromise: Promise<ZxingReader> | null = null

async function loadZxing(): Promise<ZxingReader> {
  if (!zxingPromise) {
    zxingPromise = (async () => {
      const mod = await import('zxing-wasm/reader')
      await mod.prepareZXingModule({
        overrides: {
          // 默认会去 jsDelivr 取 wasm，这里改成打包进 dist 的本地文件
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? zxingWasmUrl : prefix + path,
        },
        fireImmediately: true,
      })
      return mod
    })().catch((e) => {
      zxingPromise = null
      throw e
    })
  }
  return zxingPromise
}

/** 预热解码器：进入扫码界面时调用，减少首次识别等待 */
export async function warmUpDecoder(): Promise<void> {
  if (hasNativeDetector()) return
  await loadZxing()
}

async function decodeWithZxing(input: ImageData | Blob): Promise<string | null> {
  const { readBarcodes } = await loadZxing()
  const results = await readBarcodes(input as never, {
    formats: ZXING_FORMATS as never,
    tryHarder: true,
    maxNumberOfSymbols: 1,
  })
  for (const r of results) {
    if (r.isValid && r.text) return r.text
  }
  return null
}

/* ────────────────────────── 取景取帧 ────────────────────────── */

/**
 * 只取画面中间的一条横带做解码。
 * 一维条码（EAN/UPC）横向分辨率越足越容易读，所以把带宽固定成 canvas 宽度，
 * 同时丢弃上下无关区域，避免整帧解码拖慢扫描。
 */
function grabBand(video: HTMLVideoElement, canvas: HTMLCanvasElement, targetWidth = 900): ImageData | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const sx = vw * 0.06
  const sw = vw * 0.88
  const sh = Math.min(vh * 0.34, (sw * 260) / targetWidth)
  const sy = (vh - sh) / 2

  const w = Math.min(targetWidth, Math.round(sw))
  const h = Math.max(1, Math.round((sh / sw) * w))

  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

async function decodeFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  detector: BarcodeDetectorLike | null,
): Promise<string | null> {
  if (detector) {
    try {
      const found = await detector.detect(video)
      for (const b of found) if (b.rawValue) return b.rawValue
      return null
    } catch {
      // 某些实现会在帧未就绪时抛错，忽略后继续下一帧
      return null
    }
  }
  const band = grabBand(video, canvas)
  if (!band) return null
  return decodeWithZxing(band)
}

/* ────────────────────────── 摄像头扫描 ────────────────────────── */

export interface ScanSession {
  stop: () => void
}

export interface StartScanOptions {
  video: HTMLVideoElement
  onCode: (raw: string) => void
  onError: (message: string) => void
}

/**
 * 打开后置摄像头并持续解码，识别到第一个有效条码后回调并自动停止。
 */
export async function startScan({ video, onCode, onError }: StartScanOptions): Promise<ScanSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持调用摄像头，可以改用「上传条码照片」。')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    if (name === 'NotAllowedError') throw new Error('没有拿到摄像头权限，请在浏览器设置里允许后重试。')
    if (name === 'NotFoundError') throw new Error('没有找到可用摄像头，可以改用「上传条码照片」。')
    throw new Error('摄像头打开失败，可以改用「上传条码照片」。')
  }

  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play().catch(() => undefined)

  const Ctor = getDetectorCtor()
  let detector: BarcodeDetectorLike | null = null
  if (Ctor) {
    try {
      detector = new Ctor({ formats: RETAIL_FORMATS })
    } catch {
      detector = null
    }
  }
  if (!detector) {
    try {
      await loadZxing()
    } catch {
      stopStream(stream)
      throw new Error('解码组件加载失败，可以改用「上传条码照片」。')
    }
  }

  const canvas = document.createElement('canvas')
  let stopped = false
  let busy = false
  let missCount = 0
  let raf = 0

  function teardown() {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    stopStream(stream)
    video.srcObject = null
  }

  async function tick() {
    if (stopped) return
    if (!busy && video.readyState >= 2) {
      busy = true
      try {
        const raw = await decodeFrame(video, canvas, detector)
        if (raw) {
          const code = normalizeCode(raw)
          if (code) {
            teardown()
            onCode(code)
            return
          }
        } else {
          missCount += 1
        }
      } catch {
        missCount += 1
      } finally {
        busy = false
      }
    }
    raf = requestAnimationFrame(() => {
      // 限制到约 8 帧/秒，兼顾识别速度与发热
      window.setTimeout(tick, 120)
    })
  }

  raf = requestAnimationFrame(tick)

  // 长时间没读到就提示一次，避免用户对着模糊画面干等
  const tipTimer = window.setTimeout(() => {
    if (!stopped && missCount > 40) onError('还没读到条码，试着让条码占满取景框、避开反光。')
  }, 6000)

  return {
    stop: () => {
      window.clearTimeout(tipTimer)
      teardown()
    },
  }
}

function stopStream(stream: MediaStream) {
  for (const t of stream.getTracks()) t.stop()
}

/* ────────────────────────── 图片解码（兜底入口） ────────────────────────── */

/** 从用户上传的照片 / 截图里解条码，用于没有摄像头权限或无法对焦的场景 */
export async function decodeFromImage(file: File): Promise<string | null> {
  const Ctor = getDetectorCtor()
  if (Ctor) {
    try {
      const detector = new Ctor({ formats: RETAIL_FORMATS })
      const bitmap = await createImageBitmap(file)
      const found = await detector.detect(bitmap)
      bitmap.close()
      for (const b of found) {
        const code = normalizeCode(b.rawValue)
        if (code) return code
      }
      return null
    } catch {
      // 落到 zxing
    }
  }
  const raw = await decodeWithZxing(file)
  return raw ? normalizeCode(raw) : null
}
