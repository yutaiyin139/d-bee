-- ═══════════════════════════════════════════════════════════════════════
-- 0054 · 修复积分双扣：honey_balance() 改 FEFO（先到期先消费）口径
--
-- 背景（2026-11-17 生产只读取证，账户 18611114399 / owner 179325...）：
--   用户 10-29 获新手 +150（11-05 到期），11-02 兑换花掉 100，
--   11-09 expire_stale_honey() 按【整笔】插入 -150 冲正（应为剩余的 50）。
--   旧 honey_balance() 口径：
--     GREATEST(0, SUM(amount) FILTER (amount<0 OR expires_at IS NULL OR expires_at>now()))
--   同时「排除已过期正流水 +150」又「纳入 expire 冲正 -150」→ 同一笔扣两次；
--   叠加整笔冲正多扣的 100，用户实际应有 34 分却显示 0。
--   生产实证：当前 FILTER=0 / 朴素 SUM=-66 / FEFO=34。
--
-- 修复（本迁移）：
--   把 honey_balance() 重写为 FEFO 查询期重算：
--     · 正流水（amount>0）按 expires_at 升序排队（NULL=永不过期，排最后）；
--     · 真实消费（负流水且 reason<>'expire'）按总额从最早到期批次开始冲抵；
--     · reason='expire' 的物理冲正流水一律忽略（FEFO 在查询期重算，不依赖它）；
--     · balance = Σ(未过期批次中未被消费的剩余)；
--     · total_spent 只计真实消费（排除 expire 冲正，消除「累计消耗 250」虚高）。
--   —— 与 packages/shared/src/honeyLedger.ts 的 computeHoneyBalance() 逐句同口径。
--
-- 历史数据：无需订正。旧的错误 expire 冲正流水被 FEFO 忽略，天然不参与余额；
--           expire_stale_honey() 保留原样（其写入被忽略，对未来无副作用）。
-- 幂等：CREATE OR REPLACE + 追踪表 UPSERT，可重复运行。
-- 执行：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0054-honey-balance-fefo.sql
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.honey_balance()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  r record;
  v_remain numeric;
  v_exp timestamptz;
  v_to_consume numeric := 0;
  v_total_earned numeric := 0;
  v_total_spent numeric := 0;
  v_balance numeric := 0;
  -- 批次：到期时间 + 未消费剩余（NULL expires 视为永不过期）
  v_lots_expires timestamptz[] := ARRAY[]::timestamptz[];
  v_lots_remain  numeric[]     := ARRAY[]::numeric[];
  v_i integer;
  v_used numeric;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('balance', 0, 'total_earned', 0, 'total_spent', 0);
  END IF;

  -- 1) 收集正流水批次 + 统计真实消费总额（排除物理冲正 reason='expire'）
  FOR r IN
    SELECT amount, reason, expires_at
    FROM honey_ledger
    WHERE owner_id = v_uid
    ORDER BY id
  LOOP
    IF r.amount > 0 THEN
      v_total_earned := v_total_earned + r.amount;
      v_lots_expires := array_append(v_lots_expires, r.expires_at);
      v_lots_remain  := array_append(v_lots_remain, r.amount::numeric);
    ELSIF r.amount < 0 AND r.reason <> 'expire' THEN
      v_total_spent := v_total_spent + (-r.amount);
    END IF;
    -- reason='expire' 的负流水：忽略
  END LOOP;
  v_to_consume := v_total_spent;

  -- 2) FEFO 分摊：按到期时间升序（NULL=永不过期，排最后）冲抵，先到期先消费。
  --    选择排序：把批次按到期时间升序排列（NULL → 最后）
  FOR v_i IN 1..coalesce(array_length(v_lots_remain, 1), 0) LOOP
    DECLARE
      v_best integer := v_i;
      v_j integer;
      v_best_exp timestamptz := v_lots_expires[v_i];
      v_cur_exp timestamptz;
      v_tmp_exp timestamptz;
      v_tmp_rem numeric;
    BEGIN
      FOR v_j IN v_i + 1..coalesce(array_length(v_lots_remain, 1), 0) LOOP
        v_cur_exp := v_lots_expires[v_j];
        IF v_best_exp IS NULL THEN
          -- 当前最好为 NULL（永不过期），任何非 NULL 都更该排前面
          IF v_cur_exp IS NOT NULL THEN
            v_best := v_j; v_best_exp := v_cur_exp;
          END IF;
        ELSIF v_cur_exp IS NOT NULL AND v_cur_exp < v_best_exp THEN
          v_best := v_j; v_best_exp := v_cur_exp;
        END IF;
      END LOOP;
      IF v_best <> v_i THEN
        v_tmp_exp := v_lots_expires[v_i]; v_lots_expires[v_i] := v_lots_expires[v_best]; v_lots_expires[v_best] := v_tmp_exp;
        v_tmp_rem := v_lots_remain[v_i];  v_lots_remain[v_i]  := v_lots_remain[v_best];  v_lots_remain[v_best]  := v_tmp_rem;
      END IF;
    END;
  END LOOP;

  -- 3) 按排好序的批次冲抵消费
  FOR v_i IN 1..coalesce(array_length(v_lots_remain, 1), 0) LOOP
    EXIT WHEN v_to_consume <= 0;
    v_used := LEAST(v_lots_remain[v_i], v_to_consume);
    v_lots_remain[v_i] := v_lots_remain[v_i] - v_used;
    v_to_consume := v_to_consume - v_used;
  END LOOP;

  -- 4) 未过期批次的剩余求和 = 可用余额
  FOR v_i IN 1..coalesce(array_length(v_lots_remain, 1), 0) LOOP
    IF v_lots_expires[v_i] IS NULL OR v_lots_expires[v_i] > v_now THEN
      v_balance := v_balance + v_lots_remain[v_i];
    END IF;
  END LOOP;

  RETURN json_build_object(
    'balance', GREATEST(0, v_balance)::integer,
    'total_earned', v_total_earned::integer,
    'total_spent', v_total_spent::integer
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.honey_balance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.honey_balance() TO authenticated;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0054: public.schema_migrations 不存在，跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0054', 'honey-balance-fefo', 'applied', 'self',
          'honey_balance() 改 FEFO 查询期重算：忽略 reason=expire 物理冲正，消费按先到期先消费分摊，修双扣')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
