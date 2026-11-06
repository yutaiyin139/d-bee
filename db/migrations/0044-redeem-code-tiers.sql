-- ═══════════════════════════════════════════════════════════════════════
-- 0044 · 兑换码支持按月/按年/终身三档
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-11-06 web 变现通道盘点）：
--
--   web 端**在线支付是死代码**：`checkout.ts:33-48` getAdapter() 的 web 分支
--   → `createWechatPayAdapter()`（`wechatPay.ts:105-109`）→ `getPlugin()` 读
--   `window.Capacitor?.Plugins?.CapacitorWechat` → web 端恒为 undefined → 返回 null
--   → `checkout.ts:150` 提示「当前平台暂不支持在线支付」。
--   根因是 `@capgo/capacitor-wechat` 的 package.json `capacitor` 字段只有
--   `{ios, android}`、**无 web 实现**；且全仓无任何 alipay 插件依赖。
--   补齐 web 在线支付需要新写微信 Native 扫码 + H5 两套适配器，且商户号尚未到手。
--
--   → 决策（用户 2026-11-06 批准）：**先打通兑换码这条已经可用的变现通道**。
--     web 付费墙内兑换码入口本就存在（`PaywallSheet.tsx:445`，`!isIOS()` 分支），
--     链路 `PaywallSheet → state/plan.tsx:169 redeem() → api.ts:794 RPC` 完整可跑，
--     唯独 0012 起 `redeem_by_code` **写死只发 lifetime**（`:67-74`）——
--     于是月卡/年卡无法通过兑换码发放，只能卖终身档。本迁移解除该限制。
--
-- ─── 兼容性：RPC 签名与返回值**完全不变** ─────────────────────────────
--   仍返回 text 'ok' / 'used' / 'bad'。刻意不改成 JSON，理由有三：
--     ① `src/lib/api.ts:797` 与 `mini/src/lib/api.ts:841` 都写着
--        `return r === 'ok' || r === 'used' ? r : 'bad'` —— 任何新返回值会被
--        **静默降级成 'bad'**，用户明明兑换成功却看到「兑换码不对」。
--        若改 JSON 就必须两端 api.ts 同步改，而两端连**不同的库**
--        （主端→自建库，mini→云库，见 `mini/src/lib/backend.ts:15,47`），
--        双库升级必然有时间差，窗口期内就是「兑换成功却报失败」的线上事故。
--     ② 档位信息前端本来就拿得到：主端 `plan.tsx:170-173` 兑换成功后立即
--        `getEntitlement()` 刷新、mini `paywall.tsx:113` 成功后 `refresh()`。
--        从刷新到的 entitlement 读 plan/pro_until 比从返回值读更权威。
--     ③ 保持返回值不变 = 双库版本错位也不出错（旧库照发 lifetime，前端照显示）。
--
-- ─── 🔴 新增的用户级 advisory lock 是**必需项**，不是可选加固 ─────────
--   原实现只发 lifetime，权益写入是 `ON CONFLICT DO UPDATE SET plan='lifetime'`
--   —— **幂等覆盖**，并发两次结果相同，无竞态。
--   改成 pro 顺延后变成「读 pro_until → 加 months → 写回」的读-改-写：
--     事务 A 读 pro_until = 12-01，事务 B 同时读 pro_until = 12-01，
--     A 写 12-01 + 1月 = 01-01，B 也写 01-01（本该是 02-01）
--     → **用户白付一个码的钱，少一个月权益**。
--   单码本身不会被重复兑换（`WHERE id=? AND used_by IS NULL` 条件更新已挡住），
--   但「同一用户同时兑两个不同码」这条路径挡不住。故加用户级事务锁串行化，
--   与 0039 P1-D 给 `redeem_honey` 加锁同一手法、同一理由。
--
-- ─── 校验顺序：坏码**不得烧掉** ───────────────────────────────────────
--   档位合法性校验（plan/months 组合）放在「条件 UPDATE 标记使用」**之前**。
--   否则一张 months 被手工改坏的码会先被标记 used、再发放失败 →
--   码永久作废且用户什么都没拿到，且事后无法区分「谁用了它」。
--
-- ─── 买断不降级（沿用 0037:223-228 的既有语义）────────────────────────
--   已是 lifetime 的用户兑换 pro 档码：保留 lifetime、不动 pro_until。
--   反之 pro 用户兑换 lifetime 码则升级为终身。
--
-- 执行方式：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0044-redeem-code-tiers.sql
-- 幂等：可重复执行（ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT 守卫
--       + CREATE OR REPLACE + 追踪表 UPSERT）。
--
-- 🔴 双库对齐（0039 铁律）：`redeem_by_code` 是**权益函数**，改它必须双库同步。
--   · 自建库（主端 web/iOS/Android）→ 本文件
--   · 云库（mini 端默认后端）→ `db/cloud-patch-0044/*.sql`（逐语句拆分，供 MCP 逐条执行）
--   · 对齐探针 → `deploy/probe-0044-parity.sh`
--   两库不一致的后果是**四端行为分叉**：主端能兑月卡、mini 端仍只发终身。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- (a) redeem_codes 增档位列 + 完整性约束
-- ═══════════════════════════════════════════════════════════════════════

