-- ═══════════════════════════════════════════════════════════════════════
-- 0040 · 性能修复：积分余额服务端聚合 + 榜单缓存（审查报告 ⑥ 查询优化）
--
-- 背景（两处 O(全量) 热点，四端共用同一后端）：
--   (a) getHoneyBalance()：前端把 honey_ledger **整表**（自己名下所有流水）
--       拉到客户端再求和。流水只增不减（每日打卡 3 条 + 里程碑 + 邀请结算），
--       一年重度用户 ≈ 1500+ 行 × 每次打开首页/积分页都要全量下载。
--   (b) leaderboard()（0028）：每次调用都全量扫描 meal_entries（按 owner 聚合
--       **全部历史日期**）+ 逐用户 plpgsql 循环算 streak + 逐用户 JOIN profiles。
--       0028 注释里已预告「量大后再引入 leaderboard_cache」——本迁移落地。
--
-- 方案：
--   (a) 新增 honey_balance() RPC：单条聚合 SQL 在库内算出
--       {balance, total_earned, total_spent}，网络载荷从 N 行降到 1 行 json。
--       口径与前端旧实现逐条对齐（含过期语义，见函数体注释）。
--   (b) leaderboard() 加 5 分钟缓存（leaderboard_cache 单行表）：
--       命中缓存 → 直接返回缓存的 json 再拼上「我的实时数据」（my 部分
--       必须实时：用户刚打卡完立刻看榜单，自己的 streak 不能是 5 分钟前的）。
--       未命中 → 原逻辑全量重算 + 写缓存。并发击穿由用户级 advisory lock
--       缓解（与 0039 redeem_honey 同一模式）。
--       另修一处顺带的性能 bug：原「我的 streak」聚合了该用户**全部历史**
--       meal_entries，实际 streak 最多回溯连续天数——收窄到最近 400 天窗口
--       （> 任何业务可达的连续打卡长度，语义不变）。
--
-- 权限：
--   honey_balance()  SECURITY DEFINER 只读聚合，仅 authenticated；
--   leaderboard_cache 表对 authenticated/anon 零权限（缓存由 DEFINER 内部读写，
--   与 quota_bonus_newbie_retire_log 同口径）；leaderboard() 签名不变，
--   前端（src/lib/leaderboard.ts、mini/src/lib/leaderboard.ts）无需改动。
--
-- 执行方式：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0040-honey-balance-and-leaderboard-cache.sql
-- 幂等：可重复执行（CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE + UPSERT 追踪表）。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- (a) honey_balance()：积分余额服务端聚合
-- ═══════════════════════════════════════════════════════════════════════
-- 口径 = 前端旧 getHoneyBalance() 的逐行循环，翻译为单条聚合：
--   balance      = SUM(正流水且未过期) + SUM(全部负流水)，再 GREATEST(0, ·)
--                  （旧实现：amt>0 且 expires_at<=now 的入账跳过不计，
--                    负流水不受过期影响——FILTER 子句逐字对应）
--   total_earned = SUM(所有 amount>=0)，含已过期（旧实现同口径）
--   total_spent  = SUM(-amount) WHERE amount<0
CREATE OR REPLACE FUNCTION public.honey_balance()
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT json_build_object(
    'balance', GREATEST(0,
      COALESCE(SUM(amount) FILTER (
        WHERE amount < 0
           OR expires_at IS NULL
           OR expires_at > now()
      ), 0)),
    'total_earned', COALESCE(SUM(amount) FILTER (WHERE amount >= 0), 0),
    'total_spent',  COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)
  )
  FROM honey_ledger
  WHERE owner_id = auth.uid();
$fn$;

