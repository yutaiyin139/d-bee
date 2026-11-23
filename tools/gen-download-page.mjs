/**
 * 生成 **Android 自建分发页**（`dist-release/download/index.html`）+ 发布前校验。
 *
 * 为什么必须有它（2026-11-19 拍板 D-2 = 走 `public_site` 自建分发页；A8 工具链缺口）：
 *   App 备案 `-3A` 已下证 → 基线 `complianceGates.appBeian.blockPublicDistribution=false`
 *   → 公网分发合规闸门已开，**不必等软著**（软著只卡 `app_store` 渠道）。
 *   但分发载体此前不存在：没有下载页生成器、没有模板、没有发布脚本。
 *
 * 🔴 三条设计纪律（与基线 `generatedArtifacts._check` / `knownGap_guardrailNotWired.note` 对齐）：
 *   1. **备案号单一真源**：从 `src/content/legal.ts` 的 `SITE` 取（`SITE.icp` = 网站 ICP、
 *      `SITE.appIcp` = App 备案），**严禁硬编码**——硬编码必然漂移，且基线明确要求
 *      「下载页在备案编号缺失时不渲染假号」。用 vite `ssrLoadModule` 与
 *      `tools/gen-legal-static.mjs` 走同一条解析链，改法律文本/改号只需改一处。
 *   2. **APK 元信息单一真源**：versionName/versionCode/bytes/sha256/包名/minSdk 全部
 *      读 `tools/apk-distribution.baseline.json`，并且**实测复核**（文件存在 + 字节数一致 +
 *      sha256 一致）。不一致直接 exit 1，绝不产出与真实安装包不符的页面。
 *   3. **零 JS、内联 CSS、无外部资源**：审核爬虫与弱网用户都能拿到完整内容；
 *      不引 `/assets/*.js`（hash 文件名下次构建即失效）。
 *
 * 🔴 下载页标注 **两个号**（分发者义务 vs 页面义务，性质不同不可混）：
 *   · `京ICP备2026075565号-3A` = **App** 备案 → 工信部《关于开展移动互联网应用程序备案工作的
 *     通知》要求「分发平台应在显著位置标注其分发的 APP 备案编号」；
 *   · `京ICP备2026075565号-2` = **网站** ICP → 页面自身义务。
 *   ⚠️ 因此 `deploy/verify-legal.mjs` **不得**拿来验收 `/download/`：它的备案号双向校验
 *      期望值是 `SITE.icp`（-2），而本页按工信部要求必须同时出现 -3A，会被判
 *      「出现期望号之外的其他备案号」而 FAIL。这不是页面 bug，是校验口径不同。
 *      同理 `src/components/SiteFooter.tsx` 用 `isNative()` 门控只在原生壳渲染 -3A，
 *      与本页刻意分叉，勿"顺手统一"。
 *
 * 运行：
 *   node tools/gen-download-page.mjs                    # 默认输出 dist-release/download
 *   node tools/gen-download-page.mjs <outDir>           # 指定输出目录
 *   node tools/gen-download-page.mjs <outDir> --check   # 只校验不写文件（CI/自检用）
 *
 * 🔴 本脚本**不上传、不发布**：上传与生产实测在 `deploy/publish-apk.sh`，
 *    且必须 `--apply` 显式确认（默认 dry-run）。
 *
 * 退出码：0 成功 / 1 校验失败或产物不完整 / 2 基线或模板缺失
 */
import { createServer, loadEnv } from 'vite'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const outArg = args.find((a) => !a.startsWith('--'))
const OUT_DIR = outArg
  ? path.resolve(outArg)
  : path.join(ROOT, 'dist-release', 'download')

const BASELINE_PATH = path.join(ROOT, 'tools', 'apk-distribution.baseline.json')
const TEMPLATE_PATH = path.join(ROOT, 'tools', 'templates', 'apk-download.html')

/** HTML 转义。所有值都来自我们自己维护的真源，仍按纪律转义（防 `&`/`<` 破坏结构）。 */
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

/**
 * minSdk(API level) → Android 版本号文案。
 *
 * 为什么要这个映射：`minSdk 26` 对用户毫无意义，下载页必须写人能读懂的
 * 「Android 8.0 及以上」。这是**事实性对照表**，不是业务数值口径
 * （业务数值口径权威在 `src/lib/numfmt.ts` → `@dbee/shared`，此处不涉及）。
 * 未登记的 level 返回空串 → 模板层不渲染该行，**绝不猜**。
 */
const API_TO_ANDROID = {
  24: '7.0',
  26: '8.0',
  28: '9.0',
  29: '10',
  30: '11',
  31: '12',
  33: '13',
  34: '14',
  35: '15',
  36: '16',
}

