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
