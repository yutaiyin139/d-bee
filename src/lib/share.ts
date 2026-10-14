/**
 * 文件导出 / 分享抽象。
 *
 * 现状（Web）：Blob → URL.createObjectURL → 隐藏 <a download> 点击 → revokeObjectURL。
 * 这是浏览器里唯一可用的下载方式，阶段 0 必须**保持不变**。
 *
 * 未来（原生）：WebView **没有下载管理器**，`a.download` 会静默失败（用户点了没反应）。
 * 原生端必须改成：
 *   1. @capacitor/filesystem 把文件写到 Cache/Documents 目录
 *   2. @capacitor/share 唤起系统分享面板（存到「文件」、发微信、发邮件…）
 * 注意：这是 iOS 上付费功能之外的核心体验，落地时可作为 Pro 权益的一部分。
 *
 * 本模块把「把一段数据以文件形式交付给用户」统一成 exportFile()，
 * 业务代码只关心数据内容，不关心平台差异。
 */

import { isNative } from './platform'

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
 * 把字符串 / Blob 内容导出为文件。
 * @param content 文本内容或 Blob
 */
export async function exportFile(
  content: string | Blob,
  { filename, mimeType = 'application/json', title, text }: ExportFileOptions,
): Promise<ExportResult> {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content

  if (isNative()) {
    // ── 原生分支占位 ──────────────────────────────────────────────
    // 接入 @capacitor/filesystem + @capacitor/share 后在此实现：
    //   const base64 = await blobToBase64(blob)
    //   const { uri } = await Filesystem.writeFile({
    //     path: filename, data: base64, directory: Directory.Cache,
    //   })
    //   await Share.share({ title, text, url: uri, dialogTitle: title })
    //   return { channel: 'share', message: '已生成文件，请在分享面板中保存或发送。' }
    // 阶段 0 不改行为：原生环境尚未接入，直接落回浏览器下载实现。
    // ──────────────────────────────────────────────────────────────
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
