import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { cloud } from './cloud'
import { IconChart, IconMe, IconToday } from './components/Icons'
import { Dashboard } from './pages/Dashboard'
import { LogSheet } from './pages/LogSheet'
import { PaywallSheet } from './pages/PaywallSheet'
import { ProfileScreen } from './pages/ProfileScreen'
import { ReportScreen } from './pages/ReportScreen'
import { PlanProvider, usePlan } from './state/plan'
import type { DocId } from './content/legal'
import { DEMO_PROFILE, mockFrom, type Chain } from './preview-mock'
import './styles.css'

/**
 * 商店截图专用入口（本地使用，不进正式构建）。
 *
 * 与 `preview.html` 的差别：
 *   1. 渲染完整 App 骨架（三个 tab + tabbar），而非只有首页；
 *   2. 配合 `store-preview.html` 里的 Capacitor 桩跑在**模拟 iOS 环境**下，
 *      使付费墙呈现 App Store 要求的形态（隐藏第三方支付与兑换码、显示「恢复购买」）；
 *   3. 用 `?screen=` 切换画面、`?full=1` 解除 480px 宽度上限（供 iPad 槽位使用）。
 *
 * 数据全部来自 `preview-mock.ts` 的演示数据，与 `preview.html` 同源，避免两处漂移。
 * ⚠️ 演示数据是示意值，不是任何真实用户的记录。
 */

const params = new URLSearchParams(window.location.search)
const SCREEN = params.get('screen') ?? 'today'
const FULL_WIDTH = params.get('full') === '1'

// 拦截数据库访问；auth 保持真实（未登录时不会发请求）
;(cloud.database as unknown as { from: (t: string) => Chain }).from = mockFrom

const noop = () => undefined
const openLegal = (_id: DocId) => undefined

/** full 模式：解除 .app-shell / .tabbar 的 480px 上限，让 iPad 槽位铺满画面 */
if (FULL_WIDTH) {
  const s = document.createElement('style')
  s.textContent = '.app-shell,.tabbar{max-width:none !important}'
  document.head.appendChild(s)
}

/** 挂载即打开付费墙（PaywallSheet 由 usePlan 的 paywall.open 控制） */
function AutoOpenPaywall({ reason }: { reason: string }) {
  const { openPaywall } = usePlan()
  useEffect(() => {
    openPaywall(reason)
  }, [openPaywall, reason])
  return null
}

/** 「记一餐」抽屉：直接渲染 LogSheet，不经过 Dashboard 的点击流程 */
function LogScreen() {
  const today = new Date()
  const logDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`
  return (
    <LogSheet
      logDate={logDate}
      initialMeal="lunch"
      budget={520}
      budgetText="今天还剩 520 千卡，这一餐建议控制在 520 千卡以内"
      onClose={noop}
      onSaved={noop}
    />
  )
}

function Screen() {
  switch (SCREEN) {
    case 'report':
      return <ReportScreen profile={DEMO_PROFILE} />
    case 'me':
      return (
        <ProfileScreen
          profile={DEMO_PROFILE}
          account="138****6688"
          onOpenLegal={openLegal}
          onProfileChanged={noop}
          onSignOut={noop}
        />
      )
    case 'log':
      return (
        <>
          <Dashboard profile={DEMO_PROFILE} onOpenLegal={openLegal} />
          <LogScreen />
        </>
      )
    case 'paywall':
      return (
        <>
          <Dashboard profile={DEMO_PROFILE} onOpenLegal={openLegal} />
          <AutoOpenPaywall reason="升级 Pro，解锁全部功能" />
        </>
      )
    case 'today':
    default:
      return <Dashboard profile={DEMO_PROFILE} onOpenLegal={openLegal} />
  }
}

type TabKey = 'today' | 'report' | 'me'

function Tabbar({ active }: { active: TabKey }) {
  // 还原 App.tsx 的 tabbar 结构与类名（含真实图标组件），
  // 不直接引入 App：它需要登录态与云会话，截图页跑的是 mock 数据。
  return (
    <nav className="tabbar">
      <button type="button" className={active === 'today' ? 'active' : ''}>
        <IconToday active={active === 'today'} />
        今日
      </button>
      <button type="button" className={active === 'report' ? 'active' : ''}>
        <IconChart active={active === 'report'} />
        报告
      </button>
      <button type="button" className={active === 'me' ? 'active' : ''}>
        <IconMe active={active === 'me'} />
        我的
      </button>
    </nav>
  )
}

const TAB_OF: Record<string, TabKey> = {
  today: 'today',
  log: 'today',
  paywall: 'today',
  report: 'report',
  me: 'me',
}

const el = document.getElementById('root')
if (!el) throw new Error('root element not found')

createRoot(el).render(
  <div className="app-shell">
    <PlanProvider>
      <Screen />
      <PaywallSheet onOpenLegal={openLegal} />
      <Tabbar active={TAB_OF[SCREEN] ?? 'today'} />
    </PlanProvider>
  </div>,
)
