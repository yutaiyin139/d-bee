# db/ · 数据库版本控制

本目录把 D-Bee 的数据库结构与变更纳入版本控制。在此之前，schema 只存在于
WorkBuddy 云端，项目里没有任何 SQL 文件 —— 意味着数据库无法复现、无法审计、无法回滚。

## 目录

| 路径 | 内容 |
|---|---|
| `schema.sql` | **基线**：从线上反向导出的完整 DDL（表 / 索引 / RLS / GRANT），as-is |
| `migrations/*.sql` | 增量变更，按序号命名，文件头标注执行状态 |
| `gen-mirror-sql.py` | 生成器：由 `backups/<date>.json` 生成服务器本机镜像脚本（`migrations/0002-*`） |
| `backup.sql` / `BACKUP.md` | 云端全量 JSON 备份的查询语句与机制说明 |
| `backups/<date>.json` | 每日备份产物（保留 30 天），同时是镜像脚本的数据来源 |

## 现状速览

- 云端库：`postgres-6o15js8c`（PostgreSQL 17.11，WorkBuddy 云托管）
- 应用：`wbapp_w6iIU6TqTyHvJxESPTxBTy`
- 7 张表，RLS 全部开启，策略统一为 `owner_id = auth.uid()`
- 权限：**仅 `authenticated`**（`anon` 已 REVOKE，2026-10-13）
- 索引：14 个（含 0001 新增的 3 个 `(owner_id, log_date)` 复合索引）
- 无外键、无触发器
- 自定义函数 2 个（V1.0.0 起）：`consume_ai_quota` / `release_ai_quota`，用于原子占用与退还 AI 免费额度，见 `migrations/0003-atomic-ai-quota.sql`

## 服务器本机镜像（dbee 库）

服务器 `150.158.51.106` 上装了 PostgreSQL 17.11，库 `dbee` 是云端 schema 的
**等价镜像**（2026-10-13 由 `migrations/0002-mirror-to-local-pg.sql` 建立）。
它与云端逐项对齐：7 表 / 14 索引 / 16 策略 / RLS 全开 / `authenticated` 28 行权限 / `anon` 0 行，
外加 2 个函数（`consume_ai_quota` / `release_ai_quota`，2026-10-13 由 `0003` 同步）。

有 3 处**有意为之**的差异：

| 差异 | 云端 | 本机镜像 |
|---|---|---|
| `auth.uid()` | 平台内置 | `auth` schema + 兼容函数，依次读 `app.user_id` → `request.jwt.claim.sub` → `request.jwt.claims->>sub` |
| 角色 | `anon`/`authenticated`/`cloudbase_postgres_*`/`service_role` | 只建 `anon`/`authenticated`（NOLOGIN） |
| 表 owner | 平台角色（非超级用户，RLS 必然生效） | 本机 `postgres` 超级用户 —— **会绕过 RLS**，验证隔离须 `SET ROLE authenticated` |

数据用 `jsonb_populate_recordset` 导入，`id` 走 `OVERRIDING SYSTEM VALUE` 后已 `setval` 同步序列。
脚本幂等，可反复执行；数据变化后重新生成：

```bash
python db/gen-mirror-sql.py                    # 默认取 backups/2026-10-13.json
# 上传执行（务必放 /opt 下，postgres 读不了 /home/ubuntu）
sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0002-mirror-to-local-pg.sql
```

隔离验证（超级用户直连会绕过 RLS，必须切角色）：

```sql
SET ROLE authenticated;
SET app.user_id = '2109837240191418368';
SELECT count(*) FROM public.profiles;   -- 期望 1
SET app.user_id TO DEFAULT;
SELECT count(*) FROM public.profiles;   -- 期望 0（未登录）
RESET ROLE;
```

日常连接用应用角色 `dbee_app`（继承 `authenticated` 权限，RLS 生效，不可建表），
密码见 `db/CREDENTIALS.txt`（本目录）或服务器 `/opt/dbee-db/CREDENTIALS.txt`：

```bash
psql "postgresql://dbee_app:<密码>@127.0.0.1:5432/dbee"
# 进库后同样要先声明身份：SET app.user_id = '<owner_id>';
```


## 如何执行变更

