import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const PRODUCTION_NATIVE_ENDPOINT = 'https://d-bee.cn'

/**
 * 🔴 小程序售卖开关（与 mini 端**同名同值**，2026-11-08）。
 *
 * 变量名刻意复用 mini 的 `D_BEE_XPAY_ENABLED`（不是另起 `VITE_MINI_SALE_ENABLED`）：
 * 一个环境变量同时决定「小程序卖不卖」与「Web 引不引导去小程序下单」。
 * 若两端各用一个变量，运维极可能只开一端 —— 那就是「Web 引导用户去小程序，
 * 进去却发现不卖」的虚假宣传（或反向：小程序在卖而 Web 说没有），
 * 属《消费者权益保护法》与《广告法》层面的风险，而非纯 UI 问题。
 *
 * 取值校验与 `mini/config/index.ts:86-94` 逐字同口径：只接受 'true' / 'false'，
 * 其余（含 '1' / 'yes' / 拼写错误）一律 throw 中断构建 —— 宁可构建失败，
 * 也不要发出一个「以为在引导其实没引导」的包。
 *
 * 默认 'false'：未显式开启时 Web 只展示价格、明示网页不收款，**不出现任何
 * 「去小程序下单」字样**，与 mini 默认「免费提供、不销售」口径一致。
 *
 * 读取方式与 mini 相同（只读 `process.env`，不读 .env 文件）：两端同一条命令
 * 前缀即可同时构建，例如
 *   D_BEE_XPAY_ENABLED=true npm run build      # Web
 *   D_BEE_XPAY_ENABLED=true npm run build:weapp # mini（在 mini/ 下）
 */
function resolveXpaySaleFlag(): 'true' | 'false' {
  const raw = process.env.D_BEE_XPAY_ENABLED ?? 'false'
  const norm = raw.trim().toLowerCase()
  if (norm !== 'true' && norm !== 'false') {
    throw new Error(
      `[vite] D_BEE_XPAY_ENABLED 只接受 'true' / 'false'，收到 ${JSON.stringify(process.env.D_BEE_XPAY_ENABLED)}。` +
        '该开关同时决定「小程序是否售卖虚拟商品」与「Web 是否引导去小程序下单」，' +
        '两端必须同值，故不允许含糊取值。开启前请确认 mini/src/lib/xpayEnabled.ts 文件头' +
        '列出的平台侧前置条件（虚拟支付进件、道具发布、消息推送）已全部就绪，' +
        '否则用户会被引导到一个买不到东西的小程序。',
    )
  }
  if (norm === 'true') {
    // 构建日志留痕：产物是否引导下单是发布决策，必须在构建输出里看得见
    // （产物 grep 中文因 \uXXXX 转义会假阴性，日志是唯一可靠提示位）。
    console.warn(
      '[vite] ⚠️ 已开启小程序售卖引导（D_BEE_XPAY_ENABLED=true）：' +
        'Web 付费墙与公开定价页将展示「去微信小程序下单」引导，legal.ts 同步切换为收费口径。' +
        '发布前请确认：① mini 端已用同一变量构建并上传（否则引导指向一个不卖东西的小程序）；' +
        '② 静态小程序码已放 public/ 且 VITE_MINI_ORDER_QR 已配置。',
    )
  }
  return norm
}

/**
 * 🔴 App 端（Android 原生包）第三方支付售卖开关（2026-11-09 用户定案）。
 *
 * 与 `D_BEE_XPAY_ENABLED` 完全同构，但两者**各自独立**：mini 走微信虚拟支付、
 * App 走微信/支付宝 APP 支付，是两条互不依赖的收款通道，不应互相牵连。
 *
 * 一个环境变量同时决定两件事：
 *   ① Android 付费墙是否渲染可点的支付按钮（`PaywallSheet` 的渠道门）；
 *   ② Web 是否引导访客「去 App 内购买」（`MiniOrderGuide` 的 App 分支）。
 * 若 Web 单方面开引导而 App 还没开放收款，就是「引导到一个买不到东西的入口」，
 * 属《广告法》第 4 条引人误解宣传；反向（App 在卖但 Web 说没有购买渠道）则是
 * 口径不一致。故与 mini 一样强制**同源同值**，且非法取值构建期 throw。
 *
 * 默认 'false'：平台侧（商户号、证书、env、0047 迁移、网关部署）未就绪时，
 * Android 零支付按钮、Web 零 App 引导，杜绝「展示价格却必然支付失败」。
 *
 * 开启前置（详见 `docs/Web引导闭环与Android收款实装-2026-11-09.md` §五）：
 *   微信支付商户号 + APP 支付权限 / 支付宝企业应用、`APPPay_*` env 齐备、
 *   0047 迁移上生产、`apppay.mjs` 已部署、App 备案下证、真机 1 分钱联调通过。
 */
