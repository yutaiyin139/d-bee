-- ═══════════════════════════════════════════════════════════════════════
-- 0048 · 兑换码安全加固：哈希存储 + 有效期 + 兑换节流
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-11-10 兑换码安全加固，回应华为 P1-E-1 已识别欠账）：
--
--   兑换码是 D-Bee 唯一一条已完整打通、可立即使用的变现/获客通道（华为官方
--   认可为合规的「自建赠送码表」），但它有三处已知安全欠账，都直接威胁资金安全：
--
--   ① **码明文存库**：0012 起 `redeem_codes.code` 存明文。DBA / 备份文件泄露 /
--     SQL 注入读取 = 攻击者直接给自己发终身会员。码等于钱，明文入库是硬伤。
--   ② **无有效期**：码一旦泄露永久有效，无法止损（发出去的码想作废都做不到）。
--   ③ **无兑换节流**：`redeem_by_code` 没有任何尝试频次限制（实测函数体无
--     throttle/attempt 字样），而 `bind_invite` 自 0012 起有 `invite_throttled`
--     （60s 内失败 ≥5 次即拒）。虽靠 2^80 码空间兜底，但纵深防御缺失。
--
--   本迁移一次性补齐三处，且**严格保持对外契约不变**：
--     · RPC 签名不变：`redeem_by_code(text) → text`
--     · 返回值不变：恒为 'ok' / 'used' / 'bad'（节流与过期均返回 'bad'，不新增值）
--       理由与 0044 文件头一致 —— `src/lib/api.ts:825` 与 `mini/src/lib/api.ts`
--       都写死 `r === 'ok' || r === 'used' ? r : 'bad'`，任何新返回值会被静默
--       降级成 'bad'，且双库升级有时间差，新增值会在窗口期制造「兑换成功却报失败」。
--     · 前端零改动：redeemByCode() 与 plan.tsx redeem() 均不需动。
--
-- ─── 哈希方案（为什么清空 code 列而非只加 code_hash 列）────────────────
--   只加 code_hash 列、核销用 hash 匹配，但**保留 code 明文列**，则「DBA/备份
--   泄露明文」风险依然存在 —— 等于没做。真正消除明文风险的唯一做法是：
--     ① 加 code_hash 列，存 SHA-256（hex，64 字符）
--     ② 存量回填 hash 后，**清空 code 列明文**（改可空 + drop UNIQUE）
--     ③ 核销函数改为 `code_hash = encode(digest(v_norm,'sha256'),'hex')` 匹配
--   核销时写回 entitlements.redeemed_code 用的是**入参 p_code 的明文**（用户
--   自己输入的码），不依赖从表读明文，故清空 code 列不影响核销链路。
--
--   🔴 为什么用 SHA-256 而非 pgcrypto 的 crypt()/bcrypt：
--     码空间 2^80（32^16），本身不可字典反查，无需慢哈希抗爆破；SHA-256 是
--     pgcrypto 内置 digest()，零额外依赖，且 deterministic（同一码 hash 唯一，
--     天然支持 UNIQUE 约束 + 等值索引）。慢哈希（bcrypt）反而让 UNIQUE 无法
--     建立在确定性值上。此处「不可逆 + 确定性」是正确诉求。
--
--   🔴 发码工具的码明文只落 `release/*.txt`（gitignore + chmod 600），库内仅存
--     hash；运营从文件发码给用户，用户输入明文 → 前端传 p_code → 服务端 hash
--     后匹配。这条链路上明文只出现在「发码文件」与「用户输入」两处，都不进库。
--
-- 执行方式：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0048-redeem-code-hardening.sql
-- 幂等：可重复执行（ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS +
--       CREATE OR REPLACE + CREATE TABLE IF NOT EXISTS）。
--
-- 🔴 双库对齐（0039 铁律）：`redeem_by_code` 是权益函数，改它必须双库同步。
--   · 自建库（主端 web/iOS/Android）→ 本文件
--   · 云库（mini 端默认后端）→ `db/cloud-patch-0048/*.sql`（逐语句拆分）
--   两库不一致的后果是四端行为分叉（一端能兑、另一端报 bad）。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 🔴 pgcrypto 扩展：digest() 依赖它。幂等（已存在则跳过）。
--   CREATE EXTENSION 需超级用户权限；执行本迁移的 postgres 角色即超级用户。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ═══════════════════════════════════════════════════════════════════════
-- (a) redeem_codes 加 code_hash + expires_at 列
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.redeem_codes
  ADD COLUMN IF NOT EXISTS code_hash text;

