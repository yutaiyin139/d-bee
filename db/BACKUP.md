# D-Bee 数据备份

> 🔴 **口径已于 2026-11-05 重写**：数据面权威源是**服务器自建 PostgreSQL `dbee`**
> （`150.158.51.106`），不再是 WorkBuddy 云库。旧版描述的「云库 MCP 只读通道」
> 已废弃（该工具 `mcp__genie-baas__workbuddy_cloudservice_db_exec_sql` 自 2026-10-19 起
> 在备份会话未注册、连续失败 5 次，见 `db/backups/FAILED-*.md`）。
> 仍连云库的只剩 **mini（默认 cloud）+ 原生内测包**，正式数据面已全在自建库。

## 一句话

数据库在腾讯云服务器 `150.158.51.106` 的自建 PostgreSQL `dbee`（web 端经
`window.location.origin` → nginx `/.cloud/` → 自建网关 → PG）。备份分**两层**：
服务器本机每日 `pg_dump`（主），本地再拉一份异地副本（防机器整体丢失）。

## 实证（怎么确认权威源是自建库）

```bash
curl http://150.158.51.106/.cloud/healthz
# {"ok":true,"db":{"ok":true,"user":"dbee_app","database":"dbee"},...}
```
`database:"dbee"` = 服务器本机 PostgreSQL；`src/cloudConfig.ts` 的 web 分支返回
`window.location.origin`，云库 `CLOUD_HOST` 只在 DEV 与 `native-internal+显式授权` 两个口子生效。

## 两层备份

### 第 1 层：服务器本机 cron（主备份）

| 项 | 值 |
| --- | --- |
| 脚本 | `/usr/local/bin/dbee-backup.sh`（源：`deploy/dbee-backup.sh`） |
| 调度 | `/etc/cron.d/dbee-backup`，**每日 03:30**，root 身份 |
| 产物 | `/var/backups/dbee/dbee-{daily,weekly,monthly}-<TS>.dump` |
| 格式 | `pg_dump -Fc`（自定义压缩，支持 `pg_restore` 并行/单表恢复，约 167 KB） |
| 验证 | dump 后 `pg_restore --list` 校验 TOC 条目数（>100 才算未损坏）+ 记 sha256 |
| 保留 | 日备×7 + 周备(周日)×4 + 月备(1日)×6，滚动清理 |
| 安装/演练 | `deploy/install-backup.sh`（装脚本 + 写 cron + 首备 + **恢复到临时库比对行数**的演练） |

> 「没验证过能恢复的备份不算备份」——install-backup.sh 的恢复演练会把 dump
> `pg_restore` 到临时库 `dbee_restore_test`，逐表比对行数后再删库。

### 第 2 层：本地异地副本（防机器整体丢失）

第 1 层备份和数据库在**同一台机器**，机器挂了备份跟着没。故再拉一份到本地。

| 项 | 值 |
| --- | --- |
| 脚本 | `deploy/pull-latest-backup.py`（拉最新）/ `--all-daily`（首次建全量副本） |
| 产物 | `db/backups/offsite/dbee-*.dump`（已被 `.gitignore` 覆盖，不入库） |
| 调度 | WorkBuddy 自动化「D-Bee 每日数据备份（自建库异地副本）」，**每日 04:30**（晚于服务器 03:30 一小时，确保拉到当天 dump） |
| 校验 | 用服务器 `SHA256SUMS` 逐字节比对，大小 + sha256 双验；幂等（已最新则跳过） |
| 传输 | 经 `dbee-ssh.py getsudo`（sudo cp 到 /tmp → sftp 取回 → **`shred -u` 清理服务器暂存**，因含健康数据） |
| 保留 | 本地滚动 30 天（自动化按 mtime 删） |

手动拉一份：
```bash
cd "项目根" && set -a && . ./.env && set +a && export DBEE_USER="$USER" DBEE_PWD="$SSH_PWD"
python deploy/pull-latest-backup.py
```
🔴 `.env` 里的 `DBEE_USER=dbee_app`/`DBEE_PWD` 是**过时值、SSH 认证会失败**；
必须用 `USER=ubuntu` + `SSH_PWD`（见 MEMORY「部署侧坑」）。

## 安全红线（PIPL）

- `*.dump` 含**真实健康档案**（年龄/身高体重/饮食记录，含未成年人）= 敏感个人信息。
  **严禁** `git add`、移出项目目录、cat/grep 打印正文。
- `getsudo` 的服务器 /tmp 暂存必须 `shred -u` 清掉（脚本已做，且已实测验证零残留）。
- **绝不**跑 `deploy/deploy-gateway.sh`（缺 IDENT_PEPPER 会 rand_hex 重置 → 全站身份永久失效）；
  备份流程只读数据库、不碰网关配置。

## 怎么校验备份有效

1. 归档魔数 = `PGDMP`（`head -c 5 xxx.dump`）；
2. `pg_restore --list xxx.dump` 能读出 TOC（服务器 cron 已自动做，>100 条）；
3. 本地副本 sha256 == 服务器 `SHA256SUMS` 里对应行；
4. 终极验证 = 恢复到临时库比对行数（install-backup.sh 的演练）。

## 恢复怎么做

数据量小（dump 167 KB），恢复即 `pg_restore`：
```bash
sudo -u postgres createdb dbee_restore_test
sudo -u postgres pg_restore -d dbee_restore_test --no-owner --no-privileges <dump>
# 比对行数无误后，按需把表数据回灌生产库
```
> ⚠️ 恢复会写入生产库，人工确认后再执行，不要交给自动化。

## 历史遗留（云库备份，已停）

`db/backups/2026-10-13.json ~ 2026-11-04.json`（16 份）是**旧云库 MCP 通道**的
JSON 快照，已停止生产（云库非写入源）。保留作历史记录，**不再更新**；
`db/backup.sql` 是那条已废弃查询的留档。切换细节见 `docs/` 相关回迁文档。
