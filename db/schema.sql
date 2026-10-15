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
-- plan：free / pro。pro_until 为过期时间；redeemed_code 记录兑换码来源。
-- 注意：当前**未接入真实支付**，仅兑换码解锁（备案合规要求，见 docs/备案材料清单.md）
CREATE TABLE public.entitlements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id       text        NOT NULL DEFAULT auth.uid() UNIQUE,
  plan           text        NOT NULL DEFAULT 'free',
  pro_until      timestamptz,
  redeemed_code  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
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
