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

/**
 * 🔴 导出能力当前是否可用 —— **UI 与实现共用的单一真源**。
 *
 * 为什么需要它：P2-A 之前，「我的」页两个导出按钮看起来完全可点（文案「导出」+
 * 点击后转圈「导出中…」），实际 `exportJSON`/`exportText` 只是占位，返回
 * 「敬请期待」。这构成「可见但不可用」的误导，且与法务声明口径不一致
 * （`mini/src/content/legal.ts` §五已如实写「数据导出功能正在接入小程序端，
 * 当前版本暂不可用」）。
 *
 * 未来实装导出（wx.getFileSystemManager 写临时文件 + shareFileMessage）时，
 * **只改这里返回 true**，profile 页的置灰/角标/短路会自动消失，不必再去改 UI。
 * 反之若各页面各自判断，实装那天必然漏改某一处，又变成新的不一致。
 */
export const isExportAvailable = false

/** 导出不可用时的统一提示。与 legal.ts §五 的「可通过邮箱提供副本」口径一致。 */
export const EXPORT_UNAVAILABLE_MESSAGE =
  '导出功能正在接入小程序端，当前版本暂不可用。如需数据副本，可按《隐私政策》第五条的邮箱与我们联系，我们会以合理方式提供。'

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
  return { channel: 'none', message: EXPORT_UNAVAILABLE_MESSAGE }
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
  return { channel: 'none', message: EXPORT_UNAVAILABLE_MESSAGE }
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
