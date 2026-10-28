/**
 * App Store 审核演示账户 —— 云端注册脚本。
 *
 * 为什么需要它：
 *   App 的邮箱登录是 OTP 制（sendOtp → verifyOtp），云端 signUp 必须带
 *   verificationToken，且云端「终端用户管理」接口是只读的（不支持建号/改密）。
 *   → 想在云端建一个演示账号，只能走一次真实的邮箱验证码注册。
 *   注册时带上 password，之后审核员就能用「邮箱 + 密码」直接登录
 *   （登录入口见 src/pages/AuthScreen.tsx 的 EmailMode='password'）。
 *
 * 用法（两阶段，因为验证码要从邮箱里取）：
 *   node tools/setup-review-account.mjs send
 *       → 向 dbeesupport@163.com 发验证码，verificationId 存到 tools/.review-otp.json
 *   node tools/setup-review-account.mjs verify --code 123456
 *       → 用邮箱里收到的 6 位码完成注册（密码默认 888888，可用 --password 覆盖）
 *   node tools/setup-review-account.mjs check
 *       → 用 signInWithPassword 验证账号可登录（注册后自检）
 *
 * 自定义账号：
 *   REVIEW_EMAIL=xxx@yyy.com REVIEW_PASSWORD=zzzzzz node tools/setup-review-account.mjs send
 *
 * ⚠️ 验证码有效期约 5 分钟（OTP_TTL_SEC），发码后请尽快取信完成 verify。
 * ⚠️ 密码会明文出现在命令行与下方常量里——这是「审核演示账户」，
 *    刻意用弱密码便于审核员输入，不要复用任何真实账号密码。
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const STATE_FILE = path.join(__dirname, '.review-otp.json')

// 与 src/cloudConfig.ts 保持一致：原生端回退用的云端域名 + 公开 publishableKey
const ENDPOINT = process.env.REVIEW_ENDPOINT || 'https://zilv-mifeng.app.workbuddy.host'
const PUBLISHABLE_KEY =
  process.env.REVIEW_PUBLISHABLE_KEY || 'wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E'
const OAUTH_RELAY = 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'

const EMAIL = process.env.REVIEW_EMAIL || 'dbeesupport@163.com'
const PASSWORD = process.env.REVIEW_PASSWORD || '888888'

/** SDK 是浏览器 ESM 包，Node 侧用 createRequire 从仓库 node_modules 取 */
const require = createRequire(path.join(ROOT, 'package.json'))
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')

const cloud = createWorkBuddyCloud({
  endpoint: ENDPOINT,
  oauthRelayBaseUrl: OAUTH_RELAY,
  publishableKey: PUBLISHABLE_KEY,
})

const cmd = process.argv[2] || ''

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function mask(s) {
  const [name, domain] = String(s).split('@')
  return domain ? `${name.slice(0, 2)}***@${domain}` : s
}

async function send() {
  console.log(`→ 向 ${EMAIL} 发送验证码 …`)
  const res = await cloud.auth.sendOtp({ email: EMAIL })
  if (res.error) {
    console.error(`❌ 发码失败：${res.error.message}`)
    process.exit(1)
  }
  const { verificationId, isExistingUser } = res.data
  writeFileSync(STATE_FILE, JSON.stringify({ email: EMAIL, verificationId, isExistingUser, at: Date.now() }, null, 2))
  console.log(`✅ 已发码（verificationId 已存 tools/.review-otp.json）`)
  console.log(`   isExistingUser = ${isExistingUser} ${isExistingUser ? '（该邮箱已存在，verify 将走登录而非注册）' : '（新邮箱，verify 将完成注册）'}`)
  console.log(`\n下一步：去 ${EMAIL} 的收件箱取 6 位验证码，然后执行`)
  console.log(`   node tools/setup-review-account.mjs verify --code <验证码>`)
}

async function verify() {
  const code = argOf('code')
  if (!code) {
    console.error('❌ 缺少验证码：--code 123456')
    process.exit(2)
  }
  if (!existsSync(STATE_FILE)) {
    console.error('❌ 找不到 tools/.review-otp.json，请先执行 send')
    process.exit(2)
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  if (state.email !== EMAIL) {
    console.error(`❌ 状态文件里的邮箱（${mask(state.email)}）与当前 REVIEW_EMAIL（${mask(EMAIL)}）不一致，请重新 send`)
    process.exit(2)
  }
  console.log(`→ 用验证码完成${state.isExistingUser ? '登录' : '注册'} …`)
  const res = await cloud.auth.verifyOtp({
    email: state.email,
    verificationId: state.verificationId,
    isExistingUser: state.isExistingUser,
    token: code,
    // 仅注册时设密码；已存在的用户不覆盖其密码
    password: state.isExistingUser ? undefined : PASSWORD,
  })
  if (res.error) {
    console.error(`❌ 验证失败：${res.error.message}`)
    console.error('   常见原因：验证码输错 / 已过期（约 5 分钟）→ 重新 send 再试')
    process.exit(1)
  }
  console.log(`✅ ${state.isExistingUser ? '登录成功' : '注册成功'}：${EMAIL}`)
  if (!state.isExistingUser) console.log(`   密码已设为 ${PASSWORD}`)
  console.log('\n下一步：执行 check 自检「邮箱 + 密码」能否直接登录')
  console.log('   node tools/setup-review-account.mjs check')
}

async function check() {
  const pw = argOf('password', PASSWORD)
  console.log(`→ signInWithPassword(${EMAIL}) …`)
  const res = await cloud.auth.signInWithPassword({ email: EMAIL, password: pw })
  if (res.error) {
    console.error(`❌ 密码登录失败：${res.error.message}`)
    console.error('   若提示用户不存在 → 先 send + verify 完成注册')
    process.exit(1)
  }
  const u = res.data?.user ?? {}
  console.log(`✅ 密码登录成功`)
  console.log(`   user.id  = ${u.id ?? '(未返回)'}`)
  console.log(`   email    = ${u.email ?? EMAIL}`)
  console.log(`\nASC「App 审核信息」可填：`)
  console.log(`   用户名：${EMAIL}`)
  console.log(`   密码：  ${pw}`)
  console.log(`   备注：  打开 App → 登录页切「邮箱」→ 点「已有密码？点此用密码登录」→ 输入上述邮箱与密码`)
}

if (cmd === 'send') await send()
else if (cmd === 'verify') await verify()
else if (cmd === 'check') await check()
else {
  console.log(`App Store 审核演示账户注册脚本

用法：
  node tools/setup-review-account.mjs send              # 发验证码到 ${EMAIL}
  node tools/setup-review-account.mjs verify --code N   # 用邮箱收到的码完成注册（密码 ${PASSWORD}）
  node tools/setup-review-account.mjs check             # 自检邮箱+密码可登录

环境变量覆盖：REVIEW_EMAIL / REVIEW_PASSWORD / REVIEW_ENDPOINT`)
  process.exit(cmd ? 2 : 0)
}
