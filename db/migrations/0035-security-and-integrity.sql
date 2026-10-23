-- ═══════════════════════════════════════════════════════════════════════
-- 0035 · 安全与完整性补齐（P0-1：一次补跑 0015 残半 + 0016 + 0026 + 0027）
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-10-23 迁移全面审计，见 docs/数据库迁移审计与实施计划.md）：
--   审计以「服务器 dbee 库」为唯一真相源，用三类探针（存在性 / 版本性 /
--   事务内真实越权写）逐条核对 33 个迁移编号，查出四个从未被发现的缺陷：
--
--   🔴 0015 只生效一半 —— authenticated 对 entitlements / ai_usage 仍持完整写权限。
--      事务内实证：SET ROLE authenticated 后可
--        UPDATE entitlements SET plan='lifetime'   -- 白嫖终身会员，一分钱不付
--        UPDATE ai_usage SET count=0               -- 清零额度，无限用 AI
--      攻击链四环全部实测成立：
--        ① RLS 策略 owner_id = auth.uid() 只挡跨用户改行，**不挡改自己那行**；
--        ② server/lib/dbproxy.mjs:36 的 ALLOWED_METHODS 含 PATCH，且无表白名单；
--        ③ PostgREST 暴露整个 public schema；
--        ④ dbee_web 可 SET ROLE authenticated。
--      → 前端只需正常登录拿 JWT，再发一个 HTTP PATCH 即可得手。
--      根因是 **GRANT 的追加语义**：0015 发的 REVOKE 之后，0030 镜像又把
--      0002 建库时的宽权限 GRANT 了回去（0002-mirror-to-local-pg.sql:226-229），
--      两者叠加后无人察觉。
--      ⚠️ 当前 entitlements / payment_orders 均为 0 行（还没开始收费），
--         所以现在修是零成本零风险；一旦上线收费，这就是直接的收入漏洞。
--
--   🔴 0016 完全未生效 —— pg_constraint 里只有 0031 的 2 个 CHECK，
--      0016 的 10 条边界约束一条都没有。绕过前端直接写 age=999 / height_cm=1 /
--      calories=-5000 目前无任何拦截。
--
--   🔴 0026 完全未生效（两半都缺）——
--      第一半：grant_honey 无 newbie(150) 分支，落到 ELSE v_ok:=false。
--              而前端确实在调（src/state/plan.tsx:157、src/pages/Onboarding.tsx:204），
--              api.ts 的 grantHoney 是 try/catch + return false → **静默失败**：
--              用户走完 onboarding 拿不到 150 积分，界面不报错、日志不留痕。
--      第二半：存量 source='newbie' 的 quota_bonus 7 行 / 21 次仍在，
--              「免费识别严格 3 次/天」的产品口径（用户 2026-10-19 拍板）
--              在库里从未生效，这 7 个账号实际是 6 次/天。
--
--   🔴 0027 完全未生效 —— bind_invite 函数体无 daily_limit 分支。
--      前端**已经准备好接这个码**（src/lib/api.ts:650 的返回类型已含 'daily_limit'），
--      是库没跟上。后果：单码可被无限次绑定，邀请奖励无每日上限，可被刷。
--
-- 编号说明：审计文档里本迁移原写作 0034，但用户指定执行顺序为
--   P0-4（迁移追踪表）先于 P0-1（本安全补齐）。迁移编号必须与应用顺序一致，
--   故追踪表取 0034，本迁移顺延为 0035。
--
-- 为什么合成一个迁移：五项都是「补跑历史遗漏」，同一批、同一个备份点、
--   同一次验证。拆开跑要备份/验证五次，反而更容易漏。
--
-- ─── 覆盖式函数的基线选择（易错点，务必看清）────────────────────────
--   CREATE OR REPLACE 是**整体替换**，漏写一个分支就是永久丢失。
--   本迁移覆盖 grant_honey 与 bind_invite，基线选择经实测确认：
--     · grant_honey ← 0013（SECURITY DEFINER + 4 类白名单）**再叠加 0026 的 newbie(150)**。
--     · bind_invite ← 0017（UPSERT profiles + 月度返佣 3000 上限），
--       **不是 0013**。0013 的版本只有 `UPDATE profiles`（行不存在时静默失败），
--       0017 才修成 UPSERT；线上 functions.sql 导出的正是 0017 版。
--       若照 0013 覆盖，会把 0017 的时序竞态修复**倒退掉**。
--       再叠加 0027 的 daily_limit。
--   （0026/0027 两个文件本身就是分别基于 0013/0017 写的，故其函数体可直接沿用。）
--
-- ─── 执行方式 ────────────────────────────────────────────────────────
--   先备份：见文件末尾「回滚」段第一步。
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0035-security-and-integrity.sql
--   跑完立即复验：
--     DBEE_HOST=… DBEE_USER=… DBEE_PWD=… bash deploy/run-migration-audit.sh
--
-- 幂等：可重复执行。
--   · 权限段 REVOKE ALL + 精确 GRANT（重复设置无害）
--   · CHECK 用 DROP IF EXISTS + ADD（重复执行会重建，语义一致）
--   · 函数 CREATE OR REPLACE
--   · 作废段有「已作废则 0 行命中」的天然幂等（expires_at > now() 条件）
--   · 追踪表 INSERT ON CONFLICT DO UPDATE
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- (a) 收回 authenticated 的越权写权限 —— 补 0015 没做完的那一半
-- ═══════════════════════════════════════════════════════════════════════
-- 🔴 关键：**先无条件 REVOKE ALL，再精确 GRANT**。
--   GRANT 是追加语义，不先 REVOKE 就无法纠正 0002 遗留、又被 0030 镜像
--   重新 GRANT 回来的宽权限。这正是 0015 失效的根因，也是 0033 已验证有效的范式。
--
--   权限矩阵与 db/gen-full-mirror-sql.py 的 TABLE_GRANTS 同源（唯一真相），
--   并与 tools/migration-audit.sh D 段的期望矩阵逐表一致。
--   改动其中一处，必须同步改另外两处。

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- 用户自己记录的生活日志表：需要完整增删改查（记饮食/体重/饮水/运动/食谱）
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meal_entries  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weight_logs   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_logs    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exercise_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipes       TO authenticated;

