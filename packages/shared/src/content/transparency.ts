/**
 * 「透明化文案」单一真相源（2026-11-12 · P1.4 / P1.5 / P1.6）。
 *
 * ## 为什么集中在这里
 *
 * 官网 `features.html` 早在 11-11 就把额度规则讲清楚了，但**产品内四端**
 * 只在代码注释里写着「手动录入不扣 / 复用不扣 / 识别失败退还」，用户看不见。
 * 把规则从注释搬进 UI，若各端各写一份文案，必然再次漂移 —— 权益文案漂移
 * 不是排版问题，是《广告法》第 4 条的虚假宣传风险（见 `membership.ts` 文件头）。
 *
 * 故：文案只此一份，四端渲染同一份；所有数字一律插值 `constants/index.ts`
 * 的配额/价格/热量常量，不写死数字（改常量即改文案，无副本可漏改）。
 *
 * ## 边界（改动前必读）
 *
 * - 本文件是**纯展示文案**，不含任何业务逻辑、不读取环境、不触发网络请求。
 * - 不新增任何数据收集、不改变任何配额/价格/权益规则。
 * - 条款类表述（退款、注销）只做「指路」，权利义务以 `src/content/legal.ts`
 *   生成的用户协议 / 隐私政策为准；改那里的条款须单独评审且不刷 `LEGAL_UPDATED`。
 * - 🔴 全能力端口（Web / 原生）生成的额度文案与官网
 *   `E:/DEV/d-bee-website/src/data/site.mjs` 的 `QUOTA_RULES` 前 4 条**逐字一致**
 *   （官网是真源快照比对对象，措辞差异会被 `check-facts.mjs` 判红）。
 * - 🔴 **端能力差异不得抹平**：mini 没有条码扫码与包装营养表读取
 *   （`mini/src/components/LogSheet.tsx:20` 与护栏 19 钉住的刻意差异）。
 *   若在 mini 渲染「条码扫码不占额度」，等于宣传一个不存在的功能 —— 《广告法》第 4 条风险。
 *   故文案由 `quotaNotes(caps)` 按端能力生成，而非四端硬贴同一份数组。
 */
import {
  AI_REDEEM_DAILY_LIMIT,
  FREE_DAILY_AI,
  HONEY_PRICE,
  ACTIVITY_EATBACK_RATIO,
} from '../constants'

export type TransparencyNote = {
  /** 短标签，UI 里作小标题；不含数字，便于逐字比对 */
  label: string
  /** 说明正文 */
  text: string
}

/**
 * 端能力声明。🔴 必须与真实实现一致，否则「不占额度」的承诺就是虚假宣传。
 * Web / 原生有 barcode 模式（Open Food Facts + Scanner）与包装营养表兜底；
 * mini 的 LogSheet 只有「拍照识别 / 文字描述 / 食物库 / 手动填写」4 模式。
 */
export type RecordingCaps = {
  /** 条码扫码（扫包装条码查 Open Food Facts） */
  barcode: boolean
  /** 拍包装正面读营养表（条码查不到时的兜底） */
  packagedLabel: boolean
}

export const FULL_RECORDING_CAPS: RecordingCaps = { barcode: true, packagedLabel: true }
export const MINI_RECORDING_CAPS: RecordingCaps = { barcode: false, packagedLabel: false }

/**
 * P1.5 · 次数怎么算。按端能力生成，全能力端口输出与官网 QUOTA_RULES 前 4 条逐字一致。
 * 纯函数：不读环境、不缓存，每次调用由常量现算，改配额常量即改文案。
 */
export function quotaNotes(caps: RecordingCaps): readonly TransparencyNote[] {
  const notCounted = [
    '手动录入',
    '文字描述识别',
    ...(caps.packagedLabel ? ['包装营养表读取'] : []),
    ...(caps.barcode ? ['条码扫码'] : []),
    '体重 / 饮水 / 运动打卡',
  ].join('、')
  const fallback = caps.barcode
    ? '额度用完仍可手动录入、扫码与查看历史记录。'
    : '额度用完仍可手动录入、复用「最近吃过 / 我的食谱」与查看历史记录。'
  return [
    { label: '计入次数', text: '仅 AI 拍照识别消耗次数，且识别成功才扣、失败不扣。' },
    { label: '不计次数', text: `${notCounted}均不占额度。` },
    { label: '重置规则', text: '基础额度按自然日 0 点重置，不累计、不结转；奖励额度带 7 天有效期。' },
    { label: '免费兜底', text: `${fallback}本服务免费版永久可用，不承诺服务不中断、无差错。` },
    {
      label: '免费额度',
      text: `每日 ${FREE_DAILY_AI} 次免费 AI 拍照识别；积分可再兑换，每日最多 ${AI_REDEEM_DAILY_LIMIT} 次（${HONEY_PRICE.ai1Scan} 积分/次）。`,
    },
  ]
}

/** P1.4 · 已经实现、但此前只写在代码注释里的能力。 */
export const CAPABILITY_NOTES: readonly TransparencyNote[] = [
  {
    label: '目标怎么算',
    text: '每日热量目标由性别、年龄、身高、体重与活动量按 Mifflin-St Jeor 公式估算，再按你设定的每周体重变化速率调整，并设有安全下限。',
  },
  {
    label: '预计达成日',
    text: '报告页用近期体重记录做趋势拟合，外推到达目标体重的日期；体重记录至少 3 次、跨 5 天才显示，仅为推算，不是承诺。',
  },
  {
    label: '运动回补',
    text: `活动消耗只按 ${ACTIVITY_EATBACK_RATIO * 100}% 计入可吃回额度：手环与步数普遍高估消耗，全额回补容易抵消热量缺口。`,
  },
  {
    label: '积分规则',
    text: `蜜糖积分可兑拍照次数（${HONEY_PRICE.ai1Scan} 分/次）或 Pro 天数（${HONEY_PRICE.pro1Day} 分/天、${HONEY_PRICE.pro30Day} 分/30 天），在「蜜糖积分」页兑换。`,
  },
  {
    label: '复用不扣',
    text: '从「最近吃过 / 我的食谱」复用一餐，以及饮食体检、风险益处标签，都在本机计算，不消耗 AI 次数。',
  },
]

/**
 * P1.6 · 数据权与退款「可找到」。只指路，不替代法务条款。
 * 🔴 导出能力存在端差异（mini 的 `isExportAvailable=false`，入口显示「即将上线」），
 *    故本段**不承诺「现在就能导出」**，只讲入口位置与兜底权利，两端都成立。
 */
export const DATA_RIGHTS_NOTES: readonly TransparencyNote[] = [
  {
    label: '导出',
    text: '导出入口在「我的 → 数据与隐私」，含全部数据（JSON）与饮食记录（CSV）；导出属 Pro 权益，具体可用状态以该页显示为准。免费版仍可通过隐私政策中的联系渠道申请数据副本。',
  },
  {
    label: '清空',
    text: '「清空全部记录」删除饮食 / 体重 / 饮水 / 运动记录，账号与身体档案保留；操作前有两步确认。',
  },
  {
    label: '注销',
    text: '「我的 → 账号管理 → 注销账号」可删除账号及全部数据；具体流程以产品内隐私政策为准。',
  },
  {
    label: '退款',
    text: '退款按购买渠道规则处理：iOS 内购遵循 Apple 退款政策，其他渠道按对应支付渠道规则，也可通过用户协议第九条的联系方式申请协助。',
  },
]
