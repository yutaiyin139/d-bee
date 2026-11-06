#!/usr/bin/env bash
# D-Bee（自律蜜蜂）一键重新部署到腾讯云轻量服务器
#
# 前置（仅首次）：pip install paramiko
#   C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/pip.exe install paramiko
#
# ── 用法 1：纯前端更新（不动 nginx）──────────────────────────────
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='密码' bash deploy/deploy.sh
#
# ── 用法 2：绑域名 / 改过 nginx 配置 ────────────────────────────
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='密码' \
#   DBEE_DOMAIN=dbee.example.com APPLY_NGINX_CONF=1 bash deploy/deploy.sh
#
# ── 用法 3：上 HTTPS（需域名已解析 + ICP 备案通过）──────────────
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='密码' \
#   DBEE_DOMAIN=d-bee.cn DBEE_CERT_EMAIL=you@example.com \
#   bash deploy/deploy.sh https
#   多域名 SAN 证书（双域名规划：d-bee.cn=Web端 / d-bee.com.cn=官网）：
#   DBEE_DOMAIN=d-bee.cn \
#   DBEE_DOMAINS='d-bee.cn www.d-bee.cn d-bee.com.cn www.d-bee.com.cn' \
#   bash deploy/deploy.sh https
#
# 可选环境变量：
#   DBEE_DOMAIN        域名（不带协议）。设置后 SITE_ORIGIN 自动变 https://域名
#   DBEE_DOMAINS       空格分隔的多域名列表（https 模式签 SAN 证书用；留空退回单域名）
#   DBEE_CERT_EMAIL    Let's Encrypt 通知邮箱（https 模式用，留空则不注册邮箱）
#   SITE_ORIGIN        强制指定前端内写死的站点来源（覆盖上面的自动推导）
#   SERVER_NAME        强制指定 nginx server_name（默认「域名 服务器IP _」）
#   APPLY_NGINX_CONF=1 顺带渲染并推送 deploy/nginx.selfhost.conf.example（自托管版）
#                      ⚠️ 已用 certbot 上过 HTTPS 时不要开 —— 模板只有 80 端口，
#                         覆盖会冲掉 443 配置（push-nginx.sh 会先备份成 .bak）
#                      🔒 2026-10-31 起本分支只渲染【自托管模板】（上游 = 本机网关
#                         127.0.0.1:8080），不再渲染云端版 nginx.conf.example ——
#                         避免一键把生产 nginx 退回 WorkBuddy 云、绕过 0039 闸门。
#                         渲染后会守卫校验：有效指令含 dbee_gateway 且无 workbuddy.host。
#   FIX_ENDPOINT=1     把前端 endpoint 钉死成 $SITE_ORIGIN（仅排查问题用）。
#                      默认不钉死：src/cloudConfig.ts 运行时取 window.location.origin，
#                      同一份产物在 IP / 自建域名 / 官方域名下都可用
#   SKIP_BUILD=1       跳过构建（产物已在 dist/ 里时用）
#   PY / NPM           覆盖 python / npm 可执行文件路径
set -euo pipefail

: "${DBEE_HOST:?缺少 DBEE_HOST}"
: "${DBEE_USER:?缺少 DBEE_USER}"
: "${DBEE_PWD:?缺少 DBEE_PWD}"

MODE="${1:-deploy}"
DBEE_DOMAIN="${DBEE_DOMAIN:-}"

# ---- 推导站点来源与 server_name ----
if [ -n "$DBEE_DOMAIN" ]; then
  SITE_ORIGIN="${SITE_ORIGIN:-https://$DBEE_DOMAIN}"
  # 🔴 必须含 www 子域名：certbot --nginx 靠 server_name 定位 server 块，
  #    签 SAN 证书（DBEE_DOMAINS='d-bee.cn www.d-bee.cn'）时若 server_name 里没有
  #    www.<域名>，certbot 会报 "Unable to find a virtual host listening on port 80"。
  #    2026-11-06 实测踩过：旧推导只有 "$DBEE_DOMAIN $DBEE_HOST _"，
  #    线上 server_name 缺 d-bee.cn/www.d-bee.cn，只能手工改远端配置绕过。
  #    `_` catch-all 必须留最后：它兜住 IP 直连与未知 Host（但见下方 404 说明）。
  SERVER_NAME="${SERVER_NAME:-$DBEE_DOMAIN www.$DBEE_DOMAIN $DBEE_HOST _}"
else
  SITE_ORIGIN="${SITE_ORIGIN:-http://$DBEE_HOST}"
  SERVER_NAME="${SERVER_NAME:-_}"
fi

