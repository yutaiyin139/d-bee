/**
 * 数据导出 / 分享抽象层（小程序端占位）。
 *
 * 小程序端无 DOM、无 Blob 下载，导出 JSON/CSV 需走 wx.getFileSystemManager 写临时文件
 * 再 wx.shareFileMessage / 保存到相册。当前为规划中接入，返回安全占位结果。
 */
import Taro from '@tarojs/taro'

export interface ExportResult {
  channel: 'share' | 'none'
  message: string
}

/** 导出 JSON（导出全部数据等场景）。当前小程序端返回占位提示。 */
export async function exportJSON(
  data: unknown,
  filename: string,
  extra: { title?: string; text?: string } = {},
): Promise<ExportResult> {
  // 占位：将数据写入临时文件后唤起分享面板（后续接入）
  void data
  void filename
  void extra
  return { channel: 'none', message: '导出功能正在接入小程序，敬请期待。' }
}

/** 导出纯文本（CSV 等）。当前小程序端返回占位提示。 */
export async function exportText(
  text: string,
  filename: string,
  mimeType = 'text/plain;charset=utf-8',
): Promise<ExportResult> {
  void text
  void filename
  void mimeType
  return { channel: 'none', message: '导出功能正在接入小程序，敬请期待。' }
}

/** 分享一张图片。小程序端走 wx.showShareImageMenu（规划中接入）。 */
export async function shareImage(
  imagePath: string,
  opts: { filename?: string; title?: string; text?: string } = {},
): Promise<ExportResult> {
  void imagePath
  void opts
  // 未来：Taro.showShareImageMenu({ path: imagePath })
  return { channel: 'none', message: '分享功能正在接入小程序，敬请期待。' }
}
