import { createRoot } from 'react-dom/client'
import { cloud } from './cloud'
import { Dashboard } from './pages/Dashboard'
import { PlanProvider } from './state/plan'
import { DEMO_PROFILE, mockFrom, type Chain } from './preview-mock'
import './styles.css'

/**
 * 仅供本地预览 / 截图验收：拦截云数据库返回演示数据，直接渲染 Dashboard。
 * 不挂在 index.html 主入口上，不影响正式构建（vite build 只打包 index.html）。
 *
 * 演示数据与 mock 实现抽在 `./preview-mock`，与商店截图入口 `store-preview-main.tsx` 共用同一份，
 * 避免两处各维护一份 demo 数据导致漂移。mock 会真正执行 eq('log_date', ...) 过滤，
 * 这样「当日餐次 / 饮食体检」只统计当天，而 gte/lte 区间查询（打卡与近 7 天趋势）能拿到整周数据。
 */

// 拦截数据库访问；auth 模块保持真实（未登录时 PlanProvider 不会发请求）
;(cloud.database as unknown as { from: (t: string) => Chain }).from = mockFrom

const el = document.getElementById('root')
if (!el) throw new Error('root element not found')

createRoot(el).render(
  <div className="app-shell">
    <PlanProvider>
      <Dashboard profile={DEMO_PROFILE} onOpenLegal={() => undefined} />
    </PlanProvider>
  </div>,
)
