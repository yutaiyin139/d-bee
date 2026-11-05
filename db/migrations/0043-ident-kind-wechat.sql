-- ═══════════════════════════════════════════════════════════════════════
-- 0043 · app_users.ident_kind 扩展 'wechat'（小程序微信登录链路 A2）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-11-05，见 docs/替换云库前置条件盘点-2026-11-05.md §三 A2、
--   docs/小程序回迁自托管-切换清单-2026-11-03.md §四.2）：
--   小程序端唯一原生登录通道是 wx.login() → code → POST /v1/login-wechat，
--   网关补该路由（A1）后需要往 app_users 写 ident_kind='wechat' 的行，
--   而 0031 的列级 CHECK 只允许 ('phone','email') → INSERT 会被 23514 拒。
--
-- 本迁移只做一件事：把 CHECK 扩成 ('phone','email','wechat')。
--
-- 身份哈希口径（与 A1 实现逐字对应，server/lib/auth.mjs loginWechat）：
--   · ident_kind  = 'wechat'
--   · ident_value = 微信 jscode2session 返回的 openid（裸串，不带 wx: 前缀）
--   · ident_hash  = HMAC-SHA256('wechat:' + openid, IDENT_PEPPER)
--     —— 复用 identity.mjs 的 identHash()，kind 已拼进被签内容防跨类型碰撞
--   · ident_masked = 'wx****' + openid 后 4 位（满足 masked_is_masked 的 LIKE '%*%'）
--   · owner_id    = 'wx:' + openid（**不走 newOwnerId() 的 19 位数字发号**）。
--     为什么：云库小程序用户的业务数据 owner_id 就是 wx:<openid> 形态，
--     SDK userFromSessionPayload 读 session.user.id = sub，mini/src/lib/auth.ts
--     cacheSession 又以 uid.replace(/^wx:/,'') 提取 openid —— 保持同构则
--     mini 端与全部业务函数/RLS **零改动**。已实测全库 owner_id 列均为
--     text 类型、无长度/CHECK 约束（0030-schema.sql 全表核对，2026-11-05）。
--
-- 编号说明：0042 头注释曾把 0043 预留给「数据同步 final」（《数据库切换详细
--   规划-2026-10-26》1.3）。该同步已随 2026-11-05 决策作废（用户拍板：自建库
--   数据不清除、云库测试数据不迁移），故 0043 启用为本迁移，无编号冲突。
--
-- 执行方式（超级用户或表属主）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0043-ident-kind-wechat.sql
-- 幂等：DROP CONSTRAINT IF EXISTS + ADD（重复执行结果一致），可安全重跑。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① 扩 ident_kind CHECK ─────────────────────────────────────────────
-- 约束实名 = app_users_ident_kind_check（PG 对 0031 列级匿名 CHECK 的默认
-- 命名，tools/migration-audit.sh:230 探针用的就是这个名字，保持不变）。
ALTER TABLE public.app_users
  DROP CONSTRAINT IF EXISTS app_users_ident_kind_check;

ALTER TABLE public.app_users
  ADD CONSTRAINT app_users_ident_kind_check
  CHECK (ident_kind IN ('phone', 'email', 'wechat'));

COMMENT ON COLUMN public.app_users.ident_kind IS
  '登录标识类型：phone / email / wechat（0043 扩）。wechat 的 ident_value=openid，owner_id=wx:<openid>（与云库小程序同构）。';

-- ── ② 登记迁移追踪表（0034 纪律）───────────────────────────────────────
INSERT INTO public.schema_migrations
       (version, name, status, applied_by, note)
VALUES ('0043','ident-kind-wechat','applied','self',
        'app_users_ident_kind_check 从 (phone,email) 扩为 (phone,email,wechat)；配合网关 /v1/login-wechat（A1）')
ON CONFLICT (version, name) DO UPDATE SET
  status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证
-- ═══════════════════════════════════════════════════════════════════════
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'app_users_ident_kind_check';
--   期望：CHECK ((ident_kind = ANY (ARRAY['phone'::text, 'email'::text, 'wechat'::text])))
--
--   红验证（可选，执行后回滚）：
--   BEGIN;
--   INSERT INTO public.app_users (owner_id, ident_kind, ident_hash, ident_masked)
--   VALUES ('wx:test', 'wechat', 'deadbeef', 'wx****test');
--   ROLLBACK;
--   期望：迁移前报 23514 check violation；迁移后 INSERT 成功（被 ROLLBACK 撤销）。
-- ═══════════════════════════════════════════════════════════════════════
