/**
 * D-Bee 自托管网关 · 入口（泳道 A1+A2+A3 合一）
 *
 * 监听 127.0.0.1:8080，由 nginx 反代 /.cloud/** 过来（见 deploy/nginx.conf.example）。
 * 刻意只监听回环地址：网关不该直接暴露公网，TLS/限流/静态资源都在 nginx 那层。
 *
 * 路由分派（前缀 /.cloud）：
 *   /auth/v1/**          → A1 认证（本进程实现）
 *   /database/rest/**    → A2 反代 PostgREST（默认 127.0.0.1:3001）
 *   /llm/**              → A3 反代 DeepSeek（鉴权 + 模型白名单 + SSE）
 *   /healthz             → 自检（不鉴权，供 nginx/systemd 探活）
 *
 * 装配逻辑在 lib/app.mjs（抽出来是为了让 tools/gateway-selftest.mjs 能注入 mock pool
 * 起真 HTTP 服务做端到端断言）。本文件只做：读 env → 连真库 → listen → 优雅退出。
 *
 * 运行：
 *   本地开发  node server/index.mjs        （读项目根 .env）
 *   生产      systemd 托管，EnvironmentFile=/etc/dbee/gateway.env
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadDotEnv, warnings } from './lib/config.mjs'
import { createPool, pingPool } from './lib/db.mjs'
import { createApp } from './lib/app.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 日志 ──────────────────────────────────────────────────────────────
// 极简结构化日志，走 stdout/stderr 交给 journald。不引 pino/winston：
// 单机 systemd 下 journald 已做了轮转与检索，再加一层是负担。
const ts = () => new Date().toISOString()
const logger = {
  info: (...a) => console.log(ts(), ...a),
  warn: (...a) => console.warn(ts(), ...a),
  error: (...a) => console.error(ts(), ...a),
}

// ── 配置 ──────────────────────────────────────────────────────────────
loadDotEnv(resolve(HERE, '../.env'))

let cfg
try {
  cfg = loadConfig()
} catch (err) {
  logger.error(`[boot] 配置错误，拒绝启动：\n${err.message}`)
  process.exit(1)
}
for (const w of warnings(cfg)) logger.warn(`[boot] 提示：${w}`)

// 连接池：业务角色（dbee_app）与身份角色（dbee_gateway）分离，权限互不重叠。
// 这样即便 PostgREST 侧被打穿，也读不到 app_users 的身份哈希（0031 已 REVOKE，这是第二道）。
const pool = createPool(cfg, { role: 'app' })
const gatewayPool = createPool(cfg, { role: 'gateway' })

const { server, otp, auth } = createApp({ cfg, pool, gatewayPool, logger })

// ── 优雅退出 ──────────────────────────────────────────────────────────
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`[boot] 收到 ${signal}，开始优雅退出…`)
  server.close(() => {
    otp.close()
    auth.refresh.close()
    Promise.allSettled([pool.end(), gatewayPool.end()]).then(() => {
      logger.info('[boot] 已退出')
      process.exit(0)
    })
  })
  // 10 秒内没关干净就强退，避免 systemd 卡在 stop 超时
  setTimeout(() => {
    logger.warn('[boot] 优雅退出超时，强制退出')
    process.exit(1)
  }, 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// 单个请求的未捕获异常不该拖垮整个网关（连接池仍然健康），故只记录不退出
process.on('uncaughtException', (err) => logger.error(`[fatal] uncaughtException: ${err?.stack || err}`))
process.on('unhandledRejection', (r) => logger.error(`[fatal] unhandledRejection: ${r?.stack || r}`))

// ── 启动 ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const p = await pingPool(pool, 'app')
    logger.info(`[boot] 数据库连通 db=${p.d} user=${p.u} ${p.ms}ms`)
  } catch (err) {
    // 数据库不可达**不阻止启动**：让 /healthz 暴露问题，比进程反复重启更好排查
    // （systemd Restart=always 下，连不上库会陷入无限重启，日志刷满且看不到根因）
    logger.error(`[boot] ⚠️ 数据库连不上（${cfg.dbHost}:${cfg.dbPort}/${cfg.dbName} user=${cfg.dbUser}）：${err.message}`)
    logger.error('[boot] 网关仍会启动，但认证/数据请求会失败。请检查 DBEE_* 配置与服务器 PG 状态。')
  }

  server.listen(cfg.port, cfg.host, () => {
    logger.info(`[boot] ✅ D-Bee 网关已启动 http://${cfg.host}:${cfg.port}`)
    logger.info(`[boot]    模式=${cfg.prod ? '生产' : '开发'}  SMS=${cfg.smsProvider}  LLM=${cfg.llmModelVision}`)
    logger.info(`[boot]    PostgREST 上游=${cfg.postgrestUrl}`)
    logger.info('[boot]    端点: /.cloud/auth/v1/* · /.cloud/database/rest/* · /.cloud/llm/* · /.cloud/healthz')
    if (cfg.smsProvider === 'log') {
      logger.warn(`[boot] ⚠️ SMS_PROVIDER=log —— 验证码只写日志，万能码 ${cfg.smsMasterCode ? '已启用' : '未配置'}。仅限开发/未采购短信阶段。`)
    }
  })
}

boot()
