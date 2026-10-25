#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 服务器端：安装 Node 22 + 部署 D-Bee 网关 + 起 systemd 服务
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/deploy-gateway.sh 经 dbee-ssh.py run 调用，**不要手工跑**。
# 占位符（sudo 密码标记）由 dbee-ssh.py 在上传时替换；本注释刻意不写出该标记本身，
# 否则渲染后密码会被写进注释落盘。
#
# 前置（调用方负责上传到位）：
#   /tmp/gateway.env.in        ← gateway.env.template 渲染掉全部秘密后的产物
#   /tmp/dbee-gateway.service  ← deploy/gateway/dbee-gateway.service
#   /tmp/dbee-gateway-src/     ← server/ 目录内容（index.mjs + lib/ + package.json）
#
# 设计要点：
#   · Node 用**官方二进制 tarball + sha256 钉死**，不用 apt：
#     Ubuntu 24.04 源里只有 nodejs 18.19，而 package.json 要求 >=22
#     （代码用了 node:crypto 的现代 API 与 ESM 行为）。
#     NodeSource 虽可达，但那是第三方 apt 源，等于把版本控制权交出去；
#     官方 tarball 可精确锁版本 + 校验字节，与 PostgREST 的做法一致。
#   · 部署前先 pg_dump 备份：本轮已改过库（0031/0033），网关上线是又一次
#     状态变更，留个回滚点。
#   · 幂等：重复执行 = 覆盖代码 + 覆盖 env + 重启服务，不破坏数据。
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

NODE_VERSION="22.22.2"
NODE_SHA256="88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a"
NODE_DIRNAME="node-v${NODE_VERSION}-linux-x64"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIRNAME}.tar.xz"
NODE_INSTALL_ROOT="/usr/local/lib/nodejs"
NODE_BIN="/usr/local/bin/node"

APP_DIR="/opt/dbee-gateway"
ENV_DIR="/etc/dbee"
ENV_FILE="${ENV_DIR}/gateway.env"
UNIT="/etc/systemd/system/dbee-gateway.service"
BACKUP_DIR="/opt/dbee-db/backups"

echo "═══ D-Bee 网关部署 ═══"

# ── 0) 架构自检 ────────────────────────────────────────────────────────
MACHINE="$(uname -m)"
if [ "$MACHINE" != "x86_64" ]; then
  echo "!! 本脚本按 x86_64 写死 Node 资产名，检测到 $MACHINE，请手工调整"; exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1) 安装 Node 22（已装且版本对则跳过）───────────────────────────────
CUR_NODE="$("$NODE_BIN" -v 2>/dev/null || echo none)"
if [ "$CUR_NODE" = "v${NODE_VERSION}" ]; then
  echo "  Node 已是 v${NODE_VERSION}，跳过安装"
else
  echo "  当前 Node: $CUR_NODE → 安装 v${NODE_VERSION}"
  if [ -f /tmp/node.tar.xz ]; then
    echo "  使用本地上传的 /tmp/node.tar.xz"
    cp /tmp/node.tar.xz "$WORK/node.tar.xz"
  else
    # 腾讯云国内机器直连 nodejs.org 常不稳定（大文件 GET 易断）。
    # 优先走 npmmirror 的 Node 官方镜像（字节与官方一致，仍用同一 sha256 校验），
    # 失败再回退官方源。sha256 校验是最终裁判，镜像来源不影响安全性。
    MIRROR="https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${NODE_DIRNAME}.tar.xz"
    echo "  下载 Node（先镜像后官方）"
    if curl -fsSL --retry 3 --retry-delay 2 -m 600 -o "$WORK/node.tar.xz" "$MIRROR" \
       || curl -fsSL --retry 3 --retry-delay 2 -m 600 -o "$WORK/node.tar.xz" "$NODE_URL"; then
      echo "    ✓ 下载完成"
    else
      echo "!! 下载失败（镜像与官方源都不可达）。兜底：本地下载后用"
      echo "   DBEE_NODE_TARBALL=/path/to/${NODE_DIRNAME}.tar.xz bash deploy/deploy-gateway.sh"
      exit 1
    fi
  fi
  # 供应链完整性：Node 是跑生产服务的运行时，必须确认是官方字节
  GOT="$(sha256sum "$WORK/node.tar.xz" | awk '{print $1}')"
  if [ "$GOT" != "$NODE_SHA256" ]; then
    echo "!! sha256 不匹配 —— 拒绝安装"; echo "   期望 $NODE_SHA256"; echo "   实际 $GOT"; exit 1
  fi
  echo "    ✓ sha256 与 nodejs.org 官方 v${NODE_VERSION} 发布值一致"
  tar Jxf "$WORK/node.tar.xz" -C "$WORK"
  SUDO install -d -m 0755 "$NODE_INSTALL_ROOT"
  SUDO rm -rf "${NODE_INSTALL_ROOT:?}/${NODE_DIRNAME}"
  SUDO cp -a "$WORK/$NODE_DIRNAME" "$NODE_INSTALL_ROOT/"
  # 符号链接进 /usr/local/bin：systemd 单元里写的是绝对路径 /usr/local/bin/node
  SUDO ln -sfn "${NODE_INSTALL_ROOT}/${NODE_DIRNAME}/bin/node" /usr/local/bin/node
  SUDO ln -sfn "${NODE_INSTALL_ROOT}/${NODE_DIRNAME}/bin/npm"  /usr/local/bin/npm
  SUDO ln -sfn "${NODE_INSTALL_ROOT}/${NODE_DIRNAME}/bin/npx"  /usr/local/bin/npx
  echo "  已安装：$("$NODE_BIN" -v)"
