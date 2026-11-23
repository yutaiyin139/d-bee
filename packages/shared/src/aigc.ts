/**
 * AIGC 标识（显式 + 隐式）的**纯逻辑真相源**，四端共用。
 *
 * ## 为什么放在 shared
 *
 * Web/iOS/Android（`src/`）与微信小程序（`mini/src/`）导出的是**同一种文件**、
 * 面对的是**同一部法规**，标识口径必须逐字一致。两端各写一份必然漂移 ——
 * 而漂移的后果不是样式问题，是「同一个用户从两端导出的两份文件，
 * 一份合规一份不合规」。故与 numfmt / datefmt / honeyLedger 同一处置：下沉到 shared。
 *
 * 🔴 **本模块不得出现公司名 / 备案号等主体信息**：
 *   · 主体名称的真相源是各端自己的 `content/legal.ts`（主端 `SITE.operator` 支持
 *     `VITE_SITE_OPERATOR` 覆盖，mini 端是 `OPERATOR` 常量）—— 在 shared 里再写一份
 *     就有了第三个真相源，工商名称变更时必漏改；
 *   · 算法备案号尚未下证（见下 `AIGC_SERVICE_PROVIDER_CODE`）。
 *   主体信息由**调用方注入**，本模块只负责「结构、取值规则、判定逻辑、文案骨架」。
 *
 * ## 法规依据
 *
 *   · 《人工智能生成合成内容标识办法》（2025-09-01 施行）第四条（显式标识）、
 *     第五条（提供下载/导出功能时在导出文件中添加显式标识）；
 *   · GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》§6.1 + 附录 E
 *     （规范性）：文件元数据隐式标识格式。
 *   · 触发事由：国家网信办 2026-09-15 通报第 9 案，三项被点名事实中第 2、3 项
 *     分别是「未在文件元数据中添加…隐式标识」「未在提供导出功能时添加显式标识」。
 *
 * 原文见 `docs/refs/GB45438-2025-提取文本.txt`（§6.1 在第 194-207 行，附录 E 在 310-348 行）。
 */

/* ── 附录 E · 文件元数据隐式标识 ───────────────────────────────── */

/**
 * 隐式标识扩展字段名。附录 E a)：「字段名称或关键词中应包含 'AIGC'」→ 直接取 `AIGC`。
 */
export const AIGC_METADATA_KEY = 'AIGC'

/**
 * 生成合成标签要素（附录 E c)）的三种取值。**必须是字符串**，不是数字。
 *
 *   · '1' = 属于人工智能生成合成内容
 *   · '2' = 可能为人工智能生成合成内容
 *   · '3' = 疑似为人工智能生成合成内容（第三方检测场景用，本产品不适用）
 */
export const AIGC_LABEL_IS = '1'
export const AIGC_LABEL_POSSIBLE = '2'
export const AIGC_LABEL_SUSPECTED = '3'

/**
 * 🔴 **服务提供者编码 = 空串，且当前不得填入任何值。**
 *
 * 附录 E d) 允许 `ContentProducer` 存「名称**或**编码」，但附录 E j) 同时限定
 * 各要素的值「应主要由 GB18030—2022 中码位为 0x21、0x23~0x5B、0x5D~0x7E 的字符
 * 以及 \" 构成」—— 即**单字节 ASCII**（除 `"` 与 `\` 外，二者只能以 `\"` 出现）。
 *
 * 由此得出一个容易被忽略的结论：**中文公司名「北京迪蜂科技有限公司」在隐式标识里
 * 是不合法取值**（多字节码位落在 0x21~0x7E 之外）。故「名称或编码」这对选择关系
 * 在中文主体名下**只剩「编码」一条路** = 生成合成服务的算法备案编号。
 *
 * 而该编号尚未下证（备案进度见
 * `docs/AIGC合规-北京大模型登记与安全评估调研-2026-11-21.md`）。
 * 🔴 编造一个编号写进导出物 = 向用户与监管披露虚假信息，性质远重于留空。
 * 备案下证后：把编号填进本常量，两端导出物自动同步（这就是把它放 shared 的意义）。
 *
 * 📌 中文名并非无处可放：它属于**显式标识**（§5.x），显式标识无 ASCII 限制，
 *    已由 `AigcLabeling.service_provider` 如实披露（值来自各端 legal.ts）。
 */