REVOKE ALL ON FUNCTION public.honey_balance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.honey_balance() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (b1) leaderboard_cache：单行缓存表（TTL 5 分钟）
-- ═══════════════════════════════════════════════════════════════════════
-- 只存「全站公共部分」（两个 Top50 榜单 json），不存任何 per-user 数据；
-- 「my」部分每次实时算。表对 authenticated/anon 零权限（数据只能经由
-- SECURITY DEFINER 的 leaderboard() 访问），也不需要 RLS。
CREATE TABLE IF NOT EXISTS public.leaderboard_cache (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload     json NOT NULL,          -- {self_discipline: [...], invite: [...]}
  computed_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.leaderboard_cache FROM PUBLIC, anon, authenticated, dbee_app;

-- ═══════════════════════════════════════════════════════════════════════
-- (b2) leaderboard()：缓存版（签名与返回结构不变）
-- ═══════════════════════════════════════════════════════════════════════
-- 变化点（相对 0028/0030 版）：
--   1. 🔴 易变性 STABLE → VOLATILE：新版会写缓存表（INSERT）+ 取事务级
--      advisory 锁，STABLE 承诺「不修改库」，在只读事务/只读路由下写会失败，
--      缓存永远落不进去 → 优化失效。故必须声明 VOLATILE。
--      （honey_balance() 是纯只读聚合，保持 STABLE 不变。）
--   2. 5 分钟缓存：命中直接取 payload；未命中重算后 UPSERT 写回。
--      并发未命中时 pg_advisory_xact_lock 串行化重算，避免缓存击穿风暴。
--   3. 榜单主循环的日期窗口收窄到最近 400 天：streak 从今天/昨天起回溯，
--      400 天前的记录不可能出现在任何存活 streak 里，语义无损；
--      meal_entries 聚合量从「全部历史」降为「≤400 天」。
--   4. 「我的 streak」同样收窄 400 天窗口（原为全历史聚合）。
--   5. 缓存表读写包在 EXCEPTION 块里：缓存层任何异常（含权限/磁盘问题）
--      都退化为「无缓存直接算」，榜单可用性优先。
CREATE OR REPLACE FUNCTION public.leaderboard()
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid         text := auth.uid();
  v_today       date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_window_from date := v_today - 400;          -- streak 计算窗口（业务上限远小于此）
  v_ttl         interval := interval '5 minutes';
  v_my_streak   integer := 0;
  v_my_invites  integer := 0;
  v_payload     json := NULL;                    -- 公共榜单部分（可来自缓存）
  v_disc_json   json;
  v_inv_json    json;
  v_streak_arr  json[] := ARRAY[]::json[];
  v_inv_arr     json[] := ARRAY[]::json[];
  v_s           integer;
  r             record;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;

  -- ① 我的数据：永远实时（刚打卡完立刻可见）
  SELECT public._lb_compute_streak(
           (SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text)
              FROM meal_entries
             WHERE owner_id = v_uid AND log_date >= v_window_from),
           v_today)
    INTO v_my_streak;

  SELECT count(*) INTO v_my_invites
    FROM profiles
   WHERE invited_by = v_uid
     AND invited_at >= v_month_start;

  -- ② 公共榜单：先试缓存（5 分钟内有效）
  BEGIN
    SELECT payload INTO v_payload
      FROM leaderboard_cache
     WHERE id = 1 AND computed_at > now() - v_ttl;
  EXCEPTION WHEN others THEN
    v_payload := NULL;   -- 缓存层异常 → 直接重算，不影响可用性
  END;

  IF v_payload IS NULL THEN
    -- 串行化并发重算（同一 advisory key，事务级）
    PERFORM pg_advisory_xact_lock(hashtextextended('dbee:leaderboard_cache', 0));

    -- double-check：等锁期间可能已有别的事务写好新缓存
    BEGIN
      SELECT payload INTO v_payload
        FROM leaderboard_cache
       WHERE id = 1 AND computed_at > now() - v_ttl;
    EXCEPTION WHEN others THEN
      v_payload := NULL;
    END;
  END IF;

  IF v_payload IS NULL THEN
    -- ③ 全量重算（口径与 0028 完全一致，仅加 400 天窗口）
    FOR r IN
      SELECT m.owner_id AS uid,
             array_agg(DISTINCT m.log_date::text ORDER BY m.log_date::text) AS days,
             p.nickname AS nick
        FROM meal_entries m
        JOIN profiles p ON p.owner_id = m.owner_id
       WHERE m.log_date >= v_window_from
       GROUP BY m.owner_id, p.nickname
    LOOP
      v_s := public._lb_compute_streak(r.days, v_today);
      IF v_s >= 3 THEN
        v_streak_arr := v_streak_arr || json_build_object(
          'name', public._lb_mask_name(r.nick),
          'streak', v_s
        )::json;
      END IF;
    END LOOP;

    FOR r IN
      SELECT p.nickname AS nick, count(*) AS cnt
        FROM profiles p
        JOIN profiles invited ON invited.invited_by = p.owner_id
       WHERE invited.invited_at >= v_month_start
       GROUP BY p.owner_id, p.nickname
    LOOP
      v_inv_arr := v_inv_arr || json_build_object(
        'name', public._lb_mask_name(r.nick),
        'invites', r.cnt::int
      )::json;
    END LOOP;

    SELECT COALESCE(json_agg(e ORDER BY (e->>'streak')::int DESC), '[]'::json)
      INTO v_disc_json
      FROM unnest(v_streak_arr) AS e
     LIMIT 50;

    SELECT COALESCE(json_agg(e ORDER BY (e->>'invites')::int DESC), '[]'::json)
      INTO v_inv_json
      FROM unnest(v_inv_arr) AS e
     LIMIT 50;

    v_payload := json_build_object(
      'self_discipline', COALESCE(v_disc_json, '[]'::json),
      'invite', COALESCE(v_inv_json, '[]'::json)
    );

    -- ④ 写回缓存（失败不影响本次返回）
    BEGIN
      INSERT INTO leaderboard_cache (id, payload, computed_at)
      VALUES (1, v_payload, now())
      ON CONFLICT (id) DO UPDATE
        SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;

  RETURN json_build_object(
    'self_discipline', v_payload->'self_discipline',
    'invite', v_payload->'invite',
    'my', json_build_object('streak', v_my_streak, 'invites', v_my_invites)
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.leaderboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (c) 迁移追踪表登记 + PostgREST 重载
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0040: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0040', 'honey-balance-and-leaderboard-cache', 'applied', 'self',
          '(a) honey_balance() 服务端聚合（替代前端全量下载 honey_ledger） '
          '(b) leaderboard_cache 5 分钟缓存 + 400 天窗口 + advisory 防击穿')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 执行后自检（只读，可逐条粘贴）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) honey_balance 存在且 authenticated 可执行（期望 t / t）：
