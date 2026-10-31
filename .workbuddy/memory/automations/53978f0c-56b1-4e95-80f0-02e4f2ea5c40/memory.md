# 自动化记忆：D-Bee 每日云端数据库备份

任务 ID：53978f0c-56b1-4e95-80f0-02e4f2ea5c40
applicationId：wbapp_w6iIU6TqTyHvJxESPTxBTy

## 执行历史

### 2026-10-14 08:57（首次记录）
- 结果：**成功**。产出 `db/backups/2026-10-14.json`（8161 字节）。
- 行数：profiles=4 / meal_entries=5 / water_logs=4 / exercise_logs=1 / weight_logs=0 / entitlements=0 / ai_usage=3
- 校验：Node 脚本确认可 JSON.parse，7 张表 row_counts 与 tables.<表>.length 及线上实时行数三方一致。
- 清理：无过期备份（最早为 2026-10-13，远晚于 30 天 cutoff 2026-09-14）。

### 2026-10-15 09:10（第 3 次）
- 结果：**成功**。产出 `db/backups/2026-10-15.json`。
- 行数：profiles=10 / meal_entries=19 / water_logs=4 / exercise_logs=6 / weight_logs=0 / entitlements=0 / ai_usage=4
- 校验：`db/backups/.verify-backup.cjs` 通过——JSON.parse OK、7 表 row_counts 与 tables.<表>.length 及
  另发一条 count(*) 查询的线上实时行数三方一致。
- 清理：无过期备份（最早 2026-10-13，cutoff 2026-09-15）。

### 2026-10-16 08:58（第 4 次）
- 结果：**成功**。产出 `db/backups/2026-10-16.json`（32888 字节，4 天中最大）。
- 行数：profiles=12 / meal_entries=27 / water_logs=9 / exercise_logs=9 / weight_logs=1 / entitlements=0 / ai_usage=5
- 校验：`.verify-backup.cjs` 通过——JSON.parse OK、7 表 row_counts 与 tables.<表>.length 及
  另发 count(*) 查询的线上实时行数三方一致。
- 清理：无过期备份（最早 2026-10-13，cutoff 2026-09-16）。
- 观察：weight_logs 首次产出数据（id=1，54.6kg，owner 2109869577155379200）；
  entitlements 仍为 0 行（免费期，符合预期）。

### 2026-10-17 09:11（第 5 次）
- 结果：**成功**。产出 `db/backups/2026-10-17.json`（42162 字节，史上最大）。
- 行数：profiles=15 / meal_entries=33 / water_logs=15 / exercise_logs=12 / weight_logs=2 / entitlements=0 / ai_usage=5
- 校验：`.verify-backup.cjs` PASS——JSON.parse OK、7 表 row_counts 与 tables.<表>.length 及
  另发 count(*) 的线上实时行数三方一致；另抽查 profiles id=1/15 的 owner_id 与线上一致。
- 清理：无过期备份（cutoff 2026-09-17，现存最早 2026-10-13）。目录内共 5 份每日备份。
- 流程改进：新增 `.build-backup.cjs`——先把 MCP 返回的原始 dump 落到临时 `.YYYY-MM-DD.raw.json`，
  再用脚本按 schema 顺序重排 tables 并计算 row_counts（避免手工编辑 JSON 引入错误），
  校验通过后删除临时文件。本次一次通过。

### 2026-10-18 09:20（第 6 次）
- 结果：**成功**。产出 `db/backups/2026-10-18.json`（56533 字节，再创最大纪录）。
- 行数：profiles=17 / meal_entries=48 / water_logs=17 / exercise_logs=14 / weight_logs=2 / entitlements=0 / ai_usage=7
- 校验：`.build-backup.cjs` + `.verify-backup.cjs` PASS——JSON.parse OK、7 表 row_counts 与
  tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：无过期备份（cutoff 2026-09-18，现存最早 2026-10-13）。目录内共 6 份每日备份。
- 观察：profiles 16 号缺失（id 跳号）；meal_entries id 39-42 缺失（有删除发生）；
  新增用户 id=17/18（邀请码 4ZCNJB 邀请链继续扩张，已 3 人经此码注册）。

### 2026-10-19 08:56（第 7 次）
- 结果：**失败**，未产出 `db/backups/2026-10-19.json`（未写空备份、未覆盖 2026-10-18）。
- 原因：`mcp__genie-baas__workbuddy_cloudservice_db_exec_sql` 本次会话未注册——
  ToolSearch 精确名/关键词均无此工具，直接 DeferExecuteTool 报 not found in deferred tools index；
  `workbuddy_cloud_service(inspect)` → applications 为空（本会话未绑定应用）；
  `list_installed_plugins` → No connectors installed（无可重连连接器）。
