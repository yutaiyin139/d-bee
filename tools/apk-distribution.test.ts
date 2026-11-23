/**
 * 护栏 30 · Android APK 分发基线（闭合 `knownGap_guardrailNotWired`，2026-11-19 拍板 D-10）。
 *
 * 补的是什么：`tools/apk-distribution.baseline.json` 的 `_about` 自称
 *   「护栏 30 只保证：登记的 sha256/字节数/版本号与真实 APK 逐字一致、
 *     合规闸门未就绪时不被静默改成已就绪、下载页在备案编号缺失时不渲染假号」
 *   —— 但建立于 2026-11-16 时全仓对 `apk-distribution` 的引用为 **0 处**，
 *   30 个门禁文件里没有任何一个读它 → 上述断言**没有自动守护，纯靠发版人自觉**。
 *   风险：基线可被改成 `status=published` / `blockPublicDistribution=false` /
 *   填假 `beianNumber` 而门禁全绿。本文件即闭合该缺口。
 *
 * 🔴 **边界（必须写清，否则会被误当成「可以分发」证明）**：
 *   与护栏 19 同范式 —— 本护栏只保「**登记 ↔ 仓库真源**一致」，
 *   **不保「仓库 ↔ 生产」一致**。APK 是否真被上传、生产 URL 是否 200、
 *   Content-Length 是否相符，都在仓库之外，必须由 `deploy/publish-apk.sh --apply`
 *   实测后回填。**护栏全绿 ≠ 已发布 ≠ 可以分发。**
 *   🔴 尤其 `signerMd5`：需 `apksigner verify --print-certs` 才能实测，该工具
 *   不在本仓 CI 环境（Windows 无 Android SDK）→ 本护栏只做**格式守卫 + 历史一致性**，
 *   不宣称实测。发版人须按基线 `_check` 手工复核。
 *
 * 🔴 本护栏已按项目铁律做**红验证**（故意改坏基线确认 FAIL，见当日日志）。
 * 运行：npx vitest run tools/apk-distribution.test.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * 逐行剥离注释，只留「生效代码行」。
 *
 * 🔴 **刻意不用项目里那个字符级 `stripComments()`**：它的状态机不识别**正则字面量**，
 *   实测被 `tools/gen-download-page.mjs:61` 的 `/[&<>"']/g` 里的 `"` 带偏 → 从该行起
 *   整份文件都被当成「在双引号字符串里」，块注释再也剥不掉，导致
 *   「不得硬编码域名」这类否定断言**假阳**（把 JSDoc 里的 `d-bee.cn` 当生效代码）。
 *   而且它是 JS 语法（`//`、`/* *\/`），对 `deploy/publish-apk.sh` 的 `#` 注释**完全不剥离**。
 *
 * 本函数按「整行是注释」判定，对本文件的用途（断言某个字面量**不得出现在生效代码**）足够：
 *   · `.mjs` / `.ts`：剥 `//`、`/*`、`*`（JSDoc 续行）开头的行
 *   · `.sh`：剥 `#` 开头的行（含 shebang）
 * 🔴 已知边界：**行尾内联注释**（`code // 备注`）不会被剥 → 若字面量只写在行尾注释里，
 *   本断言会假阳。这是刻意选的保守方向（宁可假阳逼人改注释，不可假阴放过硬编码）。
 */
function codeLines(src: string, lang: 'js' | 'sh' | 'html'): string {
  const isComment = (t: string) => {
    if (lang === 'sh') return t.startsWith('#')
    if (lang === 'html') return t.startsWith('<!--')
    return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')
  }
  return src
    .split('\n')
    .filter((l) => !isComment(l.trim()))
    .join('\n')
}

const BASELINE_PATH = 'tools/apk-distribution.baseline.json'
const BASELINE = JSON.parse(read(BASELINE_PATH)) as {
  apk: {
    file: string
    versionName: string
    versionCode: number
    packageName: string
    bytes: number
    sha256: string
    applicationLabel: string
    minSdk: number
    targetSdk: number
    signerMd5: string
  }
  supersededApks?: Array<{
    file: string
    sha256?: string
    bytes?: number
    versionCode?: number
    /** 🔴 2026-11-20 起：归档 APK 本体已按用户拍板方案 C 删除，登记条目以此标记留证 */
    archived?: { deletedAt: string; deletedBy?: string; note: string }
  }>
  knownGap_guardrailNotWired?: { status: string; issue: string; note: string }
  complianceGates: {
    appBeian: { status: string; beianNumber: string; blockPublicDistribution: boolean }
    icpBeian?: { status: string; beianNumber: string; blockPublicDistribution?: boolean }
    softwareCopyright?: { status: string; blockStoreListing: boolean; blockPublicDistribution: boolean }
  }
  distribution: { status: string; channel: string; publicUrl: string; downloadPath: string }
  generatedArtifacts?: { pageTemplate: string; pageOutputDir: string }
}

