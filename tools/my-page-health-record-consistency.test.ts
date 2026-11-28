/**
 * 护栏 28 · 「我的」页 v3 / 健康档案 / 智能设备 四端一致（2026-11-14）
 *
 * ## 为什么需要这道护栏
 * ① 宫格 4 项或列表 4 项在某端漏一项、改名、换成硬编码文案 → 四端长得不一样；
 * ② 三处收敛被回退（积分双入口 / 数据统计独立页 / 4 格现场 calcTarget() 双口径）；
 * ③ 健康档案摆出体脂率、腰臀比、血糖等库里根本不存在的字段或医学结论，
 *    与 legal.ts「不构成医疗诊断」冲突，且会牵动隐私政策与 LEGAL_UPDATED；
 * ④ 智能设备摆出不可点的「绑定」按钮 / 把 planned 设备写成可连接 → 假功能；
 * ⑤ 用户点名保留的会员卡、升级、体重打卡、导出/清空、注销、退出登录被顺手删掉。
 *
 * ## 护栏断言三铁律
 * ① 一个 it() 只一条断言；
 * ② 能动态取真值就不做静态匹配（菜单项 / 锚点 / 设备目录都从 shared 动态取）；
 * ③ 代码断言一律在 stripComments() 之后做，注释里的说明不算数。
 *
 * 运行：npx vitest run tools/my-page-health-record-consistency.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MY_PAGE_SECTION_GRID, MY_PAGE_SECTION_LIST, MY_PAGE_SECTION_RECORDS,
  MY_PAGE_GRID_ITEMS, MY_PAGE_LIST_ITEMS,
  MY_PAGE_INVITE_LABEL, MY_PAGE_REPORT_ARIA,
  MY_PAGE_TODAY_TITLE, MY_PAGE_TODAY_HINT, MY_PAGE_TODAY_ARIA,
  MY_PAGE_TODAY_LABELS, MY_FOOD_HINT,
  HEALTH_APP_CATALOG, FUTURE_DEVICE_CATALOG, DEVICE_STATUS_LABEL, smartDeviceLine,
  WATCH_CATALOG, WATCH_BIND_ENTRY, WATCH_BIND_TITLE,
  HEALTH_RECORD_ANCHORS, HEALTH_RECORD_COMPLETION,
  HEALTH_RECORD_COMPLETION_NOTE, HEALTH_RECORD_COMPLETION_FIELDS,
  HEALTH_RECORD_DISCLAIMER, HEALTH_RECORD_NO_MEDICAL,
  HEALTH_RECORD_EMPTY_MEAL, HEALTH_RECORD_EMPTY_WEIGHT, HEALTH_RECORD_EMPTY_EXERCISE,
  HEALTH_PLAN_TITLE,
  buildTodayTargetCore, buildCompletionCore, buildWeekRecipeViewCore,
  buildMyFoodViewCore, buildMealSplitCore, buildExerciseWeekCore,
  HEALTH_VENDOR_DB_VALUES, healthVendorToDb, isVendorConnected,
} from '@dbee/shared'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
// 新文件在「先红」阶段尚不存在：此时返回空串让断言自然失败，而不是抛错中断整份护栏
const readMaybe = (p: string): string => existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : ''

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

/**
 * 从一段 brand.ts 分支源码里，只提取**用户可见文案**（label / tip 的单引号字符串字面量）。
 *
 * 🔴 为什么不能直接对整段断言「不含品牌字样」（HW-1 首版就是这么写的 → 假红）：
 *   整段里必然含 `vendor: 'huawei'` / `vendor: 'xiaomi'` 这个**内部路由枚举值** ——
 *   它是分派依据、必须保留，与华为资质驳回理由所指的「在入口或提示消息中显示品牌名」
 *   完全不是一回事。合规约束只针对 label / tip 这两个渲染给用户的字段。
 */
function userFacingText(seg: string): string {
  const out: string[] = []
  for (const key of ['label', 'tip']) {
    const m = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(seg)
    if (m) out.push(m[1])
  }
  return out.join(' ')
}

/**
 * 取出某个 function 声明的**函数体**（含外层大括号），找不到返回空串。
 *
 * 🔴 为什么必须按函数体断言，而不是全文 grep：
 *   werun.ts 里主动路径（ensureWerunAuth）**必须**保留 authorize/openSetting，
 *   静默路径（checkWerunAuthSilent/isPrivacyAlreadyGranted/syncWechatStepsSilent）
 *   **绝不能**出现它们。全文 grep 无法区分两者 → 要么放过违规，要么冤枉合法代码。
 * 实现细节：先配对参数列表括号，再跳过返回类型注解里的泛型（`Promise<{a:b}>`
 * 这种类型字面量的 `{` 不是函数体开头），最后做大括号配对。
 */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return ''
  let i = m.index + m[0].length - 1 // 指向参数列表的 '('
  let p = 0
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') p++
    else if (ch === ')') { p--; if (p === 0) { i++; break } }
  }
  let g = 0
  let start = -1
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '<') g++
    else if (ch === '>') g = Math.max(0, g - 1)
    else if (ch === '{' && g === 0) { start = i; break }
  }
  if (start < 0) return ''
  let d = 0
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(start, j + 1) }
  }
  return src.slice(start)
}

const WEB_PROFILE = (): string => stripComments(read('src/pages/ProfileScreen.tsx'))
const MINI_PROFILE = (): string => stripComments(read('mini/src/pages/profile/profile.tsx'))
const WEB_LIB = (): string => stripComments(read('src/lib/myPage.ts'))
const MINI_LIB = (): string => stripComments(read('mini/src/lib/myPage.ts'))
const WEB_HR = (): string => stripComments(read('src/components/HealthRecordSheet.tsx'))
const MINI_HR = (): string => stripComments(read('mini/src/components/HealthRecordSheet.tsx'))
const WEB_FOOD = (): string => stripComments(read('src/components/MyFoodSheet.tsx'))
const MINI_FOOD = (): string => stripComments(read('mini/src/components/MyFoodSheet.tsx'))
const WEB_WEEK = (): string => stripComments(read('src/components/WeekRecipeSheet.tsx'))
const MINI_WEEK = (): string => stripComments(read('mini/src/components/WeekRecipeSheet.tsx'))
const WEB_DEVICE = (): string => stripComments(read('src/components/SmartDeviceSheet.tsx'))
const MINI_DEVICE = (): string => stripComments(read('mini/src/components/SmartDeviceSheet.tsx'))
// WX-1~WX-3：微信运动网关端点 / 小程序主动同步 / 门面缓存优先
const WERUN_SERVER = (): string => stripComments(readMaybe('server/lib/werun.mjs'))
const WERUN_MINI = (): string => stripComments(readMaybe('mini/src/lib/werun.ts'))
const MINI_HEALTH_WX = (): string => stripComments(read('mini/src/lib/health/index.ts'))
// WX-3（2026-11-18）：首页刷新时机断言用 —— 实时刷新只在登录/进入，轮询读缓存
const MINI_INDEX_WX = (): string => stripComments(read('mini/src/pages/index/index.tsx'))
const SERVER_APP_WX = (): string => stripComments(read('server/lib/app.mjs'))
const SHARED_MY = (): string => stripComments(read('packages/shared/src/myPage.ts'))
const SHARED_HR = (): string => stripComments(read('packages/shared/src/healthRecord.ts'))
const SHARED_INDEX = (): string => stripComments(read('packages/shared/src/index.ts'))
const MINI_SCSS = (): string => stripComments(read('mini/src/components/MyPageSheets.scss'))
const APP = (): string => stripComments(read('src/App.tsx'))

const BOTH_PROFILES = (): string[] => [WEB_PROFILE(), MINI_PROFILE()]
const BOTH_LIBS = (): string[] => [WEB_LIB(), MINI_LIB()]
const BOTH_HR = (): string[] => [WEB_HR(), MINI_HR()]
const ALL_SHEETS = (): string[] => [
  WEB_HR(), MINI_HR(), WEB_FOOD(), MINI_FOOD(), WEB_WEEK(), MINI_WEEK(), WEB_DEVICE(), MINI_DEVICE(),
]

/* ── 一、菜单结构（动态真值 + every() 防假绿） ─────────────────── */

describe('「我的」页结构 · 四端一致', () => {
  it('宫格恰好 4 项', () => {
    expect(MY_PAGE_GRID_ITEMS.length).toBe(4)
  })

  it('列表恰好 4 项', () => {
    expect(MY_PAGE_LIST_ITEMS.length).toBe(4)
  })

  it('宫格 4 项 key 无重复', () => {
    expect(new Set(MY_PAGE_GRID_ITEMS.map((x) => x.key)).size).toBe(4)
  })

  it('列表 4 项 key 无重复', () => {
    expect(new Set(MY_PAGE_LIST_ITEMS.map((x) => x.key)).size).toBe(4)
  })

  it('两端都渲染 shared 宫格数组', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('MY_PAGE_GRID_ITEMS.map'))).toBe(true)
  })

  it('两端都渲染 shared 列表数组', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('MY_PAGE_LIST_ITEMS.map'))).toBe(true)
  })

  it('两端都有 openGrid 分发函数', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('function openGrid'))).toBe(true)
  })

  it('两端都有 openList 分发函数', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('function openList'))).toBe(true)
  })

  MY_PAGE_GRID_ITEMS.forEach((item) => {
    it(`宫格「${item.label}」两端都有分发分支`, () => {
      expect(BOTH_PROFILES().every((x) => x.includes(`'${item.key}'`))).toBe(true)
    })
  })

  MY_PAGE_LIST_ITEMS.forEach((item) => {
    it(`列表「${item.label}」两端都有分发分支`, () => {
      expect(BOTH_PROFILES().every((x) => x.includes(`'${item.key}'`))).toBe(true)
    })
  })

  it('列表第 1 项就是体重管理方案', () => {
    expect(MY_PAGE_LIST_ITEMS[0].label).toBe(HEALTH_PLAN_TITLE)
  })

  it('三个分组标题都来自 shared（两端零硬编码）', () => {
    const titles = [MY_PAGE_SECTION_GRID, MY_PAGE_SECTION_LIST, MY_PAGE_SECTION_RECORDS]
    expect(titles.every((t) => BOTH_PROFILES().every((x) => !x.includes(`'${t}'`)))).toBe(true)
  })

  it('两端都用一个 activeSheet 状态管四个弹层', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('activeSheet'))).toBe(true)
  })
})

