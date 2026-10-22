-- ════════════════════════════════════════════════════════════════════════════
-- 0030 · 自托管完整镜像：17 张表 + 业务函数 + RLS + 权限 + 全量数据
-- ════════════════════════════════════════════════════════════════════════════
-- 数据来源：WorkBuddy 云数据库实时导出（2026-10-20 21:00，含 10-18 后增量）
-- 目标环境：150.158.51.106 · dbee 库 · PostgreSQL 17.11
-- 执行方式：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f <本文件>
-- 幂等：可重复执行。
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ① auth.uid() 兼容层
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  v      text;
  claims text;
BEGIN
  v := nullif(current_setting('app.user_id', true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  v := nullif(current_setting('request.jwt.claim.sub', true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  claims := nullif(current_setting('request.jwt.claims', true), '');
  IF claims IS NOT NULL THEN
    BEGIN
      RETURN claims::jsonb ->> 'sub';
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END IF;
  RETURN NULL;
END;
$$;

-- ② 角色
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;


CREATE TABLE IF NOT EXISTS public.profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  nickname text,
  gender text,
  age integer,
  height_cm numeric,
  start_weight_kg numeric,
  current_weight_kg numeric,
  target_weight_kg numeric,
  activity_level text,
  goal text,
  weekly_rate_kg numeric,
  daily_calorie_target integer,
  protein_target_g integer,
  carb_target_g integer,
  fat_target_g integer,
  barriers text,
  plan_summary text,
  onboarded boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  invited_by text,
  invite_code text,
  invited_at timestamptz,
  health_connected_at timestamptz,
  health_connected boolean,
  step_goal integer,
  ai_consented boolean,
  CONSTRAINT profiles_owner_id_key UNIQUE (owner_id)
);

CREATE TABLE IF NOT EXISTS public.meal_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  log_date date NOT NULL,
  meal_type text NOT NULL,
  food_name text NOT NULL,
  quantity_text text,
  grams numeric,
  calories numeric NOT NULL,
  protein_g numeric DEFAULT 0,
  carb_g numeric DEFAULT 0,
  fat_g numeric DEFAULT 0,
  source text DEFAULT 'manual'::text NOT NULL,
  image_url text,
  ai_note text,
  health_score integer,
  created_at timestamptz DEFAULT now() NOT NULL,
  sodium_mg numeric,
  fiber_g numeric,
  added_sugar_g numeric
);

CREATE TABLE IF NOT EXISTS public.weight_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  log_date date NOT NULL,
  weight_kg numeric NOT NULL,
  note text,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT weight_logs_owner_id_log_date_key UNIQUE (owner_id, log_date)
);

CREATE TABLE IF NOT EXISTS public.water_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  log_date date NOT NULL,
  amount_ml integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.exercise_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  log_date date NOT NULL,
  name text NOT NULL,
  minutes integer NOT NULL,
  calories numeric DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.entitlements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  plan text DEFAULT 'free'::text NOT NULL,
  pro_until timestamptz,
  redeemed_code text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  source text,
  CONSTRAINT entitlements_owner_id_key UNIQUE (owner_id)
);

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  usage_date date NOT NULL,
  feature text DEFAULT 'scan'::text NOT NULL,
  count integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT ai_usage_owner_id_usage_date_feature_key UNIQUE (owner_id, usage_date, feature)
);

CREATE TABLE IF NOT EXISTS public.badges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  badge_key text NOT NULL,
  unlocked_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT badges_owner_id_badge_key_key UNIQUE (owner_id, badge_key)
);

CREATE TABLE IF NOT EXISTS public.honey_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  amount integer NOT NULL,
  reason text NOT NULL,
  ref_id text,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.invite_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  code text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT invite_links_code_key UNIQUE (code),
  CONSTRAINT invite_links_owner_id_key UNIQUE (owner_id)
);

CREATE TABLE IF NOT EXISTS public.invite_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL,
  code text NOT NULL,
  ok boolean NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payment_products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id text NOT NULL,
  plan text NOT NULL,
  months integer,
  amount_cents integer NOT NULL,
  currency text DEFAULT 'CNY'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT payment_products_product_id_key UNIQUE (product_id)
);

CREATE TABLE IF NOT EXISTS public.payment_orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  order_no text NOT NULL,
  provider text NOT NULL,
  product_id text NOT NULL,
  plan text NOT NULL,
  months integer,
  amount_cents integer NOT NULL,
  currency text DEFAULT 'CNY'::text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  provider_txn_id text,
  receipt_payload text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT payment_orders_order_no_key UNIQUE (order_no)
);

