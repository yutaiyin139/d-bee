#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# D-Bee 自托管数据面（A2）：在本机执行，把 PostgREST 部署资产送上服务器并安装
# ═══════════════════════════════════════════════════════════════════════
# 用法：
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='SSH密码' \
#   DBEE_JWT_SECRET='与网关 .env 里 JWT_SECRET 完全一致的值（≥32字符）' \
#     bash deploy/deploy-postgrest.sh
#
# GitHub 直连失败时的兜底（先在能上网的机器下载官方发布件，再指定本地路径）：
#   DBEE_POSTGREST_TARBALL=/path/to/postgrest-v16.4-linux-static-x86-64.tar.xz \
#     … bash deploy/deploy-postgrest.sh
#
# 本脚本只做「渲染 → 上传 → 触发远端安装」，真正的安装/校验逻辑全部在
# deploy/postgrest/install-postgrest.sh（服务器端执行），职责与 deploy.sh
# 对 push-nginx.sh 的关系一致。
#
# 安全说明：
#   · DBEE_JWT_SECRET 会经 dbee-ssh.py 的占位符替换写进两处：
#       ① 上传前的 /tmp/postgrest.config.in（安装脚本渲染完 config 后立即删除）
#       ② install-postgrest.sh 脚本体内（供第 10 步端到端验证签测试 JWT，
#          远端脚本执行完即由 dbee-ssh.py 删除）
#     两处都不入库、不打印。本脚本渲染出的本地临时文件用 mktemp 放在仓库外，
#     用毕 shred/rm —— 绝不在工作区里留下含密钥的文件。
#   · dbee_web 的数据库密码不在这里生成：由安装脚本在服务器上现场随机生成，
#     只写进 /etc/postgrest/config，从不经过网络。
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${DBEE_HOST:?缺少 DBEE_HOST}"
: "${DBEE_USER:?缺少 DBEE_USER}"
: "${DBEE_PWD:?缺少 DBEE_PWD}"
: "${DBEE_JWT_SECRET:?缺少 DBEE_JWT_SECRET（必须与网关 server/.env 的 JWT_SECRET 一致）}"

# 前置校验：PostgREST 对 HS256 密钥强制 ≥32 字符（config.mjs 的 validate 同标准）。
# 在这里挡住，而不是等远端起服务失败再翻 journal —— 那个报错离根因隔了两层。
if [ "${#DBEE_JWT_SECRET}" -lt 32 ]; then
  echo "!! DBEE_JWT_SECRET 长度 ${#DBEE_JWT_SECRET} < 32：PostgREST 会拒绝启动（JWT secret is too short）"
  echo "   生成一个：openssl rand -hex 32   （然后同步写进网关的 .env）"
  exit 1
fi

# 项目根目录（Windows 形式路径；MSYS_NO_PATHCONV 开启后不会自动转换，见 deploy.sh 同款处理）
DIR="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cygpath -w "$(cd "$(dirname "$0")/.." && pwd)")"
PY="${PY:-C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
SSH_PY="$DIR/deploy/dbee-ssh.py"

export DBEE_HOST DBEE_USER DBEE_PWD DBEE_JWT_SECRET
# 保护远端绝对路径（/tmp/…）不被 Git Bash 转成 Windows 路径
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# 渲染产物与远端探针脚本都放仓库外（前者含 JWT 密钥，绝不能出现在 git status 里）
RENDERED_CONF="$(mktemp -t postgrest-config-XXXXXX)"
PROBE_SH="$(mktemp -t postgrest-probe-XXXXXX.sh)"
cleanup() {
  shred -u "$RENDERED_CONF" 2>/dev/null || rm -f "$RENDERED_CONF"
  rm -f "$PROBE_SH"
}
trap cleanup EXIT

