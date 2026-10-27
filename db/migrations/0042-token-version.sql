-- ═══════════════════════════════════════════════════════════════════════
-- 0042 · app_users 加 token_version 列（JWT 会话强制下线）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-10-26 七项安全审计之①）：
--   access JWT 默认 7 天有效，且是纯 HS256 无状态 token —— verifyJwt 只验签
--   与 exp，登出（signOut）只能吊销网关内存里的 refresh_token，**已签发的
--   access token 在 exp 前一直有效**。被盗的会话无法立刻作废。
--
-- 本迁移做两件事：
--   ① 给 app_users 加 token_version 列（默认 1）。登出/改密时 +1，
--      网关校验 access token 时读 payload.ver 与库内 token_version 比对，
--      不一致 → 拒绝（旧 access token 立即失效）。
--   ② 注册账号时由网关写 token_version=1（新列有 DEFAULT，旧行自动补 1）。
--
-- ⚠️ 为什么列在 app_users 而不是 profiles：
--   token_version 是「身份/会话」概念，属于 app_users（身份表，仅网关可读写），
--   不放进 profiles（业务表，PostgREST 可达）。若放 profiles，前端能读到自己的
--   token_version 倒也无害，但「登出 bump」需要写权限，污染业务表语义。
--
-- 执行方式（超级用户）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0042-token-version.sql
-- 幂等：ADD COLUMN IF NOT EXISTS + 回填 ON CONFLICT。
--
-- 编号说明：0041 已被「dbee_admin 只读角色」占用；本迁移取 0042。
--   （《数据库切换详细规划》原把 0042 预留给数据同步 final，现顺延为 0043。）
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① token_version 列 ────────────────────────────────────────────────
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.app_users.token_version IS
  '会话版本号（0042）。登出/改密时 +1；网关校验 access token 的 ver 声明与此比对，不一致即拒绝（被盗会话立即作废）。';

-- ── ② 登记迁移追踪表（0034 纪律）───────────────────────────────────────
INSERT INTO public.schema_migrations
       (version, name, status, applied_by, note)
VALUES ('0042','token-version','applied','self',
        'app_users 加 token_version 列（默认 1）；配合网关 JWT ver 校验实现登出/改密强制下线')
ON CONFLICT (version, name) DO UPDATE SET
  status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证
-- ═══════════════════════════════════════════════════════════════════════
--   SELECT count(*), min(token_version), max(token_version)
--     FROM public.app_users;
--   期望：count 与改造前一致，min=max=1（存量用户全部回填 1）。
-- ═══════════════════════════════════════════════════════════════════════
