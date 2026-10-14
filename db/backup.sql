-- D-Bee（自律蜜蜂）每日备份查询 —— 单条语句，返回整库逻辑快照
--
-- 用途：配合 WorkBuddy 云端 MCP 只读通道执行（applicationId = wbapp_w6iIU6TqTyHvJxESPTxBTy，mode=read），
--      把 7 张业务表聚合成一个 JSON 对象返回，再由调用方落盘为 db/backups/YYYY-MM-DD.json。
--
-- 为什么不本地直连：数据托管在 WorkBuddy 云服务的 PostgreSQL 上，且 anon 角色的表权限已在
-- 0001 补丁中撤销，本地脚本无可用凭据；平台 MCP 只读通道是唯一合规入口。
--
-- 数据量极小（每用户约 4200 行/年），因此每次做全量快照，不做增量。

SELECT json_build_object(
  'generated_at', now(),
  'source', 'workbuddy-cloud-postgres',
  'schema_ref', 'db/schema.sql',
  'tables', json_build_object(
    'profiles',      (SELECT coalesce(json_agg(p ORDER BY p.id), '[]'::json) FROM profiles p),
    'meal_entries',  (SELECT coalesce(json_agg(m ORDER BY m.id), '[]'::json) FROM meal_entries m),
    'water_logs',    (SELECT coalesce(json_agg(w ORDER BY w.id), '[]'::json) FROM water_logs w),
    'exercise_logs', (SELECT coalesce(json_agg(x ORDER BY x.id), '[]'::json) FROM exercise_logs x),
    'weight_logs',   (SELECT coalesce(json_agg(g ORDER BY g.id), '[]'::json) FROM weight_logs g),
    'entitlements',  (SELECT coalesce(json_agg(e ORDER BY e.id), '[]'::json) FROM entitlements e),
    'ai_usage',      (SELECT coalesce(json_agg(a ORDER BY a.id), '[]'::json) FROM ai_usage a)
  )
) AS dump;