-- 邀请码：可读 + 可创建自己的码，但不可改/删（0015 口径）
GRANT SELECT, INSERT ON public.invite_links TO authenticated;

-- 🔴 只读表：写入必须走 SECURITY DEFINER 函数（本次修复的核心）
--   entitlements 写走 redeem_by_code / redeem_honey / settle_invite_checkin
--   ai_usage      写走 consume_ai_quota / consume_photo_quota
--   badges        写走 unlock_badge
--   honey_ledger  写走 grant_honey / bind_invite / settle / redeem / refund / expire
GRANT SELECT ON public.entitlements TO authenticated;
GRANT SELECT ON public.ai_usage     TO authenticated;
GRANT SELECT ON public.badges       TO authenticated;
GRANT SELECT ON public.honey_ledger TO authenticated;

-- 完全不给 authenticated 任何权限的表（前端走 RPC，不直读）：
--   quota_bonus（走 get_photo_quota）· payment_orders · payment_products ·
--   redeem_codes · invite_attempts · ai_quota_claims · app_users · schema_migrations
--   ↑ 上面的 REVOKE ALL 已覆盖，此处不再 GRANT 即为「无权限」。

-- anon 一律无表权限（0001 口径，防未登录访问）
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- ─── 函数 EXECUTE 同样先收后授 ──────────────────────────────────────
-- 为什么要做这一段：PostgreSQL 默认把新函数的 EXECUTE 授给 PUBLIC。
--   0030 镜像建库时逐个 GRANT 了白名单函数，但从未 REVOKE 过默认权限，
--   于是 **0014 明令废弃的 release_ai_quota 仍可被 authenticated 调用**，
--   _lb_compute_streak / _lb_mask_name 两个内部辅助函数也对外可执行。
--   release_ai_quota 能凭空退还额度 = 又一条刷 AI 的通道。
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- 白名单（23 个，与 db/gen-full-mirror-sql.py 的 FUNCTION_GRANTS 一致）
GRANT EXECUTE ON FUNCTION public.badge_stats()                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.bind_invite(text)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(date, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_photo_quota(date, integer)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_invitees()                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_order(text, text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_honey()                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inviter_by_code(text)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_photo_quota(integer)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_today_photo_count()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_honey(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_photo_bonus(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invite_throttled(text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard()                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_by_code(text)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_honey(text)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_checkin_exercise_by_date(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_checkin_honey_by_date(text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_checkin_water_by_date(text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_photo_quota(text)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_invite_checkin()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_badge(text)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_payment_order(text, text, text) TO authenticated;
-- 刻意**不**授予（保持废弃/内部）：
--   release_ai_quota        —— 0014 已废弃，能凭空退额度
--   _lb_compute_streak      —— leaderboard 内部辅助，由 SECURITY DEFINER 内部调用
--   _lb_mask_name           —— 同上
--   iap_verify_receipt 相关 —— 0029 永久作废（pg_net 不可用，验签改 Node 网关）

-- ═══════════════════════════════════════════════════════════════════════
-- (b) 补 0016 的 10 条边界 CHECK 约束
-- ═══════════════════════════════════════════════════════════════════════
-- 前置合规检查：ADD CONSTRAINT 会校验全部存量行，任何越界都会让整个事务失败。
--   审计时（2026-10-23）实测 10 项均 0 行越界，但数据是活的，
--   故这里**在加约束前重新实测一次**，并把越界明细打出来 —— 这样失败时
--   能立刻知道是哪几行需要清洗，而不是只看到一句 constraint violation。
--   用 RAISE EXCEPTION 主动中止：ON_ERROR_STOP=1 下整个事务回滚，库里不留半成品。
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(line, E'\n    ') INTO v_bad FROM (
    SELECT format('profiles.age 越界(1-120): %s 行', count(*)) AS line
      FROM public.profiles WHERE age IS NOT NULL AND NOT (age >= 1 AND age <= 120) HAVING count(*) > 0
    UNION ALL
    SELECT format('profiles.height_cm 越界(100-250): %s 行', count(*))
      FROM public.profiles WHERE height_cm IS NOT NULL AND NOT (height_cm >= 100 AND height_cm <= 250) HAVING count(*) > 0
    UNION ALL
    SELECT format('profiles.current_weight_kg 越界(20-300): %s 行', count(*))
      FROM public.profiles WHERE current_weight_kg IS NOT NULL AND NOT (current_weight_kg >= 20 AND current_weight_kg <= 300) HAVING count(*) > 0
    UNION ALL
    SELECT format('profiles.start_weight_kg 越界(20-300): %s 行', count(*))
      FROM public.profiles WHERE start_weight_kg IS NOT NULL AND NOT (start_weight_kg >= 20 AND start_weight_kg <= 300) HAVING count(*) > 0
    UNION ALL
    SELECT format('profiles.target_weight_kg 越界(20-300): %s 行', count(*))
      FROM public.profiles WHERE target_weight_kg IS NOT NULL AND NOT (target_weight_kg >= 20 AND target_weight_kg <= 300) HAVING count(*) > 0
    UNION ALL
    SELECT format('meal_entries.grams 越界(0-5000): %s 行', count(*))
      FROM public.meal_entries WHERE grams IS NOT NULL AND NOT (grams >= 0 AND grams <= 5000) HAVING count(*) > 0
    UNION ALL
    SELECT format('meal_entries.calories 越界(0-10000): %s 行', count(*))
      FROM public.meal_entries WHERE NOT (calories >= 0 AND calories <= 10000) HAVING count(*) > 0
    UNION ALL
    SELECT format('water_logs.amount_ml 越界(0-5000): %s 行', count(*))
      FROM public.water_logs WHERE NOT (amount_ml >= 0 AND amount_ml <= 5000) HAVING count(*) > 0
    UNION ALL
    SELECT format('exercise_logs.minutes 越界(0-600): %s 行', count(*))
      FROM public.exercise_logs WHERE NOT (minutes >= 0 AND minutes <= 600) HAVING count(*) > 0
    UNION ALL
    SELECT format('exercise_logs.calories 越界(0-5000): %s 行', count(*))
      FROM public.exercise_logs WHERE NOT (calories >= 0 AND calories <= 5000) HAVING count(*) > 0
  ) s;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      E'0035 前置检查未通过：存在越界数据，无法安全添加 CHECK 约束。明细:\n    %\n请先清洗这些数据（人工核对后 UPDATE/DELETE），再重跑本迁移。', v_bad;
  END IF;

  RAISE NOTICE '0035 前置检查通过：10 项边界均 0 行越界，可安全添加 CHECK 约束';
END $$;

-- 边界与前端 src/lib/validate.ts 的 NUM_LIMIT 一致；NULL 一律放行
-- （字段可为空是合法业务状态）。用 DROP IF EXISTS 保证幂等，
--  也能纠正历史上被误改过的约束表达式。
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_age_check;
ALTER TABLE public.profiles ADD  CONSTRAINT profiles_age_check
  CHECK (age IS NULL OR (age >= 1 AND age <= 120));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_height_check;
ALTER TABLE public.profiles ADD  CONSTRAINT profiles_height_check
  CHECK (height_cm IS NULL OR (height_cm >= 100 AND height_cm <= 250));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_current_weight_check;
ALTER TABLE public.profiles ADD  CONSTRAINT profiles_current_weight_check
  CHECK (current_weight_kg IS NULL OR (current_weight_kg >= 20 AND current_weight_kg <= 300));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_start_weight_check;
ALTER TABLE public.profiles ADD  CONSTRAINT profiles_start_weight_check
  CHECK (start_weight_kg IS NULL OR (start_weight_kg >= 20 AND start_weight_kg <= 300));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_target_weight_check;
ALTER TABLE public.profiles ADD  CONSTRAINT profiles_target_weight_check
  CHECK (target_weight_kg IS NULL OR (target_weight_kg >= 20 AND target_weight_kg <= 300));

ALTER TABLE public.meal_entries DROP CONSTRAINT IF EXISTS meal_entries_grams_check;
ALTER TABLE public.meal_entries ADD  CONSTRAINT meal_entries_grams_check
  CHECK (grams IS NULL OR (grams >= 0 AND grams <= 5000));

ALTER TABLE public.meal_entries DROP CONSTRAINT IF EXISTS meal_entries_calories_check;
ALTER TABLE public.meal_entries ADD  CONSTRAINT meal_entries_calories_check
  CHECK (calories >= 0 AND calories <= 10000);

ALTER TABLE public.water_logs DROP CONSTRAINT IF EXISTS water_logs_amount_check;
ALTER TABLE public.water_logs ADD  CONSTRAINT water_logs_amount_check
  CHECK (amount_ml >= 0 AND amount_ml <= 5000);

ALTER TABLE public.exercise_logs DROP CONSTRAINT IF EXISTS exercise_logs_minutes_check;
ALTER TABLE public.exercise_logs ADD  CONSTRAINT exercise_logs_minutes_check
  CHECK (minutes >= 0 AND minutes <= 600);

ALTER TABLE public.exercise_logs DROP CONSTRAINT IF EXISTS exercise_logs_calories_check;
ALTER TABLE public.exercise_logs ADD  CONSTRAINT exercise_logs_calories_check
  CHECK (calories >= 0 AND calories <= 5000);

-- ═══════════════════════════════════════════════════════════════════════
-- (c) 补 0026 第一半：grant_honey 增加 newbie(150) 白名单分支
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0013 的完整实现（SECURITY DEFINER + ref_id 非空校验 + 4 类白名单），
--        叠加 0026 的 newbie 分支。少写任何一个分支都会永久丢失该奖励类型。
--
-- 产品口径（用户 2026-10-19 拍板）：每日严格「3 次免费识别 + 2 次积分兑换」。
--   旧做法「新手完善资料 +3 次识别」会把免费边界从 3 次突破到 6 次，故改为
--   发 150 蜜糖积分（50 积分/次，每日最多兑 2 次），从根上锁住「免费 = 3 次/天」。
CREATE OR REPLACE FUNCTION public.grant_honey(
  p_reason text,
  p_ref_id text,
  p_amount integer,
  p_ttl_days integer DEFAULT 365
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_ok  boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;

  -- ref_id 必须非空（防重复依赖 UNIQUE(owner_id, reason, ref_id)，空值会绕过去重）
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN
    RETURN false;
  END IF;

  -- reason 白名单 + 金额校验（streak_milestone 为 7 档固定值）
  IF p_reason = 'checkin_meal' THEN
    v_ok := p_amount = 5;
  ELSIF p_reason = 'checkin_water' THEN
    v_ok := p_amount = 2;
  ELSIF p_reason = 'checkin_exercise' THEN
    v_ok := p_amount = 2;
  ELSIF p_reason = 'streak_milestone' THEN
    v_ok := p_amount IN (15, 40, 80, 120, 200, 400, 800);
  ELSIF p_reason = 'newbie' THEN          -- ← 0026 新增（此前缺失，前端调用静默失败）
    v_ok := p_amount = 150;
  ELSE
    v_ok := false;  -- 未知 reason 一律拒绝
  END IF;

  IF NOT v_ok THEN
    RETURN false;
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, p_amount, p_reason, p_ref_id,
          now() + make_interval(days => GREATEST(p_ttl_days, 1)))
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_honey(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_honey(text, text, integer, integer) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (d) 补 0026 第二半：作废存量 source='newbie' 的识别次数奖励
-- ═══════════════════════════════════════════════════════════════════════
-- 现状实测：7 行 / 共 21 次（每行 3 次），其中 5 行未过期。
--   这些行让相关账号的免费识别变成 6 次/天，突破了产品口径。
--
-- 处置选择（审计文档「待拍板」项，用户未明确答复 → 采用推荐的 A 方案）：
--   A = 按产品口径作废。这里用**非破坏、可完整回滚**的做法：
--       · 不 DELETE 任何行（保留审计痕迹，也不影响 honey_ledger 的历史流水）；
--       · 先把原始 expires_at 等字段完整备份进 quota_bonus_newbie_retire_log；
--       · 再置 expires_at = now() 让它立即失效。
--   回滚 = 一条 UPDATE ... FROM 还原（见文件末尾回滚段），无需恢复数据库备份。
--   ⚠️ 若日后决定改为 B（保留给老用户当补偿）或 C（连测试账号一起清），
--      基于这张备份表都能精确做到，不存在「已经删了没法还原」的情况。
--
-- 为什么用 expires_at=now() 而不是 DELETE：
--   quota_bonus 被 ai_quota_claims.bonus_id 引用，DELETE 可能触发外键问题；
--   而 consume_photo_quota 的可用额度筛选条件是 `amount > consumed AND expires_at > now()`，
--   置为 now() 即让它彻底不可用，效果等同删除但完全可逆。

CREATE TABLE IF NOT EXISTS public.quota_bonus_newbie_retire_log (
  bonus_id        bigint      PRIMARY KEY,     -- 对应 quota_bonus.id
  owner_id        text        NOT NULL,
  source          text        NOT NULL,
  grant_key       text        NOT NULL,
  amount          integer     NOT NULL,
  consumed        integer     NOT NULL,
  orig_expires_at timestamptz NOT NULL,        -- 作废前的原值，回滚靠它
  retired_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.quota_bonus_newbie_retire_log IS
  '0035(d) 作废存量 newbie 识别奖励的备份表：保留原 expires_at 以便精确回滚。不对外暴露。';

-- 纯基础设施表，无任何 PII 之外的用途；对前端与 PostgREST 一律不可见。
-- 注：PostgreSQL 建表时默认不授予 PUBLIC 任何表权限（与函数默认授 EXECUTE 相反），
--     且本表建在上面那句 REVOKE ALL ON ALL TABLES 之后，本已不可见。
--     这里显式再撤一次，是防将来有人图省事执行 GRANT ALL ON ALL TABLES TO PUBLIC。
REVOKE ALL ON public.quota_bonus_newbie_retire_log FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON public.quota_bonus_newbie_retire_log FROM dbee_web';
  END IF;
END $$;
GRANT SELECT ON public.quota_bonus_newbie_retire_log TO dbee_app;

-- 与全库一致的纵深防御：启用 RLS 且不放任何 policy。
--   本表由 postgres 超级用户在迁移/回滚时读写，超级用户天然绕过 RLS，不受影响；
--   而任何业务角色即使将来被误授了权限，也仍然一行都读不到。
ALTER TABLE public.quota_bonus_newbie_retire_log ENABLE ROW LEVEL SECURITY;

-- 先备份（只备份「尚有余额且未过期」的行 —— 已耗尽/已过期的本来就不生效，无需动）
INSERT INTO public.quota_bonus_newbie_retire_log
       (bonus_id, owner_id, source, grant_key, amount, consumed, orig_expires_at)
SELECT qb.id, qb.owner_id, qb.source, qb.grant_key, qb.amount, qb.consumed, qb.expires_at
  FROM public.quota_bonus qb
 WHERE qb.source = 'newbie'
   AND qb.amount > qb.consumed
   AND qb.expires_at > now()
ON CONFLICT (bonus_id) DO NOTHING;   -- 幂等：重跑不会覆盖首次备份的原值

-- 再作废
UPDATE public.quota_bonus qb
   SET expires_at = now()
  FROM public.quota_bonus_newbie_retire_log lg
 WHERE qb.id = lg.bonus_id
   AND qb.source = 'newbie'
   AND qb.amount > qb.consumed
   AND qb.expires_at > now();

-- ═══════════════════════════════════════════════════════════════════════
-- (e) 补 0027：bind_invite 增加单码单日绑定频次限制
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0017 的完整实现（UPSERT profiles 修时序竞态 + 月度返佣 3000 上限），
--        叠加 0027 的 daily_limit。**不是 0013 的版本**（那版只有 UPDATE，
--        profiles 行不存在时静默失败，正是 0017 修掉的 bug）。
--
-- 风控现状：0012 有「枚举爆破节流」（60s 内失败 ≥5 次），0017 有「月度返佣 3000 上限」，
--   唯独缺「同一邀请码单日成功绑定 ≤10 次」—— 邀请码被公开转发或羊毛党批量注册时，
--   返佣可被刷、异常邀请无法识别。
--
-- 时区统一 Asia/Shanghai（与月度返佣上限口径一致）。
-- 新增状态码 'daily_limit' 不破坏前端契约：前端 src/lib/api.ts:650 的返回类型
--   早已包含 'daily_limit'（是库没跟上，不是前端没跟上）。
CREATE OR REPLACE FUNCTION public.bind_invite(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid          text := auth.uid();
  v_inviter      text;
  v_already      text;
  v_norm         text;
  v_month_honey  integer;
  v_daily_binds  integer;
  v_profile_row  public.profiles%ROWTYPE;
  v_today_ts     timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN 'invalid';
  END IF;

  -- 节流：60 秒内失败 ≥5 次则拒绝（0012）
  IF (SELECT public.invite_throttled(v_uid)) THEN
    RETURN 'throttled';
  END IF;

  v_norm := upper(trim(coalesce(p_code, '')));
  IF v_norm = '' THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, '', false);
    RETURN 'invalid';
  END IF;

  -- 已绑定过则拒绝（幂等语义：一人只能被邀请一次）
  SELECT invited_by INTO v_already FROM profiles WHERE owner_id = v_uid;
  IF v_already IS NOT NULL THEN
    RETURN 'already';
  END IF;

  SELECT owner_id INTO v_inviter FROM invite_links WHERE code = v_norm LIMIT 1;
  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN CASE WHEN v_inviter = v_uid THEN 'self' ELSE 'invalid' END;
  END IF;

  -- 【0027 新增】同一邀请码单日成功绑定 ≤10 次
  --   （防码被公开转发 / 羊毛党批量注册刷返佣）
  SELECT count(*) INTO v_daily_binds
    FROM invite_attempts
   WHERE code = v_norm
     AND ok = true
     AND created_at >= v_today_ts;
  IF v_daily_binds >= 10 THEN
    -- 被限流的尝试也记一笔（ok=false），既留审计痕迹，也喂给 0012 的节流统计
    INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, false);
    RETURN 'daily_limit';
  END IF;

  INSERT INTO invite_attempts (owner_id, code, ok) VALUES (v_uid, v_norm, true);

  -- 【0017 核心修复】profiles 行可能尚未创建（注册后、完善资料前）。
  --   用 UPSERT 语义：不存在则创建仅含 owner_id + 绑定关系的行；存在则更新。
  --   这样无论时序如何，绑定关系都会落库，且 invited_at 精确记录绑定时刻
  --   （settle_invite_checkin 的 7 日达标窗口以此为基准）。
  SELECT * INTO v_profile_row FROM public.profiles WHERE owner_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO public.profiles (owner_id, invited_by, invite_code, invited_at)
    VALUES (v_uid, v_inviter, v_norm, now());
  ELSE
    UPDATE public.profiles
       SET invited_by = v_inviter,
           invite_code = v_norm,
           invited_at = now(),
           updated_at = now()
     WHERE owner_id = v_uid;
  END IF;

  -- 新人注册奖励 +100（reason + ref_id 防重复）
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 100, 'invitee_register', 'bind-' || v_inviter,
          now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  -- 邀请人注册奖励 +50（受月度返佣 3000 上限约束，0013）
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey
    FROM honey_ledger
   WHERE owner_id = v_inviter
     AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 50 <= 3000 THEN
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_inviter, 50, 'inviter_register', 'invitee-' || v_uid,
            now() + make_interval(days => 365))
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN 'ok';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.bind_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bind_invite(text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (f) 更新迁移追踪表（0034 建的）
-- ═══════════════════════════════════════════════════════════════════════
-- 把 0015/0016/0026/0027 从 superseded 翻成 applied：内容此刻真的进库了。
--   原 note 保留并追加结论，让「曾经失效过」这段历史不丢；
--   applied_by 记为 '0035' —— 表明是谁让它变成真的。
-- 用 to_regclass 守卫：若 0034 尚未应用（表不存在），这段跳过而不是报错，
--   保证本迁移可以独立于 0034 执行（虽然推荐顺序是先 0034）。
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0035: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;

  UPDATE public.schema_migrations
     SET status     = 'applied',
         applied_at = now(),
         applied_by = '0035',
         note       = note || ' → 2026-10-23 由 0035 补齐并实测生效'
   WHERE status = 'superseded'
     AND version IN ('0015', '0016', '0026', '0027');

  INSERT INTO public.schema_migrations
         (version, name, status, applied_by, note)
  VALUES ('0035', 'security-and-integrity', 'applied', 'self',
          '一次补齐：(a) 收 authenticated 对 entitlements/ai_usage 的写权限 + 函数 EXECUTE 先收后授 '
          '(b) 0016 的 10 条边界 CHECK (c) grant_honey 的 newbie(150) '
          '(d) 作废存量 newbie bonus（备份进 quota_bonus_newbie_retire_log，可回滚） '
          '(e) bind_invite 的 daily_limit')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- (g) 通知 PostgREST 重载 schema 缓存
-- ═══════════════════════════════════════════════════════════════════════
-- 为什么必须做：PostgREST 启动时把表结构、列、**权限**缓存进内存。
--   本迁移改了 GRANT，若不通知重载，数据面会继续按旧缓存放行/拒绝，
--   症状是「库里明明 REVOKE 了，PATCH 却仍然成功」或反之出现莫名的 403 —— 
--   极难排查（会怀疑是 RLS、是网关、是 JWT，绕一大圈才想到缓存）。
--   NOTIFY 在事务提交时才投递，故放在 COMMIT 之前是安全的。
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 执行后自检（只读，可逐条粘贴执行）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) 越权写权限应收回（三个都应返回 f）：
--    SELECT has_table_privilege('authenticated','public.entitlements','UPDATE'),
--           has_table_privilege('authenticated','public.entitlements','INSERT'),
--           has_table_privilege('authenticated','public.ai_usage','UPDATE');
-- 2) 读权限应保留（前端要读权益/用量，都应返回 t）：
--    SELECT has_table_privilege('authenticated','public.entitlements','SELECT'),
--           has_table_privilege('authenticated','public.ai_usage','SELECT');
-- 3) 废弃函数应不可执行（返回 f）：
--    SELECT has_function_privilege('authenticated','public.release_ai_quota(date,text,integer)','EXECUTE');
-- 4) 10 条 CHECK 应全部存在（返回 10）：
--    SELECT count(*) FROM pg_constraint
--     WHERE conname IN ('profiles_age_check','profiles_height_check','profiles_current_weight_check',
--                       'profiles_start_weight_check','profiles_target_weight_check',
--                       'meal_entries_grams_check','meal_entries_calories_check',
--                       'water_logs_amount_check','exercise_logs_minutes_check',
--                       'exercise_logs_calories_check');
-- 5) grant_honey 应含 newbie 分支（返回 t）：
--    SELECT position('newbie' in pg_get_functiondef('public.grant_honey(text,text,integer,integer)'::regprocedure)) > 0;
-- 6) bind_invite 应含 daily_limit（返回 t）：
--    SELECT position('daily_limit' in pg_get_functiondef('public.bind_invite(text)'::regprocedure)) > 0;
-- 7) 存量 newbie bonus 应全部失效（返回 0）：
--    SELECT count(*) FROM public.quota_bonus
--     WHERE source='newbie' AND amount > consumed AND expires_at > now();
-- 8) 完整三类探针复验（本地执行，会跑事务内真实越权写测试）：
--    DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='…' bash deploy/run-migration-audit.sh
--
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚
-- ═══════════════════════════════════════════════════════════════════════
-- 【第一步永远是备份】（在执行本迁移之前就该做）：
--   sudo -u postgres pg_dump -d dbee -F c -f /opt/dbee-db/backup-before-0035.dump
--
-- (d) 项可精确回滚，无需恢复备份（这是刻意设计成非破坏式的原因）：
--   BEGIN;
--   UPDATE public.quota_bonus qb
--      SET expires_at = lg.orig_expires_at
--     FROM public.quota_bonus_newbie_retire_log lg
--    WHERE qb.id = lg.bonus_id;
--   COMMIT;
--
-- (a)(b)(c)(e) 项要回滚，只能重放旧版定义：
--   · (a) 权限：重跑 0030-full-selfhost-mirror.sql 的 GRANT 段会把宽权限放回去
--          —— ⚠️ 那等于恢复漏洞，除非确有必要不要这么做。
--   · (b) CHECK：ALTER TABLE … DROP CONSTRAINT <name>;（逐条）
--   · (c) grant_honey：重放 0013 的定义（去掉 newbie 分支）
--   · (e) bind_invite：重放 0017 的定义（去掉 daily_limit 分支）
--   · 全部回滚后记得再 NOTIFY pgrst, 'reload schema';
--
-- 追踪表回滚：
--   UPDATE public.schema_migrations SET status='superseded', applied_by='backfill-audit-20261023'
--    WHERE version IN ('0015','0016','0026','0027');
--   DELETE FROM public.schema_migrations WHERE version='0035';
