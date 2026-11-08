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
  // 后端接入点（见 mini/src/lib/backend.ts）。2026-11-08 起云端库彻底废弃，
  // selfhost 是**唯一**后端，不再有「切后端」这回事。
  // 🔴 READY 默认 'true'：双确认门原本是防「误切到未就绪的自托管」，如今自托管链路
  //    （ICP/DNS/HTTPS/login-wechat/ident_kind/legal）已生产实测就绪、且别无选择，
  //    默认视为已确认，保证普通 `npm run build:weapp` 不带任何环境变量也能构建。
  //    运行时护栏 resolveBackendTarget() 仍保留：显式传 cloud 或任何非法值一律 throw。
  // 必须用 defineConstants 显式注入，webpack5 才会把 process.env.D_BEE_* 换成字面量：
  // 小程序运行时没有 process.env；显式注入还能让产物里 grep 到实际连的后端。
  const backend = (process.env.D_BEE_BACKEND ?? 'selfhost').trim()
  const selfhostReady = (process.env.D_BEE_SELFHOST_READY ?? 'true').trim()

  // 虚拟支付售卖开关（见 mini/src/lib/xpayEnabled.ts）。🔴 **默认 false**：
  // 未显式设 D_BEE_XPAY_ENABLED=true 时，构建出的包不展示任何价格与购买按钮，
  // legal.ts 保持「免费提供」口径 —— 与 backend.ts 的 READY 门同一思路（默认安全值），
  // 但方向相反：READY 默认 true 是因为自托管已是唯一选择，这里默认 false 是因为
  // 开启售卖还需微信后台的道具发布 / 进件 / 推送配置（平台侧人工操作，代码无法验证）。
  const xpayEnabled = (process.env.D_BEE_XPAY_ENABLED ?? 'false').trim()

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

  // 🔴 售卖开关的构建期校验：只接受 true / false，其余一律 throw。
  // 为什么不兜底成 false：`D_BEE_XPAY_ENABLED=1` / `=yes` 这类写法很常见，
  // 若静默当成 false，构建出的包「以为在卖其实没卖」—— 和 backend.ts 里
  // 「以为切了其实没切」是同一种病，都在运行时才暴露，且这次暴露方式是
  // 「用户点购买没反应」。宁可构建失败，让人当场改对。
  const xpayNorm = xpayEnabled.toLowerCase()
  if (xpayNorm !== 'true' && xpayNorm !== 'false') {
    throw new Error(
      `[mini/config] D_BEE_XPAY_ENABLED 只接受 'true' / 'false'，收到 ${JSON.stringify(process.env.D_BEE_XPAY_ENABLED)}。` +
        '该开关同时决定「付费墙是否展示三档价格与购买按钮」与「legal.ts 的法务口径」，' +
        '两者必须一致，故不允许含糊取值。开启前请先确认 xpayEnabled.ts 文件头列出的' +
        '平台侧前置条件（虚拟支付进件、道具发布、消息推送配置）已全部就绪。',
    )
  }
  if (xpayNorm === 'true') {
    // 构建日志留痕：产物是否售卖是发布决策，必须在构建输出里看得见
    // （产物里 grep 中文会因 \uXXXX 转义假阴性，日志是唯一可靠提示位）。
    console.warn(
      '[mini/config] ⚠️ 已开启虚拟支付售卖（D_BEE_XPAY_ENABLED=true）：' +
        '付费墙将展示三档价格与购买按钮，legal.ts 同步切换为收费口径。' +
        '发布前请确认微信后台已完成：虚拟支付进件、三档道具发布（productId 与 PRODUCT_IDS 一致）、' +
        '消息推送配置（URL=https://d-bee.cn/.cloud/payment/wechat/notify）；' +
        '且服务端 0046 迁移已应用、XPAY_* 与 WECHAT_SESSION_ENC_KEY 已配齐。',
    )
  }

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
      // 注入**归一化后**的值（'true'/'false'），运行时 isXpaySaleEnabled 再判一次，
      // 两层用同一份字面量，不会出现「构建期认为是 true、运行时认为是 false」。
      'process.env.D_BEE_XPAY_ENABLED': JSON.stringify(xpayNorm),
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