- 已落 `db/backups/FAILED-2026-10-19.md`（时间、SQL 原文、错误串、已排除替代路径）。
- 清理：无过期备份（cutoff 2026-09-19）。
- 结论：备份链最后一个有效快照为 2026-10-18；需恢复 genie-baas 通道后手动重跑补齐。

### 2026-10-20 09:07（第 8 次）
- 结果：**失败**，未产出 `db/backups/2026-10-20.json`（未写空备份、未覆盖历史）。
- 原因：与 2026-10-19 完全相同的故障面——`mcp__genie-baas__workbuddy_cloudservice_db_exec_sql`
  本会话未注册（ToolSearch 精确名/3 组关键词均命中不到，只回无关工具；DeferExecuteTool 报
  not found in deferred tools index）；`workbuddy_cloud_service(inspect)` → `applications: []`。
  项目根仅有 `.env.example`，无凭据。
- 已落 `db/backups/FAILED-2026-10-20.md`。
- 清理：30 天 cutoff=2026-09-20，现存最早 2026-10-13，无过期文件。
- 结论：备份链连续 2 日断档，最后有效快照仍为 2026-10-18。需在已绑定应用的会话手动补跑。
- 流程记录：本任务每次都在**全新会话**跑，genie-baas 是否注册取决于会话是否绑定该应用；
  这是外部前置条件，非脚本问题。10-19 起连续失败，说明绑定已失效（而非偶发）。
- 同日 09:09 触发第二次（重复调度/手动续跑）：复测 ToolSearch 与直接 DeferExecuteTool 仍失败，
  结论不变；已在同一份 FAILED-2026-10-20.md 追加「尝试记录」表格，未新建重复文件。
  **后续再遇同日重复触发：直接复用当日 FAILED 文件追加一行，不要再重复全流程排查。**

### 2026-10-21 09:02（第 9 次）
- 结果：**成功（通道恢复）**。产出 `db/backups/2026-10-21.json`（83067 字节，历史最大）。
- 行数：profiles=17 / meal_entries=85 / water_logs=22 / exercise_logs=15 / weight_logs=3 / entitlements=0 / ai_usage=14
  （合计 156 行；profiles 仍缺 id=16，邀请码 4ZCNJB 链下已有 3 人）。
- 校验：`.build-backup.cjs` + `.verify-backup.cjs` PASS——JSON.parse OK、7 表 row_counts 与
  tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-09-21，现存最早 2026-10-13，无过期文件（目录 7 份每日备份）。
- 说明：genie-baas 工具本会话已注册（10-19/10-20 的未注册故障消失）；备份链断档 2 日，今日全量快照已覆盖
  该 2 日增量（10-19 新增运动/ai_usage/饮水，10-20 有饮水与体重记录），无需补差量。
- 流程照旧：raw dump 先落 `.YYYY-MM-DD.raw.json` → build 重排 + 算 row_counts → verify → 删临时文件。

### 2026-10-23 08:48（第 10 次）
- 结果：**成功**。产出 `db/backups/2026-10-23.json`。
- 行数：profiles=17 / meal_entries=96 / water_logs=25 / exercise_logs=16 / weight_logs=3 / entitlements=0 / ai_usage=17（合计 174 行）
- 校验：`.build-backup.cjs` + `.verify-backup.cjs` PASS——JSON.parse OK、7 表 row_counts 与
  tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-09-23，现存最早 2026-10-13，无过期文件（目录 8 份每日备份）。
- 观察：meal_entries 首次破 90 行（id 39–42 缺失）；10-22 新增早餐/午餐记录，10-23 早已有 ai_usage(id=59) 与
  meal_entries(id=99/100)；entitlements 仍为 0。与上次备份间隔 2 日（10-22 未产出，链上 10-21 之后跳到 10-23）。

### 2026-10-24 08:56（第 11 次）
- 结果：**成功**。产出 `db/backups/2026-10-24.json`（96103 字节，历史最大）。
- 行数：profiles=17 / meal_entries=101 / water_logs=31 / exercise_logs=18 / weight_logs=3 / entitlements=0 / ai_usage=17（合计 187 行）
- 校验：`.build-backup.cjs` + `.verify-backup.cjs` PASS——JSON.parse OK、7 表 row_counts 与
  tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-09-24，现存最早 2026-10-13，无过期文件（目录 9 份每日备份）。
- 观察：meal_entries 破百（101 行，id 39–42 缺失）；10-23 晚新增晚餐 4 条（卤猪肝/菠菜/黄豆芽/大葱）；
  entitlements 仍为 0。与上次备份间隔 1 日（10-23 已产出），链上无断档。

