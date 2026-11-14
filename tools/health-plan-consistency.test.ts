/**
 * 护栏 26 · 健康管理方案单态渲染 / 目标变更自动重算 / 四端 UI 一致（2026-11-14）
 *
 * ## 为什么需要这道护栏
 * ① 又加回 segment / 目标三选一，出现「显示态 ≠ 生效态」，首页「还可吃」对不上；
 * ② 方案页现场调 calcTarget() 重算，与落库值浮点漂移（1650 vs 1648）；
 * ③ 引用 plan_summary（AI 首次建议），改目标后变成「增重 + 减脂建议」自相矛盾；
 * ④ 首次登录引导被挪到冷启动分支，全体老用户每次启动都被弹；
 * ⑤ 11-14 四端同构后：某一端偷偷改文案 / 改数值口径 / 少渲染一枚卡片，
 *    造成「同一个方案在四个端长得不一样」。故文案与纯函数下沉 @dbee/shared，
 *    两端组件消费同一组常量，本护栏动态比对两端展示模型与 UI 结构。
 *
 * ## 护栏断言三铁律
 * ① 一个 it() 只一条断言；
 * ② 能动态取真值就不做静态匹配（GOAL_LABELS / 落库值 / 标题常量都动态取）；
 * ③ 代码断言一律在 stripComments() 之后做，注释里的说明不算数。
 *
 * 运行：npx vitest run tools/health-plan-consistency.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Profile } from '../src/types'
import { GOAL_LABELS as WEB_GOALS } from '../src/lib/nutrition'
import { GOAL_LABELS as MINI_GOALS } from '../mini/src/lib/nutrition'
import {
  HEALTH_PLAN_TITLE,
  HEALTH_PLAN_NOTES,
  buildHealthPlanView as buildWebPlan,
  isHealthPlanReady as webReady,
} from '../src/lib/healthPlan'
import { buildHealthPlanView as buildMiniPlan, isHealthPlanReady as miniReady } from '../mini/src/lib/healthPlan'
import { HEALTH_PLAN_TITLE as SHARED_TITLE, HEALTH_PLAN_NOTES as SHARED_NOTES } from '@dbee/shared'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

const SHEET = (): string => stripComments(read('src/components/HealthPlanSheet.tsx'))
const LIB = (): string => stripComments(read('src/lib/healthPlan.ts'))
const PROFILE_SCREEN = (): string => stripComments(read('src/pages/ProfileScreen.tsx'))
const APP = (): string => stripComments(read('src/App.tsx'))
const SHARED = (): string => stripComments(read('packages/shared/src/healthPlan.ts'))
const SHARED_INDEX = (): string => stripComments(read('packages/shared/src/index.ts'))
const MINI_SHEET = (): string => stripComments(read('mini/src/components/HealthPlanSheet.tsx'))
const MINI_LIB = (): string => stripComments(read('mini/src/lib/healthPlan.ts'))
const MINI_SCSS = (): string => stripComments(read('mini/src/components/HealthPlanSheet.scss'))
const MINI_PROFILE = (): string => stripComments(read('mini/src/pages/profile/profile.tsx'))
const MINI_INDEX = (): string => stripComments(read('mini/src/pages/index/index.tsx'))
const MINI_ONBOARDING = (): string => stripComments(read('mini/src/pages/onboarding/onboarding.tsx'))

/** plan_summary 故意留内容：若纯函数误引用它，动态断言会立刻变红。 */
function mkProfile(patch: Partial<Profile> = {}): Profile {
  return {
    nickname: null,
    gender: 'male',
    age: 30,
    height_cm: 175,
    start_weight_kg: 70,
    current_weight_kg: 70,
    target_weight_kg: 64,
    activity_level: 'light',
    goal: 'lose',
    weekly_rate_kg: 0.5,
    daily_calorie_target: 1690,
    protein_target_g: 126,
    carb_target_g: 191,
    fat_target_g: 47,
    barriers: null,
    plan_summary: '旧的 AI 减脂建议',
    onboarded: true,
    ...patch,
  }
}

/** 两端 Profile 结构兼容；通过这层显式转换让类型意图可见。 */
const miniProfile = (p: Profile): Parameters<typeof buildMiniPlan>[0] => p