-- 存量码一律回填 'lifetime'：0012 起所有已发出的码都是终身档，
-- DEFAULT 保证「加列即等价于旧行为」，向后兼容零风险。
ALTER TABLE public.redeem_codes
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'lifetime';

-- pro 档的月数。lifetime 档必须为 NULL（与 payment_products.months 语义一致：
-- 0021 里 dbee_pro_month=1 / dbee_pro_year=12 / dbee_lifetime=NULL）。
ALTER TABLE public.redeem_codes
  ADD COLUMN IF NOT EXISTS months integer;

COMMENT ON COLUMN public.redeem_codes.plan   IS '0044 · 该码发放的档位：pro（限时）/ lifetime（终身买断）。存量码默认 lifetime';
COMMENT ON COLUMN public.redeem_codes.months IS '0044 · plan=pro 时的时长（月）；plan=lifetime 时必须为 NULL';

-- CHECK 名固定，便于幂等 DROP 后重建（不用匿名约束，否则每次生成随机名无法清理）
ALTER TABLE public.redeem_codes DROP CONSTRAINT IF EXISTS redeem_codes_plan_chk;
ALTER TABLE public.redeem_codes
  ADD CONSTRAINT redeem_codes_plan_chk CHECK (plan IN ('pro', 'lifetime'));

-- 🔴 组合约束：pro 必须带正整数月数（上限 1200 = 100 年，防手滑写 999999 变成变相终身），
--    lifetime 必须 months IS NULL（否则「终身码带 3 个月」这种自相矛盾的库存能被发出来）。
ALTER TABLE public.redeem_codes DROP CONSTRAINT IF EXISTS redeem_codes_months_chk;
ALTER TABLE public.redeem_codes
  ADD CONSTRAINT redeem_codes_months_chk CHECK (
    (plan = 'lifetime' AND months IS NULL)
    OR (plan = 'pro' AND months IS NOT NULL AND months > 0 AND months <= 1200)
  );