### 2026-10-24 08:56（第 11 次）
- 结果：**成功**。产出 `db/backups/2026-10-24.json`（96103 字节，历史最大）。
- 行数：profiles=17 / meal_entries=101 / water_logs=31 / exercise_logs=18 / weight_logs=3 / entitlements=0 / ai_usage=17（合计 187 行）
- 校验：`.verify-backup.cjs` PASS——JSON.parse OK、顶层字段完整、7 表 row_counts 与 tables.<表>.length
  及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-09-24，现存最早 2026-10-13，无过期文件（目录 9 份每日备份）。
- **并发会话记录**：本次同日重复触发（08:56 与 08:55 两次调度几乎同时跑）。本会话完成查询与实时行数
  核对后，发现 raw 临时文件及最终 `2026-10-24.json` 已由另一并发会话写出（09:01，96103 字节），
  遂**不重复构建**，改为对本会话独立查询的实时行数做第三方交叉校验（PASS）。
  **后续同日重复触发的处置**：先 `ls` 目录——若当日 json 已存在且校验 PASS，直接复用并汇报，勿重建。

### 2026-10-25 08:57（第 12 次）
- 结果：**失败**，未产出 `db/backups/2026-10-25.json`（未写空备份、未覆盖 2026-10-24）。
- 原因：与 10-19/10-20 同一故障面——`mcp__genie-baas__workbuddy_cloudservice_db_exec_sql` 未注册
  （ToolSearch 精确名 + 3 组关键词均无；DeferExecuteTool 报 not found in deferred tools index）；
  `workbuddy_cloud_service(inspect)` → `applications: []`、`activated:false`。
- 已落 `db/backups/FAILED-2026-10-25.md`（时间、SQL 原文、错误串、已排除路径）。
- 清理：cutoff=2026-09-25，现存最早 2026-10-13，无过期文件（目录 9 份每日 json）。
- 附加排查：本地无 `psql`、无 `pg` 模块；`.env` 仅有自托管 `DBEE_*`，无云库连接串 → 无第二条合规通道。
- ⚠️ 新增结构性判断：前端 10-23 已切自托管（泳道 A），云端 Postgres 很可能已非生产写入源。
  已在 FAILED 文件写明建议——若确认，应把备份目标改为自托管 `dbee` 的 `pg_dump`（本地 cron + 异地拉取），
  否则该自动化只能持续以「工具未注册」失败。**需用户人工决策，自动化不自作主张改通道。**

### 2026-10-26 03:31（第 13 次）
- 结果：**成功（通道恢复）**。产出 `db/backups/2026-10-26.json`（114005 字节，历史最大，覆盖 10-25 断档）。
- 行数：profiles=17 / meal_entries=123 / water_logs=38 / exercise_logs=24 / weight_logs=3 /
  **entitlements=1（首次非零！）** / ai_usage=22（合计 228 行）。
- 校验：`.build-backup.cjs` + `.verify-backup.cjs` PASS——JSON.parse OK、7 表 row_counts 与
  tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-09-26，现存最早 2026-10-13，无过期文件（目录 10 份每日 json）。
- 观察：**entitlements 首条记录落地**（id=1，owner 2109869577155379200，plan=pro，source=honey，
  pro_until=2026-10-26 19:38——付费转化的第一条真实数据）；与上次备份间隔 2 日（10-25 工具未注册失败，
  本快照已覆盖 10-25 全部增量，无需补差）。10-25 当日新增：晚餐 4 条 + 夜宵砂糖橘 3 条 + 饮水 2 +
  散步 1 + ai_usage 2 + pro 权益 1。

### 2026-10-29 08:52（第 14 次）
- 结果：**失败**，未产出 `db/backups/2026-10-29.json`（未写空备份、未覆盖历史）。
- 原因：与 10-19/10-20/10-25 同一故障面——genie-baas 工具未注册（ToolSearch 精确名 + 3 组关键词均无；
  DeferExecuteTool 报 not found in deferred tools index）；`workbuddy_cloud_service(inspect)` → `applications:[]`；
  `list_installed_plugins` → No connectors installed。
- 本次**新增实测排除**：自托管 `dbee`（150.158.51.106:5432）从本机可连但不被 pg_hba 放行
  （非 SSL 与 SSL 均 `no pg_hba.conf entry for host "114.246.237.57"`）→ 仅限服务器本机；`psql` 不存在；
  `~/.ssh/id_*` 不存在。即彻底无第二通道，不必再重复排查这几项。
- 已落 `db/backups/FAILED-2026-10-29.md`（含 SQL 原文、错误串、7 条通道探测表、备份链现状、建议）。
- 清理：cutoff≈2026-09-28，现存 10 份 json（最早 10-13），无过期文件。
- **断档扩大**：10-27 无备份无 FAILED；10-28 无备份但留下 `.parts/` 分片；最后完整快照仍为 **2026-10-26**（断 3 天）。
- 「`.parts/` 可否拼成 2026-10-28.json」已在 FAILED 文件写明结论——结构完整（profiles17/meal100/water42/exercise26/
  weight3/ent1/ai24，meal id 1–105 升序无重复），但缺 `generated_at` 且无法与线上交叉校验，
  **按纪律不自动拼装**，需人工确认后以 `2026-10-28T12:36+08:00` 为 generated_at 并注明来源。

