-- ═══════════════════════════════════════════════════════════════════════
-- 0036 · 数据补齐：云库（workbuddy-cloud-postgres）→ 服务器 dbee 单向增量同步
--
-- 背景（2026-10-23 核查）：
--   服务器 150.158.51.106 的 dbee 库，数据来自 2026-10-20 21:07 的 full-export 快照
--   （db/backups/full-export/*.json，17 表）。此后**前端数据面仍连在云库**，云库继续
--   增长到 2026-10-23 12:13（honey_ledger 已到 id=280、ai_quota_claims 到 id=33）。
--   因此服务器 dbee 相对云库存在「10-20 之后的增量」漂移。
--
--   本迁移就是把这段漂移**单向**补进服务器 dbee，使其与云库全表一致，为「各端切到
--   服务器 PG、随后释放云库」做数据落地。方向是云库→服务器，绝不反向。
--
-- ─── 漂移清单（按主键 id 精确比对，云库是 seed 的严格超集）──────────────
--   INSERT 38 行：
--     · meal_entries     87–101                       (15)
--     · water_logs       23–28                        (6)
--     · exercise_logs    17,18                        (2)
--     · honey_ledger     253,262,269,273,280          (5)
--     · ai_quota_claims  27–33                        (7)
--     · ai_usage         55,57,59                     (3)
--   UPDATE 2 行（seed 里已有、云库后被改写）：
--     · profiles id=2    ai_consented NULL→true, health_connected_at 10-18→10-21,
--                        updated_at 10-20→10-21（health_connected 两侧都是 true，不动）
--     · ai_usage id=52   count 2→3（owner 2109869577155379200, usage_date 2026-10-20）
--   DELETE 0 行：云库无任何行被删除，故本迁移不含删除，也不需处理「服务器有云库无」。
--
-- ─── 数据来源与可信度 ──────────────────────────────────────────────────
--   下面每一条 INSERT 的 VALUES，都是由**云库自身**用
--     jsonb_each_text(to_jsonb(t)) + WITH ORDINALITY + quote_literal
--   在线生成的（见本文件末尾「生成方式」注释），不是手工转录。这样中文食物名、
--   ai_note、时间戳精度都不会因人工誊写出错。
--
-- ─── 关键设计点 ────────────────────────────────────────────────────────
--   1) OVERRIDING SYSTEM VALUE：所有目标表主键都是
--      `bigint GENERATED ALWAYS AS IDENTITY`，显式写 id 必须带这个子句，否则报错
--      "cannot insert a non-DEFAULT value into column"。
--   2) ON CONFLICT DO NOTHING：幂等。重复执行本文件不会因主键/唯一键冲突而失败
--      （honey_ledger 有部分唯一索引 honey_ledger_once(owner_id,reason,ref_id)，
--       ai_usage 有 UNIQUE(owner_id,usage_date,feature)，DO NOTHING 一并覆盖）。
--   3) date/timestamptz 字面量：由 jsonb_each_text 产出，date 是干净的 '2026-10-20'，
--      timestamptz 带 +08:00 偏移，落库后按 UTC 归一，跨库一致。
--   4) 单事务 + 末尾 setval：全表同步序列，避免后续自增撞已写入的最大 id。
--   5) 非破坏：不 DELETE、不 TRUNCATE，只补缺失的 INSERT 与两处确定的 UPDATE。
--
-- ─── 执行方式（先备份！）───────────────────────────────────────────────
--   sudo -u postgres pg_dump -d dbee -F c -f /opt/dbee-db/backup-before-0036.dump
--   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='…' \
--     bash deploy/sync-mirror.sh 0036-data-sync-from-cloud.sql
--   跑完执行文件末尾「校验段」的 SELECT，与云库基线逐项比对（哈希全等即迁移成功）。
--
-- 幂等：可重复执行。INSERT 走 ON CONFLICT DO NOTHING；UPDATE 是确定值赋值。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- (1) meal_entries 87–101（15 行）
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('87','0.3','180.0','25.0','photo','富含纤维，有助于增加饱腹感','4.3','94.0','2026-10-20','2109869577155379200','苹果',NULL,'snack','0.5','2','2026-10-20T21:10:23.602721+08:00','85',NULL,'1 个（180 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('88','0.4','120.0','27.4','photo','能量适中，含钾丰富，适合加餐','3.1','107.0','2026-10-20','2109869577155379200','香蕉',NULL,'snack','1.3','1','2026-10-20T21:10:23.602721+08:00','80',NULL,'1 根（120 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('89','10.2','20.0','4.0','photo','脂肪含量较高，建议控制食用量','1.7','116.0','2026-10-20','2109869577155379200','葵花籽',NULL,'snack','4.2','2','2026-10-20T21:10:23.602721+08:00','55',NULL,'一小把（20 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('90','0.4','200.0','27.2','photo','水分足纤维多，适合加餐','6.2','102.0','2026-10-21','2109869577155379200','梨',NULL,'breakfast','0.8','4','2026-10-21T09:51:39.527526+08:00','85',NULL,'1 个（200 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('91','0.2','120.0','13.2','photo','富含维生素C，糖分适量','2.2','53.0','2026-10-21','2109869577155379200','橘子',NULL,'breakfast','0.9','2','2026-10-21T09:51:39.527526+08:00','80',NULL,'1 个（120 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('92','0.1','100.0','11.2','photo','低热量高水分，富含膳食纤维','2.6','44.0','2026-10-21','2109869577155379200','梨',NULL,'lunch','0.4','2','2026-10-21T13:26:22.45947+08:00','88',NULL,'半个（100 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('93','5.0','50.0','0.6','photo','优质蛋白，水煮低油适合减脂',NULL,'72.0','2026-10-22','2109869577155379200','水煮蛋',NULL,'breakfast','6.5','70','2026-10-22T07:49:58.292213+08:00','90',NULL,'1 个（50 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('94','0.1','10.0','5.0','photo','淀粉类坚果，碳水较高适量食用','0.7','22.0','2026-10-22','2109869577155379200','板栗',NULL,'breakfast','0.4','1','2026-10-22T07:49:58.292213+08:00','70',NULL,'1 颗（10 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('95','9.0','60.0','30.0','photo','高油高糖烘焙品，减脂期少吃','0.4','220.0','2026-10-22','2109869577155379200','蛋糕卷',NULL,'breakfast','3.8','80','2026-10-22T07:49:58.292213+08:00','35','14','1 段（60 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('96','0.5','150.0','34.0','photo','天然水果，熟透含糖较高','2.4','135.0','2026-10-22','2109869577155379200','香蕉',NULL,'lunch','1.6','1','2026-10-22T12:22:36.621993+08:00','75',NULL,'1 根（150 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('97','0.3','200.0','26.0','photo','高纤维低热量，适合减脂','3.6','104.0','2026-10-22','2109869577155379200','苹果',NULL,'lunch','0.6','2','2026-10-22T12:22:36.621993+08:00','85',NULL,'1 个（200 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('98','17.0','150.0','42.0','photo','加工快餐，钠和油脂偏高','2','400.0','2026-10-22','2109869577155379200','KFC芝鸡帕尼尼（轻盈版）',NULL,'lunch','18.0','780','2026-10-22T12:22:36.621993+08:00','45','3','1 份（150 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('99','2.5','300.0','4.0','photo','汤清淡但钠较高，喝汤适量','1','60.0','2026-10-23','2109869577155379200','紫菜蛋花汤',NULL,'breakfast','4.5','600','2026-10-23T07:41:37.342872+08:00','70',NULL,'1 碗（300 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('100','0.7','20.0','10.0','photo','精制碳水，纤维少易升糖','0.6','55.0','2026-10-23','2109869577155379200','白吐司',NULL,'breakfast','1.8','110','2026-10-23T07:41:37.342872+08:00','55','1.5','半片（20 克）') ON CONFLICT DO NOTHING;
INSERT INTO public.meal_entries (id,fat_g,grams,carb_g,source,ai_note,fiber_g,calories,log_date,owner_id,food_name,image_url,meal_type,protein_g,sodium_mg,created_at,health_score,added_sugar_g,quantity_text) OVERRIDING SYSTEM VALUE VALUES ('101','16.0','350.0','75.0','photo','汤底红油盐分高，建议少喝汤','2.5','520.0','2026-10-23','2109869577155379200','刀削面（红汤）',NULL,'lunch','14.0','1800','2026-10-23T12:13:27.746396+08:00','45','3','1 碗（350 克）') ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- (2) water_logs 23–28（6 行）
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.water_logs (id,log_date,owner_id,amount_ml,created_at) OVERRIDING SYSTEM VALUE VALUES ('23','2026-10-21','2109869577155379200','250','2026-10-21T13:27:16.72338+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.water_logs (id,log_date,owner_id,amount_ml,created_at) OVERRIDING SYSTEM VALUE VALUES ('24','2026-10-21','2109869577155379200','250','2026-10-21T13:27:18.056651+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.water_logs (id,log_date,owner_id,amount_ml,created_at) OVERRIDING SYSTEM VALUE VALUES ('25','2026-10-21','2109869577155379200','250','2026-10-21T13:27:20.547563+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.water_logs (id,log_date,owner_id,amount_ml,created_at) OVERRIDING SYSTEM VALUE VALUES ('26','2026-10-23','2109869577155379200','250','2026-10-23T12:13:37.483149+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.water_logs (id,log_date,owner_id,amount_ml,created_at) OVERRIDING SYSTEM VALUE VALUES ('27','2026-10-23','2109869577155379200','250','2026-10-23T12:13:38.717683+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.water_logs (id,log_date,owner_id,amount_ml,created_at) OVERRIDING SYSTEM VALUE VALUES ('28','2026-10-23','2109869577155379200','250','2026-10-23T12:13:41.645974+08:00') ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- (3) exercise_logs 17,18（2 行）
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.exercise_logs (id,name,minutes,calories,log_date,owner_id,created_at) OVERRIDING SYSTEM VALUE VALUES ('17','散步','30','100.0','2026-10-21','2109869577155379200','2026-10-21T13:27:14.497802+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.exercise_logs (id,name,minutes,calories,log_date,owner_id,created_at) OVERRIDING SYSTEM VALUE VALUES ('18','散步','30','100.0','2026-10-23','2109869577155379200','2026-10-23T12:13:47.864505+08:00') ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- (4) honey_ledger 253,262,269,273,280（5 行，蜜糖打卡奖励）
--     ⚠️ 这几行是 7 表白名单备份（2026-10-23.json）**看不到**的漂移，
--        只能从云库在线导出得到——这正是必须连云库补数据的原因。
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.honey_ledger (id,amount,reason,ref_id,owner_id,created_at,expires_at) OVERRIDING SYSTEM VALUE VALUES ('253','5','checkin_meal','2026-10-21','2109869577155379200','2026-10-21T09:51:40.364967+08:00','2027-10-21T09:51:40.364967+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.honey_ledger (id,amount,reason,ref_id,owner_id,created_at,expires_at) OVERRIDING SYSTEM VALUE VALUES ('262','2','checkin_exercise','2026-10-21','2109869577155379200','2026-10-21T13:27:15.18058+08:00','2027-10-21T13:27:15.18058+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.honey_ledger (id,amount,reason,ref_id,owner_id,created_at,expires_at) OVERRIDING SYSTEM VALUE VALUES ('269','5','checkin_meal','2026-10-22','2109869577155379200','2026-10-22T07:49:59.02954+08:00','2027-10-22T07:49:59.02954+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.honey_ledger (id,amount,reason,ref_id,owner_id,created_at,expires_at) OVERRIDING SYSTEM VALUE VALUES ('273','5','checkin_meal','2026-10-23','2109869577155379200','2026-10-23T07:41:38.103366+08:00','2027-10-23T07:41:38.103366+08:00') ON CONFLICT DO NOTHING;
INSERT INTO public.honey_ledger (id,amount,reason,ref_id,owner_id,created_at,expires_at) OVERRIDING SYSTEM VALUE VALUES ('280','2','checkin_exercise','2026-10-23','2109869577155379200','2026-10-23T12:13:48.553565+08:00','2027-10-23T12:13:48.553565+08:00') ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- (5) ai_quota_claims 27–33（7 行，拍照额度预占 token）
--     ⚠️ 本表 FORCE ROW LEVEL SECURITY + REVOKE authenticated，只能经
--        SECURITY DEFINER 函数或直接以 owner/postgres 身份写。本迁移以
--        postgres 身份执行（sync-mirror.sh 用 sudo -u postgres psql），
--        绕过 RLS，可直接 INSERT。released_at 全 NULL（这些 token 未退还）。
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('27','be01f46043017ad442da5b0641c21696','1','scan',NULL,'2109869577155379200','2026-10-20T21:10:18.560758+08:00','2026-10-20',NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('28','96875cdd8f88305ffbc5754c22458dee','1','scan',NULL,'2109869577155379200','2026-10-21T09:51:34.983308+08:00','2026-10-21',NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('29','e900876a3c658bd48f9617927fc8d7a8','1','scan',NULL,'2109869577155379200','2026-10-21T13:26:18.230289+08:00','2026-10-21',NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('30','103493b9c84b1b82f938901a88c55153','1','scan',NULL,'2109869577155379200','2026-10-22T07:49:32.344408+08:00','2026-10-22',NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('31','febafe11489e4ad9c3e8d2f89269d582','1','scan',NULL,'2109869577155379200','2026-10-22T12:22:24.751007+08:00','2026-10-22',NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('32','97209484780f18926e30ff28e63cd893','1','scan',NULL,'2109869577155379200','2026-10-23T07:41:26.60548+08:00','2026-10-23',NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.ai_quota_claims (id,token,amount,feature,bonus_id,owner_id,created_at,usage_date,released_at) OVERRIDING SYSTEM VALUE VALUES ('33','083ecd8537818e4f4f2759ce1a38f4de','1','scan',NULL,'2109869577155379200','2026-10-23T12:13:12.349348+08:00','2026-10-23',NULL) ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- (6) ai_usage 55,57,59（3 行，10-21/22/23 的拍照计数）
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.ai_usage (id,count,feature,owner_id,created_at,usage_date) OVERRIDING SYSTEM VALUE VALUES ('55','2','scan','2109869577155379200','2026-10-21T09:51:34.983308+08:00','2026-10-21') ON CONFLICT DO NOTHING;
INSERT INTO public.ai_usage (id,count,feature,owner_id,created_at,usage_date) OVERRIDING SYSTEM VALUE VALUES ('57','2','scan','2109869577155379200','2026-10-22T07:49:32.344408+08:00','2026-10-22') ON CONFLICT DO NOTHING;
INSERT INTO public.ai_usage (id,count,feature,owner_id,created_at,usage_date) OVERRIDING SYSTEM VALUE VALUES ('59','2','scan','2109869577155379200','2026-10-23T07:41:26.60548+08:00','2026-10-23') ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- (7) UPDATE：两处 seed 已有、云库后被改写的行
-- ═══════════════════════════════════════════════════════════════════════
-- 7a) profiles id=2（owner 2109869577155379200，即主账号）
--     漂移列：ai_consented NULL→true；health_connected_at 10-18→10-21；updated_at 10-20→10-21。
--     health_connected 两侧都是 true，不在 SET 里（避免无谓写）。
--     用 WHERE id=2 AND updated_at < '2026-10-21...' 守卫：只在服务器仍是旧值时更新，
--     若已被更新过（幂等重跑）则 0 行命中，无副作用。
UPDATE public.profiles
   SET ai_consented       = true,
       health_connected_at = '2026-10-21T11:53:18.046+08:00',
       updated_at          = '2026-10-21T11:53:18.5+08:00'
 WHERE id = 2
   AND updated_at < '2026-10-21T11:53:18.5+08:00';

-- 7b) ai_usage id=52（owner 2109869577155379200, usage_date 2026-10-20）
--     漂移列：count 2→3。这是当日拍照第 3 次落在云库、服务器 seed 停在 2。
--     守卫 count < 3：幂等，且不回退（万一服务器已更高则不动）。
UPDATE public.ai_usage
   SET count = 3
 WHERE id = 52
   AND count < 3;

-- ═══════════════════════════════════════════════════════════════════════
-- (8) 同步 IDENTITY 序列：显式写过 id，必须 setval，否则后续自增撞主键
--     对全部 17 表统一处理（coalesce 保证空表也不报错，取 1 且 is_called=false）。
-- ═══════════════════════════════════════════════════════════════════════
SELECT setval(pg_get_serial_sequence('public.profiles',        'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.profiles;
SELECT setval(pg_get_serial_sequence('public.meal_entries',    'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.meal_entries;
SELECT setval(pg_get_serial_sequence('public.weight_logs',     'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.weight_logs;
SELECT setval(pg_get_serial_sequence('public.water_logs',      'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.water_logs;
SELECT setval(pg_get_serial_sequence('public.exercise_logs',   'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.exercise_logs;
SELECT setval(pg_get_serial_sequence('public.entitlements',    'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.entitlements;
SELECT setval(pg_get_serial_sequence('public.ai_usage',        'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.ai_usage;
SELECT setval(pg_get_serial_sequence('public.ai_quota_claims', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.ai_quota_claims;
SELECT setval(pg_get_serial_sequence('public.quota_bonus',     'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.quota_bonus;
SELECT setval(pg_get_serial_sequence('public.honey_ledger',    'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.honey_ledger;
SELECT setval(pg_get_serial_sequence('public.badges',          'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.badges;
SELECT setval(pg_get_serial_sequence('public.invite_links',    'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.invite_links;
SELECT setval(pg_get_serial_sequence('public.invite_attempts', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.invite_attempts;
SELECT setval(pg_get_serial_sequence('public.payment_products','id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.payment_products;
SELECT setval(pg_get_serial_sequence('public.payment_orders',  'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.payment_orders;
SELECT setval(pg_get_serial_sequence('public.redeem_codes',    'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.redeem_codes;
SELECT setval(pg_get_serial_sequence('public.recipes',         'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.recipes;

-- ═══════════════════════════════════════════════════════════════════════
-- (9) 登记追踪表（0034 建的），与 0035 同范式
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0036: public.schema_migrations 不存在（0034 未应用），跳过追踪表登记';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0036', 'data-sync-from-cloud', 'applied', 'self',
          '云库→服务器单向增量补齐：38 行 INSERT（meal_entries/water_logs/exercise_logs/'
          'honey_ledger/ai_quota_claims/ai_usage）+ 2 行 UPDATE（profiles id=2、ai_usage id=52）'
          '+ 全 17 表 setval。云库为 seed 严格超集，无 DELETE。')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 校验段（只读，服务器执行后与云库基线逐项比对；全等即迁移成功）
-- ═══════════════════════════════════════════════════════════════════════
-- 云库基线（2026-10-23 12:13 快照，本轮在线测得）：
--
--   行数 / maxid：
--     meal_entries    97 / 101        water_logs       28 / 28
--     exercise_logs   17 / 18         honey_ledger     28 / 280
--     ai_quota_claims 33 / 33         ai_usage         17 / 59
--     quota_bonus     11 / 11         profiles         17 / 18
--     weight_logs      3 /  3         badges            4 / 30
--     invite_links     4 / 10         invite_attempts   1 /  2
--     payment_products 3 /  3         redeem_codes      3 /  3
--     entitlements     0 / -          payment_orders    0 / -    recipes 0 / -
--
--   数值聚合（时区无关）：
--     meal_entries   sum(calories)=16512.0   sum(grams)=14050.0
--     water_logs     sum(amount_ml)=9250
--     exercise_logs  sum(minutes)=530        sum(calories)=2550.0
--     honey_ledger   sum(amount)=409
--     ai_usage       sum(count)=39
--     ai_quota_claims sum(amount)=33         count(released_at)=0
--     quota_bonus    sum(amount)=26          sum(consumed)=6
--     profiles       sum(daily_calorie_target)=29428   count(ai_consented IS TRUE)=1
--
--   时区无关文本哈希（捕获中文/枚举转录错误）：
--     meal_entries  text_h=913730c2b05e5f365350178eeccfd30d  num_h=379e0c5fca118e2ad488a44226a88b0c
--     water_logs    h=87f0cb25301804ef446c60178007fdc9
--     exercise_logs h=7742fab94c0ae1ed9779eafec86ad49b
--     honey_ledger  h=d9c3c966aaa34654167579f59300f92c
--     ai_quota_claims h=e826471161694859416757726eb10368
--     ai_usage      h=94312b932e9c1618d1571437c226b0f6
--     profiles      h=8e608f4a3f394d16f3feb7fe0b91d572
--     quota_bonus   h=fb15a618216a41aa8626a5a4bf802efb
--
-- 服务器复验 SQL（逐条跑，结果应与上面完全一致）：
--   SELECT count(*) n, max(id) maxid, sum(calories)::text cal, sum(grams)::text g FROM meal_entries;
--   SELECT md5(string_agg(food_name||'|'||meal_type||'|'||coalesce(quantity_text,'')||'|'||coalesce(ai_note,''), ',' ORDER BY id))
--     FROM meal_entries;   -- 期望 913730c2b05e5f365350178eeccfd30d
--   SELECT count(*) n, sum(amount_ml) ml FROM water_logs;   -- 28 / 9250
--   SELECT count(*) n, sum(amount) amt FROM honey_ledger;   -- 28 / 409
--   SELECT count(*) n, max(id) FROM ai_quota_claims;        -- 33 / 33
--   SELECT count(*) n, sum(count) FROM ai_usage;            -- 17 / 39
--   SELECT count(*) FILTER (WHERE ai_consented IS TRUE) FROM profiles WHERE id=2;  -- 1
--   SELECT count FROM ai_usage WHERE id=52;                 -- 3
--
-- ═══════════════════════════════════════════════════════════════════════
-- 生成方式（可复现，非手工转录）
-- ═══════════════════════════════════════════════════════════════════════
-- 每条 INSERT 由云库在线执行以下模板生成（以 meal_entries 为例）：
--   SELECT string_agg(s, E'\n') FROM (
--     SELECT 'INSERT INTO public.meal_entries (' ||
--            (SELECT string_agg(quote_ident(k), ',' ORDER BY ord)
--               FROM jsonb_each_text(to_jsonb(m)) WITH ORDINALITY z(k,v,ord)) ||
--            ') OVERRIDING SYSTEM VALUE VALUES (' ||
--            (SELECT string_agg(CASE WHEN v IS NULL THEN 'NULL' ELSE quote_literal(v) END,
--                                 ',' ORDER BY ord)
--               FROM jsonb_each_text(to_jsonb(m)) WITH ORDINALITY z(k,v,ord)) ||
--            ') ON CONFLICT DO NOTHING;' AS s
--       FROM meal_entries m WHERE m.id BETWEEN 87 AND 101 ORDER BY m.id) x;
-- WITH ORDINALITY 的 ord 保证列名与值严格同序配对；quote_literal 负责转义单引号。
--
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚
-- ═══════════════════════════════════════════════════════════════════════
-- 首选：恢复执行前备份（本迁移只增不删，恢复备份即完全回到同步前）：
--   sudo -u postgres pg_restore -d dbee --clean --if-exists /opt/dbee-db/backup-before-0036.dump
--
-- 精确回滚（不恢复备份，仅撤销本迁移写入）：
--   BEGIN;
--   DELETE FROM public.meal_entries    WHERE id BETWEEN 87 AND 101;
--   DELETE FROM public.water_logs      WHERE id BETWEEN 23 AND 28;
--   DELETE FROM public.exercise_logs   WHERE id IN (17,18);
--   DELETE FROM public.honey_ledger    WHERE id IN (253,262,269,273,280);
--   DELETE FROM public.ai_quota_claims WHERE id BETWEEN 27 AND 33;
--   DELETE FROM public.ai_usage        WHERE id IN (55,57,59);
--   UPDATE public.profiles SET ai_consented=NULL,
--          health_connected_at='2026-10-18T12:04:19.255+08:00',
--          updated_at='2026-10-20T07:47:45.28+08:00' WHERE id=2;
--   UPDATE public.ai_usage SET count=2 WHERE id=52;
--   COMMIT;
--   （回滚后如需，重跑 (8) 段 setval 让序列回落到删除后的 max(id)。）
--
-- 追踪表回滚：
--   DELETE FROM public.schema_migrations WHERE version='0036';
-- ═══════════════════════════════════════════════════════════════════════
