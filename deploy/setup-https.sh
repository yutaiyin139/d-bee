# 在服务器上执行：为站点域名申请 Let's Encrypt 证书并开启 HTTPS。
# 占位符 __DOMAIN__ / __DOMAINS__ / __EMAIL__ / __SUDO_PWD__ 由 deploy/dbee-ssh.py 替换。
#
# 双域名规划（2026-10-28 起）：
#   d-bee.cn      = 自律蜜蜂 Web 端（SPA + /.cloud/ 反代）
#   d-bee.com.cn  = 公司官网（静态站）
# 两域名同一台服务器 → 一张 SAN 证书同时覆盖（certbot 一次 -d 传多个域名），
# 也可分批签：DBEE_DOMAINS 只填已到备案/解析状态的域名。
#
# 由 deploy/deploy.sh 的 https 模式调用：
#   单域名：
#     DBEE_HOST=… DBEE_USER=… DBEE_PWD=… DBEE_DOMAIN=d-bee.cn \
#     DBEE_CERT_EMAIL=you@example.com bash deploy/deploy.sh https
#   多域名（SAN）：
#     DBEE_HOST=… DBEE_USER=… DBEE_PWD=… DBEE_DOMAIN=d-bee.cn \
#     DBEE_DOMAINS='d-bee.cn www.d-bee.cn d-bee.com.cn www.d-bee.com.cn' \
#     DBEE_CERT_EMAIL=you@example.com bash deploy/deploy.sh https
#
# ⚠️ 前置条件（对**列表里每一个**域名都缺一不可）：
#   1. A 记录已解析到本服务器公网 IP，且已生效（dig +short 域名 能返回本机 IP）
#   2. 80 端口能从公网访问（certbot 默认用 HTTP-01 校验）
#   3. 中国大陆服务器必须先完成 ICP 备案，否则 80 会被腾讯云拦截、校验必然失败
#   4. 每个域名在 nginx 里都有对应 server_name（certbot --nginx 靠它定位 server 块；
#      缺的域名会报 "Unable to find a virtual host listening on port 80"）
set -e

DOMAIN="__DOMAIN__"
DOMAINS="__DOMAINS__"
EMAIL="__EMAIL__"

# __DOMAINS__ 未传时退回单域名（向后兼容旧调用方式）
if [ -z "$DOMAINS" ]; then
  DOMAINS="$DOMAIN"
fi
if [ -z "$DOMAINS" ]; then
  echo "!! DOMAIN/DOMAINS 均为空，未渲染出域名，终止"
  exit 1
fi

echo "=== 0) 前置检查：$DOMAINS ==="
MY_IP="$(curl -s -m 10 https://api.ipify.org || true)"
echo "    本机公网IP: ${MY_IP:-(取不到)}"
echo -n "    80 端口本地监听: "; (ss -lntp 2>/dev/null | grep -q ':80 ' && echo yes) || echo no
FAIL=0
for d in $DOMAINS; do
  IPS="$(getent hosts "$d" | awk '{print $1}' | paste -sd' ' - || true)"
  printf "    %-24s -> %s\n" "$d" "${IPS:-(解析失败)}"
  # 解析不到、或解析结果不含本机 IP → certbot 必失败，提前拦下
  if [ -z "$IPS" ] || { [ -n "$MY_IP" ] && ! echo "$IPS" | grep -qw "$MY_IP"; }; then
    echo "       !! 未解析到本机公网 IP"
    FAIL=1
  fi
done
if [ "$FAIL" = "1" ]; then
  echo "!! 存在未解析/解析错误的域名。certbot 一定失败，请先修 DNS 或把该域名移出 DBEE_DOMAINS。"
  exit 1
fi
echo

echo "=== 1) 安装 certbot ==="
if command -v certbot >/dev/null 2>&1; then
  echo "    已安装: $(certbot --version 2>&1)"
else
  export DEBIAN_FRONTEND=noninteractive
  echo "__SUDO_PWD__" | sudo -S -p '' apt-get update -qq
  echo "__SUDO_PWD__" | sudo -S -p '' apt-get install -y -qq certbot python3-certbot-nginx
  echo "    安装完成: $(certbot --version 2>&1)"
fi

echo "=== 2) 申请 SAN 证书并自动改写 nginx 配置 ==="
if [ -n "$EMAIL" ]; then
  MAIL_ARGS="-m $EMAIL --agree-tos --no-eff-email"
else
  MAIL_ARGS="--register-unsafely-without-email --agree-tos"
fi
# 拼多域名 -d 参数（SAN 证书：一张证书覆盖列表里所有域名）
D_ARGS=""
for d in $DOMAINS; do
  D_ARGS="$D_ARGS -d $d"
done
# --redirect：自动把 80 的请求 301 到 443；-n 非交互
echo "__SUDO_PWD__" | sudo -S -p '' certbot --nginx $D_ARGS $MAIL_ARGS -n --redirect 2>&1 | tail -25

echo "=== 3) 复检 ==="
echo "__SUDO_PWD__" | sudo -S -p '' nginx -t 2>&1 | tail -2
echo "__SUDO_PWD__" | sudo -S -p '' systemctl reload nginx
echo "    nginx: $(systemctl is-active nginx)"
echo "    证书到期: $(echo "__SUDO_PWD__" | sudo -S -p '' certbot certificates 2>/dev/null | grep -E 'Expiry Date' | head -1)"

echo
echo "=== 4) 端到端自测 ==="
for d in $DOMAINS; do
  for u in "https://$d/" "http://$d/"; do
    printf "    %-40s -> %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$u" || echo 'curl失败')"
  done
done

echo
echo "=== 5) 自动续期已由 certbot 的 systemd timer 接管 ==="
echo "    （SAN 证书续期时整张一起续，无需逐域名处理）"
echo "    $(systemctl list-timers 2>/dev/null | grep -i certbot | head -1 || echo '（未发现 timer，可手动 certbot renew --dry-run 验证）')"