const APK = BASELINE.apk
const GATES = BASELINE.complianceGates
const DIST = BASELINE.distribution

/** 真实 APK 的实测 sha256（9.8MB，一次算好复用；文件不存在则为 null）。 */
function realSha256(): string | null {
  if (!existsSync(join(ROOT, APK.file))) return null
  return createHash('sha256').update(readFileSync(join(ROOT, APK.file))).digest('hex')
}

// ── shared 备案号真源（四端同源）──────────────────────────────────────
const SHARED_CONSTANTS = read('packages/shared/src/constants/index.ts')
function sharedConst(name: string): string {
  const m = SHARED_CONSTANTS.match(new RegExp(`export const ${name} = '([^']*)'`))
  return m ? m[1] : ''
}
const APP_BEIAN_TRUTH = sharedConst('APP_ICP_BEIAN')
const ICP_BEIAN_TRUTH = sharedConst('ICP_BEIAN_D_BEE_CN')

// ── Android 构建真源（基线的 versionCode/label/包名必须与之逐字一致）──────
const BUILD_GRADLE = read('android/app/build.gradle')
const VARIABLES_GRADLE = read('android/variables.gradle')
const STRINGS_XML = read('android/app/src/main/res/values/strings.xml')
function gradleInt(key: string): number {
  const m = BUILD_GRADLE.match(new RegExp(`^\\s*${key}\\s+(\\d+)\\s*$`, 'm'))
  return m ? Number(m[1]) : NaN
}
/**
 * minSdk/targetSdk 的真源在 `android/variables.gradle` 的 `ext { minSdkVersion = 26 }`，
 * `build.gradle` 里只是 `minSdkVersion rootProject.ext.minSdkVersion` 引用 → 读 build.gradle 得 NaN。
 */
function variablesGradleInt(key: string): number {
  const m = VARIABLES_GRADLE.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'm'))
  return m ? Number(m[1]) : NaN
}
function gradleStr(key: string): string {
  const m = BUILD_GRADLE.match(new RegExp(`^\\s*${key}\\s+"([^"]*)"\\s*$`, 'm'))
  return m ? m[1] : ''
}
function stringRes(name: string): string {
  const m = STRINGS_XML.match(new RegExp(`<string name="${name}">([^<]*)</string>`))
  return m ? m[1] : ''
}

