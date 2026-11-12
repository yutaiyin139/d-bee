-- =============================================================================
-- tools/growth-report.sql · D-Bee 成长指标离线只读报表
-- =============================================================================
-- 创建：2026-11-12（P0.2 / 缺口 D0「项目没有度量」）
-- 用途：用**现有业务表**做离线聚合，让「一点点减少与薄荷健康的差距」可证伪。
--
-- 🔴🔴 只读约束（不可协商）
--   1. 本文件只允许 SELECT / WITH，**禁止任何 DDL、DML、CREATE、INSERT、UPDATE、
--      DELETE、COPY、pg_read_file 或任何写操作**；新增护栏会扫本文件钉住这一点。
--   2. 用**只读账号**执行（只授予 meal_entries / ai_usage / schema_migrations 的
--      SELECT）；不要用具备写权限的 dbee_app / postgres 跑报表。
--   3. 执行方式：`psql "$READONLY_URL" -tA -f tools/growth-report.sql`
--      -tA = 去表头、竖线分隔，便于解析；**变更类语句绝不 `2>/dev/null`**（项目 psql 铁律）。
--   4. 结果里**绝不出现 owner_id 或任何个人标识**：owner_id 只用于 count(distinct)，
--      不出现在输出列。这与隐私政策 legal.ts:284「其他用户无法查看」及
--      「连统计都不外包」的品牌红线同向。
--   5. 零新增表、零新增字段、零新增采集、零第三方 SDK、零数据上传。
--      若将来要新增采集，须重新过 PIPL 14「新增处理目的」评估 —— 不在本计划范围内。
--
-- 🔴🔴 发布纪律
--   本脚本产出的一切数字，在**数据面闭环（mini 体验版重传 → T+7 → 云库停用）之前
--   一律标记「草稿，不作基线」**。当前线上旧 mini 包仍连旧云库、真实用户仍在写入，
--   分裂数据面上的 DAU / 留存全部失真。见 docs/备案等待期-差距缩减与超越实施计划
--   -2026-11-12.md §2.5 / §6.2。
--
-- 口径权威：docs/成长指标字典.md（单位、时区、去重规则、期望方向）
-- 输出：统一三列 (metric | bucket | value)，便于 -tA 解析与时间序列落日志。
-- =============================================================================

