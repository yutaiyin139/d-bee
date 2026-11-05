import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import devConfig from './dev'
import prodConfig from './prod'
import { resolveBackendTarget } from '../src/lib/backend'

/**
 * 🔴 版本号单一真相源 = **项目根** package.json 的 version（当前 1.7.3），
 * 不是 mini/package.json 的 version（那是 0.1.0，小程序包自身的版本，与产品版本无关）。
 *
 * 为什么必须同源：主端 vite.config.ts:64 注入的正是根 package.json，格式 `v${pkg.version}`，
 * 其注释（vite.config.ts:55-58）明确说明目的是「避免发版时出现 package.json 已升版、
 * 界面还显示旧版本的不一致」。而 mini 端此前在 content/legal.ts 里**写死** '1.6.9'，
 * 恰好犯了主端专门防的这个错 —— 既非 mini/package.json 的 0.1.0，也非根端的 1.7.3，
 * 是个凭空出现的陈旧值，所以 legal.tsx 干脆「刻意不渲染」它。
 * 现改为构建期注入，两端从此同源同值，version 字段也就有了唯一真相源。
 *
 * 读根 package.json 用 fs 而非 import：本文件被 Taro CLI 以 Node 执行，
 * import JSON 依赖 tsconfig 的 resolveJsonModule（未开），fs 读取无此约束。
 * cwd 在 `npm run build:weapp` 下恒为 mini/（npm 会切到 package.json 所在目录），
 * 故根 package.json 在 ../；同时兜底 __dirname 相对路径，两种调用方式都能命中。
 */
function resolveProductVersion(): string {
  const candidates = [
    resolve(process.cwd(), '../package.json'),
    resolve(__dirname, '../../../package.json'),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string }
      // 必须确认读到的是**根**包（name 为 d-bee），否则可能误读 mini/package.json（d-bee-mini）
      // 而拿到 0.1.0 —— 那会让界面显示错误版本号，比不显示更糟。
      if (pkg.name === 'd-bee' && typeof pkg.version === 'string' && pkg.version) {
        return `v${pkg.version}`
      }
    } catch {
      // 换下一个候选路径
    }
  }
  // 🔴 构建期护栏（与下方 resolveBackendTarget 同思路）：本文件由 Node 执行，throw 能真正中断构建。
  // 宁可构建失败，也不要发一个显示错误版本号（或空版本号）的包给用户。
  throw new Error(
    '[mini/config] 无法从项目根 package.json 解析产品版本号（期望 name="d-bee" 且有 version 字段）。' +
    `已尝试：${candidates.join(' , ')}。` +
    '请勿改为写死版本号 —— 那正是主端 vite.config.ts:55 专门防范的不一致来源。'
  )
}

export default defineConfig<'webpack5'>(async (merge, { command, mode }) => {
  // 后端接入点开关（见 mini/src/lib/backend.ts）。默认 cloud = 当前线上行为，零改变。
  // 必须用 defineConstants 显式注入，webpack5 才会把 process.env.D_BEE_* 替换成字面量：
  // 小程序运行时没有 process.env，不注入则读出来恒为 undefined。虽然后端归一化会把
  // undefined 当 cloud 处理（不会炸），但显式注入才能让产物里 grep 到实际连的后端，
  // 也让下面这道构建期护栏拿到确定的值。
  const backend = (process.env.D_BEE_BACKEND ?? 'cloud').trim()
  const selfhostReady = (process.env.D_BEE_SELFHOST_READY ?? '').trim()

  // 产品版本号（见上方 resolveProductVersion 注释）。与主端 __APP_VERSION__ 同源同值。
  const appVersion = resolveProductVersion()

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
      'process.env.D_BEE_SELFHOST_READY': JSON.stringify(selfhostReady),
      // 🔴 标识符刻意与主端 vite.config.ts:64 **完全同名**（__APP_VERSION__），
      // 值也同源同格式（`v` + 根 package.json version）。同名是为了让
      // 「四端版本号同源」这件事可被一致性护栏直接比对，而不是靠两份注释互相承诺。
      __APP_VERSION__: JSON.stringify(appVersion)
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
