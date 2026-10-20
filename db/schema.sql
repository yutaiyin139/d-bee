-- ════════════════════════════════════════════════════════════════════════════
-- D-Bee（自律蜜蜂）数据库基线 Schema
-- ════════════════════════════════════════════════════════════════════════════
--
-- 来源：2026-10-13 从线上 WorkBuddy 云数据库**反向导出**（as-is 基线）
--   · 应用 ID     wbapp_w6iIU6TqTyHvJxESPTxBTy
--   · 资源 ID     wbcs_45DQ4I52Uv2NUAKAJkWdq1
--   · 数据库      postgres-6o15js8c  (PostgreSQL 17.11)
--   · 导出时数据  3 用户 / 6 行 / 10 MB
--
-- 用途：这是**唯一真源**。此前 schema 只存在于云端，没有任何版本记录，
--       无法复现、无法审计、无法回滚。本文件把它固化下来。
--
-- 依赖：auth.uid()（Supabase 风格的内置函数，由平台提供，返回当前登录用户 ID）
--
-- 应用方式：见 db/README.md。**不要**直接整份重跑到已有库上（表已存在会报错），
--          本文件用于①新建环境 ②审计比对 ③灾备重建。
--
-- ⚠️ 审计发现的待优化项（第 1、2 项已于 2026-10-13 由 migrations/0001 执行）：
--   ✅ 1. meal_entries / water_logs / exercise_logs 缺少 (owner_id, log_date) 索引
--         —— 已补 3 个复合索引（见文末「索引一览」）
--   ✅ 2. anon 角色被授予了表级 INSERT/UPDATE/DELETE（见文末 GRANT 段）
--         —— 已 REVOKE，防护由「仅 RLS」升级为「GRANT + RLS」双层
--   ⬜ 3. RLS 策略风格不统一：profiles/meal_entries/weight_logs 用 4 条分命令策略，
--         其余 4 张表用 1 条 FOR ALL —— 语义等价，但审计与维护不便（未处理）
--   ⬜ 4. updated_at 无触发器，靠前端写入维护（未处理）
--   ⬜ 5. authenticated 仍持有 TRUNCATE / REFERENCES / TRIGGER（PostgREST 不暴露
--         TRUNCATE，当前不可利用；如需极致收敛可再 REVOKE）
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. profiles · 用户档案（一人一行）──────────────────────────────────────
-- 身体数据与营养目标。所有目标值（daily_calorie_target 等）由前端按
-- Mifflin-St Jeor 公式算出后写入，数据库不做计算。
CREATE TABLE public.profiles (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id            text        NOT NULL DEFAULT auth.uid() UNIQUE,
  nickname            text,
  gender              text,
  age                 integer,
  height_cm           numeric,
  start_weight_kg     numeric,
  current_weight_kg   numeric,
  target_weight_kg    numeric,
  activity_level      text,
  goal                text,
  weekly_rate_kg      numeric,
  daily_calorie_target integer,
  protein_target_g    integer,
  carb_target_g       integer,
  fat_target_g        integer,
  barriers            text,
  plan_summary        text,
  onboarded           boolean     NOT NULL DEFAULT false,
  ai_consented        boolean,                       -- 0020 显式同意 AI 处理个人数据
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ── 2. meal_entries · 饮食记录（一人一天多餐多行）──────────────────────────
-- source 取值：manual（手输）/ photo（拍照识别）/ barcode（扫码）/ library（食物库）
CREATE TABLE public.meal_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id       text        NOT NULL DEFAULT auth.uid(),
  log_date       date        NOT NULL,
  meal_type      text        NOT NULL,
  food_name      text        NOT NULL,
  quantity_text  text,
  grams          numeric,
  calories       numeric     NOT NULL,
  protein_g      numeric     DEFAULT 0,
  carb_g         numeric     DEFAULT 0,
  fat_g          numeric     DEFAULT 0,
  sodium_mg      numeric,
  fiber_g        numeric,
  added_sugar_g  numeric,
  source         text        NOT NULL DEFAULT 'manual',
  image_url      text,
  ai_note        text,
  health_score   integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- ⚠️ 待补：(owner_id, log_date) 索引 —— 日视图/区间报表是最高频查询


-- ── 3. weight_logs · 体重记录（一人一天一行）───────────────────────────────
CREATE TABLE public.weight_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  log_date    date        NOT NULL,
  weight_kg   numeric     NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, log_date)
);