WITH
params AS (
  SELECT current_date AS today, 'Asia/Shanghai'::text AS tz, 29 AS lookback
),
-- 活跃口径用 created_at（真实记录时刻），**不用 log_date**：
-- log_date 是用户填报的「哪一天吃的」，可补记任意历史日期，用来算 DAU 会凭空
-- 造出过去几天的活跃。时区显式转北京时间，避免服务器 UTC 把凌晨记到前一天。
activity AS (
  SELECT m.owner_id,
         (m.created_at AT TIME ZONE (SELECT tz FROM params))::date AS d
  FROM public.meal_entries m
),
daily AS (
  SELECT d, count(DISTINCT owner_id) AS n FROM activity GROUP BY d
),
cohort AS (
  SELECT owner_id, min(d) AS d0 FROM activity GROUP BY owner_id
),
-- D1 / D7：首活跃日之后再活跃的比例。LEFT JOIN 到 activity 保证分母是完整 cohort。
retention AS (
  SELECT c.d0,
         count(*) AS cohort_n,
         count(a1.owner_id) AS d1_n,
         count(a7.owner_id) AS d7_n
  FROM cohort c
  LEFT JOIN activity a1 ON a1.owner_id = c.owner_id AND a1.d = c.d0 + 1
  LEFT JOIN activity a7 ON a7.owner_id = c.owner_id AND a7.d = c.d0 + 7
  GROUP BY c.d0
),
per_user_30d AS (
  SELECT owner_id, count(DISTINCT d) AS active_days
  FROM activity
  WHERE d >= (SELECT today FROM params) - (SELECT lookback FROM params)
  GROUP BY owner_id
),
rows AS (

  -- ── 组 1：活跃（DAU 逐日，近 30 天，含 0 活跃日）──────────────────
  SELECT 'dau'::text AS metric,
         g.d::date::text AS bucket,
         coalesce(dd.n, 0)::text AS value
  FROM generate_series(
         (SELECT today FROM params) - (SELECT lookback FROM params),
         (SELECT today FROM params),
         interval '1 day') AS g(d)
  LEFT JOIN daily dd ON dd.d = g.d::date

  UNION ALL
  SELECT 'dau_avg_30d', 'last_30d',
         coalesce(round(avg(n), 2), 0)::text
  FROM daily WHERE d >= (SELECT today FROM params) - (SELECT lookback FROM params)

  UNION ALL
  SELECT 'wau_30d', 'last_30d', count(DISTINCT owner_id)::text
  FROM activity WHERE d >= (SELECT today FROM params) - (SELECT lookback FROM params)

  UNION ALL
  SELECT 'total_ever_active', 'all_time', count(*)::text FROM cohort

  -- ── 组 2：留存（cohort 汇总 + 逐 cohort 明细）───────────────────────
  UNION ALL
  SELECT 'retention_d1_pct', 'all_cohorts',
         coalesce(round(100.0 * sum(d1_n) / nullif(sum(cohort_n), 0), 2), 0)::text
  FROM retention

  UNION ALL
  SELECT 'retention_d7_pct', 'all_cohorts',
         coalesce(round(100.0 * sum(d7_n) / nullif(sum(cohort_n), 0), 2), 0)::text
  FROM retention

  UNION ALL
  SELECT 'retention_d1_pct', d0::text,
         round(100.0 * d1_n / nullif(cohort_n, 0), 2)::text
  FROM retention
  WHERE d0 >= (SELECT today FROM params) - (SELECT lookback FROM params)

  -- ── 组 3：连打 / 活跃天数分布（近 30 天，分桶）─────────────────────
  UNION ALL
  SELECT 'active_days_bucket',
         CASE WHEN active_days = 1 THEN '1'
              WHEN active_days BETWEEN 2 AND 3 THEN '2-3'
              WHEN active_days BETWEEN 4 AND 7 THEN '4-7'
              WHEN active_days BETWEEN 8 AND 14 THEN '8-14'
              WHEN active_days BETWEEN 15 AND 21 THEN '15-21'
              ELSE '22-30' END,
         count(*)::text
  FROM per_user_30d
  GROUP BY 2

  -- ── 组 4：AI 用量（ai_usage 现有表，按日 + 按 feature）──────────────
  UNION ALL
  SELECT 'ai_usage_sum_30d', feature, coalesce(sum(count), 0)::text
  FROM public.ai_usage
  WHERE usage_date >= (SELECT today FROM params) - (SELECT lookback FROM params)
  GROUP BY feature

  UNION ALL
  SELECT 'ai_usage_daily', u.usage_date::text || '/' || u.feature, sum(u.count)::text
  FROM public.ai_usage u
  WHERE u.usage_date >= (SELECT today FROM params) - (SELECT lookback FROM params)
  GROUP BY u.usage_date, u.feature

  -- ── 组 5：记录来源构成（source，用于观察 AI 占比）───────────────────
  UNION ALL
  SELECT 'meal_source_30d', m.source, count(*)::text
  FROM public.meal_entries m
  WHERE (m.created_at AT TIME ZONE (SELECT tz FROM params))::date
        >= (SELECT today FROM params) - (SELECT lookback FROM params)
  GROUP BY m.source
)
SELECT metric, bucket, value FROM rows ORDER BY metric, bucket;

-- =============================================================================
-- 🔴 本报表**算不出来**的指标（诚实边界，不要假装有）：
--   · AI 修正率、私有库命中占比 → 依赖 PCM 端侧 KV（dbee:pcm:v1），按设计**不上云**，
--     服务端 SQL 永远看不到。只能用端侧自测 / 用户主动导出的汇总来评估。
--   · 与薄荷健康对照的食物库条数 / 用户量（A 类规模）→ 明确**不设为目标**，仅记录。
--   · 付费转化 / 留存付费分层 → 两收款开关默认 false，当前无样本。
-- =============================================================================
