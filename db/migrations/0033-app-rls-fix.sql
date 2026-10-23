-- ═══════════════════════════════════════════════════════════════════════
-- 0033 · 收回 dbee_app 的 BYPASSRLS，改用精确 policy 放行身份表
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-10-23 部署前只读体检测出，不是理论推演）：
--   `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='dbee_app'`
--     → rolinherit=t, **rolbypassrls=t**
--   实测后果：dbee_app 在**未设置任何身份**时
--     `SELECT count(*) FROM public.profiles` 返回 **17**（全部用户的档案），
--     而 `auth.uid()` 此时是 NULL —— RLS 策略 `owner_id = auth.uid()` 根本没参与过滤。
--   这与 db/CREDENTIALS.txt 里写的「不绕过 RLS」**直接矛盾**：文档是意图，库里是事实，
--   事实赢了。任何走 dbee_app 的业务查询都会拿到全库数据 = 越权。
--
-- 为什么它当初被给了 BYPASSRLS（要理解才能安全地收回）：
--   0031 把 app_users 设成 ENABLE + **FORCE** RLS 且**不放任何 policy**
--   （目的：对前端彻底不可见）。FORCE 连表属主都挡。
--   而网关身份面（server/lib/identity.mjs）必须能按 ident_hash 查/写 app_users，
--   config.mjs 的 dbGatewayUser 默认**回退到 dbee_app**，
--   0031 建的 dbee_gateway 又是 **NOLOGIN**（连不上，形同虚设）。
--   → 于是只能靠 dbee_app 的 BYPASSRLS 硬闯 app_users。
--   代价：为了开一张表的门，把**全库所有表**的 RLS 都关了。这是用大锤敲图钉。
--
-- 本迁移的修法（精确化，不是简单撤销）：
--   ① 给 app_users 建一条 `TO dbee_app` 的 policy（USING/WITH CHECK 全放行）。
--      PG 的 policy 可以指定适用角色：只有 dbee_app 命中这条策略，
--      authenticated/anon 仍无任何 policy → 依旧一行都看不到（0031 的隔离目标不变）。
--   ② 收回 dbee_app 的 BYPASSRLS。此后业务表的 RLS 真正生效。
--   净效果：dbee_app 能读写 app_users（身份面照常），但查业务表时
--          **必须**先注入身份，否则返回 0 行 —— 与设计意图一致。
--
-- 为什么不给 dbee_gateway 单独配 LOGIN+密码（看起来更正统）：
--   那需要新增一个凭据、改 .env、且 dbee_gateway 若要读 app_users 同样得给
--   BYPASSRLS 或 policy，复杂度更高收益为零。用 `TO dbee_app` 的 policy
--   一步达到同等隔离效果，凭据面不增加。
--   （若将来真要角色分离，把本 policy 的 TO 改成 dbee_gateway 并给它 LOGIN 即可，
--     本迁移的结构已经是为那一步铺好的。）
--
-- 执行方式（超级用户；含 ALTER ROLE，dbee_app 自己无权改自己属性）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0033-app-rls-fix.sql
-- 幂等：可重复执行（DROP POLICY IF EXISTS + ALTER ROLE 重复设置无害）。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① 身份表放行策略（只对 dbee_app 生效）─────────────────────────────
-- 必须在收回 BYPASSRLS **之前**建好，否则中间态会出现「网关读不到 app_users」，
-- 虽然在同一事务里对外不可见，但顺序正确 = 万一将来被拆成两句也不会留下窗口。
DROP POLICY IF EXISTS gateway_ident_access ON public.app_users;
-- ⚠️ 子句顺序是语法硬规定：AS → FOR → TO → USING → WITH CHECK。
--    写成 TO … FOR … 会直接 syntax error（本轮实测踩过）。
CREATE POLICY gateway_ident_access ON public.app_users
  FOR ALL
  -- TO 放在 FOR 之后：只有 dbee_app 命中本策略。
  -- authenticated/anon 仍无适用 policy → 0031 的「对前端彻底不可见」不变。
  TO dbee_app
  -- app_users 不按 owner_id 隔离给终端用户，网关必须能跨用户按 ident_hash 检索
  -- （否则「这个手机号是不是已注册」无法回答）。安全边界在**角色**而非行：
  -- 只有 dbee_app 命中本策略，而 dbee_app 只被网关持有。
  -- FOR ALL 含 DELETE 动作，但网关代码从不 DELETE 身份表；
  -- 且 0031 只 GRANT 了 SELECT/INSERT/UPDATE，权限层仍挡住物理删除。
  USING (true)
  WITH CHECK (true);