--    SELECT to_regprocedure('public.honey_balance()') IS NOT NULL,
--           has_function_privilege('authenticated','public.honey_balance()','EXECUTE');
-- 2) 缓存表存在且 authenticated 零权限（期望 t / f）：
--    SELECT to_regclass('public.leaderboard_cache') IS NOT NULL,
--           has_table_privilege('authenticated','public.leaderboard_cache','SELECT');
-- 3) leaderboard 已用缓存版（期望 t / t）：
--    SELECT position('leaderboard_cache' IN pg_get_functiondef('public.leaderboard()'::regprocedure)) > 0,
--           position('pg_advisory_xact_lock' IN pg_get_functiondef('public.leaderboard()'::regprocedure)) > 0;
-- 4) honey_balance 与旧口径对拍（任意有流水的用户，BEGIN…ROLLBACK）：
--    BEGIN;
--    SELECT set_config('request.jwt.claims','{"sub":"<真实owner_id>","role":"authenticated"}',true);
--    SET LOCAL ROLE authenticated;
--    SELECT public.honey_balance();
--    SELECT GREATEST(0, SUM(amount) FILTER (WHERE amount<0 OR expires_at IS NULL OR expires_at>now())) AS balance,
--           SUM(amount) FILTER (WHERE amount>=0) AS earned,
--           SUM(-amount) FILTER (WHERE amount<0) AS spent
--      FROM public.honey_ledger WHERE owner_id='<真实owner_id>';
--    ROLLBACK;
-- 5) 缓存生效实测：连续两次调用 leaderboard()，第二次应 <1ms 且
--    SELECT computed_at FROM public.leaderboard_cache; 不随第二次调用变化。
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚
-- ═══════════════════════════════════════════════════════════════════════
-- 先备份：sudo -u postgres pg_dump -d dbee -F c -f /opt/dbee-db/backup-before-0040.dump
-- 回滚 = 重放旧版定义 + 清理：
--   · leaderboard()      ← 0028-leaderboard.sql（或 0030-schema.sql 同文）
--   · DROP FUNCTION public.honey_balance();
--   · DROP TABLE public.leaderboard_cache;
--   · DELETE FROM public.schema_migrations WHERE version='0040';
--   · NOTIFY pgrst, 'reload schema';
-- 客户端无需回滚：getHoneyBalance() 在 RPC 缺失时自动回退旧全量路径（见 api.ts）。
