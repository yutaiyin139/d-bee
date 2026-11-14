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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MY_PAGE_SECTION_GRID, MY_PAGE_SECTION_LIST, MY_PAGE_SECTION_RECORDS,
  MY_PAGE_GRID_ITEMS, MY_PAGE_LIST_ITEMS,
  MY_PAGE_INVITE_LABEL, MY_PAGE_REPORT_ARIA,
  MY_PAGE_TODAY_TITLE, MY_PAGE_TODAY_HINT, MY_PAGE_TODAY_ARIA,
  MY_PAGE_TODAY_LABELS,
  HEALTH_APP_CATALOG, FUTURE_DEVICE_CATALOG, DEVICE_STATUS_LABEL,
  HEALTH_RECORD_ANCHORS, HEALTH_RECORD_COMPLETION,
  HEALTH_RECORD_COMPLETION_NOTE, HEALTH_RECORD_COMPLETION_FIELDS,
  HEALTH_RECORD_DISCLAIMER, HEALTH_RECORD_NO_MEDICAL,
  HEALTH_RECORD_EMPTY_MEAL, HEALTH_RECORD_EMPTY_WEIGHT, HEALTH_RECORD_EMPTY_EXERCISE,
  HEALTH_PLAN_TITLE,
  buildTodayTargetCore, buildCompletionCore, buildWeekRecipeViewCore,
  buildMyFoodViewCore, buildMealSplitCore, buildExerciseWeekCore,
} from '@dbee/shared'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
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

  it('可真同步的仅 Apple / 华为 / 小米', () => {
    expect(HEALTH_APP_CATALOG.filter((d) => d.status === 'available').map((d) => d.key)).toEqual(['apple', 'huawei', 'xiaomi'])
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

  it('状态标签三档齐全', () => {
    expect(Object.keys(DEVICE_STATUS_LABEL).sort()).toEqual(['available', 'guided', 'planned'])
  })

  it('两端设备页零「绑定」字样', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => !x.includes('绑定'))).toBe(true)
  })

  it('两端设备页都渲染 shared 设备目录', () => {
    expect([WEB_DEVICE(), MINI_DEVICE()].every((x) => x.includes('HEALTH_APP_CATALOG.map') && x.includes('FUTURE_DEVICE_CATALOG.map'))).toBe(true)
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
