-- ════════════════════════════════════════════════════════════════════════════
-- 0002 · 等价镜像：把云端 schema 还原到服务器本机 PostgreSQL
-- ════════════════════════════════════════════════════════════════════════════
--
-- 本文件由 db/gen-mirror-sql.py 自动生成，请勿手改数据段。
--
--   目标环境  150.158.51.106 · 数据库 dbee · PostgreSQL 17.11
--   结构来源  db/schema.sql（2026-10-13 从线上 WorkBuddy 云数据库反向导出的基线）
--   数据来源  db/backups/2026-10-13.json（快照时间 2026-10-13T17:31:28.90968+08:00）
--   执行方式  sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f <本文件>
--
-- 与云端的差异（有意为之，共 3 处）：
--   1. 平台内置的 auth.uid() 本机不存在 —— 用 auth schema + 兼容函数替代，
--      依次读取 app.user_id / request.jwt.claim.sub / request.jwt.claims->>'sub'。
--      应用侧可用 SET LOCAL app.user_id = '<用户ID>' 模拟登录态。
--   2. 平台角色 cloudbase_postgres_postgres_* / service_role 不存在 —— 只建
--      authenticated 与 anon（NOLOGIN，即参与权限模型的两个角色），
--      权限授予与云端 0001 收紧后的状态保持一致。
--   3. 表 owner 是本机 postgres 超级用户，而超级用户默认绕过 RLS ——
--      要验证行级隔离，须 `SET ROLE authenticated` 后再查（见文件末尾自检段）。
--
-- 本文件可重复执行（幂等）：建表 IF NOT EXISTS、策略先 DROP 再建、
-- 数据插入 ON CONFLICT DO NOTHING。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 阶段 1／结构 ────────────────────────────────────────────────────────────
BEGIN;

-- ① auth.uid() 兼容层：等价替代平台内置函数
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  v      text;
  claims text;
