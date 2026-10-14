import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

/**
 * 版本号统一由 package.json 提供，构建时注入为 __APP_VERSION__，
 * 页脚（src/content/legal.ts 的 SITE.version）直接引用，
 * 避免发版时出现「package.json 已升版、界面还显示旧版本」的不一致。
 */
export default defineConfig({
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
})
