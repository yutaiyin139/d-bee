-- ═══════════════════════════════════════════════════════════════════════
-- 0034 · 迁移追踪表 schema_migrations + 历史迁移状态回填（P0-4）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-10-23 迁移全面审计，见 docs/数据库迁移审计与实施计划.md）：
--   `SELECT to_regclass('public.schema_migrations')` → NULL。
--   33 个迁移编号里，状态只靠两处「文档」记录：
--     ① 迁移文件头注释 —— 只有 1 个文件写了「已应用」
--     ② db/README.md 的状态表 —— 只记到 0003
--   两者都严重滞后，且没有任何自动校验机制。
--   后果实测：0016（10 条边界 CHECK）、0026（newbie 蜜糖奖励）、
--   0027（邀请码单日频次限制）三个迁移**从未在服务器 dbee 库生效**，
--   0015（收写权限）**只生效一半**（entitlements/ai_usage 仍可越权 UPDATE），
--   而没有任何机制把这件事暴露出来 —— 直到人工逐条探库才发现。
--
-- 本迁移解决「下次还会再发生」：
--   ① 建 public.schema_migrations：记录「哪个迁移、什么时候、由谁、以什么状态」进库。
--   ② 按审计实测结论回填全部 33 个编号的真实状态（applied / superseded / void），
--      并写入各文件的 sha256 —— 用于日后发现「有人改了已应用的迁移」。
--   ③ 配套 tools/migration-audit.sh 把三类探针（存在性 / 版本性 / 可利用性）
--      固化成可重复执行的脚本，并已纳入 tools/db-healthcheck.sh（第 8 节）。
--
-- 编号说明：审计文档里 P0-1 原写作 0034-security-and-integrity.sql，
--   但用户指定执行顺序是 P0-4（追踪表）先于 P0-1（安全补齐）。
--   迁移编号必须与应用顺序一致，否则「按序号应用」和追踪表都会错乱，
--   故追踪表取 0034，安全补齐顺延为 0035-security-and-integrity.sql。
--
-- 表结构取舍（为什么比审计文档草案多两个字段）：
--   · 主键用 (version, name) 而非单 version：0020 同号两个文件、
--     0030 有 full/schema 两个产物，单列主键会撞。
--   · status：区分 applied（真生效）/ superseded（内容被后来的迁移接管，
--     本文件不再需要单独应用）/ void（永久作废，如 0029 依赖 pg_net 不可用）。
--     没有这个字段，审计脚本无法区分「忘了应用」和「有意不应用」——
--     而这两者的处置完全相反。
--   · note：记录实测证据（探针查了什么），让「为什么标这个状态」可复核。
--
-- 权限取舍：本表不含任何用户 PII，是纯基础设施元数据。
--   前端（PostgREST 走 dbee_web）不该读它 → 对 anon/authenticated/dbee_web 全撤。
--   体检脚本走 postgres 超级用户；另给 dbee_app 只读，便于应用侧自检工具。
--   不启用 RLS：本表无 owner_id 概念，RLS 策略无从写起；
--   若启用而不放 policy，dbee_app（0033 起 NOBYPASSRLS）将读不到任何行，
--   自检工具会静默失效 —— 那是比「少一层 RLS」更糟的结果。
--
-- 执行方式（超级用户）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0034-schema-migrations.sql
-- 幂等：CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO UPDATE，可重复执行。
--   重复执行会把 note/applied_at 刷新为最新一次，checksum 以本次为准。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① 追踪表 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     text        NOT NULL,              -- '0016'
  name        text        NOT NULL,              -- 'input-bounds'
  status      text        NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied', 'superseded', 'void')),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text,                              -- 执行身份（backfill-… / postgres / 手工）
  checksum    text,                              -- 迁移文件 sha256，防「改了已应用的迁移」
  note        text,                              -- 实测证据，说明为何是这个状态
  PRIMARY KEY (version, name)
);

COMMENT ON TABLE  public.schema_migrations            IS '迁移应用状态追踪（0034 建）。applied=真生效；superseded=内容被后续迁移接管；void=永久作废。';
COMMENT ON COLUMN public.schema_migrations.checksum   IS '对应 db/migrations/<version>-<name>.sql 的 sha256；与本地不一致说明已应用的迁移被改动过。';

