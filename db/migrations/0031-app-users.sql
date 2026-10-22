-- ═══════════════════════════════════════════════════════════════════════
-- 0031 · 自托管身份表 app_users
-- ═══════════════════════════════════════════════════════════════════════
-- 为什么需要这张表：
--   `0030-full-selfhost-mirror.sql` 只镜像了 **业务数据**（17 表 / 26 函数 / RLS）。
--   云端的 **身份数据**（phone / email → uid 的映射）存在云端 auth 库里，镜像没有抓，
--   也不应该抓（那是 WorkBuddy 云服务的内部表）。自托管后网关必须自己认人，
--   否则「手机号登录」拿不到 owner_id，JWT 的 sub 无从签发。
--
-- 关键设计决策：
--   ① owner_id **沿用云端那套 19 位纯数字串**（如 2109869577155379200），
--      与已迁移的 17 份业务档案的 owner_id 同构 → RLS 策略、全部 SECURITY DEFINER
--      函数、榜单/徽章逻辑**一行都不用改**。
--   ② **不存明文手机号/邮箱**：只存 HMAC-SHA256 哈希（带服务端 PEPPER）+ 展示用掩码。
--      PIPL 最小必要 + 拖库不可逆。哈希必须带 PEPPER，否则 11 位手机号空间仅 10^11，
--      彩虹表/穷举可反查 —— 这是手机号哈希与密码哈希的本质区别，PEPPER 不可省。
--   ③ **对前端完全不可见**：不放任何 RLS policy + REVOKE authenticated/anon，
--      只有网关连接角色可读写。理由见下方「为什么必须 REVOKE」。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 表 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_users (
  -- 与 profiles.owner_id 同构的 19 位数字串。新用户由网关签发（见 server/identity.mjs）。
  owner_id      text        PRIMARY KEY,

  -- 登录标识类型。当前只用 phone（邮箱路径预留，前端 AuthScreen 已有邮箱 tab）。
  ident_kind    text        NOT NULL CHECK (ident_kind IN ('phone', 'email')),

  -- HMAC-SHA256(归一化标识, IDENT_PEPPER) 的 hex。归一化：手机号 → 11 位裸号；邮箱 → 全小写去空白。
  ident_hash    text        NOT NULL,

  -- 展示用掩码：138****1234 / ab***@example.com。仅够用户认出「这是我的号」，不可反推。
  ident_masked  text        NOT NULL,

  -- 预留：邮箱注册路径的密码（须 scrypt/argon2id，禁用 md5/sha1）。
  -- 当前「短信验证码 + 万能码」方案不写此列，恒为 NULL。
  password_hash text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  login_count   integer     NOT NULL DEFAULT 0,

  -- 同一种标识类型下哈希唯一（= 一个手机号只能有一个账号）。
  -- 不用 phone UNIQUE，因为 phone/email 分列会让「两类标识各建唯一索引」变得别扭。
  CONSTRAINT app_users_ident_unique UNIQUE (ident_kind, ident_hash),

  -- 掩码必须真的被掩过：防止将来有人图省事把明文塞进 masked 列。
  CONSTRAINT app_users_masked_is_masked CHECK (ident_masked LIKE '%*%')
);

COMMENT ON TABLE public.app_users IS
  '自托管身份表（0031）。存 HMAC 哈希而非明文，对前端不可见，仅网关可读写。';

-- ── RLS：开且强制，但**不放任何 policy** ────────────────────────────────
-- 效果 = 除超级用户/表属主/BYPASSRLS 角色外，任何角色都查不到任何行。
-- FORCE 是必需的：表属主默认绕过 RLS，不 FORCE 的话属主角色能看到全表。
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users FORCE ROW LEVEL SECURITY;

