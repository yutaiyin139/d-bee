-- ═══════════════════════════════════════════════════════════════════════
-- 0041 · dbee_admin 只读排查角色（pgAdmin 专用，BYPASSRLS）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-10-26 实测诊断，deploy/diag-pgadmin-empty.sh）：
--   用户用 pgAdmin（dbee_app 角色）连 dbee 库，看到 23 张表「全是空的」。
--   根因：21/23 表开启 RLS，策略为 owner_id = auth.uid()；auth.uid() 读
--   JWT 会话 GUC（app.user_id / request.jwt.claim.sub / request.jwt.claims），
--   pgAdmin 裸会话三者皆无 → uid=NULL → 所有行被过滤。数据本身完好
--   （superuser 视角 profiles=18、meal_entries=97）。
--   App 正常是因为 PostgREST 每请求注入 JWT claims；pgAdmin 没有这层。
--
-- 本迁移建一个**只读排查角色** dbee_admin：
--   · BYPASSRLS —— 绕过行级安全，pgAdmin 里能看到全表（这正是排查所需）；
--   · 仅 SELECT —— 对全部表/序列只授 SELECT，显式 REVOKE 全部写权限；
--   · 无任何函数 EXECUTE —— 28 个 SECURITY DEFINER 写函数（grant_honey/
--     settle_apple_purchase 等）的 EXECUTE 已被 0039 收紧到
--     postgres/dbee_app/authenticated，dbee_admin 天然拿不到；此处再显式
--     REVOKE 一次做纵深防御（抗未来误 GRANT TO PUBLIC 波及）。
--   · CONNECTION LIMIT 5 —— 排查工具角色，限制连接面。
--
-- ⚠️ 安全边界（必须知晓）：
--   BYPASSRLS + 全表 SELECT = 能读到**所有用户的全部数据**（含 profiles
--   昵称、app_users 掩码手机号/ident_hash、全部业务明细）。凭据泄露等同
--   全量数据泄露，须与生产密码同等级保管。缓解措施：
--     ① 密码随机生成，只存服务器 /etc/dbee-admin-password（0600 root）
--        与本地 .env（已 gitignore），**绝不入 git**；
--     ② pg_hba 只对办公网段（114.254.3.0/24、114.246.239.129/32）放行
--        —— 与 dbee_app 相同的既有网段，不新增暴露面；
--     ③ 阶段 0 安全整改（5432 收口 localhost + ufw）完成后，此角色的
--        公网可达性进一步归零，届时 pgAdmin 需经 SSH 隧道连接。
--   不再需要时执行文件尾部【回滚段】彻底删除。
--
-- 密码纪律（与 0032 一致）：本文件**不含密码**。随机密码由
--   deploy/setup-admin-role.sh 生成（openssl rand，已存在则复用），
--   经 ALTER ROLE 设置，写入 /etc/dbee-admin-password。
--
-- 执行方式（超级用户；通常由 setup-admin-role.sh 代跑）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0041-admin-readonly-role.sql
-- 幂等：可重复执行（角色存在则强制校正属性；GRANT/REVOKE 天然幂等）。
--
-- 编号说明：《数据库切换详细规划-2026-10-26》曾把「最终数据同步」预排为
--   0041；本迁移先应用先占号（迁移编号必须与应用顺序一致，0034 教训），
--   数据同步迁移顺延为 0042，规划文档已同步更正。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① 角色（CREATE ROLE 无 IF NOT EXISTS，用 DO 块保幂等，同 0032 手法）──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_admin') THEN
    CREATE ROLE dbee_admin LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      BYPASSRLS CONNECTION LIMIT 5;
  ELSE
    -- 已存在则强制校正属性：防历史误建（尤其防 SUPERUSER/BYPASSRLS 之外的
    -- 写属性混入；BYPASSRLS 是本角色的**预期**属性，刻意保留）
    ALTER ROLE dbee_admin LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      BYPASSRLS CONNECTION LIMIT 5;
  END IF;
END $$;

COMMENT ON ROLE dbee_admin IS
  '只读排查角色（0041，pgAdmin 专用）。BYPASSRLS 看全表；仅 SELECT，无函数 EXECUTE。密码在服务器 /etc/dbee-admin-password（0600 root），禁入 git。';