CREATE TABLE IF NOT EXISTS public.quota_bonus (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  source text NOT NULL,
  grant_key text NOT NULL,
  amount integer DEFAULT 0 NOT NULL,
  consumed integer DEFAULT 0 NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT quota_bonus_owner_id_source_grant_key_key UNIQUE (owner_id, source, grant_key)
);

CREATE TABLE IF NOT EXISTS public.recipes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  name text NOT NULL,
  items jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.redeem_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL,
  note text,
  used_by text,
  used_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT redeem_codes_code_key UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS public.ai_quota_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text DEFAULT auth.uid() NOT NULL,
  token text NOT NULL,
  feature text NOT NULL,
  usage_date date NOT NULL,
  bonus_id bigint,
  amount integer DEFAULT 1 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  released_at timestamptz,
  CONSTRAINT ai_quota_claims_token_key UNIQUE (token)
);

-- 补列（兼容 0002 旧结构）
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nickname text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS age integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS height_cm numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS start_weight_kg numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS current_weight_kg numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS target_weight_kg numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS activity_level text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS goal text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS weekly_rate_kg numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS daily_calorie_target integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS protein_target_g integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS carb_target_g integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS fat_target_g integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS barriers text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS plan_summary text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarded boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS invited_by text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS health_connected_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS health_connected boolean;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS step_goal integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ai_consented boolean;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS log_date date;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS meal_type text;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS food_name text;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS quantity_text text;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS grams numeric;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS calories numeric;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS protein_g numeric DEFAULT 0;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS carb_g numeric DEFAULT 0;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS fat_g numeric DEFAULT 0;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual'::text;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS ai_note text;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS health_score integer;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS sodium_mg numeric;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS fiber_g numeric;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS added_sugar_g numeric;
ALTER TABLE public.weight_logs ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.weight_logs ADD COLUMN IF NOT EXISTS log_date date;
ALTER TABLE public.weight_logs ADD COLUMN IF NOT EXISTS weight_kg numeric;
ALTER TABLE public.weight_logs ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.weight_logs ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.water_logs ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.water_logs ADD COLUMN IF NOT EXISTS log_date date;
ALTER TABLE public.water_logs ADD COLUMN IF NOT EXISTS amount_ml integer;
ALTER TABLE public.water_logs ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.exercise_logs ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.exercise_logs ADD COLUMN IF NOT EXISTS log_date date;
ALTER TABLE public.exercise_logs ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.exercise_logs ADD COLUMN IF NOT EXISTS minutes integer;
ALTER TABLE public.exercise_logs ADD COLUMN IF NOT EXISTS calories numeric DEFAULT 0;
ALTER TABLE public.exercise_logs ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free'::text;
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS pro_until timestamptz;
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS redeemed_code text;
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS usage_date date;
ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS feature text DEFAULT 'scan'::text;
ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS count integer DEFAULT 0;
ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.badges ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.badges ADD COLUMN IF NOT EXISTS badge_key text;
ALTER TABLE public.badges ADD COLUMN IF NOT EXISTS unlocked_at timestamptz DEFAULT now();
ALTER TABLE public.honey_ledger ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.honey_ledger ADD COLUMN IF NOT EXISTS amount integer;
ALTER TABLE public.honey_ledger ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.honey_ledger ADD COLUMN IF NOT EXISTS ref_id text;
ALTER TABLE public.honey_ledger ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.honey_ledger ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.invite_links ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.invite_links ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.invite_links ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.invite_attempts ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE public.invite_attempts ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.invite_attempts ADD COLUMN IF NOT EXISTS ok boolean;
ALTER TABLE public.invite_attempts ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS months integer;
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS amount_cents integer;
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS currency text DEFAULT 'CNY'::text;
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.payment_products ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS order_no text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS months integer;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS amount_cents integer;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS currency text DEFAULT 'CNY'::text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending'::text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS provider_txn_id text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS receipt_payload text;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS grant_key text;
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS amount integer DEFAULT 0;
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS consumed integer DEFAULT 0;
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.quota_bonus ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS items jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.redeem_codes ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.redeem_codes ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.redeem_codes ADD COLUMN IF NOT EXISTS used_by text;
ALTER TABLE public.redeem_codes ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE public.redeem_codes ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS owner_id text DEFAULT auth.uid();
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS feature text;
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS usage_date date;
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS bonus_id bigint;
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS amount integer DEFAULT 1;
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS released_at timestamptz;