-- ── ①b 表权限（容易漏，且与 policy 是两件独立的事）────────────────────
-- 🔴 policy 只决定「哪些行可见」，**不决定「能不能碰这张表」**。
--   0031 的授权口径是：REVOKE ALL FROM PUBLIC/anon/authenticated，
--   然后只 `GRANT SELECT, INSERT, UPDATE TO dbee_gateway`。
--   而 dbee_gateway 是 **NOLOGIN**（连不上库，形同虚设），
--   网关实际用的 dbee_app 虽继承 authenticated，但 authenticated 已被 REVOKE 干净
--   → dbee_app 对 app_users **零权限**。
--   注意 BYPASSRLS 也救不了这里：它绕过的是行级安全，**不绕过权限检查**，
--   所以旧配置下网关连 app_users 一样会 permission denied（登录必挂）。
--   → 必须显式授给 dbee_app。刻意不给 DELETE：身份记录不做物理删除。
--
-- 🔴 为什么必须先 REVOKE 再 GRANT（实测踩坑）：
--   GRANT 是**追加**语义，不会撤销角色已有的其它权限。本库 app_users 上
--   dbee_app 历史 ACL 是 `arwd`（含 d=DELETE，0030 镜像期由 postgres 授），
--   只写 GRANT SELECT,INSERT,UPDATE 会得到 `arwd` 而非期望的 `arw` ——
--   DELETE 仍在，与本文件「刻意不给 DELETE」的注释自相矛盾，且留下物理删除身份表的口子。
--   → 先 REVOKE ALL 清空直接授权，再精确 GRANT 三样，结果才确定且幂等。
--   （REVOKE 只影响**直接授予 dbee_app** 的 ACL，不影响它作为 authenticated 成员
--     的继承；而 app_users 对 authenticated 已被 0031 REVOKE 干净，故无副作用。）
REVOKE ALL ON public.app_users FROM dbee_app;
GRANT USAGE ON SCHEMA public TO dbee_app;
GRANT SELECT, INSERT, UPDATE ON public.app_users TO dbee_app;

-- ── ② 收回 BYPASSRLS（本迁移的核心动作）────────────────────────────────
-- NOBYPASSRLS 是默认值，显式写出以表达意图并保证幂等。
ALTER ROLE dbee_app NOBYPASSRLS;

COMMENT ON ROLE dbee_app IS
  '网关业务/身份连接角色。0033 起 NOBYPASSRLS：业务表受 RLS 约束，'
  '仅 app_users 经 gateway_ident_access 策略放行。';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（部署脚本会自动跑；手工排查用）
-- ═══════════════════════════════════════════════════════════════════════
-- 用 dbee_app 连库后依次执行，**四条都必须符合期望**：
--
-- ① 属性已收回
--    SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='dbee_app';
--    期望：rolbypassrls = f
--
-- ② 业务表 RLS 真正生效（🔴 关键回归：迁移前这里是 17）
--    SELECT count(*) FROM public.profiles;
--    期望：**0**（未注入身份 → auth.uid() 为 NULL → 策略不匹配任何行）
--
-- ③ 注入身份后能且只能看到自己那行
--    SET app.user_id = '<某个真实 owner_id>';
--    SELECT count(*) FROM public.profiles;
--    期望：1
--
-- ④ 身份表仍可读写（policy 生效，登录链路不受影响）
--    SELECT count(*) FROM public.app_users;
--    期望：不报 permission denied（行数 0 属正常，0031 刚建空表）
--
-- 反向确认（前端隔离未被削弱）：以 authenticated 身份查 app_users 应被拒
--    SET ROLE authenticated;
--    SELECT count(*) FROM public.app_users;
--    期望：permission denied（0031 已 REVOKE）或返回 0 行（FORCE RLS 无匹配 policy）
-- ═══════════════════════════════════════════════════════════════════════