-- 发码工具按批次插入，批次核查时按 (plan, created_at) 扫；未使用的码盘点走 (used_by) 部分索引
CREATE INDEX IF NOT EXISTS redeem_codes_unused_idx
  ON public.redeem_codes (plan, created_at) WHERE used_by IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- (b) redeem_by_code：按码上的档位发放（签名与返回值不变）
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0012:27-78（0030 镜像 :931 与之等价，0039 未改本函数）。
-- 改动：① 入口加用户级 advisory lock（防 pro 顺延丢更新）
--       ② 标记使用前先校验档位合法性（坏码不烧）
--       ③ 权益写入按 plan 分支，pro 走 GREATEST 语义顺延、lifetime 不降级
CREATE OR REPLACE FUNCTION public.redeem_by_code(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid    text := auth.uid();
  v_norm   text;
  v_row    redeem_codes%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN 'bad'; END IF;

  -- 🔴 用户级事务锁：串行化同一用户的并发兑换。
  --   必需理由见文件头 —— pro 顺延是读-改-写，无锁会丢一次顺延（少给用户一个月）。
  --   键前缀与 redeem_honey 区分（'dbee:redeem_code:'），两把锁互不阻塞。
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:redeem_code:' || v_uid, 0));

  v_norm := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  IF v_norm = '' THEN RETURN 'bad'; END IF;

  SELECT * INTO v_row FROM redeem_codes WHERE code = v_norm;
  IF NOT FOUND THEN RETURN 'bad'; END IF;
  IF v_row.used_by IS NOT NULL THEN RETURN 'used'; END IF;

  -- 🔴 档位合法性校验必须在「标记使用」之前：
  --   否则 months 被手工改坏的码会先被烧掉再发放失败，码永久作废且用户一无所获。
  --   约束已挡掉绝大多数组合，这里是防御性双保险（约束可被超级用户绕过/历史脏数据）。
  IF v_row.plan = 'lifetime' THEN
    IF v_row.months IS NOT NULL THEN RETURN 'bad'; END IF;
  ELSIF v_row.plan = 'pro' THEN
    IF v_row.months IS NULL OR v_row.months <= 0 OR v_row.months > 1200 THEN
      RETURN 'bad';
    END IF;
  ELSE
    RETURN 'bad';   -- 未知档位：宁可不发，绝不猜
  END IF;

  -- 原子标记使用（条件更新防并发重复兑换 —— 单码维度的保护，与上面的用户锁互补）
  UPDATE redeem_codes
     SET used_by = v_uid, used_at = now()
   WHERE id = v_row.id AND used_by IS NULL;
  IF NOT FOUND THEN RETURN 'used'; END IF;

  -- 权益写入不需要先 SELECT：下面的 ON CONFLICT DO UPDATE 里 `entitlements.*`
  -- 即冲突行的现值（PG 语义），CASE 直接在库内判定，省一次往返也无竞态窗口。
  IF v_row.plan = 'lifetime' THEN
    -- 终身买断：直接置顶（与 0012 原行为一致；0037:210-213 apple 侧同语义）
    INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
    VALUES (v_uid, 'lifetime', NULL, v_norm, 'redeem')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime',
          pro_until = NULL,
          redeemed_code = v_norm,
          source = 'redeem',
          updated_at = now();
  ELSE
    -- pro 限时档：沿用 0037:235-242 的 CASE 三分支语义（0037:226 的 GREATEST 用于
    --   「Apple 通知自带到期时间」的场景；本函数到期时间由库内 now()+months 现算，
    --   不存在乱序旧值，故用 CASE 而非 GREATEST，语义等价且更直白）：
    --   · 已是 lifetime → 不降级（买断优先级最高，source 也保留，同 0037:228）
    --   · pro 且未过期 → 在现有到期日基础上**顺延**（用户不该因提前续费而亏）
    --   · 其他（free / pro 已过期 / 无记录）→ 从当下起算
    --   「pro_until > now()」判断保证过期值不会成为顺延基点（等价于取 max(现值, now())）。
    INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
    VALUES (v_uid, 'pro',
            now() + make_interval(months => v_row.months), v_norm, 'redeem')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
          pro_until = CASE
            WHEN entitlements.plan = 'lifetime' THEN NULL                       -- 买断不降级
            WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
              THEN entitlements.pro_until + make_interval(months => v_row.months)  -- 未过期 → 顺延
            ELSE now() + make_interval(months => v_row.months)                  -- 已过期/免费 → 重新起算
          END,
          -- redeemed_code 与 source 同语义 =「当前权益由谁发放」。
          -- lifetime 用户兑 pro 码时权益**未被改变**，故两者都保留原值，否则会留下
          -- 「source=apple 但 code 是兑换码」的矛盾记录（兑换事实已由
          -- redeem_codes.used_by/used_at 存证，不靠这里）。同 0037:228 口径。
          redeemed_code = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.redeemed_code ELSE v_norm END,
          source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'redeem' END,
          updated_at = now();
  END IF;

  RETURN 'ok';
END;
$fn$;

-- 权限保持 0012 口径（0035:140 亦重申）：仅 authenticated 可执行，anon/PUBLIC 全撤
REVOKE ALL ON FUNCTION public.redeem_by_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_by_code(text) TO authenticated;

-- 🔴 表隔离：ENABLE RLS + REVOKE，但**不加 FORCE**（2026-11-06 服务器实测校准）
--   0012:86-88 原文写的是 ENABLE + FORCE + REVOKE，而生产实际基线是
--   `0030-full-selfhost-mirror.sql:425`：只有 ENABLE、无 FORCE
--   （实测 `pg_class`：rls=true / force=false）。本迁移保持生产现状，不重新引入 FORCE。
--
--   ⚠️ 更正一处我自己的过度断言（写这段时先判错、被红验证推翻，特此留档）：
--   我最初写「带 FORCE 会让函数读到 0 行 → 所有兑换码恒返回 bad」。
--   **这在今天的生产环境下是错的**：`redeem_by_code` 属主是 postgres，
--   实测 `rolsuper=true / rolbypassrls=true`，超级用户**无条件绕过 RLS**，
--   FORCE 与否都照样读到全部 3 行码。注入 FORCE 跑完整验收，功能项依然全绿。
--
--   FORCE 的真实边界（一次性探针库 dbee_force_probe 实测，四种组合）：
--     · 属主=超级用户 postgres + FORCE            → 无害（BYPASSRLS 优先）【今天】
--     · 属主=NOBYPASSRLS 角色  + 仅 ENABLE        → 正常（属主默认绕过 RLS）【0030 基线】
--     · 属主=NOBYPASSRLS 角色  + ENABLE + FORCE   → **0 行可见 = 兑换静默全废**【0012 字面】
--     · 属主=NOBYPASSRLS 角色  + FORCE + 宽松 policy → 正常（补 policy 即可救）
--
--   → 所以不加 FORCE 的理由是**不埋雷**，不是「加了立刻炸」：0039 的主题就是收紧
--     信任边界，将来若把权益函数属主从 postgres 迁到 dbee_app（0033 起 NOBYPASSRLS），
--     一个遗留的 FORCE 会让兑换码功能**无任何报错地整体失效**（全部返回 'bad'）。
--     这类故障离成因很远、且无日志，排查成本极高，故按最小惊讶原则与生产基线保持一致。
--   → 安全性不受影响：真正的防线是 REVOKE（实测 `role_table_grants` 对
--     authenticated/anon/PUBLIC 为空），ENABLE RLS + 零 policy 是对非属主角色的第二层兜底。
ALTER TABLE public.redeem_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.redeem_codes FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.redeem_by_code(text) IS
  '0044 · 兑换码核销：按码上 plan/months 发放（pro 顺延、lifetime 置顶不降级）。'
  '返回值恒为 ok/used/bad（刻意不用 JSON，见 0044 文件头兼容性说明）。';

-- ═══════════════════════════════════════════════════════════════════════
-- (c) 迁移追踪表登记 + PostgREST 重载
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0044: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0044', 'redeem-code-tiers', 'applied', 'self',
          'redeem_codes 增 plan/months + 组合 CHECK；redeem_by_code 按档发放'
          '（pro 顺延 GREATEST 语义 / lifetime 不降级）+ 用户级 advisory lock'
          '（防并发丢顺延）；RPC 签名与返回值(ok/used/bad)保持不变以兼容两端前端')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 执行后自检（只读，可逐条粘贴）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) 新列已存在且存量码全为 lifetime（第二列应为 0）：
