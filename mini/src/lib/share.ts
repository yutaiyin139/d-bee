/**
 * 数据导出抽象层（小程序端）。
 *
 * 🔴 2026-11-15 实装：此前为占位（恒返回「正在接入」），用户拍板「补齐」后改为真通道。
 *   小程序无 DOM、无 Blob 下载，导出走微信原生两步：
 *     ① `Taro.getFileSystemManager().writeFileSync()` 把内容写进 `USER_DATA_PATH`；
 *     ② `Taro.shareFileMessage({ filePath, fileName })` 转发到聊天，用户在聊天里
 *        「保存到手机 / 用其他应用打开」即可拿到文件。
 *
 * 平台约束（微信开放文档，2026-11-15 现查）：
 *   · `shareFileMessage` 基础库 2.16.1+，`filePath` 必须是本地/临时路径；
 *   · **限制：仅在点击行为时调用** —— 与「用户主动点导出」天然契合；官方示例本身
 *     就是在 `downloadFile` 的异步回调里调它，故「点击 → await 拉数据 → 分享」成立。
 *   · 🔴 微信客户端对 .json / .csv 的接受度社区口径不一，**必须真机实测**（铁律 #13）。
 *     若实测某格式被拒，只需把 `isExportAvailable` 翻回 false，UI 角标/置灰自动恢复，
 *     不必再改任何页面 —— 这正是把它设为「UI 与实现共用单一真源」的原因。
 */
import Taro from '@tarojs/taro'

export interface ExportResult {
  channel: 'share' | 'none'
  message: string
}

/**
 * 🔴 导出能力当前是否可用 —— **UI 与实现共用的单一真源**。
 *
 * profile 页的「即将上线」角标 / 整行置灰 / `guardExport()` 短路全部读这一个值：
 * 实装即 `true`（角标自动消失、按钮可点）；若真机实测发现微信拒收某格式，翻回
 * `false` 即可一键退回诚实占位，无需再改 UI。各页面各自判断必然在某次改动时漏改，
 * 重新变成「可见但不可用」的误导，故收敛到此处。
 */
export const isExportAvailable = true

/**
 * 防御性兜底文案：仅当 `isExportAvailable` 被翻回 false 时由 `guardExport()` 展示。
 * 与 legal.ts §五的邮箱兜底口径一致（PIPL 第 45 条数据复制权不因端能力缺失而消失）。
 */
export const EXPORT_UNAVAILABLE_MESSAGE =
  '当前微信版本暂不支持在小程序内直接导出文件。如需数据副本，可按《隐私政策》第五条载明的邮箱与我们联系，我们将以合理方式提供。'

/**
 * PIPL 第 45 条「数据复制权」的邮箱兜底路径。
 * 🔴 非 Pro 用户也必须保留这条 —— 数据复制权是法定权利，不能被付费墙藏掉；
 *   付费墙只拦「在 App 内一键导出」这个便利功能，不拦「向开发者索取副本」这项权利。
 */
export const EXPORT_EMAIL_FALLBACK =
  '如需数据副本，也可按《隐私政策》第五条载明的邮箱与我们联系，我们将以合理方式提供。'

/**
 * 文件名安全化：只清掉路径穿越与文件系统非法字符，**保留中文**。
 * （主端 sanitizeShareFilename 把非 ASCII 全替换成 `_`，会让「饮食记录」变成一串下划线；
 *   mini 的 CSV 文件名含中文且要作为 shareFileMessage 的 fileName 展示给收件人，故单独处理。）
 */
function safeFileName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\.+/g, '_')
  return cleaned || fallback
}

/**
 * 把文本内容写入用户目录并唤起微信「转发文件到聊天」。
 * 两步都在用户点击导出的同一调用链内完成（满足 shareFileMessage「仅点击时调用」限制）。
 */
async function writeAndShare(content: string, filename: string, fallback: string): Promise<ExportResult> {
  const dir = Taro.env.USER_DATA_PATH
  if (!dir || typeof Taro.getFileSystemManager !== 'function' || typeof Taro.shareFileMessage !== 'function') {
    // 基础库过低（< 2.16.1）或缺文件系统能力：诚实降级，不假装成功
    return { channel: 'none', message: EXPORT_UNAVAILABLE_MESSAGE }
  }
  const safeName = safeFileName(filename, fallback)
  const filePath = `${dir}/${safeName}`
  try {
    Taro.getFileSystemManager().writeFileSync(filePath, content, 'utf8')
    await Taro.shareFileMessage({ filePath, fileName: safeName })
    return { channel: 'share', message: '已生成文件，请在聊天中选择「保存」或转发到其他应用。' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 用户在转发面板点取消属正常流程，不当失败处理
    if (/cancel/i.test(msg)) return { channel: 'share', message: '已取消导出' }
    return { channel: 'none', message: '导出失败，请稍后重试。' }
  }
}

/** 导出 JSON（导出全部数据等场景）：写文件 → 转发到聊天。 */
export async function exportJSON(
  data: unknown,
  filename: string,
  extra: { title?: string; text?: string } = {},
): Promise<ExportResult> {
  void extra // 微信 shareFileMessage 无标题/正文参数，保留签名以与主端调用点对齐
  return writeAndShare(JSON.stringify(data, null, 2), filename, 'd-bee-export.json')
}

/** 导出纯文本（CSV 等）：写文件 → 转发到聊天。mimeType 仅作签名对齐，小程序按扩展名识别。 */
export async function exportText(
  text: string,
  filename: string,
  mimeType = 'text/plain;charset=utf-8',
): Promise<ExportResult> {
  void mimeType
  return writeAndShare(text, filename, 'd-bee-export.txt')
}