PY="${PY:-C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
NPM="${NPM:-C:/Users/yuty/.workbuddy/binaries/node/versions/22.22.2-6/npm.cmd}"
# pwd -W：取 Windows 风格路径。因为下面设置了 MSYS_NO_PATHCONV=1，
# MSYS 不会再自动把 /c/... 转成 C:/...，必须一开始就拿到 Windows 形式
DIR="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cygpath -w "$(cd "$(dirname "$0")/.." && pwd)")"
RENDERED="$DIR/deploy/nginx.rendered.conf"

export DBEE_HOST DBEE_USER DBEE_PWD
export DBEE_SITE_ORIGIN="$SITE_ORIGIN"
export DBEE_SERVER_NAME="$SERVER_NAME"
export DBEE_DOMAIN
export DBEE_DOMAINS="${DBEE_DOMAINS:-}"
export DBEE_CERT_EMAIL="${DBEE_CERT_EMAIL:-}"

# 自测用 publishableKey：直接从源码提取，避免脚本里再抄一份（抄错会静默地把自测变成假警报）
WEBAPP_KEY="$(grep -oE 'wbpk_[A-Za-z0-9_]+' "$DIR/src/cloudConfig.ts" 2>/dev/null | head -1 || true)"
export DBEE_WEBAPP_KEY="$WEBAPP_KEY"
if [ -z "$WEBAPP_KEY" ]; then
  echo "!! 警告：未能从 src/cloudConfig.ts 提取 publishableKey，云端自测将跳过" >&2
fi

# ============================================================
# 模式 3：HTTPS
# ============================================================
if [ "$MODE" = "https" ]; then
  if [ -z "$DBEE_DOMAIN" ]; then
    echo "!! https 模式必须指定 DBEE_DOMAIN" >&2
    exit 1
  fi
  echo "==> 请求 Let's Encrypt 证书：$DBEE_DOMAIN"
  echo "    前置检查：域名已解析到 $DBEE_HOST、80 端口可从公网访问、ICP 备案已通过"
  # 🔴 必须禁用 MSYS 路径转换：putfile 的远端目标 /tmp/dbee-setup-https.sh 若被
  #    Git Bash 转成 Windows 临时路径（C:/.../tmp/...），paramiko 会报 ENOENT
  #    "No such file"（远端根本没有那个目录）。2026-11-06 实测踩过：常规部署在
  #    第 119 行才 export MSYS_NO_PATHCONV=1，而 https 分支在第 83-96 行、早于它。
  #    本分支以 exit 0 结尾，不会走到常规部署，故此处 export 无副作用；
  #    结尾的 unset 只是保持与原有写法一致（退出前恢复环境，便于被 source 调用）。
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
  "$PY" "$DIR/deploy/dbee-ssh.py" render "$DIR/deploy/setup-https.sh" "$DIR/deploy/setup-https.rendered.sh"
  "$PY" "$DIR/deploy/dbee-ssh.py" putfile "$DIR/deploy/setup-https.rendered.sh" "/tmp/dbee-setup-https.sh"
  "$PY" "$DIR/deploy/dbee-ssh.py" run "$DIR/deploy/setup-https.rendered.sh"
  # 🔴 渲染产物含明文 sudo 密码（__SUDO_PWD__ 已被 dbee-ssh.py 替换）→ 用完立即删，
  #    绝不留在工作区（否则可能被 git add 入库，或被后续操作读取泄露）。
  rm -f "$DIR/deploy/setup-https.rendered.sh"
  unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL
  echo "==> 完成。请核对上面的 https 返回码是否为 200。"
  exit 0
fi

# ============================================================
# 模式 1/2：常规部署
# ============================================================
STEP_TOTAL=3
[ "${APPLY_NGINX_CONF:-0}" = "1" ] && STEP_TOTAL=4

echo "==> 1/$STEP_TOTAL 构建（server_name = $SERVER_NAME，endpoint = 运行时取当前访问来源）"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "    已设置 SKIP_BUILD=1，跳过构建"
elif [ "${FIX_ENDPOINT:-0}" = "1" ]; then
  # 默认不写死 endpoint：src/cloudConfig.ts 会在运行时取 window.location.origin，
  # 同一份产物可在 IP / 自建域名 / 官方域名下通用，换域名无需重新构建。
  # 仅排查问题时才用 FIX_ENDPOINT=1 显式钉死到 $SITE_ORIGIN。
  echo "    FIX_ENDPOINT=1 -> 钉死 endpoint = $SITE_ORIGIN"
  (cd "$DIR" && VITE_CLOUD_ENDPOINT="$SITE_ORIGIN" "$NPM" run build)
else
  (cd "$DIR" && "$NPM" run build)
fi

echo "==> 2/$STEP_TOTAL 上传 dist/ -> /var/www/d-bee"
# MSYS_NO_PATHCONV：防止 Git Bash 把 /var/www/d-bee 转成 Windows 路径
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
"$PY" "$DIR/deploy/dbee-ssh.py" putdir "$DIR/dist" "/var/www/d-bee"