echo "==> 1/5 渲染 config 模板（替换 __JWT_SECRET__；__DB_PASSWORD__ 留给服务器端）"
# render 是纯本地操作：把模板里 dbee-ssh.py 认识的占位符换成环境变量值。
# __DB_PASSWORD__ 不在替换表里，会原样保留 → 安装脚本第 7 步在服务器上填。
"$PY" "$SSH_PY" render "$DIR/deploy/postgrest/config.template" "$RENDERED_CONF"
if grep -q '__JWT_SECRET__' "$RENDERED_CONF"; then
  echo "!! __JWT_SECRET__ 未被替换（DBEE_JWT_SECRET 传空了？）"; exit 1
fi

echo "==> 2/5 上传部署资产"
# 文本三件走 putfile（LF 归一）：config 模板 / systemd 单元 / 0032 迁移
"$PY" "$SSH_PY" putfile "$RENDERED_CONF"                        /tmp/postgrest.config.in
"$PY" "$SSH_PY" putfile "$DIR/deploy/postgrest/postgrest.service" /tmp/postgrest.service
"$PY" "$SSH_PY" putfile "$DIR/db/migrations/0032-postgrest-roles.sql" /tmp/0032-postgrest-roles.sql

if [ -n "${DBEE_POSTGREST_TARBALL:-}" ]; then
  echo "    使用本地二进制包兜底: $DBEE_POSTGREST_TARBALL"
  [ -f "$DBEE_POSTGREST_TARBALL" ] || { echo "!! DBEE_POSTGREST_TARBALL 指向的文件不存在"; exit 1; }
  # ⚠️ 必须走 putbin：putfile 会把 \r\n 替换成 \n，对二进制 tar.xz 是毁灭性的
  #    （sha256 必炸）。这正是给 dbee-ssh.py 加 putbin 子命令的原因。
  "$PY" "$SSH_PY" putbin "$DBEE_POSTGREST_TARBALL" /tmp/postgrest.tar.xz
else
  echo "    （未指定 DBEE_POSTGREST_TARBALL：服务器将直接从 GitHub 下载；失败再走兜底）"
fi

echo "==> 3/5 远端安装（下载校验 → 建角色 → 迁移 → 配置 → systemd → 端到端验证）"
# run 会在上传时替换脚本里的 __SUDO_PWD__ 与 __JWT_SECRET__，远端执行完自动删脚本
"$PY" "$SSH_PY" run "$DIR/deploy/postgrest/install-postgrest.sh"

echo "==> 4/5 远端就绪复核（admin /ready）"
# 安装脚本内部已探测过；这里再打一次是给「脚本 exit 0 但服务随后崩了」兜底
# （Restart=always 会在 3s 后拉起，若反复崩 /ready 就不会是 200）。
# 探针必须落成真实临时文件再交给 run（run 的入参是本地文件路径；
# process substitution 的 /dev/fd/xx 在 Git Bash + paramiko 下不可靠）。
cat > "$PROBE_SH" <<'PROBE'
for i in 1 2 3 4 5; do
  if curl -sf -m 3 http://127.0.0.1:3002/ready >/dev/null 2>&1; then
    echo "READY_OK"; exit 0
  fi
  sleep 2
done
echo "READY_FAIL"; exit 1
PROBE
if "$PY" "$SSH_PY" run "$PROBE_SH" | grep -q 'READY_OK'; then
  echo "    ✓ 服务在远端持续就绪"
else
  echo "    !! /ready 复核未通过 —— 安装时是好的，之后服务可能崩了。"
  echo "       排查: SSH 后执行 sudo journalctl -u postgrest -n 50 --no-pager"
  exit 1
fi

echo "==> 5/5 完成"
echo "  服务状态:  经 SSH 执行 systemctl status postgrest --no-pager"
echo "  热重载:    sudo systemctl reload postgrest   （SIGUSR1：重载 config + 刷 schema cache）"
echo "  下一步（泳道 A 剩余）: 部署 Node 网关(server/) → 切 nginx /.cloud/ 上游 → iOS 构建"