-- 索引
CREATE INDEX IF NOT EXISTS meal_entries_owner_id_log_date_idx ON public.meal_entries (owner_id, log_date);
CREATE INDEX IF NOT EXISTS water_logs_owner_id_log_date_idx ON public.water_logs (owner_id, log_date);
CREATE INDEX IF NOT EXISTS exercise_logs_owner_id_log_date_idx ON public.exercise_logs (owner_id, log_date);
CREATE INDEX IF NOT EXISTS ai_quota_claims_owner_created ON public.ai_quota_claims (owner_id, created_at);
CREATE INDEX IF NOT EXISTS honey_ledger_owner_date ON public.honey_ledger (owner_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS honey_ledger_once ON public.honey_ledger (owner_id, reason, ref_id) WHERE (ref_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS invite_attempts_owner_id_created_at_idx ON public.invite_attempts (owner_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_invited_once ON public.profiles (owner_id) WHERE (invited_by IS NOT NULL);

-- 行级安全
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weight_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercise_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.honey_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_bonus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redeem_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quota_claims ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS profiles_delete_own ON public.profiles;
CREATE POLICY profiles_delete_own ON public.profiles FOR DELETE USING (owner_id = auth.uid());
-- meal_entries
DROP POLICY IF EXISTS meal_entries_select_own ON public.meal_entries;
CREATE POLICY meal_entries_select_own ON public.meal_entries FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_insert_own ON public.meal_entries;
CREATE POLICY meal_entries_insert_own ON public.meal_entries FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_update_own ON public.meal_entries;
CREATE POLICY meal_entries_update_own ON public.meal_entries FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS meal_entries_delete_own ON public.meal_entries;
CREATE POLICY meal_entries_delete_own ON public.meal_entries FOR DELETE USING (owner_id = auth.uid());
-- weight_logs
DROP POLICY IF EXISTS weight_logs_select_own ON public.weight_logs;
CREATE POLICY weight_logs_select_own ON public.weight_logs FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_insert_own ON public.weight_logs;
CREATE POLICY weight_logs_insert_own ON public.weight_logs FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_update_own ON public.weight_logs;
CREATE POLICY weight_logs_update_own ON public.weight_logs FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS weight_logs_delete_own ON public.weight_logs;
CREATE POLICY weight_logs_delete_own ON public.weight_logs FOR DELETE USING (owner_id = auth.uid());
-- water_logs
DROP POLICY IF EXISTS water_logs_own ON public.water_logs;
CREATE POLICY water_logs_own ON public.water_logs FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- exercise_logs
DROP POLICY IF EXISTS exercise_logs_own ON public.exercise_logs;
CREATE POLICY exercise_logs_own ON public.exercise_logs FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- entitlements
DROP POLICY IF EXISTS entitlements_own ON public.entitlements;
CREATE POLICY entitlements_own ON public.entitlements FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- ai_usage
DROP POLICY IF EXISTS ai_usage_own ON public.ai_usage;
CREATE POLICY ai_usage_own ON public.ai_usage FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- badges
DROP POLICY IF EXISTS badges_own ON public.badges;
CREATE POLICY badges_own ON public.badges FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- honey_ledger
DROP POLICY IF EXISTS honey_ledger_own ON public.honey_ledger;
CREATE POLICY honey_ledger_own ON public.honey_ledger FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- invite_links
DROP POLICY IF EXISTS invite_links_own ON public.invite_links;
CREATE POLICY invite_links_own ON public.invite_links FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- quota_bonus
DROP POLICY IF EXISTS quota_bonus_own ON public.quota_bonus;
CREATE POLICY quota_bonus_own ON public.quota_bonus FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- recipes
DROP POLICY IF EXISTS recipes_select_own ON public.recipes;
CREATE POLICY recipes_select_own ON public.recipes FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_insert_own ON public.recipes;
CREATE POLICY recipes_insert_own ON public.recipes FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_update_own ON public.recipes;
CREATE POLICY recipes_update_own ON public.recipes FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_delete_own ON public.recipes;
CREATE POLICY recipes_delete_own ON public.recipes FOR DELETE USING (owner_id = auth.uid());

-- 表权限（authenticated）
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meal_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weight_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exercise_logs TO authenticated;
GRANT SELECT ON public.entitlements TO authenticated;
GRANT SELECT ON public.ai_usage TO authenticated;
GRANT SELECT ON public.badges TO authenticated;
GRANT SELECT ON public.honey_ledger TO authenticated;
GRANT SELECT, INSERT ON public.invite_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipes TO authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

COMMIT;

-- ════════════ 业务函数（SECURITY DEFINER）════════════
BEGIN;
-- 业务函数完整 DDL（云库 pg_get_functiondef 实时导出，2026-10-20 21:00）
-- 全部 SECURITY DEFINER + SET search_path TO 'public'（权益/积分/额度核心逻辑）

CREATE OR REPLACE FUNCTION public._lb_compute_streak(p_days text[], p_today date)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_cursor date;
  v_n      integer := 0;
BEGIN
  IF p_days IS NULL OR array_length(p_days, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF p_today::text = ANY(p_days) THEN
    v_cursor := p_today;
  ELSE
    v_cursor := p_today - 1;
  END IF;
  LOOP
    EXIT WHEN NOT (v_cursor::text = ANY(p_days));
    v_n := v_n + 1;
    v_cursor := v_cursor - 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public._lb_mask_name(nickname text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN nickname IS NULL OR btrim(nickname) = '' THEN '蜂友*'
    ELSE left(btrim(nickname), 1) || '*'
  END
$function$;

CREATE OR REPLACE FUNCTION public.badge_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_photo int;
  v_barcode int;
  v_recipe int;
  v_water int;
  v_exercise int;
  v_lost numeric;
  v_invitees int;
  v_settled int;
  v_water_target numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;
  SELECT COUNT(*) FILTER (WHERE source = 'photo'), COUNT(*) FILTER (WHERE source = 'barcode')
  INTO v_photo, v_barcode FROM meal_entries WHERE owner_id = v_uid;
  SELECT COUNT(*) INTO v_recipe FROM recipes WHERE owner_id = v_uid;
  SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_water_target FROM profiles WHERE owner_id = v_uid;
  v_water_target := COALESCE(v_water_target, 2100);
  SELECT COUNT(*) INTO v_water FROM (
    SELECT log_date FROM water_logs WHERE owner_id = v_uid GROUP BY log_date HAVING SUM(amount_ml) >= v_water_target
  ) t;
  SELECT COUNT(*) INTO v_exercise FROM exercise_logs WHERE owner_id = v_uid;
  IF (SELECT goal FROM profiles WHERE owner_id = v_uid) = 'lose' THEN
    SELECT COALESCE(
      (SELECT start_weight_kg FROM profiles WHERE owner_id = v_uid), 0
    ) - COALESCE(
      (SELECT weight_kg FROM weight_logs WHERE owner_id = v_uid ORDER BY log_date DESC, id DESC LIMIT 1),
      (SELECT current_weight_kg FROM profiles WHERE owner_id = v_uid), 0
    ) INTO v_lost;
  ELSE
    v_lost := 0;
  END IF;
  SELECT COUNT(*) INTO v_invitees FROM profiles WHERE invited_by = v_uid;
  SELECT COUNT(*) INTO v_settled FROM honey_ledger WHERE owner_id = v_uid AND reason = 'inviter_checkin' AND amount > 0;
  RETURN json_build_object(
    'photo_count', COALESCE(v_photo, 0), 'barcode_count', COALESCE(v_barcode, 0),
    'recipe_count', COALESCE(v_recipe, 0), 'water_days', COALESCE(v_water, 0),
    'exercise_count', COALESCE(v_exercise, 0), 'weight_lost', COALESCE(v_lost, 0),
    'invitees', COALESCE(v_invitees, 0), 'invite_settled', COALESCE(v_settled, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bind_invite(p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          text := auth.uid();
  v_inviter      text;
  v_already      text;
  v_norm         text;
  v_month_honey  integer;
  v_profile_row  public.profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN 'invalid'; END IF;
  IF (SELECT public.invite_throttled(v_uid)) THEN RETURN 'throttled'; END IF;
  v_norm := upper(trim(coalesce(p_code, '')));
  IF v_norm = '' THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, '', false);
    RETURN 'invalid';
  END IF;
  SELECT invited_by INTO v_already FROM profiles WHERE owner_id = v_uid;
  IF v_already IS NOT NULL THEN RETURN 'already'; END IF;
  SELECT owner_id INTO v_inviter FROM invite_links WHERE code = v_norm LIMIT 1;
  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN CASE WHEN v_inviter = v_uid THEN 'self' ELSE 'invalid' END;
  END IF;
  INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, true);
  SELECT * INTO v_profile_row FROM public.profiles WHERE owner_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO public.profiles (owner_id, invited_by, invite_code, invited_at)
    VALUES (v_uid, v_inviter, v_norm, now());
  ELSE
    UPDATE public.profiles SET invited_by = v_inviter, invite_code = v_norm, invited_at = now(), updated_at = now()
    WHERE owner_id = v_uid;
  END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 100, 'invitee_register', 'bind-' || v_inviter, now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey FROM honey_ledger
   WHERE owner_id = v_inviter AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 50 <= 3000 THEN
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_inviter, 50, 'inviter_register', 'invitee-' || v_uid, now() + make_interval(days => 365))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_usage_date date, p_feature text, p_limit integer, p_amount integer DEFAULT 1)
 RETURNS TABLE(allowed boolean, used integer, remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
  v_inserted boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT false, 0, 0; RETURN; END IF;
  IF v_date IS NULL THEN v_date := v_today; ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;
  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, p_feature, GREATEST(p_amount, 1))
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING RETURNING true INTO v_inserted;
  IF v_inserted THEN RETURN QUERY SELECT true, GREATEST(p_amount, 1), GREATEST(p_limit - GREATEST(p_amount, 1), 0); RETURN; END IF;
  UPDATE ai_usage SET count = ai_usage.count + GREATEST(p_amount, 1)
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date AND ai_usage.feature = p_feature
     AND ai_usage.count + GREATEST(p_amount, 1) <= p_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = p_feature;
    RETURN QUERY SELECT false, COALESCE(v_count, p_limit), 0; RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, GREATEST(p_limit - v_count, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_photo_quota(p_usage_date date, p_base_limit integer DEFAULT 3)
 RETURNS TABLE(allowed boolean, used integer, remaining integer, token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_bonus_id bigint;
  v_base_used integer;
  v_token text;
  v_inserted boolean;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT false, 0, 0, NULL::text; RETURN; END IF;
  IF v_date IS NULL THEN v_date := v_today; ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;
  SELECT id INTO v_bonus_id FROM quota_bonus WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now() ORDER BY expires_at ASC LIMIT 1 FOR UPDATE;
  IF v_bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = consumed + 1 WHERE id = v_bonus_id;
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount) VALUES (auth.uid(), v_token, 'scan', v_date, v_bonus_id, 1);
    SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage WHERE owner_id = auth.uid() AND usage_date = v_date AND feature = 'scan';
    RETURN QUERY SELECT true, v_base_used, GREATEST(p_base_limit - v_base_used, 0), v_token; RETURN;
  END IF;
  INSERT INTO ai_usage (owner_id, usage_date, feature, count) VALUES (auth.uid(), v_date, 'scan', 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING RETURNING true INTO v_inserted;
  IF v_inserted THEN
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount) VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
    RETURN QUERY SELECT true, 1, GREATEST(p_base_limit - 1, 0), v_token; RETURN;
  END IF;
  UPDATE ai_usage SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date AND ai_usage.feature = 'scan'
     AND ai_usage.count + 1 <= p_base_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = 'scan';
    RETURN QUERY SELECT false, COALESCE(v_count, p_base_limit), 0, NULL::text; RETURN;
  END IF;
  v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
  INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount) VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
  RETURN QUERY SELECT true, v_count, GREATEST(p_base_limit - v_count, 0), v_token;
END;
$function$;

CREATE OR REPLACE FUNCTION public.count_invitees()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object('invitees', (SELECT count(*) FROM profiles WHERE invited_by = auth.uid()),
    'settled', (SELECT count(*) FROM honey_ledger hl WHERE hl.owner_id = auth.uid() AND hl.reason = 'inviter_checkin'))
$function$;

CREATE OR REPLACE FUNCTION public.create_payment_order(p_product_id text, p_provider text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_prod payment_products%ROWTYPE;
  v_order_no text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN json_build_object('error', 'not_authenticated'); END IF;
  SELECT * INTO v_prod FROM payment_products WHERE product_id = p_product_id AND active = true;
  IF NOT FOUND THEN RETURN json_build_object('error', 'invalid_product'); END IF;
  v_order_no := 'PO' || to_char(now(), 'YYYYMMDDHH24MISSMS') || floor(random() * 900 + 100)::text;
  INSERT INTO payment_orders (owner_id, order_no, provider, product_id, plan, months, amount_cents, currency)
  VALUES (v_uid, v_order_no, p_provider, p_product_id, v_prod.plan, v_prod.months, v_prod.amount_cents, v_prod.currency);
  RETURN json_build_object('order_no', v_order_no, 'product_id', p_product_id, 'plan', v_prod.plan,
    'months', v_prod.months, 'amount_cents', v_prod.amount_cents, 'currency', v_prod.currency);
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_honey()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_count integer := 0;
  r record;
BEGIN
  IF v_uid IS NULL THEN RETURN 0; END IF;
  FOR r IN
    SELECT id, amount FROM honey_ledger
    WHERE owner_id = v_uid AND amount > 0 AND expires_at IS NOT NULL AND expires_at <= now()
      AND NOT EXISTS (SELECT 1 FROM honey_ledger e WHERE e.owner_id = v_uid AND e.reason = 'expire' AND e.ref_id = 'exp:' || honey_ledger.id)
  LOOP
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -r.amount, 'expire', 'exp:' || r.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_inviter_by_code(p_code text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT owner_id FROM invite_links WHERE code = upper(trim(p_code)) LIMIT 1 $function$;

CREATE OR REPLACE FUNCTION public.get_photo_quota(p_base_limit integer DEFAULT 3)
 RETURNS TABLE(base_remaining integer, bonus_remaining integer, total_remaining integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_base_used integer;
  v_bonus integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT 0, 0, 0; RETURN; END IF;
  SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage WHERE owner_id = auth.uid() AND usage_date = v_today AND feature = 'scan';
  SELECT COALESCE(SUM(amount - consumed), 0) INTO v_bonus FROM quota_bonus WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now();
  base_remaining := GREATEST(p_base_limit - v_base_used, 0);
  bonus_remaining := GREATEST(v_bonus, 0);
  total_remaining := base_remaining + bonus_remaining;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_today_photo_count()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::integer FROM ai_quota_claims
   WHERE owner_id = auth.uid() AND usage_date = (now() AT TIME ZONE 'Asia/Shanghai')::date AND released_at IS NULL
$function$;

CREATE OR REPLACE FUNCTION public.grant_honey(p_reason text, p_ref_id text, p_amount integer, p_ttl_days integer DEFAULT 365)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_ok boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN RETURN false; END IF;
  IF p_reason = 'checkin_meal' THEN v_ok := p_amount = 5;
  ELSIF p_reason = 'checkin_water' THEN v_ok := p_amount = 2;
  ELSIF p_reason = 'checkin_exercise' THEN v_ok := p_amount = 2;
  ELSIF p_reason = 'streak_milestone' THEN v_ok := p_amount IN (15, 40, 80, 120, 200, 400, 800);
  ELSE v_ok := false; END IF;
  IF NOT v_ok THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, p_amount, p_reason, p_ref_id, now() + make_interval(days => GREATEST(p_ttl_days, 1)))
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.grant_photo_bonus(p_source text, p_grant_key text, p_amount integer, p_ttl_days integer DEFAULT 7)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_ok boolean := false;
  v_max_ttl integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_grant_key IS NULL OR btrim(p_grant_key) = '' THEN RETURN false; END IF;
  IF p_source = 'newbie' THEN v_ok := p_amount = 3; v_max_ttl := 7;
  ELSIF p_source = 'streak7' THEN v_ok := p_amount = 2; v_max_ttl := 7;
  ELSIF p_source = 'honey' THEN v_ok := p_amount = 1; v_max_ttl := 7;
  ELSE v_ok := false; END IF;
  IF NOT v_ok THEN RETURN false; END IF;
  IF p_ttl_days > v_max_ttl THEN RETURN false; END IF;
  INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
  VALUES (v_uid, p_source, p_grant_key, p_amount, 0, now() + make_interval(days => p_ttl_days))
  ON CONFLICT (owner_id, source, grant_key) DO NOTHING;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.invite_throttled(p_owner text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fail integer;
BEGIN
  SELECT count(*) INTO v_fail FROM invite_attempts WHERE owner_id = p_owner AND ok = false AND created_at > now() - interval '60 seconds';
  RETURN v_fail >= 5;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leaderboard()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_my_streak integer := 0;
  v_my_invites integer := 0;
  v_disc_json json;
  v_inv_json json;
  v_streak_arr json[] := ARRAY[]::json[];
  v_inv_arr json[] := ARRAY[]::json[];
  v_s integer;
  r record;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN json_build_object('error', 'not_authenticated'); END IF;
  SELECT public._lb_compute_streak((SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text) FROM meal_entries WHERE owner_id = v_uid), v_today) INTO v_my_streak;
  SELECT count(*) INTO v_my_invites FROM profiles WHERE invited_by = v_uid AND invited_at >= v_month_start;
  FOR r IN
    SELECT m.owner_id AS uid, array_agg(DISTINCT m.log_date::text ORDER BY m.log_date::text) AS days, p.nickname AS nick
    FROM meal_entries m JOIN profiles p ON p.owner_id = m.owner_id GROUP BY m.owner_id, p.nickname
  LOOP
    v_s := public._lb_compute_streak(r.days, v_today);
    IF v_s >= 3 THEN
      v_streak_arr := v_streak_arr || json_build_object('name', public._lb_mask_name(r.nick), 'streak', v_s)::json;
    END IF;
  END LOOP;
  FOR r IN
    SELECT p.nickname AS nick, count(*) AS cnt FROM profiles p JOIN profiles invited ON invited.invited_by = p.owner_id
    WHERE invited.invited_at >= v_month_start GROUP BY p.owner_id, p.nickname
  LOOP
    v_inv_arr := v_inv_arr || json_build_object('name', public._lb_mask_name(r.nick), 'invites', r.cnt::int)::json;
  END LOOP;
  SELECT COALESCE(json_agg(e ORDER BY (e->>'streak')::int DESC), '[]'::json) INTO v_disc_json FROM unnest(v_streak_arr) AS e LIMIT 50;
  SELECT COALESCE(json_agg(e ORDER BY (e->>'invites')::int DESC), '[]'::json) INTO v_inv_json FROM unnest(v_inv_arr) AS e LIMIT 50;
  RETURN json_build_object('self_discipline', COALESCE(v_disc_json, '[]'::json), 'invite', COALESCE(v_inv_json, '[]'::json),
    'my', json_build_object('streak', v_my_streak, 'invites', v_my_invites));
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_by_code(p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_norm text;
  v_row redeem_codes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN 'bad'; END IF;
  v_norm := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  IF v_norm = '' THEN RETURN 'bad'; END IF;
  SELECT * INTO v_row FROM redeem_codes WHERE code = v_norm;
  IF NOT FOUND THEN RETURN 'bad'; END IF;
  IF v_row.used_by IS NOT NULL THEN RETURN 'used'; END IF;
  UPDATE redeem_codes SET used_by = v_uid, used_at = now() WHERE id = v_row.id AND used_by IS NULL;
  IF NOT FOUND THEN RETURN 'used'; END IF;
  INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
  VALUES (v_uid, 'lifetime', NULL, v_norm, 'redeem')
  ON CONFLICT (owner_id) DO UPDATE SET plan = 'lifetime', pro_until = NULL, redeemed_code = v_norm, source = 'redeem', updated_at = now();
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_honey(p_kind text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cost integer;
  v_days integer;
  v_uid text := auth.uid();
  v_balance integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_today text;
  v_ai_today integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_kind = 'pro1Day' THEN v_cost := 100; v_days := 1;
  ELSIF p_kind = 'pro30Day' THEN v_cost := 2600; v_days := 30;
  ELSIF p_kind = 'ai1Scan' THEN v_cost := 50; v_days := 0;
  ELSE RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_balance FROM honey_ledger WHERE owner_id = v_uid AND (expires_at IS NULL OR expires_at > now());
  IF v_balance < v_cost THEN RETURN false; END IF;
  IF p_kind = 'ai1Scan' THEN
    v_today := to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD');
    SELECT count(*) INTO v_ai_today FROM honey_ledger WHERE owner_id = v_uid AND reason = 'redeem' AND ref_id LIKE 'ai-' || v_today || '%' AND amount < 0;
    IF v_ai_today >= 2 THEN RETURN false; END IF;
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_uid, -v_cost, 'redeem', 'ai-' || v_today || '-' || to_char(clock_timestamp(), 'HH24MISSMS'), NULL);
    INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
    VALUES (v_uid, 'honey', 'redeem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 1, 0, now() + make_interval(days => 7));
    RETURN true;
  END IF;
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan = 'lifetime' THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at) VALUES (v_uid, -v_cost, 'redeem', NULL, NULL);
  IF v_ent IS NULL THEN
    INSERT INTO entitlements (owner_id, plan, pro_until, source) VALUES (v_uid, 'pro', now() + make_interval(days => v_days), 'honey');
  ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
    UPDATE entitlements SET pro_until = v_until + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  ELSE
    UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_checkin_exercise_by_date(p_log_date text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid text := auth.uid(); v_count integer; v_granted integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN RETURN false; END IF;
  SELECT count(*) INTO v_count FROM exercise_logs WHERE owner_id = v_uid AND log_date = p_log_date;
  IF v_count > 0 THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_granted FROM honey_ledger WHERE owner_id = v_uid AND reason = 'checkin_exercise' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN RETURN false; END IF;
  PERFORM 1 FROM honey_ledger WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'exercise:' || p_log_date;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -v_granted, 'refund', 'exercise:' || p_log_date);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_checkin_honey_by_date(p_log_date text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_others integer;
  v_granted integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN RETURN false; END IF;
  SELECT count(*) INTO v_others FROM meal_entries WHERE owner_id = v_uid AND log_date = p_log_date;
  IF v_others > 0 THEN RETURN false; END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_granted FROM honey_ledger WHERE owner_id = v_uid AND reason = 'checkin_meal' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN RETURN false; END IF;
  PERFORM 1 FROM honey_ledger WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'meal:' || p_log_date;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -v_granted, 'refund', 'meal:' || p_log_date);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_checkin_water_by_date(p_log_date text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid text := auth.uid(); v_total integer; v_target numeric; v_granted integer;
BEGIN
  IF v_uid IS NULL OR p_log_date IS NULL THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount_ml), 0) INTO v_total FROM water_logs WHERE owner_id = v_uid AND log_date = p_log_date;
  SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_target FROM profiles WHERE owner_id = v_uid;
  v_target := COALESCE(v_target, 2100);
  IF v_total >= v_target THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_granted FROM honey_ledger WHERE owner_id = v_uid AND reason = 'checkin_water' AND ref_id = p_log_date;
  IF v_granted <= 0 THEN RETURN false; END IF;
  PERFORM 1 FROM honey_ledger WHERE owner_id = v_uid AND reason = 'refund' AND ref_id = 'water:' || p_log_date;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id) VALUES (v_uid, -v_granted, 'refund', 'water:' || p_log_date);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_ai_quota(p_usage_date date, p_feature text, p_amount integer DEFAULT 1)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date date := p_usage_date;
  v_count integer;
BEGIN
  IF v_date IS NULL THEN v_date := v_today; ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;
  UPDATE ai_usage SET count = GREATEST(ai_usage.count - GREATEST(p_amount, 1), 0)
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date AND ai_usage.feature = p_feature
  RETURNING ai_usage.count INTO v_count;
  RETURN COALESCE(v_count, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_photo_quota(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_claim ai_quota_claims%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' OR p_token IS NULL OR btrim(p_token) = '' THEN RETURN false; END IF;
  SELECT * INTO v_claim FROM ai_quota_claims WHERE token = p_token AND owner_id = v_uid AND released_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE ai_quota_claims SET released_at = now() WHERE id = v_claim.id AND released_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_claim.bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = GREATEST(consumed - v_claim.amount, 0) WHERE id = v_claim.bonus_id AND owner_id = v_uid;
  ELSE
    UPDATE ai_usage SET count = GREATEST(count - v_claim.amount, 0) WHERE owner_id = v_uid AND usage_date = v_claim.usage_date AND feature = v_claim.feature;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_invite_checkin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_inviter text;
  v_bind_date date;
  v_logged_days integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_month_honey integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  SELECT invited_by, COALESCE(invited_at::date, created_at::date) INTO v_inviter, v_bind_date FROM profiles WHERE owner_id = v_uid;
  IF v_inviter IS NULL THEN RETURN false; END IF;
  SELECT count(DISTINCT log_date) INTO v_logged_days FROM meal_entries
   WHERE owner_id = v_uid AND log_date >= v_bind_date AND log_date <= v_bind_date + interval '6 days';
  IF v_logged_days < 5 THEN RETURN false; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey FROM honey_ledger
   WHERE owner_id = v_inviter AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 250 > 3000 THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 200, 'invitee_checkin', 'settle-' || v_inviter, now() + make_interval(days => 365)) ON CONFLICT DO NOTHING;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 250, 'inviter_checkin', 'settle-' || v_uid, now() + make_interval(days => 365)) ON CONFLICT DO NOTHING;
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan IS DISTINCT FROM 'lifetime' THEN
    IF v_ent IS NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source) VALUES (v_uid, 'pro', now() + make_interval(days => 7), 'invite');
    ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
      UPDATE entitlements SET pro_until = v_until + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    ELSE
      UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    END IF;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlock_badge(p_badge_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_badge_key NOT IN ('streak_3','streak_7','streak_21','streak_100','photo_50','scan_30','recipe_3','water_10','exercise_20','lose_3kg','invite_3','invite_top') THEN RETURN false; END IF;
  INSERT INTO badges (owner_id, badge_key) VALUES (v_uid, p_badge_key) ON CONFLICT (owner_id, badge_key) DO NOTHING;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_payment_order(p_order_no text, p_provider_txn_id text, p_receipt text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_order payment_orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  SELECT * INTO v_order FROM payment_orders WHERE order_no = p_order_no AND owner_id = v_uid;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_order.status = 'paid' THEN RETURN true; END IF;
  RETURN false;
END;
$function$;


GRANT EXECUTE ON FUNCTION public.badge_stats TO authenticated;
GRANT EXECUTE ON FUNCTION public.bind_invite TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_photo_quota TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_invitees TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_order TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_honey TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inviter_by_code TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_photo_quota TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_today_photo_count TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_honey TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_photo_bonus TO authenticated;
GRANT EXECUTE ON FUNCTION public.invite_throttled TO authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_by_code TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_honey TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_checkin_exercise_by_date TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_checkin_honey_by_date TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_checkin_water_by_date TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_photo_quota TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_invite_checkin TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_badge TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_payment_order TO authenticated;
COMMIT;

-- ════════════ 全量数据 ═══════════
-- 本文件由 --schema-only 生成，不含任何用户数据行（PIPL 最小必要）。
-- 需要带数据的完整镜像请执行：python db/gen-full-mirror-sql.py
-- （数据源 db/backups/full-export/*.json 不入库，见 .gitignore）