function resolveApppaySaleFlag(): 'true' | 'false' {
  const raw = process.env.D_BEE_APPPAY_ENABLED ?? 'false'
  const norm = raw.trim().toLowerCase()
  if (norm !== 'true' && norm !== 'false') {
    throw new Error(
      `[vite] D_BEE_APPPAY_ENABLED 只接受 'true' / 'false'，收到 ${JSON.stringify(process.env.D_BEE_APPPAY_ENABLED)}。` +
        '该开关同时决定「Android 是否可发起支付」与「Web 是否引导去 App 购买」，两端必须同值。',
    )
  }
  if (norm === 'true') {
    console.warn(
      '[vite] ⚠️ 已开启 App 售卖（D_BEE_APPPAY_ENABLED=true）：Android 付费墙将展示支付按钮，' +
        'Web 付费墙与公开定价页将展示「去 App 内购买」引导。' +
        '发布前请确认：① 网关 0047 + apppay.mjs 已部署且支付 env 齐备；' +
        '② 原生包用同一变量构建；③ VITE_APP_DOWNLOAD_LINK 或二维码已配置。',
    )
  }
  return norm
}

/** 原生包必须在构建期确定数据面，不能把 Web 产物静默同步成云库正式包。 */
function validateNativeBuild(mode: string, env: Record<string, string>): void {
  if (mode !== 'native-release' && mode !== 'native-internal') return

  const endpoint = env.VITE_NATIVE_ENDPOINT?.trim() ?? ''

  // 🔴 2026-11-08 云端库彻底废弃：native-internal 也不再允许回退云库。
  //    未给 endpoint 时统一走自建网关，与运行时 resolveNativeEndpoint() 同口径。
  if (!endpoint && mode === 'native-internal') {
    console.log(`[native-internal] 未设置 VITE_NATIVE_ENDPOINT，使用自建网关 ${PRODUCTION_NATIVE_ENDPOINT}`)
    return
  }

  if (!endpoint) {
    throw new Error(
      `[native-release] 必须设置 VITE_NATIVE_ENDPOINT=${PRODUCTION_NATIVE_ENDPOINT}。` +
        '域名/HTTPS 未就绪时请改用 npm run native:sync:internal，不要发布内测包。',
    )
  }

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`[${mode}] VITE_NATIVE_ENDPOINT 必须是绝对 URL，当前值：${endpoint}`)
  }
  const normalized = endpoint.replace(/\/+$/, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    normalized !== url.origin
  ) {
    throw new Error(
      `[${mode}] VITE_NATIVE_ENDPOINT 必须是无凭据、路径、查询参数的 HTTPS origin，例如 ${PRODUCTION_NATIVE_ENDPOINT}`,
    )
  }
  if (mode === 'native-release' && url.origin !== PRODUCTION_NATIVE_ENDPOINT) {
    throw new Error(
      `[native-release] 正式包只能使用 ${PRODUCTION_NATIVE_ENDPOINT}，当前为 ${url.origin}；其他地址只能用于 internal 构建。`,
    )
  }
  console.log(`[${mode}] 原生数据面：${url.origin}`)
}

/**
 * 版本号统一由 package.json 提供，构建时注入为 __APP_VERSION__，
 * 页脚（src/content/legal.ts 的 SITE.version）直接引用，
 * 避免发版时出现「package.json 已升版、界面还显示旧版本」的不一致。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  validateNativeBuild(mode, env)

  return {
    define: {
      __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
      // 🔴 注入**布尔字面量**（不是字符串 'true'），故产物里可直接 grep
      //    `__XPAY_SALE_ENABLED__` 被替换后的 `true`/`false`，用于核对
      //    「发出去的 Web 包到底引不引导下单」——与 mini 的 defineConstants 同理。
      __XPAY_SALE_ENABLED__: resolveXpaySaleFlag() === 'true' ? 'true' : 'false',
      // App 端售卖（同上面一样注入**布尔字面量**，可被 terser 死代码折叠）：
      // 默认 false 时 Android 支付按钮与 Web 的 App 引导一起被折叠掉，
      // 产物里 grep 不到「去 App 内购买」即为验证通过。
      __APPPAY_SALE_ENABLED__: resolveApppaySaleFlag() === 'true' ? 'true' : 'false',
    },
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
    /**
     * 🔴 fileParallelism: false —— 关掉测试文件级并行，**必须保留**。
     *
     * 症状（2026-11-04 实测）：并行跑 `npm test` 时本机报
     *   `EPERM: operation not permitted, open '<TMPDIR>/ssr/<hash>'`
     * 而 vitest 把它当 unhandled error 吞掉，**被卡住的测试文件直接不统计**：
     *   并行 → Test Files 8 passed / Tests 150   ← 假绿
     *   串行 → Test Files 10 passed / Tests 190  ← 真相（多出的 40 项是 2 个文件）
     * 即「全绿」可能建立在丢了 20% 测试的基础上，且 exit code 仍是 0，CI/人眼都发现不了。
     *
     * 为何写在这里而不是只写进 package.json 的 `test` 脚本（--no-file-parallelism）：
     *   脚本参数只覆盖 `npm test` 一条路径；直接 `npx vitest run tools/xxx.test.ts`
     *   或 IDE 的测试按钮都不带该参数，仍会假绿。配置项对所有调用方式生效。
     *
     * 代价：全套 15.9s vs 并行 9.4s（慢 6.5s）。用 6.5 秒换「绿是真绿」，划算。
     * 排查提示：看到 `Test Files` 数 < `ls tools/*.test.ts | wc -l` 就是这个问题复发。
     */
    test: {
      fileParallelism: false,
    },
  }
})
