import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const PRODUCTION_NATIVE_ENDPOINT = 'https://d-bee.cn'

/** 原生包必须在构建期确定数据面，不能把 Web 产物静默同步成云库正式包。 */
function validateNativeBuild(mode: string, env: Record<string, string>): void {
  if (mode !== 'native-release' && mode !== 'native-internal') return

  const endpoint = env.VITE_NATIVE_ENDPOINT?.trim() ?? ''
  const allowInternalCloud = env.VITE_ALLOW_CLOUD_NATIVE === 'true'

  if (!endpoint) {
    if (mode === 'native-internal' && allowInternalCloud) {
      console.warn('[native-internal] 显式允许使用 WorkBuddy 云库；此产物禁止上架。')
      return
    }
    throw new Error(
      mode === 'native-release'
        ? `[native-release] 必须设置 VITE_NATIVE_ENDPOINT=${PRODUCTION_NATIVE_ENDPOINT}。` +
          '域名/HTTPS 未就绪时请改用 npm run native:sync:internal，不要发布内测包。'
        : '[native-internal] 请设置 VITE_NATIVE_ENDPOINT，或显式设置 VITE_ALLOW_CLOUD_NATIVE=true 使用云库内测。',
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
  }
})