ALTER TABLE public.redeem_codes
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.redeem_codes.code_hash IS
  '0048 · 码的 SHA-256（hex，64 字符）。核销只按此匹配；码明文不再入库';
COMMENT ON COLUMN public.redeem_codes.expires_at IS
  '0048 · 码的有效期截止时间；NULL = 永久有效（存量码默认，向后兼容）';

-- ═══════════════════════════════════════════════════════════════════════
-- (b) 回填 code_hash（存量明文码 → hash），再清空 code 明文
-- ═══════════════════════════════════════════════════════════════════════
-- 顺序关键：先回填 hash（依赖 code 明文），再清空 code。若先清空则 hash 无从回填。

UPDATE public.redeem_codes
   SET code_hash = encode(digest(code, 'sha256'), 'hex')
 WHERE code_hash IS NULL
   AND code IS NOT NULL;

-- 回填后 code_hash 必须 NOT NULL + UNIQUE（hash 是确定性值，天然可唯一索引）
ALTER TABLE public.redeem_codes
  ALTER COLUMN code_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS redeem_codes_code_hash_uidx
  ON public.redeem_codes (code_hash);

-- 清空 code 明文：先解除 NOT NULL 与 UNIQUE 约束，再置 NULL。
-- 0012 建表的 inline UNIQUE 约束名默认为 redeem_codes_code_key。
ALTER TABLE public.redeem_codes
  ALTER COLUMN code DROP NOT NULL;
ALTER TABLE public.redeem_codes
  DROP CONSTRAINT IF EXISTS redeem_codes_code_key;
UPDATE public.redeem_codes SET code = NULL;

COMMENT ON COLUMN public.redeem_codes.code IS
  '0048 · 已弃用：明文码不再入库（安全加固），恒为 NULL。核销改走 code_hash';

-- ═══════════════════════════════════════════════════════════════════════
-- (c) 兑换尝试节流表 + 判定函数（复用 0012 invite_attempts 手法）
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.redeem_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    text        NOT NULL,
  ok          boolean     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.redeem_attempts IS
  '0048 · 兑换尝试记录（只记成功/失败，不记码明文/码 hash），供节流判定';

CREATE INDEX IF NOT EXISTS redeem_attempts_owner_created_idx
  ON public.redeem_attempts (owner_id, created_at);

-- 与 invite_attempts 同款隔离：authenticated 不得直读/直写，只经 SECURITY DEFINER 函数
ALTER TABLE public.redeem_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.redeem_attempts FROM PUBLIC, anon, authenticated;