/* ── 二、三处收敛（18:35 授权） ───────────────────────────────── */

describe('三处重复收敛 · 不得回退', () => {
  it('收敛 1：账户区标签为「邀请好友」', () => {
    expect(MY_PAGE_INVITE_LABEL).toBe('邀请好友')
  })

  it('收敛 1：两端旧「蜜糖积分 · 邀请好友」零命中', () => {
    expect(BOTH_PROFILES().every((x) => !x.includes('蜜糖积分 · 邀请好友'))).toBe(true)
  })

  it('收敛 1：两端积分入口仍复用同一个既有弹层', () => {
    expect(WEB_PROFILE().includes('setInviteOpen(true)') && MINI_PROFILE().includes('goInvite()')).toBe(true)
  })

  it('收敛 2：列表第 4 项为「查看完整报告」', () => {
    expect(MY_PAGE_LIST_ITEMS[3].label).toBe('查看完整报告')
  })

  it('收敛 2：第 4 项箭头为 ↗（其余三项为 ›）', () => {
    expect(MY_PAGE_LIST_ITEMS[3].arrow === '↗' && MY_PAGE_LIST_ITEMS.slice(0, 3).every((x) => x.arrow === '›')).toBe(true)
  })

  it('收敛 2：两端都带报告深链 aria 文案', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('MY_PAGE_REPORT_ARIA'))).toBe(true)
  })

  it('收敛 2：aria 文案明确「切换到报告页」', () => {
    expect(MY_PAGE_REPORT_ARIA).toContain('切换到报告页')
  })

  it('收敛 2：主端 App 传入切 tab 回调', () => {
    expect(APP().includes("onOpenReport={() => setTab('report')}")).toBe(true)
  })

  it('收敛 2：mini 走既有报告页 navigateTo', () => {
    expect(MINI_PROFILE().includes("navigateTo({ url: '/pages/report/report' })")).toBe(true)
  })

  it('收敛 3：今日目标标题为「今日目标」', () => {
    expect(MY_PAGE_TODAY_TITLE).toBe('今日目标')
  })

  it('收敛 3：摘要提示写明「点按进方案」', () => {
    expect(MY_PAGE_TODAY_HINT).toContain('点按进方案')
  })

  it('收敛 3：两端今日目标块都带 aria 说明', () => {
    expect(BOTH_PROFILES().every((x) => x.includes('MY_PAGE_TODAY_ARIA'))).toBe(true)
  })

  it('收敛 3：两端页面零 target.calories 现场口径', () => {
    expect(BOTH_PROFILES().every((x) => !x.includes('target.calories'))).toBe(true)
  })

  it('收敛 3：两端页面零 target.protein_g 现场口径', () => {
    expect(BOTH_PROFILES().every((x) => !x.includes('target.protein_g'))).toBe(true)
  })

  it('收敛 3：两端页面零 target.carb_g 现场口径', () => {
    expect(BOTH_PROFILES().every((x) => !x.includes('target.carb_g'))).toBe(true)
  })

  it('收敛 3：两端页面零 target.fat_g 现场口径', () => {
    expect(BOTH_PROFILES().every((x) => !x.includes('target.fat_g'))).toBe(true)
  })

  it('收敛 3：两端适配层都调 buildHealthPlanView（落库真源）', () => {
    expect(BOTH_LIBS().every((x) => x.includes('buildHealthPlanView(p)'))).toBe(true)
  })

  it('收敛 3：两端适配层零 calcTarget', () => {
    expect(BOTH_LIBS().every((x) => !x.includes('calcTarget'))).toBe(true)
  })

  it('收敛 3：展示模型由 shared 统一构造', () => {
    expect(SHARED_MY().includes('buildTodayTargetCore')).toBe(true)
  })

  it('收敛 3：空档案兜底展示「—」且不编造 1800', () => {
    expect(buildTodayTargetCore({ calories: null, currentWeightKg: null, protein: null, carb: null, fat: null }).calories).toBe('—')
  })

  it('收敛 3：4 个数值标签仍完整保留', () => {
    expect(Object.keys(MY_PAGE_TODAY_LABELS).length).toBe(4)
  })
})

/* ── 三、用户点名保留模块零删减 ───────────────────────────────── */

describe('保留模块 · 两端零删除', () => {
  const WEB_KEEP = [
    'member-card', '升级', 'stat-grid', '体重打卡', '你在意的问题',
    '健康数据源', '通知提醒', '数据与隐私', '注销账号', '退出登录',
  ]
  WEB_KEEP.forEach((word) => {
    it(`主端保留「${word}」`, () => {
      expect(WEB_PROFILE().includes(word)).toBe(true)
    })
  })

  const MINI_KEEP = [
    'member-card', '升级', 'stat-grid', '体重打卡', '你在意的问题',
    '健康数据源', '通知提醒', '数据与隐私', '注销账号', '退出登录',
  ]
  MINI_KEEP.forEach((word) => {
    it(`mini 保留「${word}」`, () => {
      expect(MINI_PROFILE().includes(word)).toBe(true)
    })
  })

  it('两端会员卡类名完整（防止改名后子串匹配假绿）', () => {
    const exact = "className={`member-card ${pro ? 'is-pro' : ''}`}"
    expect(BOTH_PROFILES().every((x) => x.includes(exact))).toBe(true)
  })

  it('mini 既有独立入口全部保留（会员与订阅 / 我的食谱 / 自律榜单）', () => {
    expect(['会员与订阅', '我的食谱', '自律榜单'].every((w) => MINI_PROFILE().includes(w))).toBe(true)
  })

  it('不新建个人主页跳转入口', () => {
    expect(BOTH_PROFILES().every((x) => !x.includes('个人主页'))).toBe(true)
  })
})

/* ── 四、健康档案合规与真源 ───────────────────────────────────── */