export const AIGC_SERVICE_PROVIDER_CODE = ''

/** 附录 E 要求的 7 个键（顺序即 b) 给出的顺序，便于逐字比对） */
export interface AigcMetadataFields {
  /** c) 生成合成标签要素：'1' / '2' / '3' */
  Label: string
  /** d) 生成合成服务提供者要素：名称或编码（受 j) 限制，本产品当前只能填编码） */
  ContentProducer: string
  /** e) 内容制作编号要素：提供者对该内容的唯一编号 */
  ProduceID: string
  /** f) 预留字段 1：可存安全防护信息（本产品未启用，见下注） */
  ReservedCode1: string
  /** g) 内容传播服务提供者要素：注 1 —— 首次写入时与 ContentProducer 一致 */
  ContentPropagator: string
  /** h) 内容传播编号要素：注 1 —— 首次写入时与 ProduceID 一致 */
  PropagateID: string
  /** i) 预留字段 2：可存传播者安全防护信息（本产品未启用） */
  ReservedCode2: string
}

/**
 * 生成「内容制作编号」（附录 E e)）。
 *
 * 编号口径：**一次导出 = 一份内容制品 = 一个编号**。这与 §6.1 c)「一个文件仅保留
 * 一份文件元数据隐式标识」是同一粒度 —— 文件级标识配文件级编号。
 *
 * 形态 `DBEE-<UTC紧凑时间戳>-<12位十六进制随机>`，全部落在附录 E j) 允许的
 * 单字节 ASCII 码位内（大写字母 / 数字 / `-`）。
 *
 * 🔴 用 `Math.random` 而非 `crypto` 是刻意的：本编号是**标识符不是安全令牌**，
 *   不需要抗碰撞以外的任何密码学性质；而 mini（微信小程序）端无 Web Crypto，
 *   引 `crypto.randomUUID()` 会在那一端抛错。跨端可用的最小实现优先。
 * 🔴 不要改用 `new Date().toISOString()` 直接当编号：含 `:` 与 `.`，虽在允许码位内，
 *   但同一毫秒内两次导出会撞号。时间戳 + 随机段才满足「唯一」。
 */
export function newAigcProduceId(now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  let rand = ''
  for (let i = 0; i < 12; i++) rand += '0123456789abcdef'[Math.floor(Math.random() * 16)]
  return `DBEE-${stamp}-${rand.toUpperCase()}`
}

/**
 * 组装附录 E b) 规定的**扩展字段值**（一个字符串）。
 *
 * 🔴 返回值的形态是 `{"AIGC":{...7键...}}` 再整体 `JSON.stringify` —— 看起来像多套了
 * 一层，但这是**照抄附录 E b) 的原文**：b) 说「隐式标识扩展字段的**值**，应为符合
 * 以下格式的字符串：`{"AIGC": {"Label":"value1",...}}`」。即外层 `AIGC` 包裹属于
 * **值**的一部分，而 a) 要求**字段名**也含 `AIGC` → 落到 JSON 容器里就是
 * `"AIGC": "{\"AIGC\":{...}}"`。不要「顺手优化」成单层，那会偏离规范性附录的字面格式。
 *
 * @param label           c) 的取值，用 AIGC_LABEL_* 常量，不要传裸字面量
 * @param contentProducer d) 服务提供者名称或编码（受 j) 限制；本产品传编码，当前为 ''）
 * @param produceId       e) 内容制作编号（用 newAigcProduceId() 生成）
 */