// ══════════════════════════════════════════════════════════════════════
describe('护栏 30-A · 基线登记 ↔ 真实 APK 逐字一致', () => {
  it('基线 apk.file 指向的文件确实存在（登记不得指向不存在的包）', () => {
    expect(existsSync(join(ROOT, APK.file)), `APK 不存在：${APK.file}`).toBe(true)
  })

  it('基线 apk.bytes 与真实文件字节数逐字一致', () => {
    expect(statSync(join(ROOT, APK.file)).size).toBe(APK.bytes)
  })

  it('基线 apk.sha256 与真实文件 sha256 逐字一致（防「登记了另一个包的指纹」）', () => {
    expect(realSha256()).toBe(APK.sha256)
  })

  it('基线 apk.versionCode 与 android/app/build.gradle 一致', () => {
    expect(gradleInt('versionCode')).toBe(APK.versionCode)
  })

  it('基线 apk.versionName 与 android/app/build.gradle 一致', () => {
    expect(gradleStr('versionName')).toBe(APK.versionName)
  })

  it('基线 apk.packageName 与 build.gradle applicationId 一致', () => {
    expect(gradleStr('applicationId')).toBe(APK.packageName)
  })

  it('基线 apk.minSdk 与 variables.gradle 的 minSdkVersion 一致（build.gradle 只是 ext 引用）', () => {
    expect(variablesGradleInt('minSdkVersion')).toBe(APK.minSdk)
  })

  it('基线 apk.targetSdk 与 variables.gradle 的 targetSdkVersion 一致', () => {
    expect(variablesGradleInt('targetSdkVersion')).toBe(APK.targetSdk)
  })

  it('基线 apk.applicationLabel 与 strings.xml app_name 逐字一致（防改名后基线漂移）', () => {
    expect(stringRes('app_name')).toBe(APK.applicationLabel)
  })

  it('基线 applicationLabel 是中文名「自律蜜蜂」（软著名/App备案名/商店名须逐字一致，否则填号 409）', () => {
    expect(APK.applicationLabel).toBe('自律蜜蜂')
  })

  it('基线 apk.signerMd5 是 32 位 hex（🔴 格式守卫，非实测：apksigner 不在 CI 环境，发版人须手工复核）', () => {
    expect(APK.signerMd5).toMatch(/^[0-9a-f]{32}$/)
  })

  it('基线 apk.sha256 是 64 位 hex（防登记成截断值/md5 冒充）', () => {
    expect(APK.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('护栏 30-B · 合规闸门未被静默改成已就绪', () => {
  it('blockPublicDistribution=true 时 distribution.status 不得为 published（基线自称的核心保证）', () => {
    const blocked = GATES.appBeian.blockPublicDistribution === true
    expect(blocked && DIST.status === 'published').toBe(false)
  })

  it('status=published 时 App 备案必须已 issued（未备案不得公网分发）', () => {
    const published = DIST.status === 'published'
    expect(published && GATES.appBeian.status !== 'issued').toBe(false)
  })

  it('channel=public_site 时 blockPublicDistribution 必须为 false（渠道与闸门不得自相矛盾）', () => {
    const isPublicSite = DIST.channel === 'public_site'
    expect(isPublicSite && GATES.appBeian.blockPublicDistribution !== false).toBe(false)
  })

  it('channel=app_store 时软著必须已 issued（商店上架的硬前置）', () => {
    const isStore = DIST.channel === 'app_store'
    const copyrightIssued = GATES.softwareCopyright?.status === 'issued'
    expect(isStore && !copyrightIssued).toBe(false)
  })

  it('status=published 时 publicUrl 与 downloadPath 均非空（防「标已发布却无处可下」）', () => {
    const published = DIST.status === 'published'
    expect(published && (!DIST.publicUrl || !DIST.downloadPath)).toBe(false)
  })

  it('App 备案 beianNumber 非空时 blockPublicDistribution 才可为 false（防「无号却开闸」）', () => {
    const gateOpen = GATES.appBeian.blockPublicDistribution === false
    expect(gateOpen && !GATES.appBeian.beianNumber).toBe(false)
  })

  it('软著未取证时 blockStoreListing 必须为 true（不得把「计划」写成「已就绪」）', () => {
    const notIssued = GATES.softwareCopyright?.status !== 'issued'
    expect(notIssued && GATES.softwareCopyright?.blockStoreListing !== true).toBe(false)
  })

  it('软著 blockPublicDistribution 必须为 false（软著只卡商店，不卡自建分发页；写反会误阻断 public_site）', () => {
    expect(GATES.softwareCopyright?.blockPublicDistribution).toBe(false)
  })
})

describe('护栏 30-C · 备案号单一真源（下载页不得渲染假号）', () => {
  it('shared 的 APP_ICP_BEIAN 真源非空（本组断言的前提，空则后续比对无意义）', () => {
    expect(APP_BEIAN_TRUTH.length).toBeGreaterThan(0)
  })

  it('基线 appBeian.beianNumber 与 shared APP_ICP_BEIAN 逐字一致（改号须双处同步，此前无护栏钉死）', () => {
    expect(GATES.appBeian.beianNumber).toBe(APP_BEIAN_TRUTH)
  })

  it('基线 icpBeian.beianNumber 与 shared ICP_BEIAN_D_BEE_CN 逐字一致（🔴 -3A 与 -2 是两个号不可混）', () => {
    expect(GATES.icpBeian?.beianNumber).toBe(ICP_BEIAN_TRUTH)
  })

  it('两个备案号互不相同（防「把 App 备案号抄进网站 ICP 字段」这类错配）', () => {
    expect(GATES.appBeian.beianNumber).not.toBe(GATES.icpBeian?.beianNumber)
  })

  it('下载页生成器不硬编码任何备案号（须走 SITE 真源；剥离注释后判定）', () => {
    const code = codeLines(read('tools/gen-download-page.mjs'), 'js')
    expect(code).not.toMatch(/ICP备\d{6,}号/)
  })

  it('下载页生成器不硬编码域名（须走 VITE_NATIVE_ENDPOINT / publicUrl 解析链）', () => {
    const code = codeLines(read('tools/gen-download-page.mjs'), 'js')
    expect(code).not.toMatch(/d-bee\.cn/)
  })

  it('下载页模板不硬编码备案号与域名（模板只留占位符）', () => {
    const tpl = codeLines(read('tools/templates/apk-download.html'), 'html')
    expect(tpl).not.toMatch(/ICP备\d{6,}号|d-bee\.cn/)
  })

  it('发布脚本不硬编码备案号（实测期望值须取自基线）', () => {
    const sh = codeLines(read('deploy/publish-apk.sh'), 'sh')
    expect(sh).not.toMatch(/ICP备\d{6,}号/)
  })

  it('发布脚本不硬编码域名（缺域名须报错而非猜一个站去实测）', () => {
    const sh = codeLines(read('deploy/publish-apk.sh'), 'sh')
    expect(sh).not.toMatch(/d-bee\.cn/)
  })

  it('生成器在备案号为空时不渲染该行（基线自称的「不渲染假号」保证）', () => {
    const code = codeLines(read('tools/gen-download-page.mjs'), 'js')
    // 必须是条件渲染：SITE.appIcp / SITE.icp 各自判空后才 push 行
    expect(code.includes('if (SITE.appIcp)') && code.includes('if (SITE.icp)')).toBe(true)
  })

  it('生成器有「未替换占位符」守卫（模板新增占位符忘了替换会产出带 __XX__ 的页面）', () => {
    const code = codeLines(read('tools/gen-download-page.mjs'), 'js')
    expect(code.includes('__[A-Z_]+__')).toBe(true)
  })

  it('生成器实测复核 APK（存在 + bytes + sha256 三项，缺一即 exit 1）', () => {
    const code = codeLines(read('tools/gen-download-page.mjs'), 'js')
    const checks = [
      code.includes('st.size !== apk.bytes'),
      code.includes("createHash('sha256')"),
      code.includes('realSha !== apk.sha256'),
    ]
    expect(checks.every(Boolean)).toBe(true)
  })
})

describe('护栏 30-D · 禁分发纪律（旧包会被 0052 网关静默重写为食物识别）', () => {
  // 🔴 2026-11-20 用户拍板方案 C：release/ + dist-release/ 归档 APK 全清（38 个 / 296.1 MiB），
  //    仅保留当前可分发候选 vc31。故本条断言由「文件必须存在」**放宽**为
  //    「不得存在未登记的幽灵条目」：已删除的包必须显式带 archived.deletedAt 留证标记。
  //    放宽已做红验证（注入一个无 archived 标记的假条目 → 本条 FAIL）。
  //    🔴 真正的硬约束转移到下面两条：当前候选必须存在、且当前候选绝不可被归档。
  it('supersededApks 每条要么文件在盘、要么已登记 archived（不得有未登记幽灵条目）', () => {
    const list = BASELINE.supersededApks ?? []
    expect(
      list.length > 0 &&
        list.every((s) => existsSync(join(ROOT, s.file)) || Boolean(s.archived?.deletedAt)),
    ).toBe(true)
  })

  it('当前可分发候选 apk.file 必须真实存在于盘上（分发前最后一道硬闸门）', () => {
    expect(existsSync(join(ROOT, APK.file))).toBe(true)
  })

  it('当前可分发候选 apk.file 绝不能被登记为 archived（已删的包不得被当作可分发）', () => {
    const list = BASELINE.supersededApks ?? []
    const hit = list.find((s) => s.file === APK.file)
    expect(hit === undefined || hit.archived === undefined).toBe(true)
  })

  it('已归档条目必须逐条写清 deletedAt 与 note（删除留证不可追溯即视为登记不实）', () => {
    const list = (BASELINE.supersededApks ?? []).filter((s) => s.archived !== undefined)
    expect(
      list.length > 0 &&
        list.every(
          (s) =>
            typeof s.archived?.deletedAt === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(s.archived.deletedAt) &&
            typeof s.archived?.note === 'string' &&
            s.archived.note.length > 20,
        ),
    ).toBe(true)
  })

  it('已归档条目必须保留 sha256 + bytes 指纹（文件已删，指纹即唯一留证）', () => {
    const list = (BASELINE.supersededApks ?? []).filter((s) => s.archived !== undefined)
    expect(
      list.length > 0 &&
        list.every((s) => /^[0-9a-f]{64}$/.test(s.sha256 ?? '') && typeof s.bytes === 'number' && s.bytes > 1000000),
    ).toBe(true)
  })

  it('当前可分发候选 apk.file 不在 supersededApks 里（不得自相矛盾）', () => {
    const list = BASELINE.supersededApks ?? []
    expect(list.some((s) => s.file === APK.file)).toBe(false)
  })

  it('supersededApks 逐条都写了 reason（禁分发理由必须可追溯，不能只列文件名）', () => {
    const raw = read(BASELINE_PATH)
    const parsed = JSON.parse(raw) as { supersededApks?: Array<{ reason?: string }> }
    const list = parsed.supersededApks ?? []
    expect(list.every((s) => typeof s.reason === 'string' && s.reason.length > 10)).toBe(true)
  })

  it('supersededApks 的 versionCode 均小于当前候选（被取代的必是更旧的包）', () => {
    const list = (BASELINE.supersededApks ?? []).filter((s) => typeof s.versionCode === 'number')
    expect(list.every((s) => (s.versionCode as number) < APK.versionCode)).toBe(true)
  })

  it('基线 apk.file 必须是 FORMAL 正式包（禁把 HCTEST/INTERNAL/debug 包登记为候选）', () => {
    expect(APK.file).toMatch(/FORMAL/)
  })

  it('分发工具链三件套均已实现（A8 缺口已闭合：生成器 + 模板 + 发布脚本）', () => {
    const files = [
      'tools/gen-download-page.mjs',
      'tools/templates/apk-download.html',
      'deploy/publish-apk.sh',
    ]
    expect(files.every((f) => existsSync(join(ROOT, f)))).toBe(true)
  })

  it('基线 generatedArtifacts 登记的路径与实物一致（登记先于实现的历史欠账已对齐）', () => {
    const ga = BASELINE.generatedArtifacts
    expect(
      ga?.pageTemplate === 'tools/templates/apk-download.html' &&
        existsSync(join(ROOT, ga.pageTemplate)),
    ).toBe(true)
  })

  it('发布脚本默认 dry-run 且必须显式 --apply 才碰生产（防手滑发布）', () => {
    const sh = codeLines(read('deploy/publish-apk.sh'), 'sh')
    expect(sh.includes('MODE="dry-run"') && sh.includes('--apply) MODE="apply"')).toBe(true)
  })

  it('发布脚本上传后必须设 0644/0755（dbee-ssh.py 的 putbin 设 0600 会让 nginx 403）', () => {
    const sh = codeLines(read('deploy/publish-apk.sh'), 'sh')
    expect(sh.includes('0o644') && sh.includes('0o755')).toBe(true)
  })

  it('发布脚本不复用 dbee-ssh.py putbin（0600 权限坑），自行 SFTP 写入', () => {
    const sh = codeLines(read('deploy/publish-apk.sh'), 'sh')
    expect(sh.includes('dbee-ssh.py putbin')).toBe(false)
  })

  it('发布脚本生产实测三项齐备（HTTP 200 + Content-Length == bytes + 服务器侧 sha256）', () => {
    const sh = codeLines(read('deploy/publish-apk.sh'), 'sh')
    const checks = [
      sh.includes('Content-Length') || sh.includes('content-length'),
      sh.includes('APK_BYTES'),
      sh.includes('sha256sum'),
    ]
    expect(checks.every(Boolean)).toBe(true)
  })
})

describe('护栏 30-E · knownGap 登记诚实性', () => {
  it('knownGap_guardrailNotWired 已标注为被本护栏闭合（登记不得停留在 unfixed 而实际已修）', () => {
    const gap = BASELINE.knownGap_guardrailNotWired
    // 本文件存在即缺口已闭合；基线 knownGap.status 须同步改成 fixed_*，否则属登记滞后 → 红
    expect(gap ? gap.status !== 'unfixed_pending_decision' : true).toBe(true)
  })
})
