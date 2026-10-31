# 在服务器上执行：安装已渲染好的 nginx 配置并 reload。
# 配置正文由 deploy.sh 用 deploy/nginx.selfhost.conf.example（自托管版）渲染后
# 上传到 /tmp/dbee-nginx.conf，本脚本只负责「装 + 检查 + 生效 + 自测」，
# 不再内嵌一份配置副本（避免两份配置改漏）。
# ⚠️ 2026-10-31 起 deploy.sh 只渲染自托管模板（上游 = 本机网关 127.0.0.1:8080），
#    云端版 nginx.conf.example 已废弃为「仅存档」，不再被任何脚本自动推送。
#
# 占位符 __SUDO_PWD__ / __SITE_ORIGIN__ 由 deploy/dbee-ssh.py 在推送时替换。
set -e

CONF=/tmp/dbee-nginx.conf
TARGET=/etc/nginx/sites-available/d-bee
ORIGIN="__SITE_ORIGIN__"

if [ ! -f "$CONF" ]; then
  echo "!! 缺少 $CONF —— 请通过 deploy.sh 调用本脚本"
  exit 1
fi

echo "=== 1) 备份现有配置 ==="
if [ -f "$TARGET" ]; then
  echo "__SUDO_PWD__" | sudo -S -p '' cp "$TARGET" "$TARGET.bak"
  echo "    已备份 -> $TARGET.bak"
else
  echo "    （首次部署，无历史配置）"
fi

echo "=== 2) 安装新配置 ==="
echo "__SUDO_PWD__" | sudo -S -p '' cp "$CONF" "$TARGET"
echo "    server_name: $(grep -E '^\s*server_name' "$TARGET" | head -1 | tr -s ' ')"

# 去掉默认站点，避免抢 80 端口
if [ -e /etc/nginx/sites-enabled/default ]; then
  echo "__SUDO_PWD__" | sudo -S -p '' rm -f /etc/nginx/sites-enabled/default
  echo "    已移除 sites-enabled/default"
fi

if [ ! -e /etc/nginx/sites-enabled/d-bee ]; then
  echo "__SUDO_PWD__" | sudo -S -p '' ln -sf "$TARGET" /etc/nginx/sites-enabled/d-bee
  echo "    已建立软链 sites-enabled/d-bee"
fi

echo "=== 3) 语法检查并生效 ==="
echo "__SUDO_PWD__" | sudo -S -p '' nginx -t 2>&1 | tail -3
echo "__SUDO_PWD__" | sudo -S -p '' systemctl reload nginx
sleep 1
echo "    nginx: $(systemctl is-active nginx)"

echo
echo "=== 4) 本机自测：打 /.cloud/ 代理链路（自托管：上游 = 本机网关）==="
# key 由 deploy.sh 从 src/cloudConfig.ts 自动提取（避免手抄漂移）
KEY="__WEBAPP_KEY__"
if [ -z "$KEY" ]; then
  echo "    !! 未取到 publishableKey，跳过自测"
  exit 0
fi
UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
for p in "/.cloud/database/rest/entitlements?select=*" "/.cloud/database/rest/ai_usage?select=*"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
    -H "x-wb-webapp-access-key: $KEY" -H "User-Agent: $UA" \
    "http://127.0.0.1$p" || echo "curl失败")
  printf "    %-50s %s\n" "$p" "$code"
done
echo "    通过判据：链路通（200/401 均可，无 token 时 401 属正常）。"
echo "             若 502/504 说明本机网关(127.0.0.1:8080)没起来；"
echo "             若返回 HTML（200 但内容是 index.html）说明 /.cloud/ 落到了 SPA 兜底。"