-- ── 4. water_logs · 饮水记录（一行 = 一次加水）─────────────────────────────
CREATE TABLE public.water_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  log_date    date        NOT NULL,
  amount_ml   integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- ⚠️ 待补：(owner_id, log_date) 索引


-- ── 5. exercise_logs · 运动记录（一行 = 一次运动）──────────────────────────
CREATE TABLE public.exercise_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  log_date    date        NOT NULL,
  name        text        NOT NULL,
  minutes     integer     NOT NULL,
  calories    numeric     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- ⚠️ 待补：(owner_id, log_date) 索引


-- ── 6. entitlements · 权益（一人一行）──────────────────────────────────────
-- plan：free / pro / lifetime。
--   pro      订阅制，pro_until 为过期时间，到期回落 free；
--   lifetime 终身买断，pro_until 恒 null；
--   redeemed_code 记录兑换码来源；source 记录支付来源（redeem/wechat/alipay/apple/google）。
-- 注意：当前**未接入真实支付**，仅兑换码解锁 lifetime（备案合规要求，见 docs/备案材料清单.md）
CREATE TABLE public.entitlements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id       text        NOT NULL DEFAULT auth.uid() UNIQUE,
  plan           text        NOT NULL DEFAULT 'free',
  pro_until      timestamptz,
  redeemed_code  text,
  source         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_plan_check CHECK (plan IN ('free', 'pro', 'lifetime'))
);


-- ── 7. ai_usage · AI 用量计数（一人一天一功能一行）─────────────────────────
-- 免费档每日 10 次（额度取自前端常量 FREE_DAILY_AI，此表只存计数）；
-- 唯一约束保证同一天同一功能只有一行，由 consume_ai_quota 原子自增
CREATE TABLE public.ai_usage (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  usage_date  date        NOT NULL,
  feature     text        NOT NULL DEFAULT 'scan',
  count       integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, usage_date, feature)
);


-- ── 7b. quota_bonus · 拍照奖励额度（连续打卡 / 完善资料）────────────────────
-- source：newbie（完善资料新手奖励）/ streak7（连续打卡 7 天）；
-- grant_key 用于防重复领取（newbie 固定 'newbie'，streak7 用达成日期）；
-- amount - consumed = 剩余余额，expires_at 过期时间（7 天有效，防囤积）。
CREATE TABLE public.quota_bonus (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  source      text        NOT NULL,
  grant_key   text        NOT NULL,
  amount      integer     NOT NULL DEFAULT 0,
  consumed    integer     NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source, grant_key)
);


-- ── 8. recipes · 自定义食谱（一人多模板，一餐 = 若干食物条目）─────────────
-- items 为 jsonb 数组，元素含 food_name/grams/calories/三大营养素/微营养素，
-- 均为「实际摄入量」口径（非每 100g）。前端一键复记时直接还原成记录行。
CREATE TABLE public.recipes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  name        text        NOT NULL,
  items       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);


-- ════════════════════════════════════════════════════════════════════════════
-- 行级安全（RLS）—— 数据隔离的唯一防线
-- 全部策略形如 owner_id = auth.uid()：用户只能看到/改到自己的行
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weight_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercise_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_bonus   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes       ENABLE ROW LEVEL SECURITY;

-- profiles（4 条分命令风格）
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_delete_own ON public.profiles;
CREATE POLICY profiles_delete_own ON public.profiles FOR DELETE USING (owner_id = auth.uid());

-- meal_entries（4 条分命令风格）
DROP POLICY IF EXISTS meal_entries_select_own ON public.meal_entries;
CREATE POLICY meal_entries_select_own ON public.meal_entries FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_insert_own ON public.meal_entries;
CREATE POLICY meal_entries_insert_own ON public.meal_entries FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_update_own ON public.meal_entries;
CREATE POLICY meal_entries_update_own ON public.meal_entries FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_delete_own ON public.meal_entries;
CREATE POLICY meal_entries_delete_own ON public.meal_entries FOR DELETE USING (owner_id = auth.uid());