数据库只能通过 WorkBuddy 云服务的 MCP 工具操作（没有直连字符串），
`mode` 决定执行角色：

| mode | 用途 | 是否绕过 RLS |
|---|---|---|
| `read` | 只读查询 | 否（受 RLS 限制） |
| `write` | 数据变更（DML） | 否 |
| `migrate` | 建表 / 改表 / RLS / GRANT / 索引 | 是 |

**执行迁移的标准流程：**

1. 在 `migrations/` 新建文件，写清目的、影响面、回滚语句
2. 先在本地 review，确认无误后逐条应用（单次只支持一条语句）
3. 应用后用 `db_list_tables` / `db_list_rls` 复验结构
4. 在文件头的「状态」行把 ⚠️ 未执行 改成 ✅ 已执行 + 日期

**注意**：`schema.sql` 是基线快照，**不要**整份重跑到已有库上（`CREATE TABLE` 会因表已存在报错）。
它的用途是①新建环境 ②审计比对 ③灾备重建。

## 变更纪律

每次改动数据库后，同步做三件事：

1. 新增 `migrations/NNNN-*.sql`
2. 更新 `schema.sql`，让它始终等于线上实际状态
3. 记录到 `.workbuddy/memory/` 当日日志

## 已执行 / 待执行

| 文件 | 内容 | 状态 |
|---|---|---|
| `migrations/0001-performance-and-hardening.sql` | 补 3 个复合索引 + 撤销 anon 表权限 | ✅ 已执行 2026-10-13 |
| `migrations/0002-mirror-to-local-pg.sql` | 等价镜像到服务器本机 dbee 库（auth.uid() 兼容层 + 结构 + 权限 + 数据） | ✅ 已执行 2026-10-13 |
| `migrations/0003-atomic-ai-quota.sql` | 新增 `consume_ai_quota` / `release_ai_quota`，把 AI 免费额度改成服务端原子占用 | ✅ 已执行 2026-10-13（云端 + 本机镜像） |

## 新建表时的纪律（重要）

平台在 `CREATE TABLE` 时**会自动给 `anon` 播撒表权限**（这是 0001 要处理的根因）。
因此每建一张新表，都要补两步，否则会退回「单层防护」：

```sql
REVOKE ALL ON public.<新表> FROM anon;   -- ① 收紧，与 0001 保持一致
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<新表> TO authenticated;  -- ② 漏了会得到 42501
```

不要依赖 `ALTER DEFAULT PRIVILEGES` —— 它绑定到执行建表的角色，
而平台建表用的角色不在我们控制范围内，写了可能不生效（会给人虚假的安全感）。

## 待办

| 项 | 说明 | 状态 |
|---|---|---|
| 每日数据备份自动化 | 每天 03:30 导出 7 张表全量 JSON，保留 30 天 | ✅ 已落地 2026-10-13（见 BACKUP.md） |
| 本机镜像自动刷新 | 服务器 dbee 库目前是手动镜像，可考虑纳入每日流程 | ⬜ 待定 |
| RLS 策略风格统一 | 分命令 / FOR ALL 两种风格混用，语义等价 | ⬜ 非紧急 |
| `updated_at` 触发器 | 目前靠前端写入维护 | ⬜ 非紧急 |
| 账号注销能力 | 个保法删除权，需前端配合 | ⬜ 待排期 |

## 测试数据：定版前暂不清理（2026-10-13 决定）

当前库中的 3 个测试账号**按用户决定保留**，不视为脏数据，定版前不要清空：

| id | owner_id | 性别 | 年龄 |
|---|---|---|---|
| 1 | `2109837240191418368` | male | 48 |
| 2 | `2109869577155379200` | male | 48 |
| 3 | `2109870547356614656` | female | 44 |

这些是开发期用于验证 RLS 行级隔离的账号（详见 `docs/数据链路核查.md` 与 `db/backups/`），
保留它们可以在后续改动后快速回归验证「用户 A 只能看到自己的数据」这类断言。
真要清理时，记得连同 `meal_entries` / `water_logs` / `exercise_logs` / `weight_logs` /
`entitlements` / `ai_usage` 中对应 `owner_id` 的记录一并处理。