describe('健康档案 · 四段 / 合规 / 零编造', () => {
  it('锚点恰好四段', () => {
    expect(HEALTH_RECORD_ANCHORS.length).toBe(4)
  })

  it('锚点顺序为核心指标 → 健康数据 → 饮食管理 → 运动记录', () => {
    expect([...HEALTH_RECORD_ANCHORS]).toEqual(['核心指标', '健康数据', '饮食管理', '运动记录'])
  })

  it('两端都渲染 shared 四段锚点', () => {
    expect(BOTH_HR().every((x) => x.includes('HEALTH_RECORD_ANCHORS.map'))).toBe(true)
  })

  it('资料填写完整度为 8 项', () => {
    expect(HEALTH_RECORD_COMPLETION_FIELDS.length).toBe(8)
  })

  it('进度条名称不含健康评分语义', () => {
    expect(HEALTH_RECORD_COMPLETION).toBe('资料填写完整度')
  })

  it('进度条免责必带「不代表健康评估」', () => {
    expect(HEALTH_RECORD_COMPLETION_NOTE).toContain('不代表健康评估')
  })

  it('两端档案页都带免责说明常量', () => {
    expect(BOTH_HR().every((x) => x.includes('HEALTH_RECORD_COMPLETION_NOTE') || x.includes('completion.note'))).toBe(true)
  })

  it('8 项全空时完整度为 0', () => {
    expect(buildCompletionCore({}).percent).toBe(0)
  })

  it('8 项全填时完整度为 100', () => {
    expect(buildCompletionCore({
      nickname: 'A', gender: 'male', age: 28, heightCm: 170,
      currentWeightKg: 68, targetWeightKg: 62, activityLevel: 'light', goal: 'lose',
    }).percent).toBe(100)
  })

  it('BMI 免责说明复用体重管理方案真源', () => {
    expect(HEALTH_RECORD_DISCLAIMER).toContain('不构成健康评估或医疗建议')
  })

  it('两端档案页都渲染 BMI 四段带', () => {
    expect(BOTH_HR().every((x) => x.includes('HEALTH_PLAN_BMI_BANDS.map'))).toBe(true)
  })

  it('两端档案页都带 bmi aria-label 非色彩编码', () => {
    expect(BOTH_HR().every((x) => x.includes('aria-label={bmiAria}') || x.includes("aria-label={bmiAria}"))).toBe(true)
  })

  it('档案底部写明不构成医疗建议', () => {
    expect(HEALTH_RECORD_NO_MEDICAL).toContain('不构成健康评估或医疗建议')
  })

  it('两端档案页都在正文中渲染底部免责常量（不是只留 import）', () => {
    expect(BOTH_HR().every((x) => x.includes('{HEALTH_RECORD_NO_MEDICAL}'))).toBe(true)
  })

  const FORBIDDEN_MEDICAL = ['体脂率', '腰臀比', '腰围', '臀围', '血糖', '用药', '疾病史', '过敏史', '饮酒史', '吸烟史']
  FORBIDDEN_MEDICAL.forEach((word) => {
    it(`库里不存在的字段「${word}」在档案代码与展示模型中零命中`, () => {
      expect([...BOTH_HR(), ...BOTH_LIBS(), SHARED_HR()].every((x) => !x.includes(word))).toBe(true)
    })
  })

  it('设备目录里的「血糖仪应用」只引导读取，不标成现在可连接', () => {
    expect(FUTURE_DEVICE_CATALOG.filter((d) => d.label.includes('血糖')).every((d) => d.status === 'guided')).toBe(true)
  })

  it('零医学结论文案', () => {
    expect([...ALL_SHEETS(), SHARED_HR()].every((x) => !x.includes('没有发现任何异常'))).toBe(true)
  })

  it('零「正常」诊断标签', () => {
    expect([...ALL_SHEETS(), SHARED_HR()].every((x) => !x.includes('正常'))).toBe(true)
  })

  it('零 plan_summary 旧 AI 建议', () => {
    expect([...ALL_SHEETS(), ...BOTH_LIBS(), SHARED_MY(), SHARED_HR()].every((x) => !x.includes('plan_summary'))).toBe(true)
  })

  it('零 forecastGoal 第二套达成日口径', () => {
    expect([...ALL_SHEETS(), ...BOTH_LIBS(), SHARED_MY(), SHARED_HR()].every((x) => !x.includes('forecastGoal'))).toBe(true)
  })

  it('单态渲染：四个新 Sheet 零 segment / 零 selectedGoal', () => {
    expect(ALL_SHEETS().every((x) => !x.includes('segment') && !x.includes('selectedGoal'))).toBe(true)
  })

  it('空态文案不摆 - 单位 占位', () => {
    expect([HEALTH_RECORD_EMPTY_MEAL, HEALTH_RECORD_EMPTY_WEIGHT, HEALTH_RECORD_EMPTY_EXERCISE]
      .every((t) => !t.includes('- '))).toBe(true)
  })

  it('今日餐次四柱由 shared 纯函数产出', () => {
    expect(buildMealSplitCore([{ meal_type: 'breakfast', calories: 300 }])[0].kcal).toBe(300)
  })

  it('本周餐次汇总由 shared 纯函数产出', () => {
    expect(buildWeekRecipeViewCore([{ log_date: '2026-11-14', calories: 200 }], ['2026-11-14'])[0].count).toBe(1)
  })

  it('我的食物展示模型由 shared 纯函数产出', () => {
    expect(buildMyFoodViewCore([{ name: 'A', items: [{ calories: 100 }, { calories: 50 }] }])[0].calories).toBe(150)
  })

  it('运动周汇总由 shared 纯函数产出', () => {
    expect(buildExerciseWeekCore([{ minutes: 30, calories: 200 }]).count).toBe(1)
  })
})

/* ── 五、智能设备诚实降级 ─────────────────────────────────────── */

describe('智能设备 · 零假功能', () => {
  it('健康应用目录 7 项', () => {
    expect(HEALTH_APP_CATALOG.length).toBe(7)
  })

  it('可真同步的仅 Apple（已真机验证）', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.status === 'available').map((d) => d.key)).toEqual(['apple'])
  })

  it('华为 / 小米 / Health Connect 为接入中，不得标成现在可连接', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.status === 'in_progress').map((d) => d.key)).toEqual(['health_connect', 'huawei', 'xiaomi'])
  })

  // HC-1（2026-11-18）：Health Connect 行必须存在且**不得**标 available。
  // 原生未接 SDK、零真机验收前标 available = 假功能（同 D7 原则）。
  it('HC-1 目录含 Health Connect 行（D1-A 拍板：单独一行，跨品牌统一层）', () => {
    expect(HEALTH_APP_CATALOG.some((d) => d.key === 'health_connect')).toBe(true)
  })

  it('HC-1 Health Connect 行未真机验收前禁止标 available（防假功能）', () => {
    expect(HEALTH_APP_CATALOG.find((d) => d.key === 'health_connect')?.status).toBe('in_progress')
  })

  it('vivo / OPPO 为引导查看，不给绑定', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.key === 'vivo' || d.key === 'oppo').every((d) => d.status === 'guided')).toBe(true)
  })

  it('更多设备全部为引导读取，不标成现在可连接', () => {
    expect(FUTURE_DEVICE_CATALOG.every((d) => d.status === 'guided')).toBe(true)
  })

  it('后续支持设备 6 项', () => {
    expect(FUTURE_DEVICE_CATALOG.length).toBe(6)
  })

  it('体脂秤读到体重后可以记入今天', () => {
    const line = smartDeviceLine('body-fat-scale', {
      weightKg: 62.4, bodyFatPct: 22, nutritionKcal: null, jumpCount: null, jumpMinutes: null, glucoseMmol: null,
      weightGranted: true, ropeGranted: true, nutritionGranted: true, glucoseGranted: true,
    }, null, 'app')
    expect(line.action).toBe('save-weight')
  })

  it('小程序不为体脂秤提供记入按钮', () => {
    const line = smartDeviceLine('body-fat-scale', null, null, 'mini')
    expect(line.action).toBe(null)
  })

  it('已读到 0 步时腕带显示今日 0 步，未读到才提示去连接', () => {
    expect(smartDeviceLine('band', null, 0, 'app').value).toBe('今日 0 步')
    expect(smartDeviceLine('band', null, null, 'app').value).toContain('连接系统健康')
  })

  it('只有体脂、没有体重时不提供记入', () => {
    const line = smartDeviceLine('body-fat-scale', {
      weightKg: null, bodyFatPct: 22, nutritionKcal: null, jumpCount: null, jumpMinutes: null, glucoseMmol: null,
      weightGranted: true, ropeGranted: true, nutritionGranted: true, glucoseGranted: true,
    }, null, 'app')
    expect(line.action).toBe(null)
    expect(line.value).toContain('22')
  })

  it('跳绳不足 1 分钟不提供记入', () => {
    const line = smartDeviceLine('jump-rope', {
      weightKg: null, bodyFatPct: null, nutritionKcal: null, jumpCount: 1, jumpMinutes: 0, glucoseMmol: null,
      weightGranted: true, ropeGranted: true, nutritionGranted: true, glucoseGranted: true,
    }, null, 'app')
    expect(line.action).toBe(null)
  })

  it('血糖只描述今日读数，并写明不上传', () => {
    const line = smartDeviceLine('glucose-app', {
      weightKg: null, bodyFatPct: null, nutritionKcal: null, jumpCount: null, jumpMinutes: null, glucoseMmol: 5.6,
      weightGranted: true, ropeGranted: true, nutritionGranted: true, glucoseGranted: true,
    }, null, 'app')
    expect(line.action).toBe(null)
    expect(line.value).toContain('今日最近')
    expect(line.value).toContain('不上传')
  })

  it('状态标签四档齐全', () => {
    expect(Object.keys(DEVICE_STATUS_LABEL).sort()).toEqual(['available', 'guided', 'in_progress', 'planned'])
  })

  it('两端设备页零「绑定」字样', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => !x.includes('绑定'))).toBe(true)
  })

  it('两端设备页都渲染 shared 设备目录', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('HEALTH_APP_CATALOG.map') && x.includes('FUTURE_DEVICE_CATALOG.map'))).toBe(true)
  })

  it('两端设备页连接按钮按当前机型目录项过滤', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => /d\.key === healthCatalogKeyForVendor\(vendorKey\)/.test(x))).toBe(true)
  })

  it('两端我的页向设备页传入当前机型', () => {
    expect([WEB_PROFILE(), MINI_PROFILE()].every((x) => x.includes('vendorKey={healthVendor.vendor}'))).toBe(true)
  })

  it('mini 今日目标摘要不再硬写 22 号大字', () => {
    expect(MINI_PROFILE().includes('fontSize: 22')).toBe(false)
  })

  it('mini 今日目标摘要复用 hint 弱化字体', () => {
    expect(/<Text className='hint'>\{MY_PAGE_TODAY_HINT\}<\/Text>/.test(MINI_PROFILE())).toBe(true)
  })
})

/* ── 六、shared 真源与数值口径 ────────────────────────────────── */

