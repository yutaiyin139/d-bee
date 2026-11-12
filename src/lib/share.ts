/**
 * 文件导出 / 分享抽象。
 *
 * 平台差异只在本文件处理，业务代码只关心数据内容：
 *   - Web：Blob → URL.createObjectURL → 隐藏 <a download> 点击 → revokeObjectURL。
 *   - 原生（iOS/Android）：Blob → Filesystem 写入 Cache 目录 → Share.share({ files })
 *     唤起系统分享面板（微信 / 钉钉 / 保存到相册…）。
 *   - 微信小程序：无 DOM、无 Blob 下载，当前为安全占位（见 mini/src/lib/share.ts）。
 *
 * 🔴 为什么原生端必须走 Filesystem + files，不能把 base64 塞进 Share 的 url：
 *   Capacitor Share 的 `url` 语义是「一条链接」，iOS 侧 SharePlugin.swift 会把它
 *   用 URL(string:) 转成 NSURL 后塞进 UIActivityViewController 的 activityItems；
 *   Android 侧 SharePlugin.java 更直接对非 file/http 的 url 抛 "Unsupported url"。
 *   传 data: 前缀的图片字符串会造成：
 *     · 微信不接受该 scheme → 分享面板里点微信无反应（拉不起微信）；
 *     · 钉钉把它当一条超长链接收下 → 分享出去的「链接」在钉钉里打不开。
 *   `files: [file://URI]` 才是「分享图片文件」的正确通道（iOS/Android 自 4.1 支持），
 *   系统面板会把真实 PNG 交给目标 App。
 *
 * ⚠️ 原生端插件缺失（旧安装包未包含 Filesystem）时**不回落 Web 下载**：
 *   WebView 没有下载管理器，a.download 会静默失败（点了没反应），
 *   比明确告知用户「请更新 App」更糟。
 */

import { isNative, isWechatMiniProgram } from './platform'

/**
 * 原生 Capacitor 插件的最小结构（鸭子类型探测，不 import 包，保持 Web 包体积不变）。
 */
interface CapacitorShare {
  share: (opts: {
    title?: string
    text?: string
    url?: string
    files?: string[]
    dialogTitle?: string
  }) => Promise<unknown>
}

interface CapacitorFilesystem {
  writeFile: (opts: { path: string; data: string; directory: string }) => Promise<unknown>
  getUri: (opts: { path: string; directory: string }) => Promise<{ uri: string }>
}

/** Directory.Cache 的字符串值（不 import 原生包，避免把 Capacitor 打进 Web 产物） */
const CAP_CACHE_DIR = 'CACHE'

function getCapPlugin<T extends object>(name: string, methods: (keyof T)[]): T | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const p = cap?.Plugins?.[name]
  if (!p || typeof p !== 'object') return null
  const plugin = p as Record<string, unknown>
  if (!methods.every((m) => typeof plugin[m as string] === 'function')) return null
  return p as T
}

function getCapShare(): CapacitorShare | null {
  return getCapPlugin<CapacitorShare>('Share', ['share'])
}

function getCapFilesystem(): CapacitorFilesystem | null {
  return getCapPlugin<CapacitorFilesystem>('Filesystem', ['writeFile', 'getUri'])
}

/** 文件名只保留安全字符：防止路径穿越，且不建子目录（Cache 根下直接写） */
export function sanitizeShareFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'share.png'
}

/** Blob → base64（供 Capacitor Filesystem 写入二进制） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string | null
      if (result) resolve(result.split(',')[1] ?? '')
      else reject(new Error('读取文件失败'))
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/** 把 Blob 写成 Cache 目录下的文件，返回可传给 Share.share({ files }) 的 file:// URI */
async function writeShareFile(blob: Blob, filename: string): Promise<string> {
  const fs = getCapFilesystem()
  if (!fs) throw new Error('Filesystem plugin unavailable')
  const base64 = await blobToBase64(blob)
  const path = sanitizeShareFilename(filename)
  // 不传 encoding：插件按 base64 解码后写入二进制（见 WriteFileOptions 注释）
  await fs.writeFile({ path, data: base64, directory: CAP_CACHE_DIR })
  const { uri } = await fs.getUri({ path, directory: CAP_CACHE_DIR })
  if (!uri) throw new Error('Failed to resolve share file URI')
  return uri
}

/** 分享面板被用户取消：不算失败，也不要回落到下载 */
function isShareCancelled(e: unknown): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    'message' in e &&
    /cancel/i.test(String((e as { message: unknown }).message ?? ''))
  )
}