-- weight_logs（4 条分命令风格）
DROP POLICY IF EXISTS weight_logs_select_own ON public.weight_logs;
CREATE POLICY weight_logs_select_own ON public.weight_logs FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_insert_own ON public.weight_logs;
CREATE POLICY weight_logs_insert_own ON public.weight_logs FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_update_own ON public.weight_logs;
CREATE POLICY weight_logs_update_own ON public.weight_logs FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_delete_own ON public.weight_logs;
CREATE POLICY weight_logs_delete_own ON public.weight_logs FOR DELETE USING (owner_id = auth.uid());

-- water_logs（1 条 FOR ALL 风格）
DROP POLICY IF EXISTS water_logs_own ON public.water_logs;
CREATE POLICY water_logs_own ON public.water_logs FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- exercise_logs（1 条 FOR ALL 风格）
DROP POLICY IF EXISTS exercise_logs_own ON public.exercise_logs;
CREATE POLICY exercise_logs_own ON public.exercise_logs FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- entitlements（1 条 FOR ALL 风格）
DROP POLICY IF EXISTS entitlements_own ON public.entitlements;
CREATE POLICY entitlements_own ON public.entitlements FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- ai_usage（1 条 FOR ALL 风格）
DROP POLICY IF EXISTS ai_usage_own ON public.ai_usage;
CREATE POLICY ai_usage_own ON public.ai_usage FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- quota_bonus（1 条 FOR ALL 风格）
DROP POLICY IF EXISTS quota_bonus_own ON public.quota_bonus;
CREATE POLICY quota_bonus_own ON public.quota_bonus FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- recipes（4 条分命令风格）
DROP POLICY IF EXISTS recipes_select_own ON public.recipes;
CREATE POLICY recipes_select_own ON public.recipes FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_insert_own ON public.recipes;
CREATE POLICY recipes_insert_own ON public.recipes FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_update_own ON public.recipes;
CREATE POLICY recipes_update_own ON public.recipes FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_delete_own ON public.recipes;
CREATE POLICY recipes_delete_own ON public.recipes FOR DELETE USING (owner_id = auth.uid());


-- ════════════════════════════════════════════════════════════════════════════
-- 权限（GRANT）—— 建表与 RLS 是两道独立的门，漏 GRANT 会得到 42501
-- ════════════════════════════════════════════════════════════════════════════
--
-- ✅ 状态（2026-10-13，migrations/0001 执行后）：anon 的表权限**已全部撤销**。
--
--    原始状态：平台建表时会自动给 anon 播撒 SELECT/INSERT/UPDATE/DELETE。
--    当时安全性**完全依赖 RLS**（未登录时 auth.uid() 返回 NULL，
--    owner_id = NULL 恒为 NULL 而非 TRUE，策略不匹配、操作落空）。
--    虽不构成漏洞，但属单层防护 —— 任何一张表的 RLS 被误关或策略写错，
--    该表全部数据立即对未登录者开放。
--
--    现在 GRANT 层先行拒绝：未登录请求直接得到 42501 permission denied，
--    不再到达策略层，防护升级为「GRANT + RLS」双层。
--    （实测：GET /.cloud/database/rest/<表>?select=* → HTTP 401 DATABASE_42501）
--
--    如需回滚（不推荐）：GRANT SELECT, INSERT, UPDATE, DELETE ON <各表> TO anon;

-- ⚠️ 新建表时的纪律：平台建表后仍会自动给 anon 播撒权限，必须补一步
--    REVOKE ALL ON public.<新表> FROM anon;
--    不要依赖 ALTER DEFAULT PRIVILEGES —— 它绑定到执行建表的角色，
--    而平台建表用的角色不在我们控制范围内，写了可能不生效。

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.profiles, public.meal_entries, public.weight_logs, public.water_logs,
     public.exercise_logs, public.entitlements, public.ai_usage, public.recipes
  TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 索引一览（含 2026-10-13 migrations/0001 新增的 3 个复合索引）