describe('shared 单一真源 / 数值口径', () => {
  it('index.ts 导出 myPage', () => {
    expect(SHARED_INDEX().includes("export * from './myPage'")).toBe(true)
  })

  it('index.ts 导出 healthRecord', () => {
    expect(SHARED_INDEX().includes("export * from './healthRecord'")).toBe(true)
  })

  it('两端适配层都从 @dbee/shared 取真值', () => {
    expect(BOTH_LIBS().every((x) => x.includes("from '@dbee/shared'"))).toBe(true)
  })

  it('两端适配层形状一致（导出函数集合相同）', () => {
    const names = (s: string) => [...s.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort()
    expect(JSON.stringify(names(WEB_LIB()))).toBe(JSON.stringify(names(MINI_LIB())))
  })

  it('shared 新文件统一走 roundTo，零手写舍入', () => {
    expect([SHARED_MY(), SHARED_HR()].every((x) => !x.includes('Math.round('))).toBe(true)
  })

  it('shared 新文件都 import numfmt.roundTo', () => {
    expect([SHARED_MY(), SHARED_HR()].every((x) => x.includes("import { roundTo } from './numfmt'"))).toBe(true)
  })

  it('mini 样式表独立 mp- 前缀，不依赖页面级 scss', () => {
    expect(MINI_SCSS().includes('.mp-sheet')).toBe(true)
  })

  it('mini 样式表辅助文字用 #757067（WCAG AA）', () => {
    expect(MINI_SCSS().includes('#757067')).toBe(true)
  })

  it('mini 样式表触控目标 ≥88px（designWidth 750 的 2 倍）', () => {
    expect(MINI_SCSS().includes('min-height: 88px')).toBe(true)
  })
})

/* ── 七、我的食物 · 能力对齐（可记一餐 / 可删除）────────────────── */
// 背景：旧「我的食物」只读，但文案写「可一键复记」，用户点进去啥也做不了。
// 与主端食谱能力对齐后，两端须都提供「记一餐」「删除」的真实现。

describe('我的食物 · 能力对齐', () => {
  // 匹配 import 行而非裸串，避免「删了 import、调用残留」的假绿
  const apiImport = (x: string) => x.match(/import \{[^}]*\} from ['"][^'"]*api['"]/)?.[0] ?? ''

  it('两端都从 api import insertMeals（记一餐真落库）', () => {
    expect([WEB_FOOD(), MINI_FOOD()].every((x) => apiImport(x).includes('insertMeals'))).toBe(true)
  })

  it('两端都从 api import deleteRecipe（删除食谱）', () => {
    expect([WEB_FOOD(), MINI_FOOD()].every((x) => apiImport(x).includes('deleteRecipe'))).toBe(true)
  })

  it('两端都有二次确认态 pendingDelete', () => {
    expect([WEB_FOOD(), MINI_FOOD()].every((x) => x.includes('pendingDelete'))).toBe(true)
  })

  it('两端都有记一餐处理函数 logMeal', () => {
    expect([WEB_FOOD(), MINI_FOOD()].every((x) => x.includes('logMeal'))).toBe(true)
  })

  it('两端都有删除处理函数 handleDelete', () => {
    expect([WEB_FOOD(), MINI_FOOD()].every((x) => x.includes('handleDelete'))).toBe(true)
  })

  it('两端都从 @dbee/shared 取操作文案常量', () => {
    expect([WEB_FOOD(), MINI_FOOD()].every((x) => x.includes('MY_FOOD_LOGGED') && x.includes('MY_FOOD_ACTION_'))).toBe(true)
  })

  it('我的食物提示文案不再误导为「记录饮食时」', () => {
    expect(MY_FOOD_HINT.includes('记录饮食时')).toBe(false)
  })
})

/* ── 八、智能手表 · 手表端蜜蜂健康 App 绑定 ───────────────────── */
// 入口卡片「其他 → 手表端蜜蜂健康App绑定」→ 打开「智能手表」页，列 5 个品牌。
// 诚实原则：D-Bee 不直连手表硬件；每个品牌的「绑定」= 连接其对应的系统健康平台，
// 状态复用 HEALTH_APP_CATALOG（单一真源）。零假「扫码绑定」按钮。

describe('智能手表 · 手表端绑定', () => {
  it('手表目录恰好 5 个品牌', () => {
    expect(WATCH_CATALOG.length).toBe(5)
  })

  it('手表品牌顺序与竞品图一致（OPPO/HUAWEI/Apple/VIVO/XIAOMI）', () => {
    expect(WATCH_CATALOG.map((w) => w.key)).toEqual(['oppo', 'huawei', 'apple', 'vivo', 'xiaomi'])
  })

  it('每个手表品牌都映射到健康应用目录（复用真状态，不另起炉灶）', () => {
    expect(WATCH_CATALOG.every((w) => HEALTH_APP_CATALOG.some((d) => d.key === w.key))).toBe(true)
  })

  it('手表品牌说明不含「规划中」三个字（给具体进度）', () => {
    expect(WATCH_CATALOG.every((w) => !w.statusNote.includes('规划中'))).toBe(true)
  })

  it('两端设备页都从 @dbee/shared 取手表目录', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('WATCH_CATALOG'))).toBe(true)
  })

  it('两端设备页都渲染手表目录（WATCH_CATALOG.map）', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('WATCH_CATALOG.map'))).toBe(true)
  })

  it('两端都有手表视图切换状态 watchView', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('watchView'))).toBe(true)
  })

  it('两端入口卡片文案取自 shared 的 WATCH_BIND_ENTRY', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('WATCH_BIND_ENTRY'))).toBe(true)
  })

  it('两端手表页零假「扫码绑定」按钮', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => !x.includes('扫码绑定'))).toBe(true)
  })

  it('两端手表页标题取自 shared 的 WATCH_BIND_TITLE', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('WATCH_BIND_TITLE'))).toBe(true)
  })

  it('两端手表页 Apple 行连接真走 onConnect（不是假绑定）', () => {
    const hasRealConnect = (x: string) => x.split('\n').some((line) => line.includes('WATCH_BIND_ACTION_CONNECT') && line.includes('onConnect'))
    expect([WEB_DEVICE(), MINI_DEVICE()].every(hasRealConnect)).toBe(true)
  })

  it('两端手表页都展示系统健康服务多设备路径说明', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('WATCH_BIND_HC_NOTE'))).toBe(true)
  })

  it('手表入口卡片的「绑定」字样来自 shared 常量（组件零中文绑定字面量）', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => !x.includes('手表端蜜蜂健康App绑定'))).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 护栏 WX · 微信运动接入 WX-1~WX-3（2026-11-17，WX-0 隐私指引已过）
 * 业务代码只从服务端解密值取步数，客户端不得传 steps；同步必须用户主动触发，
 * 自动轮询只读本地缓存、绝不调 wx.getWeRunData（平台规范 + 零假功能）。
 * ══════════════════════════════════════════════════════════════════════ */
