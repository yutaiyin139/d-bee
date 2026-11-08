import { PropsWithChildren } from 'react'
import { useLaunch } from '@tarojs/taro'
import { installGlobalErrorReporter } from './lib/bootReport'
import './app.scss'

/**
 * 🔴 2026-11-08 iOS 真机调试实证：appservice 启动期出现
 * `RangeError: Maximum call stack size exceeded`（同一栈帧无限重复），
 * 页面纯白屏、服务端零请求。模块求值期的异常不会经过任何页面 try/catch，
 * 必须在**模块顶层**尽早挂上 wx.onError，才有机会把根因弹成 Modal。
 * 该钩子零 Taro 依赖、幂等，基础库不支持时静默跳过，不影响启动。
 */
installGlobalErrorReporter()

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    // 幂等；若顶层注册时 wx 尚未就绪，App 启动后补一次。
    installGlobalErrorReporter()
    console.log('D-Bee mini launched')
  })

  return children
}

export default App
