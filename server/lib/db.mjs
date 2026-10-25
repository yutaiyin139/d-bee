/**
 * 数据库层：连接池 + 「双注入」封装。
 *
 * ── 双注入铁律（10-20 SQL 自测实测到的坑）─────────────────────────────
 * `auth.uid()`（0030 第 15 行）有三级回退：
 *   ① current_setting('app.user_id')
 *   ② current_setting('request.jwt.claim.sub')
 *   ③ current_setting('request.jwt.claims')::jsonb ->> 'sub'   ← PostgREST 原生注入的格式
 *
 * 两条链路因此分工不同：
 *   · **PostgREST 反代链路（A2）**：网关签发的 JWT 直接给 PostgREST，由它解析后
 *     注入 `request.jwt.claims`（走回退③）。网关**不需要**手动 SET LOCAL。
 *     这就是选 PostgREST 而非手写 DSL 的最大红利。
 *   · **auth 直连链路（A1）**：网关自己连 PG 读写 app_users / 回填数据，
 *     这些查询**刻意不带用户身份**（身份表对 authenticated 是 REVOKE 的），
 *     所以也不需要注入。
 *
 * 但为了兼容「将来网关内直接调业务函数」的场景（如 Apple 验签后要写 payment_orders），
 * 这里提供 asUser()：在同一事务内同时注入 ① 和 ②，覆盖全部三级回退中的前两级。
 * 少注入 ② 的后果已实测过：leaderboard()/badge_stats() 返回 {"error":"not_authenticated"}。
 */
import pg from 'pg'

const { Pool, types } = pg

// ── 类型解析修正 ──────────────────────────────────────────────────────
// pg 默认把 numeric(OID 1700) 解析成 JS number，会丢精度：
// weight_logs.weight_kg / profiles.height_cm 都是 numeric，
// 体重 62.35 变成 62.350000000000001 这类浮点误差会直接显示在界面上。
// → 保持 numeric 为**字符串**，由前端按需要 Number()；这是 pg 官方推荐做法。
types.setTypeParser(1700, (v) => v) // numeric → string

// int8(OID 20) 默认也被解析成 number。owner_id 是 text 不受影响，
// 但 profiles.id 等 bigint 自增键超过 2^53 时会丢精度 → 同样保持字符串。
types.setTypeParser(20, (v) => v) // int8 → string

/**
 * 创建连接池。
 * @param {object} cfg loadConfig() 的产物
 * @param {{role?: 'app'|'gateway'}} [opts] role='gateway' 用 dbee_gateway（可写 app_users）
 */
export function createPool(cfg, opts = {}) {
  const useGateway = opts.role === 'gateway'
  return new Pool({
    host: cfg.dbHost,
    port: cfg.dbPort,
    database: cfg.dbName,
    user: useGateway ? cfg.dbGatewayUser : cfg.dbUser,
    password: useGateway ? cfg.dbGatewayPassword : cfg.dbPassword,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // 连接建立时设会话级超时，防止慢查询把池子占满
    options: `-c statement_timeout=${cfg.dbStatementTimeoutMs}`,
    application_name: useGateway ? 'dbee-gateway-auth' : 'dbee-gateway-app',
    // PG 侧 ssl：自托管同机房内网连接默认关闭；若走公网连库须置 require
    ssl: cfg.dbSsl ? { rejectUnauthorized: false } : false,
  })
}

/** 启动期连通性自检。失败要**立刻**报错，而不是等第一个请求 500。 */
export async function pingPool(pool, label = 'db') {
  const t0 = Date.now()
  const { rows } = await pool.query('SELECT current_user AS u, current_database() AS d, now() AS t')
  return { label, ...rows[0], ms: Date.now() - t0 }
}

/**
 * 以某用户身份执行一段查询（事务内双注入）。
 *
 * 用于网关内部需要触发 RLS / auth.uid() 的场景（例如 Apple 验签后写订单）。
 * 普通 app_users 读写**不要**用它 —— 那条链路刻意不带身份。
 *
 * @param {import('pg').Pool} pool
 * @param {string} ownerId  = JWT 的 sub
 * @param {(q: (sql:string, params?:unknown[]) => Promise<pg.QueryResult>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function asUser(pool, ownerId, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // SET LOCAL 只在当前事务内有效，事务结束自动还原 —— 连接归还池子后不会串号。
    // 这是必须用 SET LOCAL 而非 SET 的原因：池化连接会复用，SET 会污染下一个使用者。
    // 值用参数化传入（set_config 的第二个参数），不做字符串拼接。
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', String(ownerId)])
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(ownerId)])
    // ③ 也补上，与 PostgREST 的注入格式保持一致，覆盖 badge_stats 之类只读 claims 的函数
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: String(ownerId), role: 'authenticated' }),
    ])
    // 切到 authenticated 角色，让 RLS 真正生效（连接角色本身可能是 BYPASSRLS）
    await client.query('SET LOCAL ROLE authenticated')

    const result = await fn((sql, params) => client.query(sql, params))
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * 为 PostgREST 反代构造要透传的 JWT claims 对象。
 * PostgREST 会把整个 payload 序列化成 request.jwt.claims 注入 PG。
 * `role` 声明是 PostgREST 切角色的依据（PGRST-JWT-SECRET 校验后 SET ROLE）。
 */
export function postgrestClaims(ownerId, extra = {}) {
  return {
    sub: String(ownerId),
    role: 'authenticated',
    ...extra,
  }
}

/**
 * 以「注入了某用户身份、但**保持连接角色不变**（dbee_app）」的方式执行一段查询。
 *
 * 与 asUser() 的关键区别：**不 SET LOCAL ROLE authenticated**。
 * 用途：调用「仅授 dbee_app、SECURITY DEFINER、内部靠 auth.uid() 取身份」的
 *   网关专用函数（如 0039 的 llm_gate）。这类函数 authenticated 无 EXECUTE 权限，
 *   若走 asUser() 切到 authenticated 反而会 permission denied；而 SECURITY DEFINER
 *   以 owner(postgres) 运行，函数体内的 auth.uid() 读的是本事务注入的 app.user_id GUC，
 *   与调用者角色无关 —— 故只需注入 GUC，无需（也不能）切角色。
 *
 * 三级回退里只注入 ① app.user_id（llm_gate 用 auth.uid() 读它即可）；
 * 为稳妥同时注入 ②③，与 asUser 覆盖同样的回退面。
 *
 * @param {import('pg').Pool} pool  必须是 dbee_app 连接池（持有目标函数 EXECUTE）
 * @param {string} ownerId
 * @param {(q: (sql:string, params?:unknown[]) => Promise<pg.QueryResult>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withUserIdentity(pool, ownerId, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', String(ownerId)])
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(ownerId)])
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: String(ownerId), role: 'authenticated' }),
    ])
    // 刻意不 SET ROLE：保持 dbee_app，才能通过 llm_gate 的 EXECUTE 权限校验。
    const result = await fn((sql, params) => client.query(sql, params))
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