describe('单态渲染', () => {
  it('主端方案 Sheet 不渲染 segment 切换器', () => {
    expect(SHEET()).not.toContain('segment')
  })

  it('主端方案 Sheet 不遍历三目标标签', () => {
    expect(SHEET()).not.toContain('Object.keys(GOAL_LABELS)')
  })

  it('主端方案 Sheet 只渲染一枚目标徽标', () => {
    expect((SHEET().match(/style=\{chipStyle\}/g) ?? []).length).toBe(1)
  })

  it('主端方案 Sheet 不持有本地目标态', () => {
    expect(SHEET()).not.toContain('useState<')
  })

  it('目标标签取自 GOAL_LABELS 真源', () => {
    expect(buildWebPlan(mkProfile({ goal: 'gain' })).goalLabel).toBe(WEB_GOALS.gain)
  })

  it('减脂态有目标体重与进度', () => {
    expect(buildWebPlan(mkProfile({ goal: 'lose' })).hasProgress).toBe(true)
  })

  it('增重态有目标体重与进度', () => {
    expect(buildWebPlan(mkProfile({ goal: 'gain' })).hasProgress).toBe(true)
  })

  it('保持体重态没有目标体重与进度', () => {
    expect(buildWebPlan(mkProfile({ goal: 'keep' })).hasProgress).toBe(false)
  })
})

describe('命名与口径', () => {
  it('页面标题统一为健康管理方案', () => {
    expect(HEALTH_PLAN_TITLE).toBe('健康管理方案')
  })

  it('运行时代码不出现旧命名', () => {
    expect(LIB() + SHEET() + PROFILE_SCREEN() + MINI_LIB() + MINI_SHEET() + MINI_PROFILE()).not.toContain('体重管理方案')
  })

  it('主端纯函数不读取 AI 首次建议', () => {
    expect(LIB()).not.toContain('plan_summary')
  })

  it('mini 纯函数不读取 AI 首次建议', () => {
    expect(MINI_LIB()).not.toContain('plan_summary')
  })

  it('shared 纯函数不读取 AI 首次建议', () => {
    expect(SHARED()).not.toContain('plan_summary')
  })

  it('方案 Sheet 不读取 AI 首次建议', () => {
    expect(SHEET() + MINI_SHEET()).not.toContain('plan_summary')
  })

  it('主端纯函数不现场重算热量目标', () => {
    expect(LIB()).not.toContain('calcTarget(')
  })

  it('mini 纯函数不现场重算热量目标', () => {
    expect(MINI_LIB()).not.toContain('calcTarget(')
  })

  it('shared 纯函数不现场重算热量目标', () => {
    expect(SHARED()).not.toContain('calcTarget(')
  })

  it('shared 纯函数不自写数值舍入', () => {
    expect(SHARED()).not.toContain('toFixed(')
  })

  it('方案页热量等于落库值', () => {
    expect(buildWebPlan(mkProfile({ daily_calorie_target: 1950 })).calories).toBe(1950)
  })

  it('方案页蛋白等于落库值', () => {
    expect(buildWebPlan(mkProfile({ protein_target_g: 105 })).protein).toBe(105)
  })

  it('空档案不生成方案', () => {
    expect(webReady(mkProfile({ daily_calorie_target: null }))).toBe(false)
  })

  it('空档案不把兜底值当作真实目标', () => {
    expect(buildWebPlan(mkProfile({ daily_calorie_target: null })).ready).toBe(false)
  })

  it('说明条目不夹带旧 AI 建议正文', () => {
    expect(buildWebPlan(mkProfile()).notes.some((n) => n.text.includes('旧的 AI'))).toBe(false)
  })
})