export interface ExportFileOptions {
  /** 文件名，含扩展名，例如 d-bee-export-2026-10-13.json */
  filename: string
  /** MIME 类型，例如 application/json */
  mimeType?: string
  /** 分享面板标题（原生端使用，Web 端忽略） */
  title?: string
  /** 分享面板文案（原生端使用，Web 端忽略） */
  text?: string
}

/** 导出结果，用于给用户不同的提示文案 */
export interface ExportResult {
  /** 'download' = 浏览器下载；'share' = 原生分享面板 */
  channel: 'download' | 'share'
  /** 可直接展示给用户的提示 */
  message: string
}

/**
 * 把字符串 / Blob 内容导出为文件（原生端 = 唤起系统分享面板）。
 */
export async function exportFile(
  content: string | Blob,
  { filename, mimeType = 'application/json', title, text }: ExportFileOptions,
): Promise<ExportResult> {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content

  if (isNative()) {
    const capShare = getCapShare()
    if (!capShare || !getCapFilesystem()) {
      return { channel: 'share', message: '当前版本暂不支持在 App 内导出，请更新到最新版本。' }
    }
    try {
      const uri = await writeShareFile(blob, filename)
      await capShare.share({
        title: title ?? '自律蜜蜂',
        text,
        files: [uri],
        dialogTitle: title ?? '分享到',
      })
      return { channel: 'share', message: '已生成文件，请在分享面板中保存或发送。' }
    } catch (e) {
      if (isShareCancelled(e)) return { channel: 'share', message: '已取消分享' }
      return { channel: 'share', message: '文件分享失败，请稍后重试。' }
    }
  }

  // 微信小程序：无 DOM，走 wx.getFileSystemManager / wx.shareFileMessage（规划中接入）。
  if (isWechatMiniProgram()) {
    return { channel: 'share', message: '导出功能正在接入小程序，敬请期待。' }
  }

  return downloadBlob(blob, filename)
}

/** Web 端实现：与改造前逐行等价（createObjectURL → a.click → revokeObjectURL） */
function downloadBlob(blob: Blob, filename: string): ExportResult {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // 立即 revoke 在部分浏览器会打断下载，放到下一个事件循环
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return { channel: 'download', message: '已导出为 JSON 文件，可在下载目录找到。' }
}

/** 便捷方法：导出 JSON（导出全部数据、报告等场景） */
export async function exportJSON(
  data: unknown,
  filename: string,
  extra: Pick<ExportFileOptions, 'title' | 'text'> = {},
): Promise<ExportResult> {
  return exportFile(JSON.stringify(data, null, 2), {
    filename,
    mimeType: 'application/json',
    ...extra,
  })
}

/** 便捷方法：导出纯文本（CSV、Markdown 报告等） */
export async function exportText(
  text: string,
  filename: string,
  mimeType = 'text/plain;charset=utf-8',
): Promise<ExportResult> {
  return exportFile(text, { filename, mimeType })
}

/**
 * 分享一张图片（PNG Blob）。
 * - 原生：写 Cache 文件后走 Share.share({ files })，微信 / 钉钉 / 相册都收到真实图片。
 * - Web：下载 PNG（用户再手动发朋友圈），行为保持不变。
 */
export async function shareImage(
  blob: Blob,
  opts: { filename: string; title?: string; text?: string },
): Promise<ExportResult> {
  const { filename, title, text } = opts

  if (isNative()) {
    const capShare = getCapShare()
    if (!capShare || !getCapFilesystem()) {
      return { channel: 'share', message: '当前版本暂不支持在 App 内分享图片，请更新到最新版本。' }
    }
    try {
      const uri = await writeShareFile(blob, filename)
      await capShare.share({
        title: title ?? '自律蜜蜂',
        text,
        files: [uri],
        dialogTitle: title ?? '分享到',
      })
      return { channel: 'share', message: '已唤起分享面板' }
    } catch (e) {
      if (isShareCancelled(e)) return { channel: 'share', message: '已取消分享' }
      return { channel: 'share', message: '分享失败，请稍后重试。' }
    }
  }

  // 微信小程序：无 DOM，走 wx.showShareImageMenu / 转发（规划中接入）。
  if (isWechatMiniProgram()) {
    return { channel: 'share', message: '分享功能正在接入小程序，敬请期待。' }
  }

  // Web 兜底：下载 PNG
  return downloadBlob(blob, filename)
}
