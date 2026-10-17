/**
 * 拍照额度 + 积分分流自测运行器。
 *
 * 同 v15-selftest.run.mjs：Node 的 --experimental-strip-types 不做扩展名补全，
 * src 内部是 Vite 风格无扩展名相对导入，这里用 esbuild（Vite 自带依赖）打成单文件再跑。
 *
 * 运行：node tools/quota-honey-selftest.run.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, '.workbuddy', 'tmp')
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'quota-honey-selftest.bundle.mjs')

await build({
  entryPoints: [path.join(root, 'tools', 'quota-honey-selftest.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
})

await import(pathToFileURL(outfile).href)
