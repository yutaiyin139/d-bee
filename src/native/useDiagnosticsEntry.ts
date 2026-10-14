/**
 * 原生端诊断入口（懒加载钩子）。
 *
 * 单独成文件的原因：AuthScreen 只需要「拿到一个组件」，不需要知道诊断面板里有什么。
 * 面板本体走动态 import，Web 端 useEffect 提前 return，分包永远不会被请求，
 * 因此 Web 主包体积与运行行为都不受影响。
 */

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { isNative } from '../lib/platform'

export function useNativeDiagnosticsEntry(): ComponentType | null {
  const [Comp, setComp] = useState<ComponentType | null>(null)

  useEffect(() => {
    if (!isNative()) return
    let alive = true
    void import('./NativeDiagnostics')
      .then((m) => {
        if (alive) setComp(() => m.NativeDiagnostics)
      })
      .catch(() => {
        /* 诊断面板加载失败不应影响登录 */
      })
    return () => {
      alive = false
    }
  }, [])

  return Comp
}
