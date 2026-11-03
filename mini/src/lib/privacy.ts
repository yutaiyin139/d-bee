/**
 * 微信隐私授权（P1-G，2026-11-03）。
 *
 * 🔴 为什么必须有这个文件：
 *   小程序端 `scan.tsx` 调 `Taro.chooseImage`（相册/摄像头），属**隐私接口**。
 *   微信自基础库 2.32.3 起支持隐私校验，且 **2023-09-15 之后平台强制开启**
 *   （`usePrivacyCheck` 不再需要开发者手动配）。本项目 `mini/project.config.json`
 *   的 `libVersion` 是 **3.4.10**，远在强制线之上。
 *   若 mp 后台「设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引」未勾选
 *   对应信息类型，真机上 `chooseImage` 会直接失败：
 *     `chooseImage:fail api scope is not declared in the privacy agreement`（errno 112）
 *   —— 拍照识别是小程序的核心转化路径，这条失败等于主功能不可用。
 *   开发者工具因为 `project.config.json` 的 `urlCheck:false` 等旁路，**测不出来**，
 *   只在真机/体验版暴露。
 *
 * 🔴 代码能做什么、不能做什么（务必分清，别以为改完代码就合规了）：
 *   能做：① 在调隐私接口**之前**主动触发授权弹窗，避免「先扣额度再拍照失败」的白扣；
 *        ② 用户拒绝时给可读提示；③ 把 errno 112 翻成人话并指向后台配置项。
 *   **不能做**：授权弹窗的内容来自 mp 后台填写的《用户隐私保护指引》，
 *        **代码里勾不出这个声明**。后台未声明时 `needAuthorization` 恒为 false，
 *        本模块会「看似正常」地放行，然后在真机 chooseImage 处才炸。
 *        → 上线前必须在 mp 后台勾选（见文件尾的清单），这是人工步骤，无法自动化。
 *
 * 与 `AiConsent.tsx` 的区别（两者都要，不是重复）：
 *   `AiConsent` = **我方业务层**对「照片会送 AI 模型识别」的告知同意（PIPL 单独同意），
 *                 存本地 `dbee:ai_consent` + 云端 `ai_consented`，对齐主工程。
 *   本模块     = **微信平台层**的隐私接口授权门禁（errno 112 那一套）。
 *   平台层过了不等于业务层过了，反之亦然。scan.tsx 里两者是串联的两道关。
 */
import Taro from '@tarojs/taro'

/** 隐私授权结果 */
export type PrivacyResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'unsupported' }

/**
 * errno 112 / 隐私声明缺失的特征串。
 * 微信不同版本 errMsg 文案有出入（有带 errno 的、有只带文案的），
 * 所以按「关键字并集」判断，宁可多命中也不要漏。
 */
const PRIVACY_FAIL_RE =
  /privacy|errno[:\s]*112|api scope is not declared|not declared in the privacy agreement|privacy permission is not authorized/i

/** 某个错误是否属于「隐私授权未通过」 */
export function isPrivacyError(e: unknown): boolean {
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : String((e as { errMsg?: string } | null)?.errMsg ?? '')
  return PRIVACY_FAIL_RE.test(msg)
}

/**
 * 用户拒绝授权 / 后台未声明时给用户看的文案。
 *
 * 🔴 文案刻意分两种情形，因为**处置方不同**：
 *   - 用户拒绝 → 用户可以自己解决（重新进入并同意）
 *   - 后台未声明 → 用户无法解决，只能提示联系客服；同时这条文案出现在真机
 *     就等于**运维告警**：说明 mp 后台的隐私指引漏勾了，必须去补。
 * 这里没法区分两者（微信都报 112），所以给一句同时覆盖、且不甩锅给用户的话。
 */
export const PRIVACY_DENIED_TEXT =
  '需要你在隐私授权弹窗中同意后，才能使用拍照识别。若没有弹出授权框，说明本小程序的隐私声明尚未完善，请联系客服反馈。'