export function buildAigcMetadataValue(
  label: string,
  contentProducer: string,
  produceId: string,
): string {
  const fields: AigcMetadataFields = {
    Label: label,
    ContentProducer: contentProducer,
    ProduceID: produceId,
    // f)/i) 预留字段「可存储」安全防护信息（如 F.4 的数字签名杂凑值）。
    // 🔴 本产品**刻意留空**：签名需要私钥与密钥托管，客户端签名等于把私钥发给全世界，
    //   属伪防护。诚实留空 > 假签名。将来若做，应在网关侧签、客户端只透传。
    ReservedCode1: '',
    // 附录 E 注 1：生成合成服务提供者**首次写入**时，传播者要素与制作者要素一致、
    // 传播编号与制作编号一致。本产品导出即首次写入（用户自行转发属后续传播，
    // 由传播平台负责改写），故按注 1 取等值。
    ContentPropagator: contentProducer,
    PropagateID: produceId,
    ReservedCode2: '',
  }
  return JSON.stringify({ [AIGC_METADATA_KEY]: fields })
}

/**
 * 附录 E j) 的字符集校验：值只允许 GB18030 码位 0x21、0x23~0x5B、0x5D~0x7E，
 * 以及转义形式 `\"`（即 `"` 只能以 `\"` 出现，裸 `\` 不允许）。
 *
 * 写成显式函数而不是内联正则，是为了让护栏能**对同一份实现**做红验证
 * （把中文名塞进 ContentProducer 必须被它判为 false）。
 */
export function isAigcMetadataValueAllowed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 0x22) {
      // `"` 只允许以 \" 出现
      if (value[i - 1] !== '\\') return false
      continue
    }
    if (c === 0x5c) {
      // `\` 只允许作为 \" 的转义前缀
      if (value[i + 1] !== '"') return false
      continue
    }
    const ok = c === 0x21 || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e)
    if (!ok) return false
  }
  return true
}

/* ── 显式标识（导出物）─────────────────────────────────────────── */

/**
 * 导出物里的「AI 生成合成内容」显式标识块（《标识办法》第五条 + GB 45438 §5.1）。
 *
 * 与 `AigcMetadataFields`（隐式标识）的区别：
 *   · 本块是**给人看的**，用中文自然语言，落在 JSON 根的可读字段上 → 显式标识；
 *   · `AigcMetadataFields` 是**给机器读的**，受附录 E j) 的单字节 ASCII 限制 → 隐式标识。
 * 二者不可互相替代：显式块里的中文公司名合法，隐式标识里非法。
 */
export interface AigcLabeling {
  /** 要素① 内容属性信息：声明本文件含 AI 生成合成内容（§6.1 a)1)） */
  content_property: string
  /** 要素② 服务提供者名称：由调用方从各端 legal.ts 注入，本模块不持有主体信息 */
  service_provider: string
  /**
   * 要素② 的服务提供者**编码**（算法备案号）。
   * 🔴 备案下证前恒为 ''（见 AIGC_SERVICE_PROVIDER_CODE 注释）。
   *   保留空键而非省略：键缺失会让接收方以为本文件无需编码，空串才如实表达「待补」。
   */
  service_provider_code: string
  /** 要素③ 内容编号：本次导出的唯一编号，与隐式标识的 ProduceID 同值（§6.1 a)3)） */
  content_id: string
  /** 逐条 `ai_generated` 字段的判定口径，便于接收方复核而非只能盲信 */
  labeling_rule: string
  /** 本导出物中属于 AI 生成合成内容的字段清单（显式指明，避免「笼统声明」） */
  ai_generated_fields: string[]
}

/** 要素① 的属性信息文案（两端逐字一致，故放 shared） */
export const AIGC_CONTENT_PROPERTY =
  '本文件包含人工智能生成合成内容。其中的 AI 餐食点评、AI 健康计划，' +
  '以及标记为 ai_generated=true 的饮食记录行（含由 AI 识别/估算的食物名称与营养素数值），' +
  '均由大语言模型或视觉模型自动生成，可能存在误差，不构成医疗或营养建议，请核对后再作决定。'

/** 逐条 `ai_generated` 的判定口径说明（两端逐字一致） */
export const AIGC_LABELING_RULE =
  'meal_entries[].ai_generated 由既有 source 列派生：photo / text / barcode 为 true，' +
  'manual 为 false。其中 barcode 含「扫码命中商品库」与「AI 读包装营养表」两条来路，' +
  '因 confidence 未落库无法区分，一律从宽判为 true。' +
  'weight_logs / water_logs / exercise_logs 均为用户手工录入，ai_generated 恒为 false。'