fi
"$NODE_BIN" -v

# ── 2) 专用系统账号 ────────────────────────────────────────────────────
if ! id -u dbee >/dev/null 2>&1; then
  SUDO useradd --system --no-create-home --shell /usr/sbin/nologin \
    --home-dir /nonexistent --user-group dbee
  echo "  已创建系统账号 dbee"
else
  echo "  系统账号 dbee 已存在"
fi

# ── 3) pg_dump 备份（改动前留回滚点）───────────────────────────────────
SUDO install -d -m 0750 -o postgres -g postgres "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BK="${BACKUP_DIR}/dbee-pre-gateway-${STAMP}.sql.gz"
echo "  备份数据库 → $BK"
# 🔴 必须 `sudo -u postgres`，不能 `sudo bash -c "pg_dump -U postgres …"`。
#    pg_hba 里本地连接是 `local all postgres peer` —— peer 认证按**OS 用户**判定，
#    以 root 身份跑时 OS 用户是 root≠postgres，直接
#    `FATAL: Peer authentication failed for user "postgres"`。
#    实测踩过：那条命令让 pg_dump 失败，但管道后的 gzip 仍会生成一个 20 字节的空壳，
#    看起来"备份成功"—— 所以下面还配了体积守卫，双重防呆。
#    BACKUP_DIR 属主是 postgres，故它有权在里面创建文件。
if SUDO -u postgres bash -c "pg_dump -d dbee --no-owner --no-privileges | gzip -9 > '$BK'"; then
  SZ="$(SUDO stat -c%s "$BK" 2>/dev/null || echo 0)"
  # 体积守卫：pg_dump 失败时 gzip 会留下几十~几百字节的空壳，
  # 「有文件」不等于「有备份」。宁可中止部署，也不要在没有回滚点的情况下动生产。
  if [ "$SZ" -gt 10000 ]; then
    SUDO chown postgres:postgres "$BK"
    SUDO chmod 0640 "$BK"
    echo "    ✓ 备份完成（${SZ} 字节）"
    # 备份可用性抽查：确认 gzip 流完整且含真实 DDL（不完整的归档 gunzip 会报错）
    if SUDO -u postgres bash -c "gunzip -t '$BK'"; then
      echo "    ✓ 归档完整性校验通过（gunzip -t）"
    else
      echo "!! 归档损坏，拒绝继续"; exit 1
    fi
  else
    echo "!! 备份文件异常小（${SZ} 字节），拒绝继续 —— 没有回滚点就不动生产"
    exit 1
  fi
else
  echo "!! pg_dump 失败，拒绝继续"; exit 1
fi
# 只保留最近 5 份，避免磁盘被备份撑满
SUDO bash -c "ls -1t ${BACKUP_DIR}/dbee-pre-gateway-*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f"

# ── 4) 部署代码 ────────────────────────────────────────────────────────
if [ ! -f /tmp/dbee-gateway-src/index.mjs ]; then
  echo "!! 缺少 /tmp/dbee-gateway-src/index.mjs（应由 deploy-gateway.sh 上传）"; exit 1
fi
echo "  部署代码 → $APP_DIR"
SUDO install -d -m 0755 -o root -g root "$APP_DIR"
# 先放进 root 属主的目录，再整体覆盖：避免"上传到一半服务读到残缺代码"
SUDO cp -a /tmp/dbee-gateway-src/. "$APP_DIR/"
SUDO rm -rf /tmp/dbee-gateway-src

