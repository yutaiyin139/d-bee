-- ════════════════════════════════════════════════════════════════════════════
-- 补丁 0001 · 性能索引 + 权限收紧
-- ════════════════════════════════════════════════════════════════════════════
--
-- 状态：✅ 已执行 —— 2026-10-13
-- 依据：2026-10-13 对线上库的导出与审计（见 db/schema.sql 文末清单）
-- 影响：纯增量（加索引 + 收权限），不改表结构、不动数据、不改 RLS 语义
-- 回滚：文末附回滚语句
--
-- 执行记录（4 条语句，逐条 migrate 应用，全部成功）：
--   1) CREATE INDEX meal_entries_owner_id_log_date_idx   ✓
--   2) CREATE INDEX water_logs_owner_id_log_date_idx     ✓
--   3) CREATE INDEX exercise_logs_owner_id_log_date_idx  ✓
--   4) REVOKE ALL ON <7 张表> FROM anon                   ✓
-- 执行后复验：
--   · pg_indexes 三个索引存在，定义正确（btree (owner_id, log_date)）
--   · role_table_grants 中 anon 对 7 张表已无任何权限行
--   · has_table_privilege('anon', <表>, 'SELECT') 全部 false
--   · has_table_privilege('authenticated', <表>, {SELECT,INSERT,UPDATE,DELETE}) 全部 true
--   · pg_policies 16 条策略完好，RLS 语义未受影响
--   · HTTP 实测：未登录 GET /.cloud/database/rest/meal_entries?select=*
--     → 401 DATABASE_42501 "permission denied for table meal_entries"（符合预期）
--   · 浏览器回归 verify-live / verify-legal 双 PASS
--
-- ⚠️ 连带修复（本补丁暴露的上游问题，改动在应用层不在数据库）：
--   撤销 anon 权限后，未登录首页原本那个「读 entitlements」的请求从
--   「200 空数组」变成「401」，在浏览器控制台留下红字报错。
--   根因：src/state/plan.tsx 的 PlanProvider 挂在 App 最外层（连登录页也包着），
--   挂载即无条件读云端 —— 而 fetch 的 401 无法被 JS 的 try/catch 消除。
--   已修正为：权益状态跟随登录态（订阅 onAuthStateChange，未登录直接跳过），
--   顺带修掉「登录后权益不刷新、必须整页刷新才生效」的既存缺陷。
--   修正后实测：未登录时云端数据请求数 = 0、console 错误 = 0。
--
-- 为什么当时立即做：当前库只有 3 用户 / 6 行，加索引是**瞬时**的；
--                    一旦有真实用户（哪怕几百人），建索引就要考虑锁表窗口了。
-- ════════════════════════════════════════════════════════════════════════════


-- ── A. 性能索引 ─────────────────────────────────────────────────────────────
-- 现状：meal_entries / water_logs / exercise_logs 只有主键索引，
--      而 App 最高频的查询是「某用户某天」或「某用户某区间」：
--        listMealsByDate(owner_id, log_date)
--        listMealsBetween(owner_id, start, end)
--        listWaterByDate / listExerciseByDate
--      没有复合索引 → 全表扫描。行数少时无感，上万行后每次开屏都要扫全表。
--
-- 参照 weight_logs 已有的 UNIQUE (owner_id, log_date) 的排序方式（owner_id 在前）。

CREATE INDEX IF NOT EXISTS meal_entries_owner_id_log_date_idx
  ON public.meal_entries (owner_id, log_date);

CREATE INDEX IF NOT EXISTS water_logs_owner_id_log_date_idx
  ON public.water_logs (owner_id, log_date);

CREATE INDEX IF NOT EXISTS exercise_logs_owner_id_log_date_idx
  ON public.exercise_logs (owner_id, log_date);

-- 说明：meal_entries 的区间查询（报表页要按日期范围取数）也由同一复合索引覆盖，
--      owner_id 等值 + log_date 范围扫描走同一条索引，无需额外加 log_date 单列索引。


-- ── B. 撤销 anon 的表权限（由单层防护升级为双层）──────────────────────────
-- 现状：anon（未登录）对全部 7 张表持有 SELECT/INSERT/UPDATE/DELETE。
--       安全性完全依赖 RLS —— 因为未登录时 auth.uid() 为 NULL，
--       而 owner_id = NULL 的结果是 NULL（不是 TRUE），策略永远不匹配。
--       这**不是漏洞**，但意味着没有第二道防线：
--       任何一张表的 RLS 被误关（ALTER TABLE ... DISABLE ROW LEVEL SECURITY）
--       或被写出错误的策略，该表全部数据立即对未登录者开放。
--
-- 本 App 的表全部是私有数据，没有任何需要匿名读取的内容
-- （认证走 /auth/ 端点，不经过这些表），因此可以安全撤销。

REVOKE ALL ON public.profiles,
              public.meal_entries,
              public.weight_logs,
              public.water_logs,
              public.exercise_logs,
              public.entitlements,
              public.ai_usage
  FROM anon;


-- ── C. 后续建表的流程纪律（非 SQL，抄进 checklist）────────────────────────
-- 平台在 CREATE TABLE 时会自动给 anon 播撒权限。因此**每新建一张表后**，
-- 都要补两步，否则会重现 B 中的单层防护状态：
--   1) REVOKE ALL ON public.<新表> FROM anon;
--   2) 确认 GRANT 到 authenticated（漏 GRANT 会得到 42501）
-- 不建议依赖 ALTER DEFAULT PRIVILEGES：它绑定到执行建表的角色，
-- 而平台建表用的角色不在我们控制范围内，写了可能不生效（会给人虚假的安全感）。


-- ════════════════════════════════════════════════════════════════════════════
-- 回滚
-- ════════════════════════════════════════════════════════════════════════════
-- DROP INDEX IF EXISTS public.meal_entries_owner_id_log_date_idx;
-- DROP INDEX IF EXISTS public.water_logs_owner_id_log_date_idx;
-- DROP INDEX IF EXISTS public.exercise_logs_owner_id_log_date_idx;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.meal_entries,
--       public.weight_logs, public.water_logs, public.exercise_logs,
--       public.entitlements, public.ai_usage TO anon;
-- ════════════════════════════════════════════════════════════════════════════