/** 导出物中属于 AI 生成合成内容的字段清单（两端同一份数据库 schema，故清单相同） */
export const AIGC_GENERATED_FIELDS: string[] = [
  'meal_entries[].ai_note',
  'meal_entries[].health_score',
  'meal_entries[].food_name（仅 ai_generated=true 的行）',
  'meal_entries[].calories/protein_g/carb_g/fat_g/sodium_mg/fiber_g/added_sugar_g（仅 ai_generated=true 的行，AI 估算值）',
  'profile.plan_summary',
]

/**
 * 组装显式标识块。
 *
 * @param serviceProvider 服务提供者**名称**（中文全称），由各端从自己的 legal.ts 注入。
 *                        主端 = `SITE.operator`（可用 VITE_SITE_OPERATOR 覆盖），
 *                        mini = `SITE.operator`（`mini/src/content/legal.ts` 的 OPERATOR）。
 *                        🔴 调用方不得在此传字面量公司名，否则又造出一个真相源。
 */
export function buildAigcLabeling(serviceProvider: string, contentId: string): AigcLabeling {
  return {
    content_property: AIGC_CONTENT_PROPERTY,
    service_provider: serviceProvider,
    // 🔴 恒取 shared 常量：备案下证后只改一处，两端同时生效。
    service_provider_code: AIGC_SERVICE_PROVIDER_CODE,
    content_id: contentId,
    labeling_rule: AIGC_LABELING_RULE,
    ai_generated_fields: [...AIGC_GENERATED_FIELDS],
  }
}

/* ── 逐条判定（由既有 source 列派生，不改数据库）────────────────── */

/**
 * 判定为 AI 生成合成内容的 `source` 取值。抽成常量便于护栏逐字核对两端口径。
 */
export const AI_GENERATED_SOURCES: string[] = ['photo', 'text', 'barcode']

/**
 * 由既有 `source` 列判定一条饮食记录是否含 AI 生成合成内容。
 *
 * 🔴 **刻意不改数据库**：判定完全派生自 `db/migrations/0030-schema.sql:93` 已有的
 * `source` 列（'photo' | 'text' | 'barcode' | 'manual'），不新增列、不写迁移。
 *
 * ## barcode 的口径与 LogSheet 的 isAiDraft 有一处**已知偏差**，此处从宽
 *
 * `source = 'barcode'` 实际覆盖两条来路（见 `src/pages/LogSheet.tsx:191` 注释）：
 *   1. 扫码命中 Open Food Facts 商品库（`fromPackaged`）—— 第三方实测数据，**不是** AI 生成；
 *   2. 商品库查不到时拍包装、由视觉模型读营养表（`identifyPackagedFood` → `toDraft`）—— **是** AI 生成。
 * 界面上靠 `isAiDraft()` 的 `confidence !== undefined` 区分二者，但
 * **confidence 从未落库**（`db/migrations/` 全库零命中该列）→ 导出侧无法从 source 复原区分。
 *
 * 两难之下选择**从宽（barcode 一律判为 AI 生成）**：
 *   · 漏标 = 复现第 9 案被点名的违规事实，是《标识办法》直接规制的对象；
 *     多标 = 对商品库数据偏保守，属「过度谨慎的提示」，不构成对用户的不利陈述；
 *   · 与 legal.ts「四之一」向用户承诺的标识范围不冲突：该条承诺「AI 读取包装营养表
 *     产生的条目会标注」，从宽只是把商品库条目一并标了，并未少标任何一条。
 * 要做到精确需把 provenance / confidence 持久化（改库 + 改网关），本轮明确不做。
 *
 * @param source 数据库 `source` 列原值；类型取 unknown 以兼容两端各自的 RecordSource 定义
 */
export function isAiGeneratedSource(source: unknown): boolean {
  return typeof source === 'string' && AI_GENERATED_SOURCES.includes(source)
}
