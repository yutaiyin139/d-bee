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
  HEALTH_APP_CATALOG, FUTURE_DEVICE_CATALOG, DEVICE_STATUS_LABEL,
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

  it('设备目录里的「血糖仪应用」仅作后续支持目录名，状态恒为 planned', () => {
    expect(FUTURE_DEVICE_CATALOG.filter((d) => d.label.includes('血糖')).every((d) => d.status === 'planned')).toBe(true)
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
  it('健康应用目录 6 项', () => {
    expect(HEALTH_APP_CATALOG.length).toBe(6)
  })

  it('可真同步的仅 Apple（已真机验证）', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.status === 'available').map((d) => d.key)).toEqual(['apple'])
  })

  it('华为 / 小米为接入中，不得标成现在可连接', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.status === 'in_progress').map((d) => d.key)).toEqual(['huawei', 'xiaomi'])
  })

  it('vivo / OPPO 为引导查看，不给绑定', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.key === 'vivo' || d.key === 'oppo').every((d) => d.status === 'guided')).toBe(true)
  })

  it('后续支持设备全部为 planned', () => {
    expect(FUTURE_DEVICE_CATALOG.every((d) => d.status === 'planned')).toBe(true)
  })

  it('后续支持设备 6 项', () => {
    expect(FUTURE_DEVICE_CATALOG.length).toBe(6)
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
