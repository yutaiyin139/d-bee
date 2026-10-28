#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 切 nginx /.cloud/ 上游：WorkBuddy 云端 → 本机自托管网关（本机编排）
# ═══════════════════════════════════════════════════════════════════════
# 用法：
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='SSH密码' \
#     bash deploy/switch-nginx-selfhost.sh
#
#   可选：
#     SERVER_NAME='_ 150.158.51.106 d-bee.cn www.d-bee.cn'
#       主 server 块（自律蜜蜂 Web 端）的 server_name，默认 '_ <HOST> d-bee.cn www.d-bee.cn'。
#       默认已含 Web 端正式域名：重跑本脚本不会把已绑定的域名覆盖掉。
#       域名仅写入 server_name（预认领），不触发任何 DNS；备案+解析生效前，
#       站点仍只经 IP 访问，加域名零副作用。HTTPS 见 deploy/setup-https.sh。
#     DBEE_CORP_SERVER_NAME='d-bee.com.cn www.d-bee.com.cn'
#       公司官网 server 块的 server_name（独立块，见 nginx.selfhost.conf.example）。
#       ⚠️ 官网域名不要写进 SERVER_NAME，两块重复会 conflicting server name。
#
# 前置：deploy-gateway.sh 与 deploy-postgrest.sh 都已跑完（网关 + 数据面在线）。
# 本脚本做：渲染自托管 nginx 配置 → 上传 → 远端备份+安装+reload+全链路E2E验证。
#
# 🔑 万能码：远端 E2E 若从日志读不到真实验证码会退回万能码，
#    从 deploy/gateway/.secrets.local 读 SMS_MASTER_CODE，本地注入到远端脚本
#    的一个临时副本（不改仓库版本、不入库）。
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${DBEE_HOST:?缺少 DBEE_HOST}"
: "${DBEE_USER:?缺少 DBEE_USER}"
: "${DBEE_PWD:?缺少 DBEE_PWD（SSH 密码）}"

DIR="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cygpath -w "$(cd "$(dirname "$0")/.." && pwd)")"
PY="${PY:-C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
SSH_PY="$DIR/deploy/dbee-ssh.py"
GW_DIR="$DIR/deploy/gateway"
SECRETS="$GW_DIR/.secrets.local"

# 双域名规划（2026-10-28）：主 server 块只放 Web 端域名（d-bee.cn，备案+解析生效前
# 可先用 _ + IP 预认领）；官网域名 d-bee.com.cn 由模板里独立的公司官网 server 块
# 承载（__CORP_SERVER_NAME__，默认 'd-bee.com.cn www.d-bee.com.cn'）。
# ⚠️ 不要把官网域名加回主块 SERVER_NAME —— 两块重复声明同一域名会触发
#    conflicting server name，且请求分流不可预期。
SERVER_NAME="${SERVER_NAME:-_ $DBEE_HOST d-bee.cn www.d-bee.cn}"
export DBEE_HOST DBEE_USER DBEE_PWD
export DBEE_SERVER_NAME="$SERVER_NAME"
# 官网块 server_name 可覆盖（如需临时下线官网块，传空串即可让渲染结果为空 server_name，
# 但更推荐保留默认值：域名未解析时该块零流量、零副作用）
export DBEE_CORP_SERVER_NAME="${DBEE_CORP_SERVER_NAME:-d-bee.com.cn www.d-bee.com.cn}"
# publishableKey：与 deploy.sh 同款，从前端源码提取（避免手抄漂移）
WEBAPP_KEY="$(grep -oE 'wbpk_[A-Za-z0-9_]+' "$DIR/src/cloudConfig.ts" 2>/dev/null | head -1 || true)"
export DBEE_WEBAPP_KEY="$WEBAPP_KEY"
[ -n "$WEBAPP_KEY" ] || { echo "!! 未能从 src/cloudConfig.ts 提取 publishableKey"; exit 1; }
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# 读万能码（E2E 兜底用）
MASTER=""
if [ -f "$SECRETS" ]; then
  MASTER="$(grep -E '^SMS_MASTER_CODE=' "$SECRETS" | head -1 | cut -d= -f2-)"
fi
[ -n "$MASTER" ] || { echo "!! .secrets.local 里没有 SMS_MASTER_CODE（网关也没配，E2E 兜底会失败）"; exit 1; }

# 临时产物：nginx 配置 + 注入万能码后的远端脚本（都不入库，用毕删）
# 临时产物：nginx 配置 + 注入万能码后的远端脚本（都不入库，用毕删）。
# ⚠️ 路径归一：本脚本设了 MSYS_NO_PATHCONV=1 + MSYS2_ARG_CONV_EXCL='*'（为了让
#    dbee-ssh.py 的远端绝对路径不被 Git Bash 改写），副作用是 mktemp 的 /tmp/... POSIX
#    路径会原样传给原生 Windows Python，被解释成 C:\tmp（不存在）而 FileNotFoundError；
#    而反斜杠的 C:\... 又会被 cleanup 的 safe-delete 判为「embedded drive prefix」拒绝。
#    cygpath -m 归一成纯正斜杠的 C:/... 两头都吃：Python open 正常，rm 也不触发 safe-delete。
TMP_NGINX="$(cygpath -m "$(mktemp)")"
TMP_REMOTE="$(cygpath -m "$(mktemp)")"
cleanup() { rm -f "$TMP_NGINX" "$TMP_REMOTE"; }
trap cleanup EXIT

echo "==> 1/3 渲染自托管 nginx 配置（server_name=$SERVER_NAME）"
"$PY" "$SSH_PY" render "$DIR/deploy/nginx.selfhost.conf.example" "$TMP_NGINX"
# 确认渲染后指向本机网关、且有效指令里不含云端域名
grep -q 'proxy_pass http://dbee_gateway' "$TMP_NGINX" || { echo "!! 渲染结果未指向 dbee_gateway"; exit 1; }
# 只看非注释行：模板注释里解释性地提到 workbuddy.host（说明云端版为何改写 Origin），
# 那不是生效指令，不能误判为「仍指向云端」。真正要防的是 proxy_pass/upstream 落到云端。
if grep -vE '^\s*#' "$TMP_NGINX" | grep -qE 'workbuddy\.host'; then
  echo "!! 渲染结果的有效指令仍含云端域名，拒绝切换"; exit 1
fi
echo "    ✓ 上游 = dbee_gateway(127.0.0.1:8080)，有效指令无云端残留"

echo "==> 2/3 上传 nginx 配置 → /tmp/dbee-nginx-selfhost.conf"
"$PY" "$SSH_PY" putfile "$TMP_NGINX" /tmp/dbee-nginx-selfhost.conf

# 远端脚本：本地先把 __SMS_MASTER_CODE__ 换成真值，__SUDO_PWD__/__WEBAPP_KEY__ 留给 run 替换
echo "==> 3/3 远端切换 + 全链路 E2E 验证"
sed "s#__SMS_MASTER_CODE__#${MASTER}#g" "$GW_DIR/switch-nginx-selfhost.remote.sh" > "$TMP_REMOTE"
grep -q '__SMS_MASTER_CODE__' "$TMP_REMOTE" && { echo "!! 万能码未注入"; exit 1; }
"$PY" "$SSH_PY" run "$TMP_REMOTE"

echo
echo "==> 切换编排完成。若上方 E2E 全 ✓，自托管链路已生效。"
echo "    公网访问验证（本机 → 服务器 80）：可在浏览器打开 http://$DBEE_HOST/ 走一遍登录。"
echo "    回滚到云端：见远端脚本失败时打印的 sudo cp 命令。"