- **同日 08:55 重复触发**：按既定规则只做复测（ToolSearch 精确名 + 直接 DeferExecuteTool），结果不变，
  未生成新文件、未改动既有备份；已在同一份 `FAILED-2026-10-29.md` 追加「重复触发记录」表格，未新建文件。
  保留策略复核：现存 10 份 json，过期 0 份。

### 2026-10-30 07:24（第 15 次）
- 结果：**成功（通道恢复）**。产出 `db/backups/2026-10-30.json`（约 128KB，历史最大，覆盖 10-27~10-29 三天断档）。
- 行数：profiles=18 / meal_entries=135 / water_logs=46 / exercise_logs=28 / weight_logs=3 /
  entitlements=1 / ai_usage=26（合计 257 行）。
- 校验：合并脚本内含 id 严格升序校验 + `.verify-backup.cjs` PASS——JSON.parse OK、顶层字段完整、
  7 表 row_counts 与 tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-09-30，现存最早 2026-10-13，无过期文件（目录 11 份每日 json）。
- 观察：新用户 profiles id=19（10-28 注册，非邀请码）；entitlements 仍 1 条 pro；
  meal_entries 断档期新增 10-27 晚餐 2 条 / 10-28 花生 / 10-29 花生；10-29 晚散步 2 + 饮水 4 + scan 1。
- 流程说明：本次 dump 体量过大（~128KB），单次 Write 转录易截断——首次写入即为截断占位（已删除）。
  改用**三部分片写入**（part1=ai_usage+entitlements+exercise_logs / part2=meal_entries /
  part3=profiles+water_logs+weight_logs）→ 临时合并脚本（含 id 升序校验）拼装 → verify → 删临时文件。
  **后续 dump 超过 ~60KB 时沿用分片方案。**

### 2026-10-31 07:27（第 16 次）
- 结果：**成功**。产出 `db/backups/2026-10-31.json`（127,994 字节，历史最大，覆盖 10-31 当日数据；与 10-30 快照间隔 1 日，链上无断档）。
- 行数：profiles=18 / meal_entries=138 / water_logs=46 / exercise_logs=28 / weight_logs=3 /
  entitlements=1 / ai_usage=27（合计 261 行）。
- 校验：分片合并脚本内含 7 表 id 严格升序校验 + `.verify-backup.cjs` PASS——JSON.parse OK、顶层字段完整、
  7 表 row_counts 与 tables.<表>.length 及另发 count(*) 的线上实时行数三方一致。
- 清理：cutoff=2026-10-01，现存最早 2026-10-13，无过期文件（目录 12 份每日 json）。临时分片已删除。
- 观察：meal_entries 新增 10-30 早餐 3 条（牛奶/面包/橘子，id 143-145）；ai_usage 新增 10-30 scan 1 条（id 80）；
  10-30 全天无其他新记录；entitlements 仍 1 条 pro（已于 10-26 19:38 过期）。
- 流程：genie-baas 工具本会话已注册（连续第 2 次成功）；dump ~128KB，沿用三部分片方案一次通过。

## 经验与注意事项

1. **SQL 直接用 `sql` 参数传单行字符串即可**，无需 base64（本次一次通过）。
   查询语句留档在 `db/backup.sql`。
2. **校验脚本必须用 `.cjs` 后缀**：项目 `package.json` 有 `"type": "module"`，
   用 `.js` 会被当 ESM，`require` 报 `ReferenceError`。
3. 校验脚本除比对 row_counts 外，还**写死线上实时行数做交叉核对**，
   可发现「写文件时漏行/多行」这类 row_counts 自洽但数据错误的隐性故障。
4. 备份目录初始只有 `2026-10-13.json`；清理逻辑按文件名日期 `< cutoff` 删除，
   FAILED-*.md 不参与清理（不受保留策略影响）。
5. 表顺序在源 JSON 中为 ai_usage/entitlements/exercise_logs/meal_entries/profiles/water_logs/weight_logs
   （Postgres json_build_object 不保证键序），落盘时重排为 schema 顺序，不影响校验。
6. **唯一的硬依赖是 genie-baas 只读工具在会话中已注册**。它不在索引里时无第二条合规通道：
   本地无云端凭据（anon 表权限已撤）、服务器无业务库（dbee 只是 10-13 的镜像）、
   SSH 无 sshpass/私钥。此时必须走 FAILED 分支，**不要用服务器镜像顶替**（会造成日期与数据不符的假备份）。