-- ── 权限：为什么必须显式 REVOKE ────────────────────────────────────────
-- PostgREST 会把 public schema 下的**所有**表暴露成 REST 端点。若 app_users
-- 对 authenticated 有 SELECT 权限，前端就能直接
--   GET /.cloud/database/rest/app_users?select=*
-- 把全部用户的身份哈希拖走。RLS 无 policy 虽然已经挡住了，但**权限层再挡一道**
-- ——纵深防御，任何一处配置失误都不至于直接泄露。
REVOKE ALL ON public.app_users FROM PUBLIC;
REVOKE ALL ON public.app_users FROM anon;
REVOKE ALL ON public.app_users FROM authenticated;

-- 网关连接角色：A1 auth 模块用它读写 app_users。
-- 与 PostgREST 的 authenticator 角色（dbee_web）**刻意分离**，两条链路权限互不重叠。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_gateway') THEN
    CREATE ROLE dbee_gateway NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO dbee_gateway;
GRANT SELECT, INSERT, UPDATE ON public.app_users TO dbee_gateway;
-- 刻意不给 DELETE：身份记录只应软失效，不给物理删除的口子。
-- 刻意不给 authenticated/anon EXECUTE 任何 app_users 相关函数（本来也没有）。

-- ── 登录审计用的轻量索引 ──────────────────────────────────────────────
-- last_login_at 用于「N 天未登录」运营召回；建部分索引避免全表扫。
CREATE INDEX IF NOT EXISTS app_users_last_login_idx
  ON public.app_users (last_login_at)
  WHERE last_login_at IS NOT NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 执行说明
-- ═══════════════════════════════════════════════════════════════════════
-- 本地/服务器执行（dbee_gateway 角色的密码在服务器 .env 里配，勿写进本文件）：
--   PGPASSWORD=$DBEE_PWD psql -h 150.158.51.106 -U dbee_app -d dbee \
--     -f db/migrations/0031-app-users.sql
--
-- 若 dbee_app 不是表属主、也无 BYPASSRLS，则建表后它自己也会读不到 app_users。
-- 用属主或超级用户（如 postgres）执行本迁移，再 GRANT 给 dbee_gateway。
--
-- ⚠️⚠️ 老用户数据缺口（自托管切换的**唯一**未解问题，必须在 A4 切流量前拍板）⚠️⚠️
--   现状：库里已有 17 份业务档案（owner_id 均为云端签发的 19 位数字串），
--         但「手机号 → owner_id」的映射存在 **WorkBuddy 云端 auth 库**里，
--         0030 镜像没有抓、也抓不到（那是云服务内部表，不下发给应用）。
--   后果：老用户用手机号登录自托管网关 → app_users 查无此人 → 被当**新用户**
--         签发新 owner_id → 打卡/体重/积分/徽章全部归零，且旧档案成孤儿数据。
--
--   三条可选路径（按推荐度排序）：
--   A.【推荐·若 17 份确为开发测试数据】判定为开发数据，不做迁移。
--      理由：小程序与 App **均尚未正式上线**，不存在需要保护的真实老用户。
--      切换后所有人重新注册，旧档案留在库里当回归测试的现成数据（RLS 会挡住新用户）。
--      代价：0。风险：若其中有真实用户（如家人长期记录），其历史数据不可见。
--   B.【手动认领】切换后由你为需要保留的账号手动插一行 app_users：
--      知道某手机号对应哪个 owner_id（只有你自己知道，例如你自己的号），
--      就用 tools/hash-ident.mjs 算出 ident_hash 后 INSERT，即可登录并看到旧数据。
--      适合「只有 1–3 个账号需要保留」的情形 —— 本项目大概率就是这种。
--   C.【双活过渡】nginx 同时保留云端上游，老用户走云端、新用户走自托管，
--      待老用户自然流失后再摘掉云端。代价：需长期维护两套上游与云库冻结风险，
--      与「自托管是数据主权」的初衷相悖，**不推荐**。
--
--   👉 决策待你拍板。若选 A/B，本迁移即可直接执行，无需额外脚本。
-- ═══════════════════════════════════════════════════════════════════════

