import { useCallback, useEffect, useState } from 'react'
import { cloud } from './cloud'
import { IconChart, IconMe, IconToday } from './components/Icons'
import { getProfile } from './lib/api'
import type { Profile } from './types'
import type { DocId } from './content/legal'
import { AuthScreen } from './pages/AuthScreen'
import { Dashboard } from './pages/Dashboard'
import { LegalPage } from './pages/LegalPage'
import { Onboarding } from './pages/Onboarding'
import { PaywallSheet } from './pages/PaywallSheet'
import { ProfileScreen } from './pages/ProfileScreen'
import { ReportScreen } from './pages/ReportScreen'
import { PlanProvider } from './state/plan'

type Stage = 'loading' | 'auth' | 'onboarding' | 'main'
type Tab = 'today' | 'report' | 'me'

function maskAccount(user: unknown): string {
  const u = (user ?? {}) as Record<string, unknown>
  const phone = (u.phone ?? u.phone_number) as string | undefined
  const email = u.email as string | undefined
  if (phone) {
    const digits = String(phone).replace(/\D/g, '')
    if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`
  }
  if (email && email.includes('@')) {
    const [name, domain] = email.split('@')
    return `${name.slice(0, 2)}***@${domain}`
  }
  return '已登录'
}

export default function App() {
  // 法律文档页（用户协议 / 隐私政策 / 免责声明）以整屏浮层呈现，
  // 状态放在最外层，这样登录前（首页）和登录后都能打开同一份文档。
  const [legal, setLegal] = useState<DocId | null>(null)

  return (
    <PlanProvider>
      <AppInner onOpenLegal={setLegal} />
      <PaywallSheet />
      {legal && <LegalPage id={legal} onBack={() => setLegal(null)} />}
    </PlanProvider>
  )
}

function AppInner({ onOpenLegal }: { onOpenLegal: (id: DocId) => void }) {
  const [stage, setStage] = useState<Stage>('loading')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [account, setAccount] = useState('')
  const [tab, setTab] = useState<Tab>('today')
  const [bootError, setBootError] = useState('')

  const enterApp = useCallback(async (user: unknown) => {
    setAccount(maskAccount(user))
    // 冷启动 / 弱网时首批请求可能整体失败（模拟器实测：DNS 短暂未就绪，SDK 内部
    // 重试 3 次仍失败）。启动期读档案失败若直接落回 onboarding，会把「引导已完成」
    // 的老用户误当成新号重新走引导 —— 这里做有限次退避重试，全部失败才降级。
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const p = await getProfile()
        if (p && p.onboarded) {
          setProfile(p)
          setStage('main')
        } else {
          setProfile(p)
          setStage('onboarding')
        }
        return
      } catch (e) {
        lastErr = e
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
    setBootError(lastErr instanceof Error ? lastErr.message : '读取档案失败')
    setStage('onboarding')
  }, [])

  /** 读取当前会话并决定进入哪个阶段 */
  const checkSession = useCallback(async () => {
    const { data: session, error } = await cloud.auth.getSession()
    if (error || !session) {
      setStage('auth')
      return
    }
    await enterApp(session.user)
  }, [enterApp])

  useEffect(() => {
    let alive = true

    void (async () => {
      try {
        // 必须在任何登录守卫之前无条件执行：微信扫码回调用 code 换会话
        const cb = await cloud.auth.handleWechatWebCallback()
        if (cb.error) {
          setBootError(cb.error.message || '微信登录回调失败')
        } else if (cb.data) {
          history.replaceState(null, '', location.pathname)
        }
        if (!alive) return
        await checkSession()
      } catch (e) {
        if (!alive) return
        setBootError(e instanceof Error ? e.message : '初始化失败')
        setStage('auth')
      }
    })()

    const off = cloud.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setProfile(null)
        setTab('today')
        setStage('auth')
      }
    })

    return () => {
      alive = false
      off()
    }
  }, [checkSession])

  async function handleSignOut() {
    try {
      await cloud.auth.signOut()
    } finally {
      setProfile(null)
      setTab('today')
      setStage('auth')
    }
  }

  if (stage === 'loading') {
    return (
      <div className="app-shell">
        <div className="page">
          <div className="page-top" />
          <div className="hero">
            <h1>
              D-Bee<span className="brand-cn">自律蜜蜂</span>
            </h1>
            <p>正在载入…</p>
          </div>
          <div className="skeleton" style={{ height: 250, borderRadius: 20, marginBottom: 14 }} />
          <div className="skeleton" style={{ height: 120, borderRadius: 20 }} />
        </div>
      </div>
    )
  }

  if (stage === 'auth') {
    return (
      <div className="app-shell">
        {bootError && (
          <div className="page" style={{ paddingBottom: 0 }}>
            <div className="page-top" />
            <div className="notice err" style={{ marginTop: 12 }}>{bootError}</div>
          </div>
        )}
        <AuthScreen
          onOpenLegal={onOpenLegal}
          onSignedIn={() => {
            setStage('loading')
            void checkSession().catch((e) => {
              setBootError(e instanceof Error ? e.message : '登录状态读取失败')
              setStage('auth')
            })
          }}
        />
      </div>
    )
  }

  if (stage === 'onboarding') {
    return <Onboarding nickname={profile?.nickname ?? null} onDone={(p) => {
      setProfile(p)
      setTab('today')
      setStage('main')
    }} />
  }

  if (!profile) return null

  return (
    <div className="app-shell">
      {tab === 'today' && <Dashboard profile={profile} onOpenLegal={onOpenLegal} />}
      {tab === 'report' && <ReportScreen profile={profile} />}
      {tab === 'me' && (
        <ProfileScreen
          profile={profile}
          account={account}
          onOpenLegal={onOpenLegal}
          onProfileChanged={setProfile}
          onSignOut={handleSignOut}
        />
      )}

      <nav className="tabbar">
        <button className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>
          <IconToday active={tab === 'today'} />
          今日
        </button>
        <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>
          <IconChart active={tab === 'report'} />
          报告
        </button>
        <button className={tab === 'me' ? 'active' : ''} onClick={() => setTab('me')}>
          <IconMe active={tab === 'me'} />
          我的
        </button>
      </nav>
    </div>
  )
}