-- ── ② 连接与 schema 可见性 ─────────────────────────────────────────────
GRANT CONNECT ON DATABASE dbee TO dbee_admin;
GRANT USAGE ON SCHEMA public TO dbee_admin;
-- auth schema 只有 auth.uid() 一个 STABLE 只读函数；授 USAGE+EXECUTE 便于
-- 在 pgAdmin 里 SELECT auth.uid() 复核 RLS 机制（无任何写副作用）。
GRANT USAGE ON SCHEMA auth TO dbee_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO dbee_admin;

-- ── ③ 只读授权（表 + 序列）─────────────────────────────────────────────
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dbee_admin;
-- 序列权限三种：USAGE(nextval) / SELECT(查看当前值) / UPDATE(setval)。
-- 只读排查只需 SELECT；先授后收，保证幂等重跑也能校正历史误授。
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO dbee_admin;
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM dbee_admin;

-- ── ④ 未来新表自动只读可见 ─────────────────────────────────────────────
-- 0001 注释提醒过 ALTER DEFAULT PRIVILEGES 绑定「建表角色」——本项目全部
-- 迁移都以 postgres 超级用户执行建表，故 FOR ROLE postgres 精确有效。
-- 没有这两行，切换期新增的表（如 0042 数据同步相关）在 pgAdmin 里会不可见。
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO dbee_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO dbee_admin;

-- ── ⑤ 纵深防御：显式收回全部写权限 ─────────────────────────────────────
-- 新角色本无写权限，此处显式 REVOKE 是抗「未来误操作」：
--   · 有人图省事 GRANT ALL ON ALL TABLES TO PUBLIC；
--   · 有人把 dbee_admin 加进别的角色 membership。
-- REVOKE 不存在的授权不报错，幂等安全。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM dbee_admin;
-- public 下 31 个函数（含 28 个 SECURITY DEFINER）：全部收回 EXECUTE。
-- BYPASSRLS 角色查表不经过 RLS 策略求值，不需要任何业务函数。
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM dbee_admin;

-- ── ⑥ 登记迁移追踪表（0034 纪律）───────────────────────────────────────
INSERT INTO public.schema_migrations
       (version, name, status, applied_by, note)
VALUES ('0041','admin-readonly-role','applied','self',
        '建 dbee_admin 只读排查角色：BYPASSRLS + 全表 SELECT + 零函数 EXECUTE + CONNECTION LIMIT 5；密码由 setup-admin-role.sh 随机生成存 /etc/dbee-admin-password；pg_hba 办公网段放行由同脚本追加')
ON CONFLICT (version, name) DO UPDATE SET
  status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（setup-admin-role.sh 会自动跑全部断言；手工复核可用）
-- ═══════════════════════════════════════════════════════════════════════
-- ① 角色属性：
--    SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolconnlimit
--      FROM pg_roles WHERE rolname='dbee_admin';
--    期望：t / t / f / -1 或 5
-- ② BYPASSRLS 生效（对比 dbee_app 的 0 行）：
--    SET ROLE dbee_admin; SELECT count(*) FROM profiles;   -- 期望 18（全量）
-- ③ 只读断言（必须全部 permission denied）：
--    SET ROLE dbee_admin; INSERT INTO profiles(owner_id) VALUES ('x');
--    SET ROLE dbee_admin; SELECT grant_honey('x','y',1,1);
--
-- ═══════════════════════════════════════════════════════════════════════
-- 【回滚段】不再需要此角色时（超级用户执行）：
--   DROP OWNED BY dbee_admin;              -- 清掉它名下的全部授权
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE SELECT ON TABLES FROM dbee_admin;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE SELECT ON SEQUENCES FROM dbee_admin;
--   DROP ROLE dbee_admin;
--   DELETE FROM public.schema_migrations WHERE version='0041';
--   -- 并从 pg_hba.conf 删除两条 dbee_admin 行后 SELECT pg_reload_conf();
--   -- 删除服务器 /etc/dbee-admin-password 与本地 .env 的 DBEE_ADMIN_PWD
-- ═══════════════════════════════════════════════════════════════════════
