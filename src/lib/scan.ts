/**
 * 扫码能力门面（facade）。
 *
 * 为什么要多这一层：现有实现 src/lib/barcode.ts 是**纯浏览器方案**——
 * getUserMedia 开摄像头 + BarcodeDetector / zxing-wasm 解码。
 * 它在原生 App 里有三个问题：
 *   1. iOS WKWebView **不支持** BarcodeDetector API，只能走 zxing-wasm，
 *      意味着每次都白下载 ~966 KB 的 wasm；
 *   2. WebView 里保持摄像头常开，发热与耗电都明显高于原生；
 *   3. 权限弹窗文案无法控制，且无法复用系统相机的对焦能力。
 * 因此原生端应改用 @capacitor-mlkit/barcode-scanning（系统级、免 wasm、可控制权限）。
 *
 * 但在阶段 0，**行为必须零变化**：本模块只是把 barcode.ts 的能力重新导出并加一层
 * 原生分支打桩，Web 端调用路径与原实现完全一致（同一个函数、同一份 wasm）。
 *
 * 接入原生时只需要改这一个文件里的 appStartScan / appDecodeFromImage 两个函数，
 * components/Scanner.tsx 与 pages/LogSheet.tsx 都不用动。
 */

import { isNative } from './platform'
import {
  decodeFromImage as webDecodeFromImage,
  hasNativeDetector as webHasNativeDetector,
  normalizeCode as webNormalizeCode,
  startScan as webStartScan,
  warmUpDecoder as webWarmUpDecoder,
  type ScanSession,
  type StartScanOptions,
} from './barcode'

// 类型透传，保证业务代码只依赖本模块也能拿到完整类型
export type { ScanSession, StartScanOptions }

/** 规整解码结果（提取零售条码数字）；平台无关，直接复用 */
export const normalizeCode = webNormalizeCode

/**
 * 当前设备是否原生支持条码识别（仅用于 UI 提示，不决定功能可用性）。
 * Web 端语义与原 barcode.ts 完全一致。
 */
export function hasNativeDetector(): boolean {
  if (isNative()) return true // 原生端用 MLKit，恒可用
  return webHasNativeDetector()
}

/**
 * 预热解码器：进入扫码界面时调用，减少首次识别等待。
 * Web 端行为与改造前一致（有 BarcodeDetector 就直接返回，否则预载 zxing wasm）。
 */
export async function warmUpDecoder(): Promise<void> {
  if (isNative()) {
    // ── 原生分支占位 ──────────────────────────────────────────────
    // 接入 @capacitor-mlkit/barcode-scanning 后在此做权限预检：
    //   const { camera } = await BarcodeScanner.checkPermissions()
    //   if (camera !== 'granted') await BarcodeScanner.requestPermissions()
    // 无需预载任何解码资源（系统自带）。
    // ──────────────────────────────────────────────────────────────
    return
  }
  await webWarmUpDecoder()
}

/**
 * 打开摄像头持续解码，识别到第一个有效条码后回调并自动停止。
 *
 * Web：原样走 getUserMedia + BarcodeDetector/zxing（逐帧取中间横带解码）。
 * 原生：待接入 MLKit 的 addListener('barcodesScanned') + startScan。
 */
export async function startScan(opts: StartScanOptions): Promise<ScanSession> {
  if (isNative()) {
    return nativeStartScan(opts)
  }
  return webStartScan(opts)
}

/** 原生分支实现（阶段 0 为占位：尚未接入插件，落回 Web 实现以保证行为不变） */
async function nativeStartScan(opts: StartScanOptions): Promise<ScanSession> {
  // ── 原生分支占位 ──────────────────────────────────────────────
  // 接入 @capacitor-mlkit/barcode-scanning 后的目标实现：
  //   await BarcodeScanner.addListener('barcodesScanned', (event) => {
  //     for (const b of event.barcodes) {
  //       const code = normalizeCode(b.rawValue)
  //       if (code) { void BarcodeScanner.stopScan(); opts.onCode(code); return }
  //     }
  //   })
  //   await BarcodeScanner.startScan({ formats: [...], lensFacing: LensFacing.Back })
  //   return { stop: () => { void BarcodeScanner.stopScan(); void BarcodeScanner.removeAllListeners() } }
  // 阶段 0 不改行为：直接复用 Web 实现，原生环境下的差异留到阶段 2 处理。
  // ──────────────────────────────────────────────────────────────
  return webStartScan(opts)
}

/**
 * 从用户上传的照片 / 截图里解条码（没有摄像头权限或无法对焦时的兜底入口）。
 * Web 端行为与改造前一致：优先 BarcodeDetector，失败落 zxing。
 */
export async function decodeFromImage(file: File): Promise<string | null> {
  if (isNative()) {
    // ── 原生分支占位 ──────────────────────────────────────────────
    // 接入 MLKit 后用系统识别（无需 wasm）：
    //   const { barcodes } = await BarcodeScanner.readBarcodesFromImage({ path: ... })
    // 阶段 0 不改行为：复用 Web 实现。
    // ──────────────────────────────────────────────────────────────
  }
  return webDecodeFromImage(file)
}