--   profiles_pkey                    PRIMARY KEY (id)
--   profiles_owner_id_key            UNIQUE (owner_id)
--   meal_entries_pkey                PRIMARY KEY (id)
--   meal_entries_owner_id_log_date_idx    (owner_id, log_date)      ← 0001 新增
--   weight_logs_pkey                 PRIMARY KEY (id)
--   weight_logs_owner_id_log_date_key UNIQUE (owner_id, log_date)
--   water_logs_pkey                  PRIMARY KEY (id)
--   water_logs_owner_id_log_date_idx      (owner_id, log_date)      ← 0001 新增
--   exercise_logs_pkey               PRIMARY KEY (id)
--   exercise_logs_owner_id_log_date_idx   (owner_id, log_date)      ← 0001 新增
--   entitlements_pkey                PRIMARY KEY (id)
--   entitlements_owner_id_key        UNIQUE (owner_id)
--   ai_usage_pkey                    PRIMARY KEY (id)
--   ai_usage_owner_id_usage_date_feature_key UNIQUE (owner_id, usage_date, feature)
--
-- 新增索引的覆盖场景（App 最高频的查询形态，owner_id 等值 + log_date 等值/范围）：
--   listMealsByDate / listWaterByDate / listExerciseByDate
--   listMealsBetween（报表页日期区间）
--
-- 无外键约束：owner_id 指向上层认证体系的用户，跨 schema，平台未建 FK。
-- 无触发器（updated_at 由前端维护）。
--
-- 自定义函数 2 个（V1.0.0 起，完整定义见 migrations/0003-atomic-ai-quota.sql）：
--   consume_ai_quota(date, text, integer, integer) → TABLE(allowed, used, remaining)
--   release_ai_quota(date, text, integer)          → integer
--   均为 SECURITY INVOKER（RLS 照常生效），owner_id 取 auth.uid()，
--   EXECUTE 已 REVOKE PUBLIC/anon，仅 GRANT 给 authenticated。
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- 2026-10-16 · migrations/0008-invite-honey.sql 新增（邀约 + 蜜糖积分 + 徽章）
--
-- 新增 3 张表（完整 DDL 见 migrations/0008）：
--   invite_links  邀约邀请码（owner_id UNIQUE + code UNIQUE，一人一码）
--   honey_ledger  蜜糖积分账本（流水式正负记账，余额=SUM(amount)；
--                 UNIQUE(owner_id, reason, ref_id) WHERE ref_id IS NOT NULL 防重复）
--   badges        成就徽章（UNIQUE(owner_id, badge_key) 防重复解锁）
--
-- profiles 加 2 列：
--   invited_by  text（邀请人 owner_id，partial unique 防一人被多次邀请）
--   invite_code text（新人填的码，审计用）
--
-- 新增 3 个函数：
--   get_inviter_by_code(text) → text   SECURITY DEFINER（绕过 RLS 按码查邀请人）
--   grant_honey(text,text,integer,integer) → boolean  SECURITY INVOKER（发积分，去重）
--   unlock_badge(text) → boolean       SECURITY INVOKER（解锁徽章，去重）
--   EXECUTE 均已 REVOKE PUBLIC/anon，仅 GRANT authenticated。
--
-- ══ 0009 邀请奖励闭环补齐（V1.3.0）═══════════════════════════════════════════
-- 新增 3 个 SECURITY DEFINER 函数（跨用户发积分必需）：
--   bind_invite(text) → text           绑定关系 + 双向发积分（新人100/邀请人50）
--                                      返回 ok/invalid/self/already
--   settle_invite_checkin() → boolean  受邀人7日打卡≥5天 → 新人200+7天Pro/邀请人250
--   count_invitees() → json            邀请记录统计（invitees + settled）
--   EXECUTE 均已 REVOKE PUBLIC/anon，仅 GRANT authenticated。
-- ════════════════════════════════════════════════════════════════════════════
--
-- ══ 0010 徽章统计快照（V1.4 优化）═════════════════════════════════════════════
--   badge_stats() → json  SECURITY DEFINER（一次返回 8 枚统计类徽章所需计数）
--   EXECUTE 已 REVOKE PUBLIC/anon，仅 GRANT authenticated。
--
-- ══ 0011 打卡积分删除收回 + 积分过期（V1.4 优化）═════════════════════════════
--   refund_checkin_honey_by_date(text) → boolean  SECURITY DEFINER
--       删除当日最后一条饮食记录后收回 checkin_meal 积分（防刷，幂等）
--   expire_stale_honey() → integer  SECURITY DEFINER
--       结算已过期入账（记 expire 负流水，幂等）
--   EXECUTE 均已 REVOKE PUBLIC/anon，仅 GRANT authenticated。
-- ════════════════════════════════════════════════════════════════════════════
--
-- ══ 0012 兑换码服务端化 + 邀请码风控（V1.4 优化）════════════════════════════
--   redeem_codes 表：兑换码服务端库存（前端不再硬编码，翻包拿不到终身会员）
--   invite_attempts 表：邀请码绑定尝试记录（节流用）
--   redeem_by_code(text) → text  SECURITY DEFINER（核销+发终身会员，ok/used/bad）
--   invite_throttled(text) → boolean  SECURITY DEFINER（60s 失败≥5 次限流）
--   EXECUTE 均已 REVOKE PUBLIC/anon，仅 GRANT authenticated。
-- ════════════════════════════════════════════════════════════════════════════
--
-- ══ 0013 积分体系安全加固（审计后修复，2026-10-16）════════════════════════
--   审计发现 4 个「幽灵函数」无版本化 SQL，导出真实 DDL 后确认最致命漏洞：
--     grant_honey 是 SECURITY INVOKER 且无入参校验，任何登录用户可 RPC 伪造
--     任意积分换终身会员。
--   本 migration 修复（均已云端执行）：
--     grant_photo_bonus 重写为 SECURITY DEFINER + source 白名单（newbie=3/
--                     streak7=2/honey=1）+ ttl 上限 7 天（复查补充发现的同类漏洞）
--     grant_honey     重写为 SECURITY DEFINER + reason 白名单 + 金额校验
--                     （checkin_meal=5/water=2/exercise=2/streak_milestone∈7档）
--     unlock_badge    重写为 SECURITY DEFINER + 12 枚 badge_key 白名单
--     redeem_honey    重写：ai1Scan 加单日上限 5 次（ref_id='ai-'+日期计数）
--     bind_invite     重写：接入 invite_throttled 节流 + 写 invite_attempts +
--                     邀请人月度返佣上限 3000（inviter_register 也计入）
--     settle_invite_checkin 重写：邀请人月度返佣上限 3000
--     refund_checkin_water_by_date / refund_checkin_exercise_by_date 新增：
--                     撤销饮水/删除运动后收回对应打卡积分（防刷）
--   ⚠️ 审计结论：grant_honey/redeem_honey/unlock_badge/get_inviter_by_code 此前
--      均为「云端手工创建、无版本化脚本」，本次已补全为 migration 0013。
-- ════════════════════════════════════════════════════════════════════════════
--
-- ══ 0014 拍照额度「预占 token」机制（堵 release_ai_quota 额度绕过）═════════
--   ai_quota_claims 表：consume 落 token（记录扣的是基础/奖励额度），release 凭 token
--     一次性精确退还。ENABLE+FORCE RLS + REVOKE authenticated（只经函数访问）。
--   consume_photo_quota 重写为 SECURITY DEFINER + 返回 token 列。
--   release_photo_quota(token) 新增：SECURITY DEFINER，凭 token 精确释放（扣奖励还奖励、
--     扣基础还基础），每个 token 只能退一次。
--   release_ai_quota 废弃：REVOKE authenticated（堵住「清零当日用量白嫖无限拍照」旧路径）。
-- ════════════════════════════════════════════════════════════════════════════
--
-- ══ 0015 权益/积分/额度表级直写通道封堵（P0-0 根因）════════════════════════
--   二次复查发现：honey_ledger/entitlements/quota_bonus/ai_usage/badges/invite_links
--   的 RLS policy 是 FOR ALL + 表级 GRANT authenticated 全权限 → 用户可绕过函数白名单
--   直接写表（直插积分、直改 lifetime、直插额度、直清用量）。函数白名单治标不治本。
--   修复：
--     consume_ai_quota / get_photo_quota 改 SECURITY DEFINER（避免被 REVOKE 误伤）。
--     表级 REVOKE authenticated 写权限：
--       honey_ledger / entitlements / ai_usage / badges → 仅保留 SELECT（读）
--       quota_bonus → 完全 REVOKE（前端走 get_photo_quota RPC）
--       invite_links → 保留 SELECT + INSERT（getMyInviteCode 创建邀请码）
--   前端：删除 saveEntitlement + activate（预留的支付回调直写 entitlements，真实支付
--     接入后由服务端回调写权益，不经前端 authenticated）。
-- ════════════════════════════════════════════════════════════════════════════
--