BEGIN
  -- 优先：本机直连时的显式会话变量（SET LOCAL app.user_id）
  v := nullif(current_setting('app.user_id', true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  -- 其次：Supabase 风格的单值 claim
  v := nullif(current_setting('request.jwt.claim.sub', true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  -- 最后：Supabase 风格的完整 claims JSON
  claims := nullif(current_setting('request.jwt.claims', true), '');
  IF claims IS NOT NULL THEN
    BEGIN
      RETURN claims::jsonb ->> 'sub';
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END IF;
  RETURN NULL;  -- 未登录：NULL，与平台行为一致（owner_id = NULL 永不匹配）
END;
$$;

COMMENT ON FUNCTION auth.uid() IS
  '本机等价替代平台内置 auth.uid()：app.user_id → request.jwt.claim.sub → request.jwt.claims->>sub';

-- ② 角色（平台角色的最小等价物，均不可登录）
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
      RAISE NOTICE '已创建角色 %', r;
    END IF;
  END LOOP;
END $$;

-- ③ 表结构（与 schema.sql 逐字一致）
CREATE TABLE IF NOT EXISTS public.profiles (
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

CREATE TABLE IF NOT EXISTS public.meal_entries (
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
  source         text        NOT NULL DEFAULT 'manual',
  image_url      text,
  ai_note        text,
  health_score   integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.weight_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  log_date    date        NOT NULL,
  weight_kg   numeric     NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, log_date)
);

CREATE TABLE IF NOT EXISTS public.water_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  log_date    date        NOT NULL,
  amount_ml   integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.exercise_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  log_date    date        NOT NULL,
  name        text        NOT NULL,
  minutes     integer     NOT NULL,
  calories    numeric     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.entitlements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id       text        NOT NULL DEFAULT auth.uid() UNIQUE,
  plan           text        NOT NULL DEFAULT 'free',
  pro_until      timestamptz,
  redeemed_code  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  usage_date  date        NOT NULL,
  feature     text        NOT NULL DEFAULT 'scan',
  count       integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, usage_date, feature)
);

-- ④ 索引：migrations/0001 新增的 3 个复合索引（PK/UNIQUE 已在表定义内）
CREATE INDEX IF NOT EXISTS meal_entries_owner_id_log_date_idx ON public.meal_entries (owner_id, log_date);
CREATE INDEX IF NOT EXISTS water_logs_owner_id_log_date_idx   ON public.water_logs  (owner_id, log_date);
CREATE INDEX IF NOT EXISTS exercise_logs_owner_id_log_date_idx ON public.exercise_logs (owner_id, log_date);

-- ⑤ 行级安全：7 张表全开
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weight_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercise_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage      ENABLE ROW LEVEL SECURITY;

-- ⑥ 策略：16 条，全部形如 owner_id = auth.uid()
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_delete_own ON public.profiles;
CREATE POLICY profiles_delete_own ON public.profiles FOR DELETE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS meal_entries_select_own ON public.meal_entries;
CREATE POLICY meal_entries_select_own ON public.meal_entries FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_insert_own ON public.meal_entries;
CREATE POLICY meal_entries_insert_own ON public.meal_entries FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_update_own ON public.meal_entries;
CREATE POLICY meal_entries_update_own ON public.meal_entries FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_delete_own ON public.meal_entries;
CREATE POLICY meal_entries_delete_own ON public.meal_entries FOR DELETE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS weight_logs_select_own ON public.weight_logs;
CREATE POLICY weight_logs_select_own ON public.weight_logs FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_insert_own ON public.weight_logs;
CREATE POLICY weight_logs_insert_own ON public.weight_logs FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_update_own ON public.weight_logs;
CREATE POLICY weight_logs_update_own ON public.weight_logs FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_delete_own ON public.weight_logs;
CREATE POLICY weight_logs_delete_own ON public.weight_logs FOR DELETE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS water_logs_own ON public.water_logs;
CREATE POLICY water_logs_own ON public.water_logs FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS exercise_logs_own ON public.exercise_logs;
CREATE POLICY exercise_logs_own ON public.exercise_logs FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS entitlements_own ON public.entitlements;
CREATE POLICY entitlements_own ON public.entitlements FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS ai_usage_own ON public.ai_usage;
CREATE POLICY ai_usage_own ON public.ai_usage FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- ⑦ 权限模型：与云端 0001 收紧后的状态逐项一致
--    authenticated：只保留 4 项 DML（7 表 × 4 = 28 行权限）
--      云端原本的 TRUNCATE / REFERENCES / TRIGGER 已被 0001 REVOKE，此处显式收敛
--    anon：无任何表权限 —— GRANT 层先行拒绝，未登录请求直接 42501
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA auth   TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.profiles, public.meal_entries, public.weight_logs, public.water_logs,
     public.exercise_logs, public.entitlements, public.ai_usage
  TO authenticated;

REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON public.profiles, public.meal_entries, public.weight_logs, public.water_logs,
     public.exercise_logs, public.entitlements, public.ai_usage
  FROM authenticated;

REVOKE ALL ON public.profiles, public.meal_entries, public.weight_logs,
              public.water_logs, public.exercise_logs, public.entitlements,
              public.ai_usage
  FROM anon;

COMMIT;

-- ── 阶段 2／数据 ────────────────────────────────────────────────────────────
-- 来源快照：db/backups/2026-10-13.json（2026-10-13T17:31:28.90968+08:00）
-- 用 jsonb_populate_recordset 逐字段填充：JSON 字符串 → 目标列类型由 PG 自行转换，
-- 避免手写 INSERT 时的转义与类型错误。空表跳过。
BEGIN;

-- profiles：3 行
INSERT INTO public.profiles
OVERRIDING SYSTEM VALUE
SELECT * FROM jsonb_populate_recordset(null::public.profiles, $j$[{"id":1,"owner_id":"2109837240191418368","nickname":null,"gender":"male","age":48,"height_cm":171,"start_weight_kg":55,"current_weight_kg":55,"target_weight_kg":60,"activity_level":"sedentary","goal":"gain","weekly_rate_kg":0.41,"daily_calorie_target":2114,"protein_target_g":83,"carb_target_g":313,"fat_target_g":59,"barriers":"管不住嘴,应酬喝酒,不爱运动","plan_summary":"{\"summary\":\"48岁偏瘦久坐，先靠吃和少酒稳增5公斤，别急着猛练。\",\"advice\":[\"今天每餐加一勺花生酱或一个鸡蛋，先吃够2114千卡。\",\"应酬只喝1瓶啤酒，其余换茶水，酒后补一杯牛奶。\",\"每天饭后快走10分钟，本周先做3次，不追求强度。\"]}","onboarded":true,"created_at":"2026-10-13T10:44:04.722544+08:00","updated_at":"2026-10-13T10:44:04.722544+08:00"},{"id":2,"owner_id":"2109869577155379200","nickname":null,"gender":"male","age":48,"height_cm":171,"start_weight_kg":55,"current_weight_kg":55,"target_weight_kg":60,"activity_level":"sedentary","goal":"gain","weekly_rate_kg":0.41,"daily_calorie_target":2114,"protein_target_g":83,"carb_target_g":313,"fat_target_g":59,"barriers":"管不住嘴,应酬喝酒,外卖吃太多,不爱运动,熬夜吃夜宵","plan_summary":null,"onboarded":true,"created_at":"2026-10-13T12:52:04.052729+08:00","updated_at":"2026-10-13T12:52:04.052729+08:00"},{"id":3,"owner_id":"2109870547356614656","nickname":null,"gender":"female","age":44,"height_cm":154,"start_weight_kg":56,"current_weight_kg":56,"target_weight_kg":55,"activity_level":"light","goal":"lose","weekly_rate_kg":0.42,"daily_calorie_target":1200,"protein_target_g":101,"carb_target_g":125,"fat_target_g":33,"barriers":"没时间做饭,情绪化进食,甜食奶茶难戒,反复反弹,不爱运动,外卖吃太多,熬夜吃夜宵,管不住嘴","plan_summary":null,"onboarded":true,"created_at":"2026-10-13T12:55:51.244024+08:00","updated_at":"2026-10-13T12:55:51.244024+08:00"}]$j$::jsonb)
ON CONFLICT DO NOTHING;

-- meal_entries：源库 0 行，跳过

-- weight_logs：源库 0 行，跳过

-- water_logs：3 行
INSERT INTO public.water_logs
OVERRIDING SYSTEM VALUE
SELECT * FROM jsonb_populate_recordset(null::public.water_logs, $j$[{"id":1,"owner_id":"2109869577155379200","log_date":"2026-10-13","amount_ml":250,"created_at":"2026-10-13T16:29:15.122698+08:00"},{"id":2,"owner_id":"2109869577155379200","log_date":"2026-10-13","amount_ml":500,"created_at":"2026-10-13T16:29:16.028817+08:00"},{"id":3,"owner_id":"2109869577155379200","log_date":"2026-10-13","amount_ml":500,"created_at":"2026-10-13T16:29:26.528456+08:00"}]$j$::jsonb)
ON CONFLICT DO NOTHING;

-- exercise_logs：源库 0 行，跳过

-- entitlements：源库 0 行，跳过

-- ai_usage：源库 0 行，跳过

-- 同步 IDENTITY 序列：显式写入过 id，必须 setval 否则后续自增撞主键
SELECT setval(pg_get_serial_sequence('public.profiles',      'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.profiles;
SELECT setval(pg_get_serial_sequence('public.meal_entries',  'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.meal_entries;
SELECT setval(pg_get_serial_sequence('public.weight_logs',   'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.weight_logs;
SELECT setval(pg_get_serial_sequence('public.water_logs',    'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.water_logs;
SELECT setval(pg_get_serial_sequence('public.exercise_logs', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.exercise_logs;
SELECT setval(pg_get_serial_sequence('public.entitlements',  'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.entitlements;
SELECT setval(pg_get_serial_sequence('public.ai_usage',      'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.ai_usage;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- 执行后自检（本文件不含，需另行执行）：
--
--   表数量      7
--   索引数量    14（7 个 PK + 4 个 UNIQUE + migrations/0001 的 3 个复合索引）
--   策略数量    16
--   RLS 已启用  7
--
--   行级隔离验证（超级用户绕过 RLS，必须切角色）：
--     SET ROLE authenticated;
--     SET app.user_id = '2109837240191418368';
--     SELECT count(*) FROM public.profiles;   -- 期望 1（只看得到自己那一行）
--     SET app.user_id = '0000000000000000000';
--     SELECT count(*) FROM public.profiles;   -- 期望 0
--     RESET ROLE;
-- ════════════════════════════════════════════════════════════════════════════
