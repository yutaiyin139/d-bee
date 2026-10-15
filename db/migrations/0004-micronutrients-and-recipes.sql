-- 0004 微营养素字段 + 自定义食谱表（P1 功能）
--
-- 背景：P1 对标自律茄子 / Cal AI 的两项升级——
--   1. 微营养素（钠 / 膳食纤维 / 添加糖）：此前 meal_entries 只有能量与三大营养素，
--      规则引擎对钠、添加糖只能靠名称关键词给「倾向性提示」。本次新增 3 列，
--      让 AI 识别与 Open Food Facts 能落库实测值，规则引擎改为「数值驱动」判断。
--   2. 自定义食谱：用户把常吃的一餐存成模板，下次一键复记，无需再走 AI。
--
-- 注意：sodium_mg 单位是毫克，fiber_g / added_sugar_g 单位是克，均为「实际摄入量」口径。

-- ── 1. meal_entries 补 3 列（IF NOT EXISTS 幂等）────────────────────────────
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS sodium_mg numeric;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS fiber_g numeric;
ALTER TABLE public.meal_entries ADD COLUMN IF NOT EXISTS added_sugar_g numeric;

-- ── 2. 新建 recipes 表 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recipes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  name        text        NOT NULL,
  items       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 3. RLS：owner-only（4 条分命令风格，与 meal_entries 一致）────────────────
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recipes_select_own ON public.recipes;
CREATE POLICY recipes_select_own ON public.recipes FOR SELECT USING (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_insert_own ON public.recipes;
CREATE POLICY recipes_insert_own ON public.recipes FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_update_own ON public.recipes;
CREATE POLICY recipes_update_own ON public.recipes FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS recipes_delete_own ON public.recipes;
CREATE POLICY recipes_delete_own ON public.recipes FOR DELETE USING (owner_id = auth.uid());

-- ── 4. 权限：GRANT 给 authenticated；revoke anon（平台建表会默认播撒 anon）──
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipes TO authenticated;
REVOKE ALL ON public.recipes FROM anon;
