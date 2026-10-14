#!/usr/bin/env bash
# 把 db/migrations 下的某个迁移同步到服务器本机镜像库（dbee）并执行。
#
# 背景：服务器 150.158.51.106 上有个与云端结构等价的 dbee 库（见 db/README.md）。
# 云端 schema 变更后，用这个脚本同步一份，避免两侧结构漂移。
#
# 用法：
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='密码' \
#     bash deploy/sync-mirror.sh 0003-atomic-ai-quota.sql
#
# 说明：迁移文件本身是幂等的（CREATE OR REPLACE / 条件判断），可重复执行。
set -euo pipefail

: "${DBEE_HOST:?缺少 DBEE_HOST}"
: "${DBEE_USER:?缺少 DBEE_USER}"
: "${DBEE_PWD:?缺少 DBEE_PWD}"

FILE="${1:?用法: bash deploy/sync-mirror.sh <db/migrations 下的文件名>}"
DIR="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cygpath -w "$(cd "$(dirname "$0")/.." && pwd)")"
PY="${PY:-C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
LOCAL_SQL="$DIR/db/migrations/$FILE"
REMOTE_SQL="/tmp/dbee-mirror-$FILE"
RUNNER="$(mktemp -t dbee-mirror-XXXXXX.sh)"

[ -f "$LOCAL_SQL" ] || { echo "找不到迁移文件: $LOCAL_SQL" >&2; exit 1; }

export MSYS_NO_PATHCONV=1
export DBEE_HOST DBEE_USER DBEE_PWD

echo "==> 上传 $FILE -> $REMOTE_SQL"
"$PY" "$DIR/deploy/dbee-ssh.py" putfile "$LOCAL_SQL" "$REMOTE_SQL"

# 服务器端以 postgres 身份在 dbee 库执行；ON_ERROR_STOP 保证任一句失败即中止。
# SQL 先放进 /opt/dbee-db（755）并放开读权限 —— postgres 读不到 /tmp 下 SFTP
# 上传的文件（0600），早前踩过这个坑。paramiko 无 tty，每条 sudo 都显式喂密码。
cat > "$RUNNER" <<EOF
set -e
SUDO_PWD='__SUDO_PWD__'
echo "\$SUDO_PWD" | sudo -S mkdir -p /opt/dbee-db
echo "\$SUDO_PWD" | sudo -S cp '$REMOTE_SQL' /opt/dbee-db/$FILE
echo "\$SUDO_PWD" | sudo -S chmod 644 /opt/dbee-db/$FILE
echo "\$SUDO_PWD" | sudo -S -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/$FILE
rm -f '$REMOTE_SQL'
EOF

echo "==> 在 dbee 库执行 $FILE"
"$PY" "$DIR/deploy/dbee-ssh.py" run "$RUNNER"
rm -f "$RUNNER"
echo "==> 完成"
