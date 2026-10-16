-- ═══════════════════════════════════════════════════════════════
-- 0016 · 输入边界 CHECK 约束（输入边界校验的数据库层兜底）
--
-- 背景：前端 src/lib/validate.ts 做了「输入过滤 → 失焦纠正 → 提交门禁」
-- 三层校验，但前端校验可被 devtools 直接调 API 绕过。按本项目安全铁律
-- （见 MEMORY.md：函数白名单 + 表级 REVOKE 缺一不可），数据完整性同样
-- 需要「前端体验防线 + 数据库最终防线」两层。
--
-- 已核实（2026-10-16）：现有 15 条 profiles 无任何越界数据，本约束可直接加上。
-- 边界值与前端 NUM_LIMIT 一致；NULL 一律放行（字段可为空是合法业务状态）。
--
-- 执行方式：genie-baas db_exec_sql mode=migrate（逐条执行，单次不支持多语句）
-- ═══════════════════════════════════════════════════════════════

-- 1. profiles：年龄 / 身高 / 体重（当前、起始、目标）
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_age_check            CHECK (age IS NULL OR (age >= 1 AND age <= 120));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_height_check         CHECK (height_cm IS NULL OR (height_cm >= 100 AND height_cm <= 250));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_current_weight_check CHECK (current_weight_kg IS NULL OR (current_weight_kg >= 20 AND current_weight_kg <= 300));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_start_weight_check   CHECK (start_weight_kg IS NULL OR (start_weight_kg >= 20 AND start_weight_kg <= 300));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_target_weight_check  CHECK (target_weight_kg IS NULL OR (target_weight_kg >= 20 AND target_weight_kg <= 300));

-- 2. meal_entries：份量 0–5000 g、热量 0–10000 kcal
ALTER TABLE public.meal_entries
  ADD CONSTRAINT meal_entries_grams_check      CHECK (grams IS NULL OR (grams >= 0 AND grams <= 5000));

ALTER TABLE public.meal_entries
  ADD CONSTRAINT meal_entries_calories_check   CHECK (calories >= 0 AND calories <= 10000);

-- 3. water_logs：单次饮水量 0–5000 ml
ALTER TABLE public.water_logs
  ADD CONSTRAINT water_logs_amount_check       CHECK (amount_ml >= 0 AND amount_ml <= 5000);

-- 4. exercise_logs：时长 0–600 分钟、热量 0–5000 kcal
ALTER TABLE public.exercise_logs
  ADD CONSTRAINT exercise_logs_minutes_check   CHECK (minutes >= 0 AND minutes <= 600);

ALTER TABLE public.exercise_logs
  ADD CONSTRAINT exercise_logs_calories_check  CHECK (calories >= 0 AND calories <= 5000);