/**
 * 在调用隐私接口（chooseImage / chooseMedia 等）之前请求授权。
 *
 * 行为设计（🔴 这里 fail-open / fail-closed 的边界是刻意划的）：
 *   - 用户**明确拒绝** → fail-closed，返回 `ok:false, reason:'denied'`，调用方必须中止。
 *     理由：微信随后必然拦截，继续走只会白扣一次拍照额度。
 *   - API 不存在 / 查询自身报错 → fail-open，返回 `ok:true`。
 *     理由：这是**我方检查逻辑的故障**，不是用户没授权。此时若 fail-closed，
 *     会把「本来能正常拍照」的用户全挡在门外，比放行更糟；放行后微信仍会自己拦，
 *     兜底没丢。与配额侧（P0-B）相反——配额失败放行会**白送 AI 次数（资损）**，
 *     隐私检查失败放行**不会造成资损**，只是可能多一次失败提示，所以两边取向不同。
 *   - 后台未声明隐私类型 → 微信返回 needAuthorization=false，本函数放行，
 *     真正的失败发生在 chooseImage，由 isPrivacyError 兜住。
 *
 * 注意：`requirePrivacyAuthorize` 会触发弹窗（未注册 onNeedPrivacyAuthorization 时
 * 走微信默认弹窗），所以**不要**在页面 onLoad 里无条件调用——那会让用户一进来就被弹窗。
 * 只在用户主动点了「拍照」这类会用到隐私接口的动作时调用。
 */
export async function ensurePrivacyAuthorized(): Promise<PrivacyResult> {
  try {
    // 低版本基础库或非微信端（支付宝/抖音）没有这两个 API，直接放行
    if (typeof Taro.getPrivacySetting !== 'function') return { ok: true }

    const setting = await new Promise<{ needAuthorization?: boolean }>((resolve) => {
      Taro.getPrivacySetting({
        success: (res) => resolve(res ?? {}),
        // 查询失败不阻断（见上方 fail-open 理由）
        fail: () => resolve({}),
      })
    })

    // 无需授权：后台未声明，或用户此前已同意过
    if (!setting.needAuthorization) return { ok: true }

    if (typeof Taro.requirePrivacyAuthorize !== 'function') return { ok: true }

    return await new Promise<PrivacyResult>((resolve) => {
      Taro.requirePrivacyAuthorize({
        success: () => resolve({ ok: true }),
        // 用户点了「不同意」会走 fail
        fail: () => resolve({ ok: false, reason: 'denied' }),
      })
    })
  } catch {
    // 检查逻辑自身异常 → fail-open（见函数头注释的取向说明）
    return { ok: true }
  }
}

/**
 * 打开《用户隐私保护指引》原文（微信托管页）。
 * 用于用户点「查看隐私政策」时直接看**平台侧那份**，与我方 legal 页互补。
 * 失败时静默返回 false，由调用方降级到我方 legal 页。
 */
export async function openPlatformPrivacyContract(): Promise<boolean> {
  try {
    if (typeof Taro.openPrivacyContract !== 'function') return false
    return await new Promise<boolean>((resolve) => {
      Taro.openPrivacyContract({
        success: () => resolve(true),
        fail: () => resolve(false),
      })
    })
  } catch {
    return false
  }
}

/*
 * 🔴 上线前人工清单（代码无法覆盖，必须去 mp 后台做）：
 *
 * 1. 微信公众平台 → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引 → 更新
 *    勾选本小程序**实际调用**的信息类型（按代码扫描结果，当前只需这几项）：
 *      - 「收集你选择的照片或视频信息」 ← Taro.chooseImage（scan.tsx）
 *      - 「访问你的摄像头」            ← chooseImage 的 sourceType 含 'camera'
 *    用途说明如实填写，例如「用于拍摄或选择餐食照片，由 AI 识别食物并估算营养」。
 *    ⚠️ 不要勾未使用的类型（如位置、通讯录）——多勾属超范围收集，是 PIPL 风险。
 *
 * 2. 提交后需等审核通过（快的几小时，实测有反馈约 40 分钟后才生效），
 *    然后在开发者工具**重新编译**才会解除 errno 112。
 *
 * 3. 提交体验版 / 提审时，「采集用户隐私」那一项要勾上并与后台声明一致
 *    （后台设置管开发环境，提审页设置管线上环境，两处不一致仍会 112）。
 *
 * 4. 当前**未使用**、将来若接入需回来补声明的接口：
 *      - wx.getWeRunData（微信运动步数）→ 需「运动健康」类目资质，资质申请中
 *        （见 mini/src/lib/health/index.ts:5）
 *      - wx.scanCode（条码扫描）→ 小程序端当前无此入口
 *        （见 mini/src/components/AiConsent.tsx:40 的说明）
 *    接入前必须先补后台声明，否则同样 112。
 *
 * 5. 自测判据：真机（不是开发者工具）走一次拍照识别；
 *    若首次进入弹出隐私授权框 → 说明声明已生效；
 *    若直接报「需要你在隐私授权弹窗中同意…」→ 声明还没生效，回第 1 步。
 */