describe('首次登录与改目标接线（主端 = Web/iOS/Android 共用）', () => {
  it('首次引导只在完成 Onboarding 时触发一次', () => {
    expect((APP().match(/setIntroPlan\(true\)/g) ?? []).length).toBe(1)
  })

  it('老用户冷启动分支不弹引导', () => {
    const src = APP()
    const enter = src.slice(src.indexOf('const enterApp'), src.indexOf('const checkSession'))
    expect(enter).not.toContain('setIntroPlan')
  })

  it('确认保存后自动打开方案 Sheet', () => {
    expect(PROFILE_SCREEN()).toContain('setPlanOpen(true)')
  })

  it('编辑确认层写明历史记录不会被改动', () => {
    expect(PROFILE_SCREEN()).toContain('历史记录不会被改动')
  })

  it('我的页提供健康管理方案入口', () => {
    expect(PROFILE_SCREEN()).toContain('{HEALTH_PLAN_TITLE}')
  })

  it('底部导航仍为三项', () => {
    expect((APP().match(/aria-current=\{tab ===/g) ?? []).length).toBe(3)
  })

  it('主端方案组件被 App 与我的页共同复用', () => {
    expect((APP() + PROFILE_SCREEN()).match(/HealthPlanSheet/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('四端文案单一真源（@dbee/shared）', () => {
  it('shared 导出面统一导出 healthPlan', () => {
    expect(SHARED_INDEX()).toContain("export * from './healthPlan'")
  })

  it('主端适配层从 shared 取值', () => {
    expect(LIB()).toContain("from '@dbee/shared'")
  })

  it('mini 适配层从 shared 取值', () => {
    expect(MINI_LIB()).toContain("from '@dbee/shared'")
  })

  it('主端适配层不硬编码方案标题', () => {
    expect(LIB()).not.toContain("'健康管理方案'")
  })

  it('mini 适配层不硬编码方案标题', () => {
    expect(MINI_LIB()).not.toContain("'健康管理方案'")
  })

  it('主端组件不硬编码中文文案', () => {
    expect(SHEET()).not.toContain("'健康管理方案'")
  })

  it('mini 组件不硬编码中文文案', () => {
    expect(MINI_SHEET()).not.toContain("'健康管理方案'")
  })

  it('两端组件都引用每日建议摄入标签', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('HEALTH_PLAN_LABEL_DAILY'))).toBe(true)
  })

  it('两端组件都引用说明区标题', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('HEALTH_PLAN_NOTES_TITLE'))).toBe(true)
  })

  it('两端组件都引用更改目标按钮文案', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('HEALTH_PLAN_LABEL_CHANGE'))).toBe(true)
  })

  it('两端组件都引用首次引导标题', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('HEALTH_PLAN_INTRO_TITLE'))).toBe(true)
  })

  it('shared 标题与适配层标题同值', () => {
    expect(SHARED_TITLE).toBe(HEALTH_PLAN_TITLE)
  })

  it('shared 说明条目为四条', () => {
    expect(SHARED_NOTES.length).toBe(4)
  })

  it('适配层说明条目与 shared 同引用', () => {
    expect(HEALTH_PLAN_NOTES).toBe(SHARED_NOTES)
  })
})

describe('四端展示模型一致（动态比对两端输出）', () => {
  it('减脂态两端逐字段相等', () => {
    expect(JSON.stringify(buildWebPlan(mkProfile({ goal: 'lose' })))).toBe(JSON.stringify(buildMiniPlan(miniProfile(mkProfile({ goal: 'lose' })))))
  })

  it('增重态两端逐字段相等', () => {
    expect(JSON.stringify(buildWebPlan(mkProfile({ goal: 'gain' })))).toBe(JSON.stringify(buildMiniPlan(miniProfile(mkProfile({ goal: 'gain' })))))
  })

  it('保持态两端逐字段相等', () => {
    expect(JSON.stringify(buildWebPlan(mkProfile({ goal: 'keep' })))).toBe(JSON.stringify(buildMiniPlan(miniProfile(mkProfile({ goal: 'keep' })))))
  })

  it('两端目标标签同值', () => {
    expect(buildWebPlan(mkProfile({ goal: 'gain' })).goalLabel).toBe(buildMiniPlan(miniProfile(mkProfile({ goal: 'gain' }))).goalLabel)
  })

  it('两端说明条目逐条同值', () => {
    expect(buildWebPlan(mkProfile()).notes).toEqual(buildMiniPlan(miniProfile(mkProfile())).notes)
  })

  it('两端 GOAL_LABELS 逐键同值', () => {
    expect(WEB_GOALS).toEqual(MINI_GOALS)
  })

  it('两端保持态都无进度条', () => {
    expect(buildWebPlan(mkProfile({ goal: 'keep' })).hasProgress).toBe(buildMiniPlan(miniProfile(mkProfile({ goal: 'keep' }))).hasProgress)
  })

  it('两端减脂态都有进度条', () => {
    expect(buildWebPlan(mkProfile({ goal: 'lose' })).hasProgress).toBe(buildMiniPlan(miniProfile(mkProfile({ goal: 'lose' }))).hasProgress)
  })

  it('两端空档案判定一致', () => {
    expect(webReady(mkProfile({ daily_calorie_target: null }))).toBe(miniReady(miniProfile(mkProfile({ daily_calorie_target: null }))))
  })
})

