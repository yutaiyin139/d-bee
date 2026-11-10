/**
 * 🔴 护栏 22：mini 上传期编译配置（源码包体积闸门）。
 *
 * ## 为什么需要这道护栏
 *
 * 微信小程序**主包硬上限 2048KB**，超限直接拒收上传，报
 * `源码包超出最大限制, source size NNNNKB exceed max limit 2MB`。
 * 这个 NNNN 是**开发者工具「编译后」的体积，不是本地 `dist/` 的字节数**，
 * 两者可以差一倍以上，所以「本地看着很小」完全不能说明安全。
 *
 * 2026-11-10 实测：本地 `dist/` 仅 **899KB**，工具报 **2057KB**（2.29x）。
 * 膨胀全部来自 `project.config.json` 的三个 setting 触发的**上传期二次编译**：
 *
 * | setting              | 错误值 | 后果（实测） |
 * | -------------------- | ------ | ------------ |
 * | `es6`                | `true` | 把**已压缩**的产物反向展开成 ES5：+565KB（缺口 49%）。<br>`vendors.js` 89KB→261KB（**3.00x**，cloud-sdk 的 async/await 被 regenerator 展开）、<br>`app.js` 1.75x、`taro.js` 1.69x、`common.js` 1.38x |
 * | `minified`           | `false`| 上传时不压缩混淆，官方文档明示「开启可减小代码包」 |
 * | `uploadWithSourceMap`| `true` | 附带 sourcemap 调试信息 |
 *
 * `es6` 尤其隐蔽：Taro 产物**已经被 terser 压成单行**（`common.js` 1 行 / 243KB），
 * 此时再让工具做 ES6→ES5，等于「解压 + 注入 regeneratorRuntime + 展开语法糖」，
 * 纯负收益。而 `libVersion` 已是 **3.4.10**，基础库原生支持全部 ES6+ 语法
 * （async/await、class、箭头函数），转译只为兼容 < 2.0 的古董基础库，**毫无必要**。
 *
 * ## 为什么必须写成护栏而不是「改一次就完事」
 *
 * 这三项在开发者工具 GUI 里就是三个**复选框**（「将 JS 编译成 ES5」「上传时压缩」
 * 「上传时生成 sourcemap」），任何人在 GUI 里勾一下就会**写回本文件**，
 * 且**不报错、不影响本地预览**——只在最终上传那一刻突然拒绝，
 * 排查成本极高（本次就误判过一轮根因）。护栏把「静默复发」变成「测试变红」。
 *
 * ## 关键陷阱：改源文件后必须重新构建
 *
 * 🔴 微信开发者工具打开的项目根是 **`mini/dist`**（见 DevTools workspace.json 实证），
 * 真正生效的是 **`dist/project.config.json`**，不是仓库里的 `mini/project.config.json`。
 * Taro 构建时会把 `mini/project.config.json` **拷进 dist 并把 `miniprogramRoot` 改写成 `./`**。
 *
 * 所以「改了 `mini/project.config.json` 但没跑 `npm run build:weapp`」= **改动完全无效**，
 * 工具仍读旧配置。这正是 2026-11-10 第一轮修复失败的原因（体积只动了 2KB，
 * 那 2KB 是同期 `common.js` 的自然增长，配置根本没被读到）。
 *
 * 本护栏校验**源文件**（仓库唯一真相源、可被 commit 追踪；`dist` 已 gitignore），
 * 并要求构建后二者一致 —— 见最后一条「源与产物同步」断言。
 *
 * ## 三条护栏铁律的落实
 *
 * ① 一个 `it()` 只一条断言 → 每个 setting 独立 `it()`。
 * ② 匹配「实际使用」→ 读的是**解析后的 JSON 值**（`c.setting.es6 === false`），
 *    不做字符串 grep，避免被注释或同名字段误伤。
 * ③ `stripComments()` → 本护栏对象是 **JSON**，JSON 无注释语法，
 *    故不适用；改为 `JSON.parse` 解析（本身即校验文件合法性，语法错误会直接抛）。
 *
 * ## 明确不在射程内
 *
 * - **不校验 `dist/project.config.json` 一定存在**：dist 已 gitignore，CI/干净克隆下
 *   本就没有产物。仅在 dist 存在时（本地开发态）校验其与源一致。
 * - **不校验 `enhance`**：增强编译（babel7 + preset-env + 跨文件共享 helpers）
 *   官方建议开启，且它本身不产生 `es6:true` 那种「解压已压缩产物」的膨胀。
 *   它与 `es6:false` 可共存。
 * - **不校验 `libVersion` 具体值**：基础库版本会随项目升级，只要 ≥ 2.11.2
 *   即原生支持 async/await，写死具体版本号只会造成无意义的红。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const SRC_CONFIG = join(ROOT, 'mini/project.config.json')
const DIST_CONFIG = join(ROOT, 'mini/dist/project.config.json')

/**
 * 解析 project.config.json。
 * JSON.parse 本身即一道校验：文件语法损坏会直接抛，测试变红（而非静默通过）。
 */