-- 前端与 PostgREST 一律不可见（含 dbee_web，若该角色已由 0032 建出）
REVOKE ALL ON public.schema_migrations FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON public.schema_migrations FROM dbee_web';
  END IF;
END $$;
GRANT SELECT ON public.schema_migrations TO dbee_app;

-- ── ② 回填历史状态（审计实测结论，2026-10-23）─────────────────────────
-- applied_at 统一记为回填时刻：真实的历史应用时间已不可考
--   （0001–0028 大多在云库执行，云库无追踪表；服务器 dbee 库由 0030 镜像一次性建起）。
--   与其编造时间，不如如实标注「本行是 2026-10-23 审计回填的」，
--   真正的证据在 note 列（当时探库查到的东西）。
-- checksum 为各迁移文件的 sha256（本地 sha256sum 计算，2026-10-23）。
-- 0016 / 0026 / 0027 此处**不写 applied**：它们从未生效，
--   内容由 0035 一次性补齐，故标 superseded 并指向 0035。
INSERT INTO public.schema_migrations
       (version, name, status, applied_at, applied_by, checksum, note) VALUES
  ('0001','performance-and-hardening','applied',now(),'backfill-audit-20261023','4f15d8d5dcc761c58f3f1941ebe7173b8b0d9fdabde3105e964e6d2f709fc773','3 个复合索引存在；anon 表权限计数=0'),
  ('0002','mirror-to-local-pg','applied',now(),'backfill-audit-20261023','7015b37deb1db362ba2e67d01a881871a883f95c8f3588f0a6e559aa57c1cd07','auth.uid() 存在且未注入身份时返回 NULL'),
  ('0003','atomic-ai-quota','applied',now(),'backfill-audit-20261023','872d8842cba910b58e93b0de75fed7553eb332f17ffd7bd42809724e8561f955','consume_ai_quota / release_ai_quota 两函数存在'),
  ('0004','micronutrients-and-recipes','applied',now(),'backfill-audit-20261023','cc6646b77f13fcf2be19ed53cbabf045d0bf83d38c2b0226c9530c58d94b3274','sodium_mg/fiber_g/added_sugar_g 三列在；recipes 表与 recipes_select_own 策略在'),
  ('0005','membership-tiers','applied',now(),'backfill-audit-20261023','860d1557e0a2b5da8ae3b027a29e33b49c03831f8760db4935b147746c996129','entitlements.source 列存在'),
  ('0006','quota-bonus','applied',now(),'backfill-audit-20261023','3ad3bbba197e29a61388d72d63b0738b0e0fd7a295646e52572022fe19ffb0d4','quota_bonus 表、grant_photo_bonus 函数、策略全在'),
  ('0007','consume-photo-quota','applied',now(),'backfill-audit-20261023','bffa1e1150526d46435fbec8f832552d4e0493930c0bc8cbc8d86149b96b1f57','consume_photo_quota / get_photo_quota 全在'),
  ('0008','invite-honey','applied',now(),'backfill-audit-20261023','f8dd19c1ca9eab581d7f7d748990c04eca68213b4ad9a5529ea2cb5a9d56c309','badges / honey_ledger / invite_links 三表全在'),
  ('0009','invite-reward-closure','applied',now(),'backfill-audit-20261023','eb8d652267c80c40c3331769bf2694e388b913c5bd926e1d5b8715fb6406b6c6','count_invitees / settle_invite_checkin / bind_invite 全在'),
  ('0010','badge-stats','applied',now(),'backfill-audit-20261023','ab87b81930027abacff1660ab145f7a45bdb2b7565bffb7f5437052f4ffedb8c','badge_stats 函数存在'),
  ('0011','honey-refund-expire','applied',now(),'backfill-audit-20261023','e6328b9b5b8d9e82c8f7ebe482edae815c052bd306a4968619bc34d811f939e4','expire_stale_honey / refund_checkin_honey_by_date 全在'),
  ('0012','redeem-server-and-invite-throttle','applied',now(),'backfill-audit-20261023','294a92235f92374e06589a2d63062d800f15fed6565390db20c1f643f759f1e6','redeem_codes / invite_attempts 表 + redeem_by_code / invite_throttled 函数全在'),
  ('0013','honey-security-hardening','applied',now(),'backfill-audit-20261023','50f75a554d555ccafe609a2bf7b74ec1bc4720555b14699647361c4f243f02ed','grant_honey / redeem_honey / unlock_badge / 3 个 refund 函数全在'),
  ('0014','quota-token','applied',now(),'backfill-audit-20261023','ee0ed86f571f24f8ee48108e1db2565d9d6ea73852422f4b51e1af4ee4004037','release_photo_quota 函数 + ai_quota_claims 表全在'),
  ('0015','revoke-table-write','superseded',now(),'backfill-audit-20261023','9cc3325c0f3f4af38a78b228b43d65001813490347ff4d90c78d184d5a38e9ff','半失效：authenticated 对 entitlements/ai_usage 仍持有完整写权限（事务内 SET ROLE 实测可 UPDATE entitlements SET plan=''lifetime''）。REVOKE 追加语义坑，由 0035 先 REVOKE ALL 再精确 GRANT 修正'),
  ('0016','input-bounds','superseded',now(),'backfill-audit-20261023','9268d71f4c86da9104d08cefe048289a8d354e914e358ea396cef86144f676a0','完全未生效：10 条边界 CHECK 在 pg_constraint 中一条都不存在（补跑前置实测 10 项越界数据均为 0 行）。由 0035 补齐'),
  ('0017','invite-bind-fix','applied',now(),'backfill-audit-20261023','eeec1d3a17a73db5946eccb10ea1a5dd4ef045987448280bf4e0d4bcc7ca3b41','bind_invite 函数体含 already 分支（重复绑定防护生效）'),
  ('0018','photo-count','applied',now(),'backfill-audit-20261023','139ed217e23eb8c4f3fd389b324d9e3aa0a3b4922a0252391f4f68f9b7d3aad5','get_today_photo_count 函数存在'),
  ('0019','invite-once-fix','applied',now(),'backfill-audit-20261023','f45d9331d85ddf9cd70792625ca3b3d4ec3c4b6221d0d8da2cea0a1daa0c324b','profiles_invited_once 部分唯一索引在（含 WHERE invited_by IS NOT NULL）'),
  ('0020','ai-consent','applied',now(),'backfill-audit-20261023','9d17802ba949fb4caa799a6cec2e5921c913202d11bf334a2936edca33b53770','profiles.ai_consented 列存在（PIPL 同意）。同号两文件之一，故主键含 name'),
  ('0020','badge-weight-lost-fix','applied',now(),'backfill-audit-20261023','046e8b8be106ea381fb7444a3e9f7a33a41da0c4fc9c43621324507cefb5596e','badge_stats 函数体含 weight_lost / barcode_count / recipe_count'),
  ('0021','payment-orders','applied',now(),'backfill-audit-20261023','37fd33ec41379545e5b84584f883830a389bcfc23a3e3f6bb5e825dad8fe65aa','payment_orders / payment_products 表在，2 个 RPC 在，3 档商品数据齐（18/128/328 元 CNY）'),
  ('0022','health-connect','applied',now(),'backfill-audit-20261023','f21fb2205b3a23bd60beb1128ec1fb34330fd58742c796624aa5882e54852d6e','profiles.health_connected / health_connected_at 两列在'),
  ('0023','step-goal','applied',now(),'backfill-audit-20261023','9c888f8ace25a28fb1e8a5ac360f5d4cf836c9cb76d27217cdc7e6e08fd0909a','profiles.step_goal 列在'),
  ('0024','redeem-refid-fix','applied',now(),'backfill-audit-20261023','4c0eb709ae10ba0c63b25ff38d4c8c7f1550acbbc177c1857ff53ee9778815b8','redeem_honey 函数体含 redeem ref_id'),
  ('0025','ai1scan-redeem-limit-2','applied',now(),'backfill-audit-20261023','98bf109c77935cd78bcbb73d3cba61ad52992968cc5fd12240a1ffeed6d45c23','redeem_honey 函数体含 v_ai_today >= 2 限制'),
  ('0026','newbie-streak-honey-reward','superseded',now(),'backfill-audit-20261023','8353d5c9e75ddb79d203e2441f1c2a69cf7b35e5145d8b6f76b8b5979c3a0ee3','完全未生效：grant_honey 函数体无 newbie(150) 分支（前端 Onboarding 发新手奖励静默失败）；存量 source=''newbie'' 的 quota_bonus 7 行/21 次仍在。由 0035 补齐'),
  ('0027','invite-daily-limit','superseded',now(),'backfill-audit-20261023','0718ef62ff1d3a1df391f46eb9b5b1370ef0ee8b19b59f0b0c3bb7880dfa8627','完全未生效：bind_invite 函数体无 daily_limit 分支（前端已备好该状态码）。由 0035 补齐'),
  ('0028','leaderboard','applied',now(),'backfill-audit-20261023','6bc4cfb59ada37519796e884398a6c3ef362f97eb740d139bf056c920c39db48','leaderboard / _lb_compute_streak / _lb_mask_name 三函数全在'),
  ('0029','iap-verify-receipt','void',now(),'backfill-audit-20261023','850947778eb07fa8f5782fc33ed22e334d44fa2c57c101cb24e6da48695cd16e','永久作废：依赖 pg_net 扩展，服务器 PG17.11 不可用（实测 count=0）。Apple IAP 验签改由 Node 网关承担（P1-1）'),
  ('0030','full-selfhost-mirror','applied',now(),'backfill-audit-20261023','55eab49270d0637b4ed6c94da432515d1aacb74cca12e4ee9f167d9f2d03e335','服务器 dbee 库的建立者：18 表、40 索引、25 策略、26 个 public 函数与 0030-schema.sql 逐项一致'),
  ('0030','schema','applied',now(),'backfill-audit-20261023','d7e3fe646856f9fb624b6655fa56795362b419200634bf59b2490d8a7696655d','与 full-selfhost-mirror 同一份镜像的「仅结构」产物（入库版）。注：2026-10-23 生成器修复（P0-3）后已重新生成，checksum 为修复后值'),
  ('0031','app-users','applied',now(),'backfill-audit-20261023','c048dab583901820300a31a03f1ac5fe6ed178481c896c3a5dc63af559feefcd','app_users 表在，ident_kind_check 与 masked_is_masked 两个 CHECK 在，ENABLE+FORCE RLS'),
  ('0032','postgrest-roles','applied',now(),'backfill-audit-20261023','1751db3416aca6912b4f52f3c673b16f18689f575d7a59f8ce68ac1a98afb1dd','dbee_web 角色存在，rolcanlogin=t、rolinherit=f（NOINHERIT 实测确认）'),
  ('0033','app-rls-fix','applied',now(),'backfill-audit-20261023','4c5b24cac87a94c4ac4893f86af75c88fd672d18bbf75ba5db88983da395e92f','dbee_app rolbypassrls=f（已收回）；gateway_ident_access policy 在；dbee_app 对 app_users 仅 INSERT,SELECT,UPDATE（DELETE 已收回）')
