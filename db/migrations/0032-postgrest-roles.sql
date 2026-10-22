-- ═══════════════════════════════════════════════════════════════════════
-- 0032 · PostgREST 连接角色（authenticator = dbee_web）
-- ═══════════════════════════════════════════════════════════════════════
-- 为什么必须有这个迁移：
--   PostgREST 不是用「每个用户一个 PG 角色」的方式工作，而是**单连接角色 + SET ROLE**：
--     · 它用 `db-uri` 里的那个角色（官方术语 authenticator）连库；
--     · 每个请求解出 JWT 的 `role` 声明后，`SET ROLE` 切过去（本项目恒为 authenticated）；
--     · 请求结束回到 authenticator。
--   0030 只建了 `anon` / `authenticated`，两者都是 **NOLOGIN**，不能用来连接。
--   0031 第 73 行注释虽已提到「PostgREST 的 authenticator 角色（dbee_web）」，
--   但**仓库里此前没有任何迁移创建它** —— 不补这一步，PostgREST 装完也连不上库。
--
-- 三个不能省的设计点：
--   ① **NOINHERIT 是安全关键，不是风格偏好**。
--      若 dbee_web 带 INHERIT，它会**自动继承** authenticated 的全部权限 ——
--      那么一个**没有 JWT 的匿名请求**（PostgREST 本应切到权限更小的 anon）
--      也会带着 authenticated 的读写权跑，等于把「必须登录」这条线整体作废。
--      NOINHERIT 后，权限**只能**通过显式 SET ROLE 获得，即只能来自已验签的 JWT。
--   ② 角色分离：`dbee_web`（PostgREST 数据面）与 `dbee_gateway`（网关身份面，0031）
--      **刻意不重叠**。即使 PostgREST 被打穿，也读不到 app_users 的身份哈希。
--   ③ 密码**不写在本文件**：由 deploy/postgrest/ 的安装脚本随机生成后
--      用 ALTER ROLE 设置，并直接写入服务器上的 /etc/postgrest/config（0640 root:postgrest）。
--      本文件因此可以安全入库。
--
-- 执行方式（须用超级用户，因为要建角色 + GRANT CONNECT）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0032-postgrest-roles.sql
-- 幂等：可重复执行。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① authenticator 角色 ────────────────────────────────────────────────
-- 用 DO 块而非 CREATE ROLE …：CREATE ROLE 没有 IF NOT EXISTS，
-- 直接写会在重跑时报 42P04（duplicate_object）破坏幂等性。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    CREATE ROLE dbee_web LOGIN NOINHERIT;
  ELSE
    -- 已存在则**强制校正属性**：防止历史上被误建成 INHERIT（见上方 ①，那是越权口子）
    ALTER ROLE dbee_web LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

COMMENT ON ROLE dbee_web IS
  'PostgREST authenticator（0032）。NOINHERIT：权限只能经 SET ROLE 从已验签 JWT 获得。';

-- ── ② 允许切换到两个业务角色 ────────────────────────────────────────────
-- PG 16+ 的 membership 默认 INHERIT 属性**取被授予者自身的属性**：
-- dbee_web 是 NOINHERIT，所以这两条授权只赋予「SET ROLE 的能力」，不会自动继承权限。
GRANT anon TO dbee_web;
GRANT authenticated TO dbee_web;

-- ── ③ 连接权限 ──────────────────────────────────────────────────────────
-- 默认 PUBLIC 有 CONNECT，但显式授予可抗未来「REVOKE CONNECT FROM PUBLIC」的收紧。
-- 库名硬编码 dbee（GRANT … ON DATABASE 不接受 current_database()）。
GRANT CONNECT ON DATABASE dbee TO dbee_web;

