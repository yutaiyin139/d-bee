import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const PRODUCTION_NATIVE_ENDPOINT = 'https://d-bee.cn'

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
  validateNativeBuild(mode, loadEnv(mode, process.cwd(), 'VITE_'))

  return {
    define: {
      __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
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