ON CONFLICT (version, name) DO UPDATE SET
  status     = EXCLUDED.status,
  applied_by = EXCLUDED.applied_by,
  checksum   = EXCLUDED.checksum,
  note       = EXCLUDED.note;
-- 刻意不更新 applied_at：首次回填的时间戳更有信息量，重复执行不该把它冲掉。

-- ── ③ 本迁移自身入表 ──────────────────────────────────────────────────
-- checksum 无法自指（文件内含本行），故留 NULL，由 migration-audit.sh
-- 在运行时用本地文件的 sha256 与库内值比对时跳过 NULL 项（脚本已处理）。
INSERT INTO public.schema_migrations
       (version, name, status, applied_by, note)
VALUES ('0034','schema-migrations','applied','self','建本表 + 回填 33 个编号的历史状态')
ON CONFLICT (version, name) DO UPDATE SET
  status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;

COMMIT;

-- ── 校验（只读，执行后可肉眼确认）─────────────────────────────────────
-- SELECT status, count(*) FROM public.schema_migrations GROUP BY status ORDER BY status;
--   期望：applied=31, superseded=4, void=1（共 36 行）
--   行数构成：33 个编号 + 0020 同号拆 2 行 + 0030 双产物拆 2 行 = 35 行历史，
--             再加本迁移自身的 1 行 = 36 行。
--   applied 31 = 历史 30 + 本迁移自身 1。
-- SELECT version, name, status FROM public.schema_migrations WHERE status <> 'applied' ORDER BY version;
--   期望：0015/0016/0026/0027 = superseded（由 0035 接管），0029 = void
