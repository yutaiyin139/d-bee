import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { isNative } from './lib/platform'
import { PrivacyGate } from './components/PrivacyGate'

const el = document.getElementById('root')
if (!el) throw new Error('root element not found')

// 🔴 PrivacyGate 必须包在 <App /> 最外层：App 内的 PlanProvider 一挂载就会调
// getEntitlement / getPhotoQuota 等云端接口。若门控放在 App 内部，等于「用户还没
// 同意隐私政策，App 已经发出网络请求采集数据」——这是比「不弹窗」更严重的违规
// （工信部「未同意前不得收集个人信息」专项整治的直接靶心）。放在这里，未同意时
// <App /> 根本不挂载，零请求。详见 components/PrivacyGate.tsx 文件头注释。
//
// 不使用 StrictMode：避免开发模式下 effect 双次执行导致 AI 调用与写入重复
createRoot(el).render(
  <PrivacyGate>
    <App />
  </PrivacyGate>,
)

// PWA 可安装性：仅注册一个透传 fetch 的最小 SW，不做离线缓存。
//
// 原生 App 内不注册：Capacitor 走的是 capacitor:// / https://localhost 自定义协议，
// Service Worker 在该协议下行为不确定，且原生环境本来就有本地资源，
// 注册 SW 只会带来额外的调试噪音（之前靠 protocol.startsWith('http') 间接排除，
// 现在用显式判断，意图更清楚）。
if (isNative()) {
  void navigator.serviceWorker?.getRegistrations?.().then((regs) => {
    // 清掉历史遗留注册，避免从「添加到主屏幕」升级成原生包后仍被旧 SW 接管
    for (const r of regs) void r.unregister()
  })
} else if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败不影响使用 */
    })
  })
}