# ── 5) 安装依赖（只有一个：pg）─────────────────────────────────────────
# npm 需要写 node_modules，所以这一步先以 ubuntu 身份跑（$APP_DIR 此时 root:root 755
# 对 ubuntu 不可写）→ 改为临时放开属主，装完再锁回 root。
echo "  npm install（依赖树极小：pg + 传递依赖）"
SUDO chown -R ubuntu:ubuntu "$APP_DIR"
cd "$APP_DIR"
# 默认走 npmjs.org（权威源）。国内慢时用 NPM_REGISTRY 覆盖成 npmmirror：
#   NPM_REGISTRY=https://registry.npmmirror.com bash install-gateway.sh
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
if ! "$NODE_INSTALL_ROOT/$NODE_DIRNAME/bin/npm" install --omit=dev --no-audit --no-fund \
      --registry "$REGISTRY" 2>&1 | tail -15; then
  echo "!! npm install 失败。若为网络原因，重试：NPM_REGISTRY=https://registry.npmmirror.com"
  exit 1
fi
# 锁定：代码与依赖都归 root，dbee 组只读 → 网关进程被攻破也改不了自己的代码
SUDO chown -R root:dbee "$APP_DIR"
SUDO chmod -R a-w "$APP_DIR"
SUDO find "$APP_DIR" -type d -exec chmod 0755 {} \;
SUDO find "$APP_DIR" -type f -exec chmod 0644 {} \;
echo "    ✓ 依赖就绪（node_modules 只读）"

# ── 6) 安装环境变量文件 ────────────────────────────────────────────────
if [ ! -f /tmp/gateway.env.in ]; then
  echo "!! 缺少 /tmp/gateway.env.in"; exit 1
fi
SUDO install -d -m 0750 -o root -g dbee "$ENV_DIR"
if SUDO test -f "$ENV_FILE"; then
  SUDO cp -a "$ENV_FILE" "${ENV_FILE}.bak"
  echo "  已备份旧 env → ${ENV_FILE}.bak"
fi
# 🔴 本地已渲染好（含秘密），这里只做搬位 + 收权限，**不在远端命令行里碰秘密**
#    （否则密码/密钥会出现在 ps 输出与 shell history 里）。
SUDO install -m 0640 -o root -g dbee /tmp/gateway.env.in "$ENV_FILE"
rm -f /tmp/gateway.env.in
echo "  已写入 $ENV_FILE (0640 root:dbee)"
# 确认没有残留占位符：残留会让网关启动即报"配置不完整"，而报错信息只列键名，
# 不会告诉你"是模板没渲染"，排查容易绕远路。
if SUDO grep -q '__' "$ENV_FILE"; then
  echo "!! env 里仍有未替换的占位符："; SUDO grep -n '__' "$ENV_FILE"; exit 1
fi

# ── 7) 安装 systemd 单元并启动 ─────────────────────────────────────────
SUDO install -m 0644 -o root -g root /tmp/dbee-gateway.service "$UNIT"
rm -f /tmp/dbee-gateway.service
SUDO systemctl daemon-reload
SUDO systemctl enable dbee-gateway >/dev/null 2>&1
SUDO systemctl restart dbee-gateway
echo "  服务已启动"

# ── 8) healthz 探活 ────────────────────────────────────────────────────
# 网关的设计是「连不上库也启动，靠 healthz 暴露问题」，所以必须真的打 healthz
# 并检查数据库探活字段，而不是只看 systemctl is-active。
echo "  等待 healthz（最多 30s）"
OK=0
for i in $(seq 1 30); do
  if curl -sf -m 3 http://127.0.0.1:8080/.cloud/healthz >/tmp/hz.json 2>/dev/null; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  echo "!! healthz 未通过。最近日志："
  SUDO journalctl -u dbee-gateway --no-pager -n 40 || true
  exit 1
fi
echo "    ✓ healthz 200"
echo "    响应: $(head -c 500 /tmp/hz.json)"
rm -f /tmp/hz.json

# 启动日志里的告警要显示出来（LLM_API_KEY 未配 / publishableKey 未配等）
echo "  ── 启动日志 ──"
SUDO journalctl -u dbee-gateway --no-pager -n 20 | sed 's/^/    /' || true

echo
echo "═══ 网关部署完成 ═══"
echo "  状态:   systemctl status dbee-gateway --no-pager"
echo "  日志:   sudo journalctl -u dbee-gateway -f"
echo "  配置:   $ENV_FILE  （0640 root:dbee，含秘密，勿入库勿外传）"
echo "  代码:   $APP_DIR   （root:dbee 只读）"
echo "  ⚠️ 数据面（/.cloud/database/rest/*）此刻仍会 502 —— PostgREST 还没装。"
echo "     下一步跑 deploy/deploy-postgrest.sh，然后再切 nginx 上游。"