--    SELECT count(*) AS total,
--           count(*) FILTER (WHERE plan <> 'lifetime') AS not_lifetime
--      FROM redeem_codes;
-- 2) 组合约束生效（应报 23514 check violation）：
--    INSERT INTO redeem_codes (code, plan, months) VALUES ('TEST-BAD-1', 'pro', NULL);
--    INSERT INTO redeem_codes (code, plan, months) VALUES ('TEST-BAD-2', 'lifetime', 3);
-- 3) 函数体已含锁与档位分支（三行均应为 t）：
--    SELECT (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'advisory_xact_lock') AS has_lock,
--           (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'make_interval')     AS has_interval,
--           (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'lifetime')          AS has_lifetime;
-- 4) 返回值仍是 text（未变成 json，兼容性关键）：
--    SELECT pg_get_function_result('public.redeem_by_code(text)'::regprocedure);
-- 5) 表隔离未被放宽（应无 authenticated 行）：
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'redeem_codes' AND grantee IN ('authenticated','anon','PUBLIC');
-- 6) FORCE 应保持 false（与 0030 生产基线一致；不为将来属主迁移埋雷，见 (b) 段末）：
--    SELECT relrowsecurity AS rls, relforcerowsecurity AS force_should_be_false
--      FROM pg_class WHERE oid = 'public.redeem_codes'::regclass;
--    期望：rls=t | force_should_be_false=f
--    📌 注意 false 在**今天**不代表兑换会坏（属主 postgres 是超级用户，绕过 RLS）；
--       这一项防的是「函数属主日后改为 NOBYPASSRLS 角色」时兑换静默全废。
-- 7) 函数属主能真正读到码（直接证明兑换没被 RLS 挡死）：
--    以 postgres 身份 SELECT count(*) FROM redeem_codes; 应 = 库存总数而非 0。
--
-- ═══════════════════════════════════════════════════════════════════════
-- 功能验收（需两个测试账号；在自建库执行，事后清理）
-- ═══════════════════════════════════════════════════════════════════════
-- A) pro 月卡顺延：先发两张月卡码，同一账号连兑两次，
--    pro_until 应约等于 now() + 2 个月（**不是 +1 个月** —— 这一条专门验证锁生效）。
-- B) 买断不降级：lifetime 账号兑月卡码 → plan 仍为 'lifetime'、pro_until 仍为 NULL。
-- C) 升级：pro 账号兑 lifetime 码 → plan='lifetime'、pro_until=NULL。
-- D) 坏码不烧：把某码 months 改成 NULL（超级用户绕过约束后）→ 兑换返回 'bad'
--    且该码 used_by 仍为 NULL（可修数据后重兑）。
-- 清理：DELETE FROM redeem_codes WHERE code LIKE 'TEST-%';
--       UPDATE entitlements SET plan='free', pro_until=NULL, source=NULL
--        WHERE owner_id IN (<测试账号>);