/** 字节数 → 人类可读体积（MB，1 位小数）。仅用于下载页展示，不参与任何校验判定。 */
function humanSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fail(msg) {
  console.error(`[download-page] ❌ ${msg}`)
  process.exit(1)
}

async function main() {
  // ---- 1. 读基线（APK 元信息真源）----
  let baseline
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  } catch {
    fail(`基线不可读或 JSON 非法：${path.relative(ROOT, BASELINE_PATH)}`)
  }
  const apk = baseline?.apk
  if (!apk?.file || !apk.versionName || !apk.bytes || !apk.sha256) {
    fail('基线 apk 段缺 file/versionName/bytes/sha256，无法生成下载页')
  }

  // ---- 2. 合规闸门校验：备案未下证时拒绝生成公开分发页 ----
  const appBeian = baseline?.complianceGates?.appBeian
  if (appBeian?.blockPublicDistribution === true) {
    fail(
      '合规闸门未开（complianceGates.appBeian.blockPublicDistribution=true）：' +
        'App 备案未下证前不得生成公开分发页。内部测试请走点对点分发。',
    )
  }

  // ---- 3. 实测复核 APK 文件：存在 + 字节数 + sha256 三者一致 ----
  const apkPath = path.join(ROOT, apk.file)
  let st
  try {
    st = await stat(apkPath)
  } catch {
    fail(`基线登记的 APK 不存在：${apk.file}（发版人须实测复核，勿沿用旧值）`)
  }
  if (st.size !== apk.bytes) {
    fail(`字节数不符：基线 ${apk.bytes} ≠ 实测 ${st.size}（${apk.file}）`)
  }
  const buf = await readFile(apkPath)
  const realSha = createHash('sha256').update(buf).digest('hex')
  if (realSha !== apk.sha256) {
    fail(`sha256 不符：基线 ${apk.sha256} ≠ 实测 ${realSha}（${apk.file}）`)
  }

  // ---- 4. 读模板 ----
  let tpl
  try {
    tpl = await readFile(TEMPLATE_PATH, 'utf8')
  } catch {
    fail(`模板缺失：${path.relative(ROOT, TEMPLATE_PATH)}`)
  }

  // ---- 5. 用 vite ssrLoadModule 取 SITE（备案号/运营主体单一真源）----
  // middlewareMode + appType:'custom'：只用 vite 的模块加载能力，不起 HTTP 服务
  const server = await createServer({
    root: ROOT,
    mode: 'production',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  })

  /**
   * 下载页安全提示里要写的「官方域名」。
   *
   * 🔴 **刻意不硬编码 `d-bee.cn`**：shared 无域名常量、`SITE` 也不暴露域名，
   *   项目里域名真相源是分散的（`server/lib/config.mjs` 的 `PUBLIC_BASE_URL` 默认值 /
   *   nginx `server_name` / `VITE_NATIVE_ENDPOINT`）。写死会造出第 N 份漂移源。
   *   解析链：`VITE_NATIVE_ENDPOINT`（构建期覆盖口，同 SITE.icp 的 env 覆盖口思路）
   *   → 基线 `distribution.publicUrl`（发布后由 publish-apk.sh 回填的实测 URL）
   *   → 都取不到则**不写域名**，降级为「请只从官方页面下载」纯文字提示。
   *   与 `src/lib/miniOrderGuide.ts` 既有设计同一纪律：**绝不渲染猜测值/死链接**。
   */
  const viteEnv = loadEnv('production', ROOT, '')
  function resolveSiteLabel() {
    for (const raw of [viteEnv?.VITE_NATIVE_ENDPOINT, baseline?.distribution?.publicUrl]) {
      const v = String(raw ?? '').trim()
      if (!v) continue
      try {
        return new URL(v).hostname
      } catch {
        // 非完整 URL（例如只填了域名）→ 去掉协议与路径后当 hostname 用
        const bare = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim()
        if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(bare)) return bare
      }
    }
    return ''
  }

  let html
  try {
    const mod = await server.ssrLoadModule('/src/content/legal.ts')
    const SITE = mod?.SITE
    if (!SITE?.name || !SITE?.operator || !SITE?.contactEmail) {
      fail('SITE 缺 name/operator/contactEmail，无法生成下载页（不得硬编码兜底）')
    }

    // 备案块：两个号都有才渲染「App 备案」行；缺号则**不渲染该行**（展示假号属违规）
    const rows = []
    if (SITE.appIcp) {
      rows.push(
        `<tr><th>App 备案号</th><td><a href="${esc(SITE.icpUrl)}" target="_blank" rel="noreferrer noopener">${esc(SITE.appIcp)}</a></td></tr>`,
      )
    } else {
      console.warn('[download-page] ⚠️ SITE.appIcp 为空 → App 备案号行不渲染（分发者义务缺口，请核对）')
    }
    if (SITE.icp) {
      rows.push(
        `<tr><th>网站 ICP 备案号</th><td><a href="${esc(SITE.icpUrl)}" target="_blank" rel="noreferrer noopener">${esc(SITE.icp)}</a></td></tr>`,
      )
    } else {
      console.warn('[download-page] ⚠️ SITE.icp 为空 → 网站备案号行不渲染')
    }
    if (SITE.police) {
      rows.push(
        `<tr><th>公安联网备案号</th><td><a href="${esc(SITE.policeUrl)}" target="_blank" rel="noreferrer noopener">${esc(SITE.police)}</a></td></tr>`,
      )
    }
    const beianBlock = rows.length
      ? `      <section>\n        <h2>备案信息</h2>\n        <table>\n          ${rows.join('\n          ')}\n        </table>\n      </section>`
      : ''

    const apkName = path.basename(apk.file)
    const minAndroid = API_TO_ANDROID[apk.minSdk] ?? ''
    const siteLabel = resolveSiteLabel()
    if (!siteLabel) {
      console.warn(
        '[download-page] ⚠️ 未解析到官方域名（VITE_NATIVE_ENDPOINT 与 distribution.publicUrl 均为空）' +
          '→ 安全提示降级为「只从官方页面下载」，不写具体域名（拒绝硬编码）',
      )
    }
    const safeSourceLine = siteLabel
      ? `请只从本页面（${esc(siteLabel)}）下载安装包，不要使用第三方转发的安装包。`
      : '请只从官方页面下载安装包，不要使用第三方转发的安装包。'

    html = tpl
      .replaceAll('__APP_NAME__', esc(SITE.name))
      .replaceAll('__APP_NAME_EN__', esc(SITE.nameEn))
      .replaceAll('__OPERATOR_ADDRESS__', SITE.operatorAddress ? `（注册地址：${esc(SITE.operatorAddress)}）` : '')
      .replaceAll('__OPERATOR__', esc(SITE.operator))
      .replaceAll('__CONTACT_EMAIL__', esc(SITE.contactEmail))
      // 🔴 safeSourceLine 内部已按需 esc()，此处不再二次转义（否则括号内域名会变成 &amp;）
      .replaceAll('__SAFE_SOURCE_LINE__', safeSourceLine)
      .replaceAll('__APK_FILE__', esc(apkName))
      .replaceAll('__APK_HREF__', esc(`/download/${apkName}`))
      .replaceAll('__VERSION_NAME__', esc(apk.versionName))
      .replaceAll('__VERSION_CODE__', esc(apk.versionCode))
      .replaceAll('__BYTES__', esc(apk.bytes))
      .replaceAll('__SIZE_HUMAN__', esc(humanSize(apk.bytes)))
      .replaceAll('__SHA256__', esc(apk.sha256))
      .replaceAll('__PACKAGE_NAME__', esc(apk.packageName))
      .replaceAll('__MIN_SDK__', esc(apk.minSdk))
      .replaceAll('__MIN_ANDROID__', esc(minAndroid || '（见安装包说明）'))
      .replaceAll('__GENERATED_AT__', new Date().toISOString().slice(0, 10))
      .replace('__BEIAN_BLOCK__', beianBlock)

    // 残留占位符守卫：模板改了/新增占位符忘了替换 → 宁可不产出也别产出带 __XX__ 的页面
    const leftover = html.match(/__[A-Z_]+__/g)
    if (leftover) {
      fail(`模板存在未替换的占位符：${[...new Set(leftover)].join('、')}`)
    }
  } finally {
    await server.close()
  }

  // ---- 6. 正文长度守卫（与 gen-legal-static.mjs 同思路）----
  const textLen = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length
  if (textLen < 200) {
    fail(`正文仅 ${textLen} 字（<200），疑似渲染不完整 → 不产出`)
  }

  if (CHECK_ONLY) {
    console.log(`[download-page] ✅ 校验通过（--check，未写文件）`)
    console.log(`[download-page]    APK: ${apk.file}`)
    console.log(`[download-page]    版本: ${apk.versionName} (vc${apk.versionCode}) / ${apk.bytes} B / sha256 一致`)
    console.log(`[download-page]    正文 ${textLen} 字`)
    return
  }

  await mkdir(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, 'index.html')
  await writeFile(outFile, html, 'utf8')

  console.log(`[download-page] ✅ 已生成分发页 → ${path.relative(ROOT, outFile)}`)
  console.log(`[download-page]    ${apk.versionName} (vc${apk.versionCode}) / ${humanSize(apk.bytes)} / sha256 实测一致`)
  console.log(`[download-page]    正文 ${textLen} 字`)
  console.log('[download-page] 🔴 下一步发布须走 deploy/publish-apk.sh --apply（含生产实测）')
}

main().catch((e) => {
  console.error('[download-page] 💥 生成失败：', e?.stack || e)
  process.exit(1)
})
