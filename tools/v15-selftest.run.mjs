/**
 * V1.5.0 自测运行器。
 *
 * 为什么需要它：v15-selftest.mjs 直接 import 真实 TS 模块，而 Node 的
 * --experimental-strip-types 只剥离类型、不做**扩展名补全**（src 内部用的是
 * Vite 风格的无扩展名相对导入，Node ESM 解析不了）。这里先用 esbuild
 * （Vite 自带依赖，不新增包）打成单文件，再交给 Node 执行。
 *
 * 运行：node tools/v15-selftest.run.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, '.workbuddy', 'tmp')
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'v15-selftest.bundle.mjs')

await build({
  entryPoints: [path.join(root, 'tools', 'v15-selftest.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
})

await import(pathToFileURL(outfile).href)
