# 腾讯云服务器 PostgreSQL 17.11 运维说明

> 安装时间：2026-10-13 · 服务器：150.158.51.106（Ubuntu 24.04.4 LTS / 4 vCPU / 3.7 GB RAM / 40 GB SSD）

## 一、现状速览

| 项目 | 值 |
| --- | --- |
| 数据库版本 | **PostgreSQL 17.11**（`17.11-1.pgdg24.04+2`） |
| 集群 / 端口 | `17/main` · `5432` |
| 监听地址 | **`127.0.0.1`（仅本机）**，不对外暴露 |
| 认证方式 | 本地 socket = `peer`；TCP 回环 = `scram-sha-256` |
| 密码加密算法 | `scram-sha-256` |
| 数据目录 | `/var/lib/postgresql/17/main`（约 41 MB） |
| 配置目录 | `/etc/postgresql/17/main/`（含 `conf.d/`） |
| 服务 | `postgresql.service`，`active` + **开机自启 enabled** |
| 日志 | `/var/log/postgresql/postgresql-17-main.log` |
| 已建数据库 | `dbee`（owner `postgres`，UTF8）—— 已镜像云端 7 张表 / 14 索引 / 16 策略 / 6 行数据；另有 `postgres`、`template0/1` |
| 系统时区 | `Asia/Shanghai` |
| 已装包 | `postgresql-17`、`postgresql-contrib-17`、`postgresql-client-17`、`postgresql-common` |

可用扩展（已验证）：`pg_stat_statements`、`uuid-ossp`、`pgcrypto`、`pg_trgm`、`citext`、`unaccent`。

## 二、安装方式（可复现）

Ubuntu 24.04 官方源自带 PG 16，装 17 必须加 PGDG 源：

```bash
# 1) 导入 PGDG 签名密钥（指纹 B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8）
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

# 2) 源指向阿里云镜像（实测 2.7 MB/s，官方源仅 ~35 kB/s）
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://mirrors.aliyun.com/postgresql/repos/apt noble-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list

# 3) 安装
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17 postgresql-contrib-17
```

> 注意：清华 / 中科大镜像的 `postgresql/repos/apt` 路径对该仓库返回 404，阿里云镜像是可用的。
> 17.11 在 PGDG 上仍可精确安装（该源保留 `17.9 / 17.10 / 17.11` 多个小版本），可锁定版本：`apt-get install postgresql-17=17.11-1.pgdg24.04+2`。

## 三、参数调优

独立文件 `/etc/postgresql/17/main/conf.d/10-tuning.conf`（主 `postgresql.conf` 第 840 行 `include_dir = 'conf.d'` 已生效），便于单独回滚：

```ini
shared_buffers = 512MB            # 约内存 1/7
effective_cache_size = 2GB        # 供优化器估算，不实际占用
work_mem = 8MB                    # 单排序/哈希操作上限
maintenance_work_mem = 128MB      # VACUUM / CREATE INDEX
random_page_cost = 1.1            # 云盘 SSD
wal_compression = on              # 实际生效 pglz
log_min_duration_statement = 1000 # 记录 >1s 慢查询
log_line_prefix = '%m [%p] %u@%d '
```

修改后：`sudo systemctl restart postgresql`，生效值已逐项核验通过。

## 四、安全配置

- `listen_addresses = 'localhost'`，`ss -lntp` 确认只有 `127.0.0.1:5432` 在听
- `pg_hba.conf` 有效规则：`local all postgres peer`、`local all all peer`、`host all all 127.0.0.1/32 scram-sha-256`、IPv6 回环同理
- **腾讯云安全组不要放行 5432 / 3306 入站**；应用与数据库同机，走回环即可
- `postgres` 超级用户没有设置远程密码，`peer` 认证下只能由服务器上的 `postgres` 系统账号通过 sudo 进入

## 五、常用命令速查

```bash
# 进入交互
sudo -u postgres psql                 # 进 postgres 库
sudo -u postgres psql -d dbee         # 进 dbee 库

# 服务
sudo systemctl {status|restart|stop|start} postgresql
pg_lsclusters                         # 集群与端口状态

# 查看库 / 表 / 大小
sudo -u postgres psql -c "\l"
sudo -u postgres psql -d dbee -c "\dt+"
sudo -u postgres psql -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database;"

# 谁在连、慢查询
sudo -u postgres psql -c "SELECT pid,usename,application_name,state,query_start,left(query,60) FROM pg_stat_activity WHERE state <> 'idle';"
```

## 六、应用账号（✅ 已创建 2026-10-13）

| 项目 | 值 |
| --- | --- |
| 角色名 | `dbee_app`（LOGIN，非超级用户，**不绕过 RLS**，无连接数限制） |
| 成员关系 | 属于 `authenticated` —— 继承 7 张表的 SELECT / INSERT / UPDATE / DELETE |
| 额外授权 | `public` / `auth` schema 的 USAGE、`auth.uid()` 的 EXECUTE、public 下所有序列的 USAGE+SELECT（自增主键必需） |
| 不能做 | 建表、改结构、绕过 RLS、访问其他库的隐藏数据 |
| 密码 | 32 位十六进制（`secrets.token_hex(16)`，256 bit 熵），**不写在本文档** |

**密码存放位置**（任一处读取即可）：

- 服务器：`/opt/dbee-db/CREDENTIALS.txt`（权限 `root:ubuntu 640`，`sudo cat` 可读）
- 本地：`db/CREDENTIALS.txt`（相对项目根 `zilv-mifeng/`）

**连接方式**（服务器本机执行）：

```bash
psql "postgresql://dbee_app:<密码>@127.0.0.1:5432/dbee"
# 或
PGPASSWORD='<密码>' psql -h 127.0.0.1 -U dbee_app -d dbee
```

