import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'
import { resolveBackendTarget } from '../src/lib/backend'

export default defineConfig<'webpack5'>(async (merge, { command, mode }) => {
  // 后端接入点开关（见 mini/src/lib/backend.ts）。默认 cloud = 当前线上行为，零改变。
  // 必须用 defineConstants 显式注入，webpack5 才会把 process.env.D_BEE_* 替换成字面量：
  // 小程序运行时没有 process.env，不注入则读出来恒为 undefined。虽然后端归一化会把
  // undefined 当 cloud 处理（不会炸），但显式注入才能让产物里 grep 到实际连的后端，
  // 也让下面这道构建期护栏拿到确定的值。
  const backend = (process.env.D_BEE_BACKEND ?? 'cloud').trim()
  const selfhostReady = (process.env.D_BEE_SELFHOST_READY ?? '').trim()

  // 🔴 构建期护栏（第 1 层）。本文件由 Node 执行，故这里 throw 能真正中断构建。
  // 为什么必须有这一层：webpack **不执行**被打包的模块代码，backend.ts 里的 throw
  // 只在小程序启动、加载 cloud.ts 那一刻才触发 —— 也就是说单靠它，误切的包照样
  // 能构建成功并发出去，等到启动即崩才发现（实测：D_BEE_BACKEND=selfhost 且缺
  // READY 时 build:weapp 仍 exit=0）。
  // 这里复用 resolveBackendTarget 本身而非另写一份判断，保证两层逻辑不会漂移。
  // 对齐主端的双层护栏思路（vite.config.ts:14-25 构建期 + cloudConfig.ts:109-112 运行时）。
  resolveBackendTarget({ backend, selfhostReady })

  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'd-bee-mini',
    date: '2026-10-19',
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {
      'process.env.D_BEE_BACKEND': JSON.stringify(backend),
      'process.env.D_BEE_SELFHOST_READY': JSON.stringify(selfhostReady)
    },
    copy: {
      patterns: [],
      options: {}
    },
    framework: 'react',
    compiler: {
      type: 'webpack5',
      prebundle: { enable: false }
    },
    cache: {
      enable: false
    },
    mini: {
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false }
      }
    },
    sass: {
      resource: ['src/styles/tokens.scss'],
      projectDirectory: '.',
      data: ''
    }
  }

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig)
  }
  return merge({}, baseConfig, prodConfig)
})
