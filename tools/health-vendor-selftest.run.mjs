/**
 * 品牌识别自测运行器（与 v15-selftest.run.mjs 同构）。
 *
 * 直接用 esbuild（Vite 自带依赖）把 health-vendor-selftest.mjs 连同它 import 的
 * 真实 TS 模块（brand.ts + platform.ts）打成单文件，再交给 Node 执行。
 *
 * 运行：node tools/health-vendor-selftest.run.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, '.workbuddy', 'tmp')
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'health-vendor-selftest.bundle.mjs')

await build({
  entryPoints: [path.join(root, 'tools', 'health-vendor-selftest.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
})

await import(pathToFileURL(outfile).href)