**关键：查询前必须先声明用户身份**，否则 RLS 会让你一行都看不到：

```sql
SET app.user_id = '2109837240191418368';   -- 换成实际的 owner_id
SELECT * FROM public.profiles;             -- 只返回该用户自己的行
SET app.user_id TO DEFAULT;                -- 取消身份（回到未登录视角，0 行）
```

已实测（2026-10-13）：TCP 连接成功、用户 B 视角只见自己 1 行档案 + 3 行饮水、写入返回新 id 并成功清理、未设身份 0 行、建表被拒。

> 若未来要让**外部**连接，需要同时改 `listen_addresses`、`pg_hba.conf` 加放行网段，并**必须**在腾讯云安全组收紧来源 IP；默认不建议。

## 七、备份与恢复

```bash
# 全库逻辑备份（自定义格式，可并行、可选择性恢复）
sudo -u postgres pg_dump -Fc -d dbee -f /var/backups/dbee-$(date +%F).dump

# 纯文本 + gzip
sudo -u postgres pg_dump -d dbee | gzip > /var/backups/dbee-$(date +%F).sql.gz

# 恢复
sudo -u postgres pg_restore -d dbee --clean --if-exists /var/backups/dbee-2026-10-13.dump
```

cron 示例（每天 04:10，保留 14 天）：

```
10 4 * * * sudo -u postgres pg_dump -Fc -d dbee -f /var/backups/dbee-$(date +\%F).dump && find /var/backups -name 'dbee-*.dump' -mtime +14 -delete
```

## 八、与云端 WorkBuddy 云数据库的关系

当前 D-Bee 线上数据仍托管在 **WorkBuddy 云 PostgreSQL 17.11**（库 `postgres-6o15js8c`，7 张表 + 16 条 RLS 策略）。本机这份 PG 与云端**同为大版本 17**，因此 `pg_dump` / `pg_restore` 迁移无需跨版本转换。

**已完成（2026-10-13）：把云端 schema 与数据等价镜像到本机 `dbee` 库**，脚本为 `db/migrations/0002-mirror-to-local-pg.sql`（由 `db/gen-mirror-sql.py` 从备份文件生成，幂等可重跑，服务器留存副本在 `/opt/dbee-db/`）。镜像逐项对齐云端：7 表 / 14 索引 / 16 策略 / RLS 全开 / `authenticated` 28 行权限 / `anon` 0 行 / 数据 6 行。

与云端有 3 处**有意为之**的差异，使用前务必知道：

| 差异 | 说明 |
| --- | --- |
| `auth.uid()` | 本机无平台内置函数，改为 `auth` schema + 兼容函数，依次读 `app.user_id` → `request.jwt.claim.sub` → `request.jwt.claims->>'sub'`。应用侧可 `SET LOCAL app.user_id = '<用户ID>'` 模拟登录态 |
| 角色 | 只建 `anon` / `authenticated`（均 NOLOGIN）；平台的 `cloudbase_postgres_*` / `service_role` 不存在 |
| 表 owner | 本机是 `postgres` 超级用户，**超级用户默认绕过 RLS** —— 要验证行级隔离必须先 `SET ROLE authenticated` |

本机镜像的隔离实测（已通过）：用户 A 只可见自己的 1 行档案；用户 B 可见自己的 1 行档案 + 3 行饮水；陌生人视角 0 行；未登录（`auth.uid()` 为 NULL）0 行。

它可承担两种角色：

1. **备份落地目标** —— 与 `db/BACKUP.md` 的每日 JSON 快照互补，本机多一份可直接查询的关系型副本
2. **未来自建数据层** —— 若脱离托管平台，还需补齐：用户认证体系、`auth.uid()` 的真实来源（现为兼容层，需接真实会话/JWT）、以及 nginx 反代路由

尚未做的事（按需再决定）：配置 pg_dump 定时备份（把 dbee 库定期导出）、把本机镜像纳入每日自动化流程、为服务端应用接入真实会话（现在 `app.user_id` 需手动设置，未来应由后端在每次请求时按登录态注入）。

## 九、卸载 / 回滚

```bash
# 仅移除调优（保留数据库）
sudo rm /etc/postgresql/17/main/conf.d/10-tuning.conf && sudo systemctl restart postgresql

# 完整卸载
sudo pg_dropcluster --stop 17 main        # 会删除数据目录，谨慎
sudo apt-get purge postgresql-17 postgresql-contrib-17 postgresql-client-17
sudo rm /etc/apt/sources.list.d/pgdg.list
```

## 十、变更记录

- 2026-10-13：首次安装 PG 17.11（PGDG noble-pgdg @ 阿里云镜像）；新增 `conf.d/10-tuning.conf`；创建数据库 `dbee`；验证中文读写、扩展可用性、仅回环监听。
- 2026-10-13：把云端 schema 与数据**等价镜像**到 `dbee`（脚本 `db/migrations/0002-mirror-to-local-pg.sql`，服务器副本 `/opt/dbee-db/`，可幂等重跑）。复验：7 表 / 14 索引 / 16 策略 / `authenticated` 28 权限行 / `anon` 0 行 / 6 行数据；行级隔离四项实测通过。
- 2026-10-13：创建应用登录角色 `dbee_app`（继承 `authenticated`，非超级用户、不绕过 RLS、不可建表）。TCP + scram 连接、读写（含序列）、RLS 隔离、越权防护全部实测通过。凭据落 `/opt/dbee-db/CREDENTIALS.txt`（服务器）与 `db/CREDENTIALS.txt`（本地项目内）。
- 2026-10-13：所有产物统一收归项目目录 `zilv-mifeng/`；新增 `.gitignore` 排除凭据、备份与截图，防止误入库。