describe('护栏 WX · 微信运动网关端点与小程序主动同步', () => {
  // ── WX-1 网关端点 werun.mjs ────────────────────────────────
  it('WX-1 网关注册 werun/sync 端点（app.mjs）', () => {
    expect(SERVER_APP_WX().includes('werun/sync')).toBe(true)
  })

  it('WX-1 端点只接受 code/appid/encryptedData/iv，绝不读客户端 steps', () => {
    const c = WERUN_SERVER()
    expect(/body\.steps|body\?\.steps|['"]steps['"]\s*:\s*body/.test(c)).toBe(false)
  })

  it('WX-1 端点校验 Bearer 归属（authOwnerId/Strict）', () => {
    expect(/authOwnerId(Strict)?\s*\(/.test(WERUN_SERVER())).toBe(true)
  })

  it('WX-1 端点校验 openid 归属与 token owner 一致（403 防串号）', () => {
    expect(/wx:\$\{|403|forbidden/.test(WERUN_SERVER())).toBe(true)
  })

  it('WX-1 端点 AES-128-CBC 解密（createDecipheriv + aes-128-cbc）', () => {
    const c = WERUN_SERVER()
    expect(c.includes('createDecipheriv') && c.includes('aes-128-cbc')).toBe(true)
  })

  it('WX-1 端点校验 watermark.appid 防串包', () => {
    expect(/watermark/.test(WERUN_SERVER())).toBe(true)
  })

  it('WX-1 端点 session_key 瞬时内存，不落库不下发（无 saveSessionKey/loadSessionKey）', () => {
    const c = WERUN_SERVER()
    expect(!c.includes('saveSessionKey') && !c.includes('loadSessionKey')).toBe(true)
  })

  it('WX-1 端点只返回当天单条步数（无 stepInfoList 全量回传）', () => {
    const c = WERUN_SERVER()
    expect(/stepInfoList/.test(c) && !/body:\s*\{[^}]*stepInfoList/.test(c)).toBe(true)
  })

  // ── WX-2 小程序主动同步 werun.ts ──────────────────────────
  it('WX-2 小程序 werun.ts 存在且暴露主动同步函数', () => {
    expect(/export async function syncWechatStepsActive/.test(WERUN_MINI())).toBe(true)
  })

  it('WX-2 主动同步走隐私授权门禁', () => {
    expect(/ensurePrivacyAuthorized/.test(WERUN_MINI())).toBe(true)
  })

  it('WX-2 主动同步请求 scope.werun 授权', () => {
    expect(/scope\.werun/.test(WERUN_MINI())).toBe(true)
  })

  it('WX-2 主动同步调用 wx.login 取同批次 code', () => {
    expect(/Taro\.login|wx\.login/.test(WERUN_MINI())).toBe(true)
  })

  it('WX-2 主动同步调 getWeRunData 取密文', () => {
    expect(/getWeRunData/.test(WERUN_MINI())).toBe(true)
  })

  it('WX-2 上传网关的 payload 只含密文四元组，绝不含 steps', () => {
    const c = WERUN_MINI()
    // 精准匹配「传给 gatewayPost 的 payload 对象」这一处，而非全文（本地结果体/缓存里的 steps 是合法的）
    const payload = c.match(/const payload\s*=\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(
      /code/.test(payload) && /appid/.test(payload) &&
        /encryptedData/.test(payload) && /\biv\b/.test(payload) && !/steps/.test(payload),
      '上传给网关的 payload 必须只有 code/appid/encryptedData/iv，steps 只能来自服务端解密',
    ).toBe(true)
  })

  it('WX-2 code 失效自动重试一次', () => {
    expect(/retry|重试|attempt|invalid_grant/.test(WERUN_MINI())).toBe(true)
  })

  it('WX-2 同步结果写本地缓存（kvSet 或等价），带 syncedAt', () => {
    expect(/kvSet/.test(WERUN_MINI()) && /syncedAt/.test(WERUN_MINI())).toBe(true)
  })

  // ── WX-3 门面：实时静默同步（已授权）+ 缓存兜底（未授权）──────────
  it('WX-3 mini 门面 syncFromHealth 真调用缓存读取作为兜底（非仅 import 标识符）', () => {
    expect(/readWechatStepsCache\(\)/.test(MINI_HEALTH_WX())).toBe(true)
  })

  it('WX-3 mini 门面 connectHealth 真调用主动同步（非仅 import 标识符）', () => {
    expect(/syncWechatStepsActive\(\)/.test(MINI_HEALTH_WX())).toBe(true)
  })

  /* 🔴 2026-11-18 修订：原「门面文件零 getWeRunData」已失效且变成假绿。
   *   旧断言的**意图**是「自动路径不得凭生命周期弹授权框」，但它用「门面文件里
   *   不出现 getWeRunData 字面量」来代理该意图。用户实测反馈「连接后步数不刷新 /
   *   登录不实时」后，门面改为默认静默实时同步：getWeRunData 仍只写在 werun.ts，
   *   门面经 syncWechatStepsSilent() 间接调用 → 旧断言**字面照样通过，意图已被推翻**。
   *   故改为直接断言真实意图：静默路径零弹框 + 只有明确已授权才读取。 */
  it('WX-3 静默路径 checkWerunAuthSilent 存在且被 syncWechatStepsSilent 真实调用', () => {
    const c = WERUN_MINI()
    expect(
      /export async function syncWechatStepsSilent/.test(c) &&
        fnBody(c, 'syncWechatStepsSilent').includes('checkWerunAuthSilent()'),
    ).toBe(true)
  })

  it('WX-3 静默路径只在 scope.werun 明确为 true 时才读取（false/undefined 一律跳过）', () => {
    expect(fnBody(WERUN_MINI(), 'checkWerunAuthSilent').includes('(await readWerunScope()) !== true')).toBe(true)
  })

  it('WX-3 静默路径零弹框：不出现 authorize / openSetting / requirePrivacyAuthorize', () => {
    const c = WERUN_MINI()
    const silent = ['checkWerunAuthSilent', 'isPrivacyAlreadyGranted', 'syncWechatStepsSilent']
      .map((n) => fnBody(c, n)).join('\n')
    // silent.length>0 防「函数名写错→取到空串→断言恒真」的假绿
    expect(silent.length > 0 && !/\.authorize!?\s*\(|openSetting|requirePrivacyAuthorize/.test(silent)).toBe(true)
  })

  it('WX-3 静默门禁用只读的 getPrivacySetting（needAuthorization 为真即放弃，不弹框）', () => {
    const b = fnBody(WERUN_MINI(), 'isPrivacyAlreadyGranted')
    expect(b.includes('getPrivacySetting') && b.includes('!s.needAuthorization')).toBe(true)
  })

  it('WX-3 主动路径仍会请求授权（ensureWerunAuth 保留 authorize/openSetting，两条路径不混）', () => {
    const b = fnBody(WERUN_MINI(), 'ensureWerunAuth')
    // 🔴 代码形态是 `wx.authorize!({…})`（TS 非空断言），正则必须容忍那个 `!`，
    //   否则写成 /\.authorize\(/ 会漏匹配 → 断言假红（本轮实测踩过）
    expect(/\.authorize!?\s*\(/.test(b) && /openSetting/.test(b)).toBe(true)
  })

  it('WX-3 门面 syncFromHealth 支持 live 开关，且默认走实时（未显式传 false 即实时）', () => {
    expect(/opts\?\.live !== false/.test(MINI_HEALTH_WX())).toBe(true)
  })

  it('WX-3 门面把 connectHealth 当次步数回传给调用方（连接成功即刻刷新，不等缓存）', () => {
    expect(/steps: r\.steps/.test(MINI_HEALTH_WX())).toBe(true)
  })

  it('WX-3 首页 60s 轮询只读缓存（live:false），实时刷新仅用于登录/进入时机', () => {
    expect(/setInterval\(\(\) => \{ void refreshHealth\(false\) \}/.test(MINI_INDEX_WX())).toBe(true)
  })

  it('WX-3 首页在 useDidShow 里实时刷新（tabBar 页不重新 mount，否则跨页返回步数不更新）', () => {
    expect(/void refreshHealth\(true\)/.test(MINI_INDEX_WX())).toBe(true)
  })

  it('WX-3 主端 wechat-miniprogram 分支文案不再说「接入正在准备中」', () => {
    expect(!read('src/lib/health/index.ts').includes('微信运动接入正在准备中')).toBe(true)
  })

  it('WX-3 weapp 目录 status 仍 planned（真机验收前不标 available，零假绿）', () => {
    expect(HEALTH_APP_CATALOG.find((d) => d.key === 'weapp')?.status).toBe('planned')
  })
})

// ── WX-4 连接态串台：health_vendor 来源判定（2026-11-17）──────────
// 验收：iPhone App 连 Apple 健康后，小程序不显示「微信运动已连接」。
describe('护栏 28-WX4 · health_vendor 跨端串台防护', () => {
  // 真源纯函数断言（shared 已实现，应为绿）
  it('WX-4 合法来源值恰好 5 个（apple/health_connect/huawei/xiaomi/werun）', () => {
    expect([...HEALTH_VENDOR_DB_VALUES].sort().join(',')).toBe('apple,health_connect,huawei,werun,xiaomi')
  })

  it('WX-4 品牌→来源映射：apple/huawei/xiaomi/wechat-miniprogram 各有来源，web 无', () => {
    expect(
      healthVendorToDb('apple') === 'apple' && healthVendorToDb('huawei') === 'huawei' &&
        healthVendorToDb('xiaomi') === 'xiaomi' && healthVendorToDb('wechat-miniprogram') === 'werun' &&
        healthVendorToDb('web') === null,
    ).toBe(true)
  })

  it('WX-4 新数据按来源严格判定：apple 来源在微信运动端不算已连接（杜绝串台）', () => {
    expect(isVendorConnected(true, 'apple', 'werun')).toBe(false)
  })

  it('WX-4 新数据同来源算已连接', () => {
    expect(isVendorConnected(true, 'werun', 'werun')).toBe(true)
  })

  it('WX-4 旧数据无来源回退布尔（兼容旧包，不丢连接态）', () => {
    expect(isVendorConnected(true, null, 'werun')).toBe(true)
  })

  it('WX-4 未连接恒 false', () => {
    expect(isVendorConnected(false, 'werun', 'werun')).toBe(false)
  })

  // HC-1（2026-11-18）：Health Connect 来源映射。缺此映射时 HC 连接态会写成
  // 「有 connected、无 vendor」→ isVendorConnected 命中「旧数据回退布尔」→ WX-4 串台复发。
  it('HC-1 healthVendorToDb 映射 health_connect → health_connect（消除串台复发陷阱）', () => {
    expect(healthVendorToDb('health_connect')).toBe('health_connect')
  })

  it('HC-1 health_connect 来源在微信运动端不算已连接（杜绝串台）', () => {
    expect(isVendorConnected(true, 'health_connect', 'werun')).toBe(false)
  })

  // ── HC-1 前端形状（2026-11-18）：第三适配器与门面分派，与 iOS 侧同构 ──

  it('HC-1 适配器接口三方法全可选（旧插件无方法 → 零回归）', () => {
    const src = stripComments(read('src/lib/health/connect.ts'))
    expect(/healthConnectStatus\?:\s*\(\)\s*=>\s*Promise<\{\s*available:\s*boolean/.test(src) &&
      /requestHealthConnectAuthorization\?:\s*\(\)\s*=>\s*Promise</.test(src) &&
      /fetchHealthConnectToday\?:\s*\(\)\s*=>\s*Promise</.test(src)).toBe(true)
  })

  it('HC-1 可用性走「异步 probe + 模块级缓存」，同步读缓存（跨进程查询不打满热路径）', () => {
    const src = stripComments(read('src/lib/health/connect.ts'))
    expect(/let availabilityCache: boolean \| null = null/.test(src) &&
      /export async function probeHealthConnectAvailability\(force = false\): Promise<boolean>/.test(src) &&
      /if \(availabilityCache !== null && !force\) return availabilityCache/.test(src) &&
      /export function isHealthConnectAvailable\(\): boolean \{\s*return isAndroid\(\) && availabilityCache === true/.test(src)).toBe(true)
  })

  it('HC-1 门面 Android 分派 Health Connect 优先于厂商 SDK', () => {
    const body = fnBody(stripComments(read('src/lib/health/index.ts')), 'getHealthVendor')
    expect(/if \(isHealthConnectAvailable\(\)\) return HEALTH_CONNECT_INFO\s*\n\s*if \(healthConnectInstallOffered\(\)\) return HEALTH_CONNECT_INSTALL_INFO\s*\n\s*return detectHealthVendor\(\)/.test(body)).toBe(true)
  })

  it('HC-1 连接/同步/已连接判定在取 vendor 前先 await probe（消除缓存未热的时序误判）', () => {
    const src = stripComments(read('src/lib/health/index.ts'))
    const fns = ['connectHealth', 'syncFromHealth', 'isHealthConnected'].map((n) => fnBody(src, n))
    expect(fns.every((b) => b.includes('await probeHealthConnectAvailability()'))).toBe(true)
  })

  it('HC-1 连接成功写 health_vendor: health_connect（来源落库，防 WX-4 串台）', () => {
    const body = fnBody(stripComments(read('src/lib/health/index.ts')), 'connectHealth')
    expect(/health_vendor:\s*'health_connect'/.test(body)).toBe(true)
  })

  it('HC-1 两端健康页挂载时 probe 并以 hcReady 触发 useMemo 重算（UI 入口时序）', () => {
    const pages = ['src/pages/Dashboard.tsx', 'src/pages/ProfileScreen.tsx'].map((p) => stripComments(read(p)))
    expect(pages.every((x) =>
      /probeHealthConnectAvailability\(true\)/.test(x) &&
      x.includes('const healthVendor = useMemo(() => getHealthVendor(), [hcEpoch])'))).toBe(true)
  })

  it('HC-1 mini 端不引入 Health Connect 适配器（小程序无 HC，形状钉死）', () => {
    // ⚠️ 词边界：health_connected（已连接布尔列）含 health_connect 前缀，须排除
    expect(MINI_PROFILE().includes('probeHealthConnectAvailability') ||
      /\bhealth_connect\b(?!ed)/.test(MINI_HEALTH_WX())).toBe(false)
  })

  // ── HC-3 读数挂起兜底（2026-11-18 小米 15 Ultra 实测「连上但一直没反应」）──
  //
  // 根因两条，缺一不可：
  //  ① `aggregate()` 是跨进程 suspend 调用，厂商 ROM 上可能**永不返回**。原生侧的
  //     CoroutineExceptionHandler 只能兜「抛异常」，兜不住「一直挂起」→ Promise
  //     不 settle → syncFromHealth() 不返回 → UI 永停在「正在读取」。
  //  ② UI 只用 `!hasHealthData` 判「还在读取中」，但「读完且今天真是 0 步 / 超时
  //     降级」**同样**满足该条件 → 文案永驻不消失。
  // 两条都修完，用户才可能看到「读数结论」而不是无限转圈。

  it('HC-3 读数跨进程调用必须套硬超时（挂起不返回时如实降级，绝不用假数据填空）', () => {
    const src = stripComments(read('src/lib/health/connect.ts'))
    expect(
      /const HC_FETCH_TIMEOUT_MS = 8_000/.test(src) &&
        /function withTimeout<T>\(p: Promise<T>, ms: number, onTimeout: \(\) => T\): Promise<T>/.test(src) &&
        fnBody(src, 'fetchHealthConnectToday').includes('withTimeout(plugin.fetchHealthConnectToday(), HC_FETCH_TIMEOUT_MS'),
      'aggregate() 挂起不返回 → Promise 永不 settle → UI 永停「正在读取」',
    ).toBe(true)
  })

  it('HC-3 超时降级为 error 而非「0 步」（零假功能：挂起不等于今天没运动）', () => {
    const body = fnBody(stripComments(read('src/lib/health/connect.ts')), 'fetchHealthConnectToday')
    expect(
      /status: 'error'/.test(body) && /数据超时/.test(body) && !/status: 'ok'/.test(body),
      '超时伪装成 0 步 → 用户以为自己没运动，且永远看不出读数其实失败了',
    ).toBe(true)
  })

  it('HC-3 withTimeout 不用 Promise.race（race 会让迟到的 rejection 逃逸成 unhandledrejection）', () => {
    // 🔴 这条**不能用 fnBody**：withTimeout 是泛型声明 `function withTimeout<T>(…)`，
    //    fnBody 的正则要求名字后紧跟 `(` → 匹配不到，返回空串 → 断言假红。
    //    改为全文件断言，且「不含 Promise.race」在全文口径下反而更严（整份适配器都不许用）。
    const src = stripComments(read('src/lib/health/connect.ts'))
    expect(
      !src.includes('Promise.race') &&
        /function withTimeout<T>\(p: Promise<T>, ms: number, onTimeout: \(\) => T\): Promise<T> \{[\s\S]*?let settled = false[\s\S]*?p\.then\(/.test(src),
      'race 超时后不消费 p 的迟到 rejection → WebView 报 unhandledrejection',
    ).toBe(true)
  })

  it('HC-3 probe 超时不写缓存（一次系统卡顿不得把 HC 永久判死，下次仍可重探）', () => {
    const body = fnBody(stripComments(read('src/lib/health/connect.ts')), 'probeHealthConnectAvailability')
    expect(
      /withTimeout<HealthConnectProbeResult>\(/.test(body) &&
        /if \(res\?\.timedOut === true\) return false/.test(body),
      'probe 超时后缓存 false → 用户重开 App 也永远看不到 HC 入口',
    ).toBe(true)
  })

  it('HC-3 UI 必须区分「读取进行中」与「读取已结束但无数据」（healthSyncSettled）', () => {
    const src = stripComments(read('src/pages/Dashboard.tsx'))
    expect(
      /const \[healthSyncSettled, setHealthSyncSettled\] = useState\(false\)/.test(src) &&
        /healthConnectable && healthConnected && !hasHealthData && \(\s*<div[\s\S]{0,300}healthSyncSettled \?/.test(src),
      '只用 !hasHealthData 判「正在读取」→「今天真 0 步」与「超时降级」也永显正在读取',
    ).toBe(true)
  })

  it('HC-3 三条落状态路径（轮询 / 手动连接 / 重新读取）共用同一纯函数，规则不得各写一份', () => {
    const src = stripComments(read('src/pages/Dashboard.tsx'))
    const sites = [
      fnBody(src, 'applySync'),
      fnBody(src, 'handleConnectHealth'),
      fnBody(src, 'handleRefreshHealth'),
    ]
    expect(
      sites.every((b) => b.length > 0 && b.includes('healthSyncView(data, healthVendor.label, isHealthConnectVendor)') &&
        b.includes('setHealthSyncSettled(true)')),
      '三路各写一份 if/else 必然漂 → 出现「轮询说空、手动连接说正在读取」的自相矛盾',
    ).toBe(true)
  })

  it('HC-3 读数已有结论后不得再声称「正在读取」（顶栏文案受 settled 约束）', () => {
    const src = stripComments(read('src/pages/Dashboard.tsx'))
    expect(
      /healthSyncSettled \? \(\s*<span style=\{\{ color: 'var\(--ink-3\)', fontSize: 13 \}\}>今日 <b>0<\/b> 步<\/span>\s*\) : \(\s*<span style=\{\{ color: 'var\(--ink-3\)', fontSize: 13 \}\}>正在同步步数…<\/span>\s*\)/.test(src),
      '顶栏「正在同步步数…」永驻 → 与卡片文案一起构成「连接成功但一直没反应」',
    ).toBe(true)
  })

  it('HC-3 empty 状态必须有可见说明（今天真 0 步 ≠ 功能坏了，静默会让用户误判）', () => {
    // 🔴 同样不能用 fnBody：healthSyncView 的返回类型是**对象字面量类型**
    //    `): { steps: number; … }`，fnBody 的「跳过泛型尖括号」启发式会把类型体的 `{`
    //    当函数体开头 → 取到的 body 是类型而非实现 → 断言假红。
    //    故按「函数名之后的一段实现」定位，避开该 helper 的盲区（不改 helper：
    //    它被大量既有断言依赖，为两条新断言改共享工具的风险远大于收益）。
    const src = stripComments(read('src/pages/Dashboard.tsx'))
    const at = src.indexOf('function healthSyncView(')
    const body = at >= 0 ? src.slice(at, at + 1200) : ''
    expect(
      body.length > 0 &&
        /data\.status === 'empty'\s*\?\s*healthStatusHint\(data\.status, vendorLabel, isHealthConnectVendor\)\s*:\s*''/.test(body) &&
        /writeValues: true/.test(body) && /writeValues: false/.test(body),
      'empty 静默 → 用户看到步数 0 且无任何提示，以为同步坏了',
    ).toBe(true)
  })

  it('HC-3 读数失败/无数据时必须给「重新读取」出口（不能让用户只能杀进程重开）', () => {
    const src = stripComments(read('src/pages/Dashboard.tsx'))
    expect(
      /async function handleRefreshHealth\(\)/.test(src) &&
        /onClick=\{\(\) => void handleRefreshHealth\(\)\}/.test(src) &&
        /重新读取/.test(src),
      '无重试出口 → 用户体感「功能坏了」，只能杀进程重开 App',
    ).toBe(true)
  })

  it('HC-3 HC 的 empty 文案必须点明「中转层需数据源先写入」（否则用户只会干等）', () => {
    const body = fnBody(stripComments(read('src/lib/health/index.ts')), 'healthStatusHint')
    expect(
      /case 'empty':\s*return isHealthConnect\s*\?[\s\S]{0,400}?中转层/.test(body),
      'HC 只是中转层：只说「今天还没有数据」→ 用户不知道要去开数据源共享，永远等不到步数',
    ).toBe(true)
  })

  // ── HC-3 原生侧：分段超时（真机排查线索的唯一来源）──

  it('HC-3 原生 aggregate / 权限查询必须分段超时（挂起时给出卡在哪个阶段）', () => {
    const src = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    expect(
      /private const val CALL_TIMEOUT_MS = 6_000L/.test(src) &&
        /private suspend fun <T> withStageTimeout\(stage: String, block: suspend \(\) -> T\): T = try \{\s*withTimeout\(CALL_TIMEOUT_MS\) \{ block\(\) \}/.test(src) &&
        /withStageTimeout\("permission_query"\)/.test(src) &&
        /withStageTimeout\("aggregate"\)/.test(src) &&
        /withStageTimeout\("probe_permission_query"\)/.test(src),
      '跨进程调用无超时 → 协程泄漏 + 前端 Promise 永不 settle（且查不出卡在哪一步）',
    ).toBe(true)
  })

  it('HC-3 原生超时必须转自定义异常（TimeoutCancellationException 是 CancellationException 子类，宽泛 catch 会吞掉）', () => {
    const src = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    expect(
      /catch \(e: TimeoutCancellationException\) \{\s*throw HcTimeoutException\(stage\)/.test(src) &&
        /catch \(e: HcTimeoutException\) \{[\s\S]{0,400}?out\["status"\] = "error"[\s\S]{0,200}?reason"\] = "timeout:\$\{e\.stage\}"/.test(src),
      '不转自定义异常 → 超时被当成普通取消/异常吞掉，前端拿不到「卡在哪个阶段」',
    ).toBe(true)
  })

  it('HC-3 原生超时上报 status=error 而非「0 步」（与前端零假功能口径一致）', () => {
    // 🔴 必须从 `fun fetchToday` 起定位：文件里有**两处** catch (e: HcTimeoutException)
    //    （probe 的在前、fetchToday 的在后），直接 indexOf 会取到 probe 那处 →
    //    断言打到错的代码块（本轮实测假红，已修正）。
    const src = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    const from = src.indexOf('fun fetchToday(')
    const at = src.indexOf('catch (e: HcTimeoutException)', from)
    const seg = at >= 0 ? src.slice(at, at + 600) : ''
    expect(
      from > 0 && seg.length > 0 &&
        seg.includes('out["status"] = "error"') &&
        seg.includes('读数超时'),
      '超时若落到默认 steps=0 → 用户看到「今天 0 步」，永远看不出是读数挂了',
    ).toBe(true)
  })

  it('HC-3 probe 超时不得把 HC 判成不可用（SDK 已确认可用，只是权限查询卡住）', () => {
    // 🔴 按代码形态断言，不断言注释文字：probe 的 HcTimeoutException 分支只写 reason，
    //    **不得**写 available=false（那会让 UI 连「连接系统健康」按钮都不显示）。
    const src = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    const at = src.indexOf('catch (e: HcTimeoutException) {', src.indexOf('fun checkAvailability'))
    const seg = at >= 0 ? src.slice(at, src.indexOf('} catch', at + 10)) : ''
    expect(
      seg.length > 0 &&
        /out\["reason"\] = "timeout:\$\{e\.stage\}"/.test(seg) &&
        !seg.includes('out["available"] = false'),
      'probe 超时写 available=false → 用户连「连接系统健康」按钮都看不到，比读数挂起更难排查',
    ).toBe(true)
  })

  it('HC-3 原生分段超时（6s）必须短于前端硬超时（8s），让带阶段的结论先返回', () => {
    const native = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    const fe = stripComments(read('src/lib/health/connect.ts'))
    const n = /private const val CALL_TIMEOUT_MS = (\d+)_000L/.exec(native)
    const f = /const HC_FETCH_TIMEOUT_MS = (\d+)_000/.exec(fe)
    expect(
      n !== null && f !== null && Number(n[1]) < Number(f[1]),
      '前端先超时 → 只能给「读数超时」这种无阶段信息的笼统结论，真机排查失去线索',
    ).toBe(true)
  })

  // ── HW-1 华为机型「点连接没反应」（2026-11-18 华为 P40 实测）──
  //
  // 根因四层，缺一不可（任一层单独修都不能解决用户看到的现象）：
  //  ① Health Connect 在华为上**根本不可用**：需 Google Play services，华为无 GMS；
  //     且华为运动健康不向 HC 写数据（HMS/GMS 生态隔离）。
  //  ② 厂商 Health Kit 恒 not_ready（资质未获批），但 `canSync: true` → 按钮显示「连接」
  //     = 点了必然失败的假按钮（违反铁律 #13）；而 `isAndroidVendorHealthAvailable()`
  //     只检查「插件在不在」，不检查「厂商通道通不通」，所以挡不住。
  //  ③ 反馈不可见：`.notice` 基类无 background/color，裸用渲染成与卡片同底色的透明小字，
  //     插在一条语义雷同的常驻说明上方 → 用户看不出任何变化。
  //  ④ Dashboard 的连接按钮完全不看 canSync，恒显示「连接{label}」，与 ProfileScreen 口径不一致。

  it('HW-1 华为 canSync 必须为 false（厂商通道恒 not_ready，标 true 就是假连接按钮）', () => {
    const src = stripComments(read('src/lib/health/brand.ts'))
    // 取 huawei 分支体：从 vendor: 'huawei' 到该分支结束的 tip 行
    const seg = src.slice(src.indexOf("vendor: 'huawei'"), src.indexOf("if (/HONOR/i.test(ua))"))
    expect(seg.length > 0, '定位华为分支失败').toBe(true)
    expect(/canSync:\s*false/.test(seg), '华为标 canSync:true → 按钮显示「连接」但永远连不上').toBe(true)
    expect(/canSync:\s*true/.test(seg)).toBe(false)
  })

  it('HW-1 华为分支文案不得出现厂商品牌字样（华为将其列为资质申请驳回理由）', () => {
    const src = stripComments(read('src/lib/health/brand.ts'))
    const seg = src.slice(src.indexOf("vendor: 'huawei'"), src.indexOf("if (/HONOR/i.test(ua))"))
    // 🔴 只查**用户可见文案**（label / tip 的字符串字面量），不查整段：
    //   整段里必然含 `vendor: 'huawei'` 这个内部路由枚举值 —— 它是分派依据、必须保留，
    //   与「在入口/提示消息中显示品牌名」不是一回事（直接对整段断言是假红）。
    const visible = userFacingText(seg)
    expect(visible.length > 0, '未提取到 label/tip 文案，断言形同虚设').toBe(true)
    // 🔴 Incorrect Brand Icon Usage：「入口或提示消息中出现 Huawei / 华为运动健康 等字样」
    expect(/华为|HUAWEI|Huawei/i.test(visible), `用户可见文案含品牌字样: ${visible}`).toBe(false)
  })

  it('HW-1 小米厂商分支 canSync 同样为 false，且文案不含品牌字样（与华为同口径）', () => {
    const src = stripComments(read('src/lib/health/brand.ts'))
    const seg = src.slice(src.indexOf("vendor: 'xiaomi'"), src.indexOf("if (/vivo/i.test(ua))"))
    expect(seg.length > 0, '定位小米分支失败').toBe(true)
    expect(/canSync:\s*false/.test(seg)).toBe(true)
    const visible = userFacingText(seg)
    expect(visible.length > 0, '未提取到 label/tip 文案').toBe(true)
    expect(/小米|Xiaomi|Redmi|MIUI|HyperOS/i.test(visible), `用户可见文案含品牌字样: ${visible}`).toBe(false)
  })

  it('HW-1 荣耀（HONOR）不得被识别为华为（已独立厂商、带 GMS，误标会被华为文案连坐）', () => {
    const src = stripComments(read('src/lib/health/brand.ts'))
    // 🔴 华为分支的正则里不得再含 HONOR；且必须存在独立的 HONOR 分支
    const hwRe = /if \(\/([^/]*HUAWEI[^/]*)\/i\.test\(ua\)\)/.exec(src)
    expect(hwRe !== null, '定位华为 UA 正则失败').toBe(true)
    expect(/HONOR/i.test(hwRe![1]), 'HONOR 仍在华为正则里 → 荣耀机型被误标为华为').toBe(false)
    expect(/if \(\/HONOR\/i\.test\(ua\)\)/.test(src), '缺少独立的 HONOR 分支').toBe(true)
  })

  it('HW-1 connectHealth 在 canSync=false 时不得调原生授权（零假功能：不假装尝试连接）', () => {
    const src = stripComments(read('src/lib/health/index.ts'))
    const seg = src.slice(
      src.indexOf("if (v.vendor === 'huawei' || v.vendor === 'xiaomi')"),
      src.indexOf("if (v.vendor === 'wechat-miniprogram')"),
    )
    expect(seg.length > 0, '定位厂商分支失败').toBe(true)
    // 拦截必须在 isAndroidVendorHealthAvailable() 之前，否则那个函数返回 true 会绕过
    const guardAt = seg.indexOf('if (!v.canSync)')
    const bridgeAt = seg.indexOf('isAndroidVendorHealthAvailable()')
    expect(guardAt >= 0, '缺少 canSync 拦截 → 会一路走到恒 not_ready 的原生授权').toBe(true)
    expect(bridgeAt >= 0 && guardAt < bridgeAt, 'canSync 拦截必须在插件可用性检查之前').toBe(true)
  })

  it('HW-1 Dashboard 连接按钮文案必须受 canSync 约束（与 ProfileScreen 口径一致）', () => {
    const src = stripComments(read('src/pages/Dashboard.tsx'))
    // 🔴 原先恒为 `连接${healthVendor.label}`，不看 canSync → 华为上是点了必然失败的假按钮
    expect(/healthVendor\.canSync/.test(src), 'Dashboard 未读 canSync → 不可连机型仍显示「连接」').toBe(true)
    expect(/连接\$\{healthVendor\.label\}/.test(src)).toBe(true) // 可连时仍是原文案（零回归）
  })

  it('HW-1 两端点击反馈都必须带可见修饰类（裸 .notice 无底色 = 用户看不出变化）', () => {
    // 🔴 这是「点了没反应」的直接技术原因，两端都踩过
    expect(
      [read('src/pages/Dashboard.tsx'), read('src/pages/ProfileScreen.tsx')].every((x) =>
        /className="notice warn"[^>]*>\{healthTip\}/.test(x),
      ),
      'healthTip 用了裸 className="notice" → 渲染成透明小字',
    ).toBe(true)
  })

  it('HW-1 .notice 基类必须自带可见底色与文字色（防止任何裸用法再次隐形）', () => {
    const css = read('src/styles.css')
    const seg = css.slice(css.indexOf('.notice {'), css.indexOf('.notice.err'))
    expect(seg.length > 0, '定位 .notice 基类失败').toBe(true)
    expect(/background:\s*var\(--/.test(seg), '基类无 background → 裸用与卡片同底色').toBe(true)
    expect(/color:\s*var\(--/.test(seg), '基类无 color → 文字色不可控').toBe(true)
  })

  it('HW-1 原生授权 Intent 必须异步构造（@PluginMethod 在主线程，同步阻塞 = ANR）', () => {
    const kt = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    const java = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/DbeeHealthPlugin.java')
    expect(/fun createPermissionIntentAsync\(/.test(kt), '缺少异步版构造入口').toBe(true)
    // 异步版内部必须走超时保护的 sdkStatus/client（阻塞调用不得裸调）
    const asyncSeg = kt.slice(kt.indexOf('fun createPermissionIntentAsync('))
    expect(/sdkStatusWithTimeout\(/.test(asyncSeg) && /clientWithTimeout\(/.test(asyncSeg)).toBe(true)
    // Java 侧必须调异步版，且不得再同步调阻塞版
    expect(/createPermissionIntentAsync\(/.test(java)).toBe(true)
    expect(/Intent intent = HealthConnectReader\.createPermissionIntent\(/.test(java), 'Java 侧仍在主线程同步构造 Intent → ANR').toBe(false)
  })

  it('HW-1 原生 sdkStatus / client 必须有超时保护版，且 fetchToday 内不得裸调', () => {
    const kt = read('native-plugins/dbee-health/android/src/main/java/com/dbee/health/HealthConnectReader.kt')
    expect(/private suspend fun sdkStatusWithTimeout\(/.test(kt)).toBe(true)
    expect(/private suspend fun clientWithTimeout\(/.test(kt)).toBe(true)
    // 🔴 fetchToday 里原先 `val status = sdkStatus(app)` 在 try **之外**：挂起时既不抛异常
    //   也不走 catch → callback 永不触发 → 前端永驻「正在读取」（HC-3 的遗漏项）
    const seg = kt.slice(kt.indexOf('fun fetchToday('))
    expect(/sdkStatusWithTimeout\("sdk_status"/.test(seg), 'fetchToday 仍裸调 sdkStatus').toBe(true)
    expect(/clientWithTimeout\("client_create"/.test(seg), 'fetchToday 仍裸调 client').toBe(true)
  })

  // 文件落地断言（实现前应为红）
  it('WX-4 存在 0053 迁移文件（0052 已占用，编号顺延）', () => {
    expect(existsSync(join(ROOT, 'db/migrations/0053-health-vendor.sql'))).toBe(true)
  })

  it('WX-4 迁移加 health_vendor 列', () => {
    expect(readMaybe('db/migrations/0053-health-vendor.sql')).toMatch(/ADD COLUMN(\s+IF NOT EXISTS)?\s+health_vendor\s+text/i)
  })

  it('WX-4 迁移对来源值加 CHECK 约束（只认合法值）', () => {
    expect(/CHECK[\s\S]*health_vendor|health_vendor[\s\S]*CHECK/i.test(readMaybe('db/migrations/0053-health-vendor.sql'))).toBe(true)
  })

  it('WX-4 两端连接成功都写 health_vendor（来源落库；词边界排除注释/改名）', () => {
    const main = stripComments(read('src/lib/health/index.ts'))
    // 主端 apple 分支必须写死 'apple'，huawei/xiaomi 分支走 dbVendor 变量
    expect(/health_vendor:\s*'apple'/.test(main) && /health_vendor:\s*dbVendor/.test(main) &&
      /health_vendor:\s*'werun'/.test(MINI_HEALTH_WX())).toBe(true)
  })

  it('WX-4 两端断开连接都清 health_vendor（来源复位）', () => {
    expect([MINI_HEALTH_WX(), stripComments(read('src/lib/health/index.ts'))]
      .every((x) => /health_vendor:\s*null/.test(x))).toBe(true)
  })

  it('WX-4 两端 isHealthConnected 都真调用 isVendorConnected（词边界排除 MUT_ 前缀）', () => {
    expect([MINI_HEALTH_WX(), stripComments(read('src/lib/health/index.ts'))]
      .every((x) => /\bisVendorConnected\(/.test(x))).toBe(true)
  })

  it('WX-4 两端 api.ts 都把 health_vendor 列入可写白名单', () => {
    expect([read('src/lib/api.ts'), read('mini/src/lib/api.ts')]
      .every((x) => /'health_vendor'/.test(x))).toBe(true)
  })

  it('WX-4 mini 连接态展示真调用 isVendorConnected（词边界排除改名）', () => {
    const c = MINI_PROFILE()
    expect(/\bisVendorConnected\(profile\?\.health_connected/.test(c)).toBe(true)
  })
})

/**
 * WX-5 · 四端健康绑定一致性审计（2026-11-19 新增）。
 * 用户指令：「再次详细梳理4端，针对运动的健康绑定，确保4端实现逻辑一致，都能连接正常」。
 *
 * 审计结论：Web 无连接入口（vendor='web' 恒不可连，刻意设计）；iOS/Android 主端
 * 三分支（apple / health_connect / 厂商兜底）连接都写 health_connected_at +
 * health_vendor、断开都清；mini 走微信运动主动/静默双路径。本轮修了 3 处 mini
 * 「抄主端抄出来的错误引导」+ 1 处类型漂移：
 *   ① denied 指向 iOS「系统设置 > 健康」—— 微信小程序没有该路径，用户照着找
 *      必然找不到（与小米 15 Ultra「授权成功但一直没反应」同类误导）；
 *   ② empty 称「会自动读取」—— 微信运动只在用户进入小程序时更新（werun.ts
 *      头注④），不存在自动刷新，用户会干等一个永不发生的更新；
 *   ③ connect/disconnect 漏写/漏清 health_connected_at（0022 审计字段）→
 *      werun 来源的行时间戳恒 NULL，「何时连接的」跨端口径不一致；
 *   ④ mini Profile 接口漏声明 health_connected_at（白名单却有）→ tsc TS2561。
 *
 * 🔴 denied/empty 按端分叉是**刻意设计**（主端同样按 isHealthConnect 参数分叉），
 *   护栏 12 钉的 not_ready 句两端同源不变（mini 该分支是死分支：werun status
 *   枚举无 not_ready）。本组把「分叉的正确方向」钉死：谁为了「统一」把 mini
 *   文案改回主端版本，这里立刻红。
 */
describe('WX-5 · mini 健康绑定错误引导修复 + 审计字段对齐（2026-11-19）', () => {
  const miniHealth = MINI_HEALTH_WX()
  const mainHealth = stripComments(read('src/lib/health/index.ts'))
  const miniApi = stripComments(read('mini/src/lib/api.ts'))

  it('WX-5a mini denied 必须指向小程序权限管理路径，不得抄 iOS「系统设置 > 健康」', () => {
    const body = fnBody(miniHealth, 'healthStatusHint')
    expect(
      /权限管理/.test(body) && !/系统设置\s*>\s*健康/.test(body),
      'mini denied 又指回 iOS 系统设置路径 → 微信用户找不到开关，误判功能坏了',
    ).toBe(true)
  })

  it('WX-5b mini empty 必须给出主动出口（同步微信运动），不得声称「会自动读取」', () => {
    const body = fnBody(miniHealth, 'healthStatusHint')
    expect(
      /同步微信运动/.test(body) && !/会自动读取/.test(body),
      'mini empty 声称自动读取 → 微信运动只在进入小程序时更新，用户会干等',
    ).toBe(true)
  })

  it('WX-5c mini connectHealth 必须写 health_connected_at（与主端三分支对齐）', () => {
    expect(/health_connected_at:\s*new Date\(\)\.toISOString\(\)/.test(fnBody(miniHealth, 'connectHealth'))).toBe(true)
  })

  it('WX-5d mini disconnectHealth 必须清 health_connected_at（不得残留上次连接时间）', () => {
    expect(/health_connected_at:\s*null/.test(fnBody(miniHealth, 'disconnectHealth'))).toBe(true)
  })

  it('WX-5e 两端 error/unavailable 措辞必须同源（not_ready 同源由护栏 12 钉）', () => {
    expect(
      ['读取健康数据时出错，请稍后重试；步数暂时保持上次结果。', '当前设备不支持健康数据同步，请手动记录运动。']
        .every((s) => miniHealth.includes(s) && mainHealth.includes(s)),
      'error/unavailable 被单端改写 → 同一状态两端说法不同，用户以为是两个问题',
    ).toBe(true)
  })

  it('WX-5f mini Profile 接口必须声明 health_connected_at 且列入可写白名单', () => {
    expect(/health_connected_at\?:\s*string\s*\|\s*null/.test(miniApi) && /'health_connected_at'/.test(miniApi)).toBe(true)
  })
})