function readConfig(p: string): {
  miniprogramRoot?: string
  libVersion?: string
  setting?: Record<string, unknown>
} {
  return JSON.parse(readFileSync(p, 'utf8'))
}

const SRC = readConfig(SRC_CONFIG)

describe('护栏 22 · mini 上传期编译配置（主包 2048KB 闸门）', () => {
  describe('setting.es6 —— 禁止对已压缩产物做 ES6→ES5 二次转译', () => {
    it('必须为 false（产物已由 terser 压缩，基础库原生支持 ES6，转译纯膨胀 +565KB）', () => {
      expect(SRC.setting?.es6).toBe(false)
    })
  })

  describe('setting.minified —— 上传时必须压缩混淆', () => {
    it('必须为 true（官方文档：开启可减小代码包体积）', () => {
      expect(SRC.setting?.minified).toBe(true)
    })
  })

  describe('setting.uploadWithSourceMap —— 不附带 sourcemap', () => {
    it('必须为 false（sourcemap 只服务线上报错定位，不应占主包配额）', () => {
      expect(SRC.setting?.uploadWithSourceMap).toBe(false)
    })
  })

  describe('基础库版本 —— 必须高到原生支持 ES6+，es6:false 才安全', () => {
    // 🔴 这是 `es6:false` 的**前置安全条件**，不是可选装饰：
    // 若哪天 libVersion 被降到 < 2.11.2（不支持 async/await），
    // 关掉 es6 转译会让含 async 的 vendors.js（cloud-sdk）在真机直接语法报错。
    // 故二者必须一起校验，防止「单独改一个」造成运行时崩溃。
    it('libVersion 主版本 ≥ 3（3.4.10 原生支持 async/await、class、箭头函数）', () => {
      const major = Number(String(SRC.libVersion ?? '0').split('.')[0])
      expect(major).toBeGreaterThanOrEqual(3)
    })
  })

  describe('源与产物同步 —— 🔴 改源文件后必须重新构建', () => {
    // 微信开发者工具打开的项目根是 mini/dist，真正生效的是 dist/project.config.json。
    // Taro 构建时把 mini/project.config.json 拷进 dist 并把 miniprogramRoot 改写成 './'。
    // 「只改源、不构建」= 改动完全无效（2026-11-10 第一轮修复失败的确切原因）。
    it('若 dist 已构建，其三项 setting 必须与源一致（不一致 = 改了没重新 build）', () => {
      if (!existsSync(DIST_CONFIG)) return // dist 已 gitignore，干净克隆下无产物，跳过
      const dist = readConfig(DIST_CONFIG)
      expect([dist.setting?.es6, dist.setting?.minified, dist.setting?.uploadWithSourceMap]).toEqual([
        SRC.setting?.es6,
        SRC.setting?.minified,
        SRC.setting?.uploadWithSourceMap,
      ])
    })

    it('dist 的 miniprogramRoot 必须是 "./"（工具以 dist 为项目根，路径口径不同）', () => {
      if (!existsSync(DIST_CONFIG)) return
      expect(readConfig(DIST_CONFIG).miniprogramRoot).toBe('./')
    })
  })
})