-- 节流判定：最近 60 秒内失败 ≥5 次则拒绝（返回 true = 被限流）
CREATE OR REPLACE FUNCTION public.redeem_throttled(p_owner text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_fail integer;
BEGIN
  SELECT count(*) INTO v_fail
    FROM redeem_attempts
   WHERE owner_id = p_owner
     AND ok = false
     AND created_at > now() - interval '60 seconds';
  RETURN v_fail >= 5;
END;
$fn$;

REVOKE ALL ON FUNCTION public.redeem_throttled(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_throttled(text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (d) redeem_by_code：hash 匹配 + 有效期检查 + 节流（返回值不变）
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0044 版（含用户级 advisory lock + 档位分支 + pro 顺延）。
-- 改动：
--   ① 查码由 `WHERE code = v_norm` 改为 `WHERE code_hash = encode(digest(v_norm,'sha256'),'hex')`
--   ② 入口加节流检查（失败 60s≥5 次即返回 'bad'）
--   ③ 查码命中后检查 expires_at 是否已过期（过期返回 'bad'，且不烧码、不记成功）
--   ④ 每次尝试（无论成败）写 redeem_attempts（节流判定的数据源）
--   其余（advisory lock / 档位校验 / 标记使用 / 权益写入 / 返回值）全部保持 0044 语义不变。
CREATE OR REPLACE FUNCTION public.redeem_by_code(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid    text := auth.uid();
  v_norm   text;
  v_hash   text;
  v_row    redeem_codes%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN 'bad'; END IF;

  -- 🔴 用户级事务锁：串行化同一用户的并发兑换（0044 保留，防 pro 顺延丢更新）
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:redeem_code:' || v_uid, 0));

  v_norm := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  IF v_norm = '' THEN RETURN 'bad'; END IF;

  -- 🔴 节流检查（0048 新增）：失败尝试过多即拒，不进入查码/发码流程。
  --   返回 'bad' 与「码不对」同值，不向爆破者泄露「码正确但被限流」的信息。
  IF redeem_throttled(v_uid) THEN
    RETURN 'bad';
  END IF;

  -- 🔴 查码改按 hash 匹配（0048 变更）：码明文不再入库，只比 SHA-256。
  v_hash := encode(digest(v_norm, 'sha256'), 'hex');
  SELECT * INTO v_row FROM redeem_codes WHERE code_hash = v_hash;
  IF NOT FOUND THEN
    -- 记一次失败尝试（节流数据源）；不记码明文，只记 ok=false
    INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
    RETURN 'bad';
  END IF;

  IF v_row.used_by IS NOT NULL THEN
    -- 码已被用过：也记一次失败（防止用「已用码」刷接口探测存活）
    INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
    RETURN 'used';
  END IF;

  -- 🔴 有效期检查（0048 新增）：过期码返回 'bad'，不烧码（码本身仍有效可查，
  --   只是过了可兑换窗口），也不记成功。
  IF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
    INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
    RETURN 'bad';
  END IF;

  -- 🔴 档位合法性校验必须在「标记使用」之前（0044 保留：坏码不烧）
  IF v_row.plan = 'lifetime' THEN
    IF v_row.months IS NOT NULL THEN
      INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
      RETURN 'bad';
    END IF;
  ELSIF v_row.plan = 'pro' THEN
    IF v_row.months IS NULL OR v_row.months <= 0 OR v_row.months > 1200 THEN
      INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
      RETURN 'bad';
    END IF;
  ELSE
    INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
    RETURN 'bad';   -- 未知档位：宁可不发，绝不猜
  END IF;

  -- 原子标记使用（条件更新防并发重复兑换 —— 单码维度的保护，与用户锁互补）
  UPDATE redeem_codes
     SET used_by = v_uid, used_at = now()
   WHERE id = v_row.id AND used_by IS NULL;
  IF NOT FOUND THEN
    INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, false);
    RETURN 'used';
  END IF;

  -- 权益写入（0044 语义完全不变：lifetime 置顶不降级 / pro 顺延）
  IF v_row.plan = 'lifetime' THEN
    INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
    VALUES (v_uid, 'lifetime', NULL, v_norm, 'redeem')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime',
          pro_until = NULL,
          redeemed_code = v_norm,
          source = 'redeem',
          updated_at = now();
  ELSE
    INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
    VALUES (v_uid, 'pro',
            now() + make_interval(months => v_row.months), v_norm, 'redeem')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
          pro_until = CASE
            WHEN entitlements.plan = 'lifetime' THEN NULL
            WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
              THEN entitlements.pro_until + make_interval(months => v_row.months)
            ELSE now() + make_interval(months => v_row.months)
          END,
          redeemed_code = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.redeemed_code ELSE v_norm END,
          source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'redeem' END,
          updated_at = now();
  END IF;

  -- 记一次成功尝试（清空失败计数依赖「只记 ok=false」的语义）
  INSERT INTO redeem_attempts (owner_id, ok) VALUES (v_uid, true);

  RETURN 'ok';
END;
$fn$;

-- 权限保持 0012 口径：仅 authenticated 可执行，anon/PUBLIC 全撤
REVOKE ALL ON FUNCTION public.redeem_by_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_by_code(text) TO authenticated;

-- 表隔离保持 0044 口径（ENABLE RLS + REVOKE，不加 FORCE，理由见 0044 文件头）
ALTER TABLE public.redeem_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.redeem_codes FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.redeem_by_code(text) IS
  '0048 · 兑换码核销（安全加固版）：按 code_hash 匹配 + expires_at 有效期检查'
  ' + redeem_attempts 节流（60s 失败≥5 次拒）。'
  '返回值恒为 ok/used/bad（刻意不用 JSON，见 0044 文件头兼容性说明）。';

-- ═══════════════════════════════════════════════════════════════════════
-- (e) 迁移追踪表登记 + PostgREST 重载
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0048: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0048', 'redeem-code-hardening', 'applied', 'self',
          '兑换码安全加固：code_hash 哈希存储（清空 code 明文）+ expires_at 有效期'
          ' + redeem_attempts 节流（60s 失败≥5 次拒）。RPC 签名与返回值保持不变')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 执行后自检（只读，可逐条粘贴）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) code_hash 已回填且非空（第二列应为 0）；code 明文已清空（第三列应为 0）：
--    SELECT count(*) AS total,
--           count(*) FILTER (WHERE code_hash IS NULL) AS no_hash,
--           count(*) FILTER (WHERE code IS NOT NULL) AS still_plaintext
--      FROM redeem_codes;
-- 2) code_hash 唯一索引已建：
--    SELECT indexname FROM pg_indexes WHERE tablename='redeem_codes' AND indexname='redeem_codes_code_hash_uidx';
-- 3) 函数体已含 hash 匹配 + 有效期 + 节流（三行均应为 t）：
--    SELECT (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'digest') AS has_digest,
--           (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'expires_at') AS has_expires,
--           (pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'redeem_throttled') AS has_throttle;
-- 4) 返回值仍是 text（兼容性关键）：
--    SELECT pg_get_function_result('public.redeem_by_code(text)'::regprocedure);
-- 5) redeem_attempts 表隔离（应无 authenticated 行）：
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'redeem_attempts' AND grantee IN ('authenticated','anon','PUBLIC');
-- 6) 函数属主能真正读到码（hash 匹配不依赖 RLS 挡死）：
--    以 postgres 身份 SELECT count(*) FROM redeem_codes; 应 = 库存总数而非 0。
--
-- ═══════════════════════════════════════════════════════════════════════
-- 功能验收（需两个测试账号；在自建库执行，事后清理）
-- ═══════════════════════════════════════════════════════════════════════
-- A) 正常核销：发一张码（工具已写 code_hash），用户输明文码 → 返回 'ok'，权益生效。
-- B) 码不存在：随便输一个不存在的码 → 'bad'（且 redeem_attempts 记失败）。
-- C) 已用码：同一码第二次兑 → 'used'。
-- D) 过期码：把某码 expires_at 设为过去 → 'bad'（且 used_by 仍 NULL，码未烧）。
-- E) 节流：同一账号连输 5 次错码 → 第 6 次起即使输入正确码也返回 'bad'（限流生效）。
-- 清理：DELETE FROM redeem_codes WHERE code_hash = encode(digest('<明文>','sha256'),'hex');
--       DELETE FROM redeem_attempts WHERE owner_id IN (<测试账号>);
--       UPDATE entitlements SET plan='free', pro_until=NULL, source=NULL
--        WHERE owner_id IN (<测试账号>);
