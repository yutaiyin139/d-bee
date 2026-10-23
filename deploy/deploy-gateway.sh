#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# D-Bee 网关部署（本机编排）：渲染 env → 上传代码+资产 → 远端安装
# ═══════════════════════════════════════════════════════════════════════
# 用法：
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='SSH密码' \
#   DBEE_APP_PWD='数据库 dbee_app 密码' \
#     bash deploy/deploy-gateway.sh
#
#   可选：
#     LLM_API_KEY='sk-…'            配了就启用 LLM 代理（留空则 /.cloud/llm 返回 503）
#     DBEE_NODE_TARBALL=/path/x.tar.xz   Node 官方 tarball 兜底（GitHub/nodejs.org 直连失败时）
#     NPM_REGISTRY=https://registry.npmmirror.com   国内加速 npm
#
# 🔑 密钥持久化（重要）：
#   JWT_SECRET / IDENT_PEPPER / SMS_MASTER_CODE 首次运行时随机生成，
#   存进本地 deploy/gateway/.secrets.local（gitignored，**不入库、不外传**）。
#   以后每次部署**复用同一份** —— 因为它们绝不能变：
#     · 改 JWT_SECRET  → 所有在线用户被登出
#     · 改 IDENT_PEPPER → app_users 里已存的 ident_hash 全部失效，老用户变新用户
#   deploy-postgrest.sh 也从这份文件读 JWT_SECRET，保证网关与 PostgREST 验签一致。
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${DBEE_HOST:?缺少 DBEE_HOST}"
: "${DBEE_USER:?缺少 DBEE_USER}"
: "${DBEE_PWD:?缺少 DBEE_PWD（SSH 密码）}"
: "${DBEE_APP_PWD:?缺少 DBEE_APP_PWD（数据库 dbee_app 密码）}"

DIR="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cygpath -w "$(cd "$(dirname "$0")/.." && pwd)")"
PY="${PY:-C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
SSH_PY="$DIR/deploy/dbee-ssh.py"
GW_DIR="$DIR/deploy/gateway"
SECRETS="$GW_DIR/.secrets.local"

# openssl 生成随机 hex（本机 Git Bash 自带）
rand_hex() { openssl rand -hex "${1:-32}"; }

# ── 密钥装载：读 .secrets.local，缺哪个补哪个 ──────────────────────────
# 用一个简易 KEY=VALUE 读写；不引 jq/yq（本机不一定有）。
declare -A SEC
load_secret() {
  if [ -f "$SECRETS" ]; then
    local v; v="$(grep -E "^$1=" "$SECRETS" | head -1 | cut -d= -f2-)"
    [ -n "$v" ] && { SEC[$1]="$v"; return 0; }
  fi
  return 1
}
load_secret JWT_SECRET      || SEC[JWT_SECRET]="$(rand_hex 32)"
load_secret IDENT_PEPPER    || SEC[IDENT_PEPPER]="$(rand_hex 32)"
load_secret SMS_MASTER_CODE || SEC[SMS_MASTER_CODE]="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 24)"

# 两个密钥绝不能相同（config.validate 会拦；这里提前生成期就保证）
if [ "${SEC[JWT_SECRET]}" = "${SEC[IDENT_PEPPER]}" ]; then
  SEC[IDENT_PEPPER]="$(rand_hex 32)"
fi

# 落盘（0600，仅本机本人可读）；每次部署重写以纳入新生成的项
umask 077
{
  echo "# D-Bee 网关密钥 · 自动生成于 $(date '+%F %T') · 不入库"
  echo "# ⚠️ 这些值一经投用不可再改（改 JWT_SECRET=全员登出，改 IDENT_PEPPER=老用户失效）"
  echo "JWT_SECRET=${SEC[JWT_SECRET]}"
  echo "IDENT_PEPPER=${SEC[IDENT_PEPPER]}"
  echo "SMS_MASTER_CODE=${SEC[SMS_MASTER_CODE]}"
} > "$SECRETS"
chmod 600 "$SECRETS" 2>/dev/null || true

# 前置校验：PostgREST 与网关都要求 HS256 密钥 ≥32
[ "${#SEC[JWT_SECRET]}" -ge 32 ] || { echo "!! JWT_SECRET < 32"; exit 1; }

export DBEE_HOST DBEE_USER DBEE_PWD
export DBEE_JWT_SECRET="${SEC[JWT_SECRET]}"   # 供 dbee-ssh.py 的 __JWT_SECRET__ 占位符
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# 渲染产物放仓库外（含全部秘密），用毕 shred
RENDERED_ENV="$(mktemp -t dbee-gw-env-XXXXXX)"
cleanup() { shred -u "$RENDERED_ENV" 2>/dev/null || rm -f "$RENDERED_ENV"; }
trap cleanup EXIT