describe('四端 UI 结构一致', () => {
  it('mini 组件不渲染 segment 切换器', () => {
    expect(MINI_SHEET()).not.toContain('segment')
  })

  it('mini 组件不遍历三目标标签', () => {
    expect(MINI_SHEET()).not.toContain('Object.keys(GOAL_LABELS)')
  })

  it('mini 组件只渲染一枚目标徽标', () => {
    expect((MINI_SHEET().match(/style=\{chipStyle\}/g) ?? []).length).toBe(1)
  })

  it('mini 组件不持有本地目标态', () => {
    expect(MINI_SHEET()).not.toContain('useState<')
  })

  it('mini 组件渲染四格统计', () => {
    expect((MINI_SHEET().match(/className='hp-stat'/g) ?? []).length).toBe(4)
  })

  it('主端组件渲染四格统计', () => {
    expect((SHEET().match(/className="stat"/g) ?? []).length).toBe(4)
  })

  it('mini 组件有统计网格容器', () => {
    expect(MINI_SHEET()).toContain("className='hp-stat-grid'")
  })

  it('主端组件有统计网格容器', () => {
    expect(SHEET()).toContain('className="stat-grid"')
  })

  it('两端组件都复用透明化折叠说明', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('<TransparencyNotes'))).toBe(true)
  })

  it('mini 组件标注进度条无障碍语义', () => {
    expect(MINI_SHEET()).toContain("'aria-role': 'progressbar'")
  })

  it('主端组件标注进度条无障碍语义', () => {
    expect(SHEET()).toContain('role="progressbar"')
  })

  it('两端大数字字号一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('fontSize: 28'))).toBe(true)
  })

  it('两端单位字号一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('fontSize: 14'))).toBe(true)
  })

  it('两端统计数值字号一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('fontSize: 18'))).toBe(true)
  })

  it('两端进度条高度一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('height: 8'))).toBe(true)
  })

  it('两端圆角口径一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('borderRadius: 99'))).toBe(true)
  })

  it('两端徽标字号一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes('fontSize: 13'))).toBe(true)
  })

  it('两端徽标内边距一致', () => {
    expect([SHEET(), MINI_SHEET()].every((x) => x.includes("padding: '5px 12px'"))).toBe(true)
  })

  it('mini 样式按 750 设计稿做 2 倍换算', () => {
    expect(MINI_SCSS()).toContain('max-width: 960px')
  })

  it('mini 卡片圆角与主端 20px 对应', () => {
    expect(MINI_SCSS()).toContain('border-radius: 40px')
  })

  it('mini 网格间距与主端 12px 对应', () => {
    expect(MINI_SCSS()).toContain('gap: 24px')
  })

  it('mini 主按钮高度与主端 50px 对应', () => {
    expect(MINI_SCSS()).toContain('height: 100px')
  })

  it('mini 颜色一律走设计 token', () => {
    expect(MINI_SCSS()).toContain('$honey')
  })

  it('mini 关闭热区满足 44×44 的 2 倍触控规格', () => {
    expect(MINI_SCSS()).toContain('min-height: 88px')
  })
})

describe('mini 端接线', () => {
  it('我的页引入方案 Sheet', () => {
    expect(MINI_PROFILE()).toContain('<HealthPlanSheet')
  })

  it('我的页入口标题取 shared 常量', () => {
    expect(MINI_PROFILE()).toContain('{HEALTH_PLAN_TITLE}')
  })

  it('我的页入口标签取落库目标而非编辑草稿', () => {
    expect(MINI_PROFILE()).toContain("GOAL_LABELS[profile?.goal ?? 'lose']")
  })

  it('确认保存后自动打开方案 Sheet', () => {
    expect(MINI_PROFILE()).toContain('setPlanOpen(true)')
  })

  it('确认层写明会改变的字段', () => {
    expect(MINI_PROFILE()).toContain('HEALTH_PLAN_EDIT_WILL_PREFIX')
  })

  it('确认层写明不会改变的字段', () => {
    expect(MINI_PROFILE()).toContain('HEALTH_PLAN_EDIT_WONT_PREFIX')
  })

  it('确认层保留历史记录不会被改动', () => {
    expect(MINI_PROFILE()).toContain('历史记录不会被改动')
  })

  it('更改目标回到既有编辑弹层', () => {
    expect(MINI_PROFILE()).toContain('setEditing(true)')
  })

  it('引导完成后写入一次性旗标', () => {
    expect(MINI_ONBOARDING()).toContain("Taro.setStorageSync(HEALTH_PLAN_INTRO_FLAG_KEY, '1')")
  })

  it('首页读取并清除一次性旗标', () => {
    expect(MINI_INDEX()).toContain('Taro.removeStorageSync(HEALTH_PLAN_INTRO_FLAG_KEY)')
  })

  it('首页只在旗标命中时弹一次', () => {
    expect((MINI_INDEX().match(/setIntroPlan\(true\)/g) ?? []).length).toBe(1)
  })

  it('首页渲染首次引导态方案 Sheet', () => {
    expect(MINI_INDEX()).toContain("mode='intro'")
  })

  it('旗标 key 两端引用同一常量', () => {
    expect([MINI_ONBOARDING(), MINI_INDEX()].every((x) => x.includes('HEALTH_PLAN_INTRO_FLAG_KEY'))).toBe(true)
  })
})