if [ "${APPLY_NGINX_CONF:-0}" = "1" ]; then
  echo "==> 3/$STEP_TOTAL 渲染并推送 Nginx 配置（自托管版）"
  # 🔒 只渲染自托管模板（上游 = 本机网关 dbee_gateway 127.0.0.1:8080）。
  #    绝不渲染 nginx.conf.example（云端反代版）：那会把生产 nginx 退回
  #    WorkBuddy 云，/.cloud/ 流量绕开 0039 权益闸门（grant_honey 不验事实、
  #    consume_* 限额可传参绕过）。需要回云端属重大架构决策，不走本脚本。
  "$PY" "$DIR/deploy/dbee-ssh.py" render "$DIR/deploy/nginx.selfhost.conf.example" "$RENDERED"
  # 守卫 1：渲染结果必须指向本机网关
  grep -q 'proxy_pass http://dbee_gateway' "$RENDERED" \
    || { echo "!! 渲染结果未指向 dbee_gateway，拒绝推送"; rm -f "$RENDERED"; exit 1; }
  # 守卫 2：有效指令（非注释行）里不得残留云端域名 —— 注释里解释性地提到
  #    workbuddy.host 不算生效指令，不能误判（与 switch-nginx-selfhost.sh 同款判据）
  if grep -vE '^\s*#' "$RENDERED" | grep -qE 'workbuddy\.host'; then
    echo "!! 渲染结果的有效指令仍含云端域名，拒绝推送"; rm -f "$RENDERED"; exit 1
  fi
  echo "    ✓ 上游 = dbee_gateway(127.0.0.1:8080)，有效指令无云端残留"
  "$PY" "$DIR/deploy/dbee-ssh.py" putfile "$RENDERED" "/tmp/dbee-nginx.conf"
  "$PY" "$DIR/deploy/dbee-ssh.py" run "$DIR/deploy/push-nginx.sh"
  rm -f "$RENDERED"
fi

echo "==> $STEP_TOTAL/$STEP_TOTAL 冒烟验证"
# 恢复 MSYS 路径转换：上面为了保护远端路径禁用了它，
# 但禁用后 curl 的 -o /dev/null 在 Windows 上也会失效（exit 23）
unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL

if [ -n "$DBEE_DOMAIN" ]; then
  # 🔴 上 HTTPS（certbot --redirect）后，IP 直连 http://$DBEE_HOST/ 会变成 404：
  #    certbot 生成的 80 块只对 if ($host = 域名) 做 301，末尾 return 404 兜底，
  #    而 IP / 未知 Host 不匹配任何 if → 落 404（2026-11-06 实测，签发前是 200）。
  #    因此冒烟必须以「域名 + https」为准，IP 只作参考且 404 不算失败。
  # 🔴 每个 URL 最多重试 3 次：curl 偶发抖动会返回 000（2026-11-06 实测同一 IP
  #    连续探测中偶发一次 000curl失败、复测又稳定）。冒烟是部署最后一步，此时产物
  #    已推送成功，若因网络抖动误报 exit 1 会把「部署成功」误判为「失败」。重试后
  #    仍非 200 才算真失败（.invalid 域名 DNS 必失败，重试 3 次仍红 → 护栏不失效）。
  for url in "$SITE_ORIGIN/" "https://www.$DBEE_DOMAIN/" "$SITE_ORIGIN/.cloud/healthz"; do
    code="000"
    for attempt in 1 2 3; do
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$url" || echo "curl失败")
      [ "$code" = "200" ] && break
      [ "$attempt" -lt 3 ] && sleep 2
    done
    printf "    %-42s -> %s\n" "$url" "$code"
    case "$code" in
      200) ;;
      *) echo "    !! 冒烟失败：$url 返回 $code（期望 200，已重试 3 次）" >&2; SMOKE_FAIL=1 ;;
    esac
  done
  # 80 应 301 跳 https（certbot --redirect 的效果），IP 直连 404 属预期
  for url in "http://$DBEE_DOMAIN/" "http://$DBEE_HOST/"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$url" || echo "curl失败")
    printf "    %-42s -> %s %s\n" "$url" "$code" \
      "$([ "$url" = "http://$DBEE_HOST/" ] && echo '(IP直连 404 属预期：certbot 跳转块只匹配域名)' || echo '(应为 301)')"
  done
  echo "    $(curl -s -m 20 "$SITE_ORIGIN/" | grep -o '<title>[^<]*</title>' || true)"
  if [ "${SMOKE_FAIL:-0}" = "1" ]; then
    echo "==> 🔴 冒烟未全绿，请检查上面的失败项" >&2
    exit 1
  fi
else
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://$DBEE_HOST/" || echo "curl失败")
  echo "    http://$DBEE_HOST/ -> $code"
  echo "    $(curl -s -m 15 "http://$DBEE_HOST/" | grep -o '<title>[^<]*</title>' || true)"
fi
echo "==> 完成"