echo "==> 1/4 渲染 gateway.env（注入密钥；密钥已持久化到 deploy/gateway/.secrets.local）"
# 模板里的占位符用 dbee-ssh.py 的 render 只能替换它认识的那几个，
# 这里的秘密（IDENT_PEPPER/SMS_MASTER_CODE/DBEE_APP_PWD/LLM_API_KEY/WB_PUBLISHABLE_KEY）
# 不在它的替换表里 → 直接本地 sed 精确替换，逐项校验无残留。
sed \
  -e "s#__JWT_SECRET__#${SEC[JWT_SECRET]}#g" \
  -e "s#__IDENT_PEPPER__#${SEC[IDENT_PEPPER]}#g" \
  -e "s#__SMS_MASTER_CODE__#${SEC[SMS_MASTER_CODE]}#g" \
  -e "s#__DBEE_APP_PWD__#${DBEE_APP_PWD}#g" \
  -e "s#__LLM_API_KEY__#${LLM_API_KEY:-}#g" \
  "$GW_DIR/gateway.env.template" > "$RENDERED_ENV"
# WB_PUBLISHABLE_KEY 从前端源码提取（与 deploy.sh 同款做法，避免抄错静默失效）
WBKEY="$(grep -oE 'wbpk_[A-Za-z0-9_]+' "$DIR/src/cloudConfig.ts" 2>/dev/null | head -1 || true)"
sed -i "s#__WB_PUBLISHABLE_KEY__#${WBKEY}#g" "$RENDERED_ENV"
if grep -q '__' "$RENDERED_ENV"; then
  echo "!! env 仍有未替换占位符："; grep -n '__' "$RENDERED_ENV"; exit 1
fi
[ -n "$WBKEY" ] && echo "    publishableKey 已注入" || echo "    (未提取到 publishableKey，将跳过 access-key 校验)"
[ -n "${LLM_API_KEY:-}" ] && echo "    LLM_API_KEY 已配置（LLM 代理启用）" || echo "    LLM_API_KEY 留空 → /.cloud/llm 返回 503（拍照识别/AI 教练暂不可用）"

echo "==> 2/4 上传部署资产"
"$PY" "$SSH_PY" putfile "$RENDERED_ENV"                  /tmp/gateway.env.in
"$PY" "$SSH_PY" putfile "$GW_DIR/dbee-gateway.service"   /tmp/dbee-gateway.service
# 代码目录：putdir 原样字节上传（不做换行替换，.mjs 保持仓库里的 LF）
"$PY" "$SSH_PY" putdir  "$DIR/server"                    /tmp/dbee-gateway-src
if [ -n "${DBEE_NODE_TARBALL:-}" ]; then
  echo "    使用本地 Node tarball 兜底: $DBEE_NODE_TARBALL"
  [ -f "$DBEE_NODE_TARBALL" ] || { echo "!! DBEE_NODE_TARBALL 文件不存在"; exit 1; }
  "$PY" "$SSH_PY" putbin "$DBEE_NODE_TARBALL" /tmp/node.tar.xz   # 二进制走 putbin
fi

echo "==> 3/4 远端安装（Node22 → pg_dump 备份 → 部署代码 → npm install → env → systemd → healthz）"
# install-gateway.sh 从环境变量 NPM_REGISTRY 读 npm 源。dbee-ssh.py run 只接受单文件，
# 所以要在需要覆盖 registry 时，把它 export 到脚本首行再上传（不改仓库里的版本）。
NPM_REGISTRY="${NPM_REGISTRY:-}"
if [ -n "$NPM_REGISTRY" ]; then
  TMPINST="$(mktemp -t dbee-inst-XXXXXX.sh)"
  # 单引号包裹：registry URL 里没有单引号，避免再被 shell 二次解析
  { echo "export NPM_REGISTRY='$NPM_REGISTRY'"; cat "$GW_DIR/install-gateway.sh"; } > "$TMPINST"
  echo "    npm registry = $NPM_REGISTRY"
  "$PY" "$SSH_PY" run "$TMPINST"
  rm -f "$TMPINST"
else
  "$PY" "$SSH_PY" run "$GW_DIR/install-gateway.sh"
fi

echo "==> 4/4 完成"
echo "  网关 healthz（本机经 SSH 探测）: curl -sf http://127.0.0.1:8080/.cloud/healthz"
echo "  ⚠️ 数据面仍需 PostgREST：下一步 bash deploy/deploy-postgrest.sh"
echo "  ⚠️ 之后才切 nginx 上游：deploy/switch-nginx-cloud.sh"