-- ── ④ schema USAGE：给 authenticator 本身，而不是只给 authenticated ─────
-- 官方 Database Authorization 页明确要求「必须显式允许角色访问 db-schemas 里列出的
-- schema」。PostgREST 的 schema cache 是以 **authenticator 身份**构建的，而
-- dbee_web 是 NOINHERIT —— 它**不会**继承 0030 授给 authenticated 的
-- `GRANT USAGE ON SCHEMA public`。少了这一步的典型症状是：服务正常、
-- admin/ready 也 200，但所有请求报 **PGRST205 "Could not find the table …
-- in the schema cache"** —— 极难排查，因为看起来像表不存在而不是权限问题。
--
-- 🔒 为什么这个授权**不削弱安全**（三条独立的防线，任何一条单独都够）：
--   · USAGE ON SCHEMA 只是「能看见 schema 这个命名空间」，**不等于能读任何表**。
--     dbee_web 对 public 下的表一条 GRANT 都没有，直接 SELECT 会 permission denied。
--   · dbee_web 是 NOINHERIT，不会自动获得 authenticated 的表权限；
--     那些权限只能通过 PostgREST 对**已验签 JWT** 执行 SET LOCAL ROLE 才生效。
--   · config 里 openapi-mode = "disabled"，所以根端点不会吐出表结构清单。
--   → 净效果：dbee_web 能读系统目录建缓存，但拿不到任何一行业务数据。
GRANT USAGE ON SCHEMA public TO dbee_web;
-- auth schema 里只有 auth.uid() 这一个函数（0030 第 13–35 行）。
-- RLS 策略内部会调它，而策略是以「被冒充的角色」（authenticated）身份执行的，
-- 0030 第 491–492 行已授给它；这里补授 dbee_web 是为了 schema cache 能内省到
-- 函数签名（缓存函数元数据时同样以 authenticator 身份跑）。
GRANT USAGE ON SCHEMA auth TO dbee_web;
GRANT EXECUTE ON FUNCTION auth.uid() TO dbee_web;

-- ── ⑤ 纵深防御：身份表对数据面彻底不可见 ────────────────────────────────
-- 0031 已 REVOKE FROM PUBLIC/anon/authenticated，且 RLS FORCE 无 policy。
-- 这里对 dbee_web 再撤一次：它虽无直接权限，但显式声明可抗未来误操作
-- （例如有人图省事 GRANT ALL ON ALL TABLES TO PUBLIC）。
-- 用 DO 块判存在：允许 0032 在 0031 之前执行而不报错（两者无强依赖顺序）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'app_users'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.app_users FROM dbee_web';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（安装脚本会自动跑，手工排查时也可用）
-- ═══════════════════════════════════════════════════════════════════════
-- ① 角色属性正确：rolcanlogin=t 且 rolinherit=f
--    SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls
--      FROM pg_roles WHERE rolname IN ('dbee_web','dbee_gateway','authenticated','anon');
--
-- ② 成员关系已建立（PG16+ 看 pg_auth_members 的 grantee/member）
--    SELECT r.rolname AS member_of
--      FROM pg_auth_members m
--      JOIN pg_roles r ON r.oid = m.roleid
--      JOIN pg_roles g ON g.oid = m.member
--     WHERE g.rolname = 'dbee_web';
--    期望：anon、authenticated 各一行
--
-- ③ 能连库（密码由安装脚本设置后才有意义）
--    PGPASSWORD='<见 /etc/postgrest/config>' psql -h 127.0.0.1 -U dbee_web -d dbee -c 'select 1'
--
-- ④ SET ROLE 生效且 **NOINHERIT 真的生效**（关键安全断言）
--    PGPASSWORD='…' psql -h 127.0.0.1 -U dbee_web -d dbee -c "
--      SELECT current_user, session_user;                 -- 应为 dbee_web / dbee_web
--      SELECT count(*) FROM public.profiles;"             -- 期望：permission denied
--    → 这一步**必须报权限错**。若居然读到了行，说明 rolinherit=t 或被误授了表权限，
--      那么匿名/无 JWT 的请求也会带着 authenticated 的读写权跑 —— 越权口子，立即修。
--    → 反过来，若第 ⑤ 步（带 JWT 语义）也读不到，则是 schema cache/GRANT 缺失，
--      典型表现为 HTTP 侧的 PGRST205。两个方向的失败模式不同，据此定位。
--
-- ⑤ 模拟一次带 JWT 的请求语义（手工 SET ROLE + 注入 claims，验证 auth.uid() 第三级回退）
--    PGPASSWORD='…' psql -h 127.0.0.1 -U dbee_web -d dbee -c "
--      BEGIN;
--      SELECT set_config('request.jwt.claims',
--                        '{\"sub\":\"2109869577155379200\",\"role\":\"authenticated\"}', true);
--      SET LOCAL ROLE authenticated;
--      SELECT auth.uid();                                  -- 期望 2109869577155379200
--      SELECT owner_id FROM public.profiles LIMIT 1;       -- RLS 按该 sub 过滤
--      COMMIT;"
--    auth.uid() 三级回退见 0030 第 15–35 行；第三级 request.jwt.claims 正是
--    PostgREST 在 **PG 14+** 的原生注入格式（PG<14 才是 request.jwt.claim.sub）——
--    服务器是 PG 17.11，故命中第三级。这也是 A2 选 PostgREST 而非手写 DSL 的红利：
--    「双注入铁律」自动满足，数据库函数一行都不用改，也不需要配 db-pre-request。
-- ═══════════════════════════════════════════════════════════════════════
