#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 在服务器上执行：安装 PostgREST v16.4 + 建角色 + 生成配置 + 起 systemd 服务
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/deploy-postgrest.sh 通过 deploy/dbee-ssh.py run 调用，**不要手工跑**。
# 占位符 __SUDO_PWD__ / __JWT_SECRET__ 由 dbee-ssh.py 在上传时替换。
#
# 前置（由调用方负责上传到位）：
#   /tmp/postgrest.config.in   ← deploy/postgrest/config.template 渲染掉 __JWT_SECRET__ 后的产物
#   /tmp/postgrest.service     ← deploy/postgrest/postgrest.service
#   /tmp/0032-postgrest-roles.sql ← db/migrations/0032-postgrest-roles.sql
#   /tmp/postgrest.tar.xz      ← 可选：本地已下载的二进制（GitHub 直连失败时的兜底）
#
# 设计要点：
#   · dbee_web 的密码**在服务器上现场随机生成**，只写进 /etc/postgrest/config，
#     不出现在任何入库文件、不打印到日志、不经网络传输 —— 所以 config 绝不能入库。
#   · 幂等：重复执行只会「校正角色属性 + 覆盖 config + 重启服务」，不会破坏数据。
#   · 版本与 sha256 钉死：PostgREST 是直连生产库的组件，不接受"最新即最好"。
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

# sudo 一律走这个封装：密码经 stdin 喂给 -S，不落 history、不进 ps。
# ⚠️ 因为 -S 会**占用 stdin**，所以任何自身需要从 stdin 读内容的命令
#    （典型：psql <<SQL heredoc）都不能用它 —— heredoc 会被 sudo 吃掉，
#    psql 读到空输入、什么都不做却返回 0，脚本还会打印「✓ 成功」。
#    需要喂 SQL 的场景见第 6 步，改用「临时文件 + -f」而不是 heredoc。
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

VERSION="16.4"
SHA256="b47ecc82fce1dcebbbc4183d839e52f07f7630c9d7ad0f54db753d1939299354"
ARCH="x86-64"                                   # 服务器是腾讯云轻量 x86_64
TARBALL="postgrest-v${VERSION}-linux-static-${ARCH}.tar.xz"
URL="https://github.com/PostgREST/postgrest/releases/download/v${VERSION}/${TARBALL}"
BIN_TARGET="/usr/local/bin/postgrest"
CONF_DIR="/etc/postgrest"
CONF="${CONF_DIR}/config"
MIGRATION_SRC="/tmp/0032-postgrest-roles.sql"
MIGRATION_DST="/opt/dbee-db/0032-postgrest-roles.sql"

echo "═══ PostgREST 安装（v${VERSION}，sha256 已钉死）═══"

# ── 0) 架构自检 ────────────────────────────────────────────────────────
# 装错架构的二进制会在 exec 时报 "cannot execute binary file"，先挡一道。
MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64)  ARCH="x86-64" ;;
  aarch64) ARCH="aarch64" ;;
  *) echo "!! 未知架构 $MACHINE，请手工确认 PostgREST 资产名"; exit 1 ;;
esac
TARBALL="postgrest-v${VERSION}-linux-static-${ARCH}.tar.xz"
URL="https://github.com/PostgREST/postgrest/releases/download/v${VERSION}/${TARBALL}"
echo "  架构: $MACHINE → 资产 $TARBALL"

# ── 1) 取得二进制 ──────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -f /tmp/postgrest.tar.xz ]; then
  # 本地上传兜底：GitHub 在国内直连不稳，deploy-postgrest.sh 可先把 tarball 传上来
  echo "  使用本地上传的 /tmp/postgrest.tar.xz"
  cp /tmp/postgrest.tar.xz "$WORK/$TARBALL"
else
  echo "  下载 $URL"
  if ! curl -fsSL --retry 3 --retry-delay 2 -m 300 -o "$WORK/$TARBALL" "$URL"; then
    echo "!! 下载失败（GitHub 直连受阻很常见）。兜底做法："
    echo "   在本地下载 $TARBALL 后执行："
    echo "     DBEE_POSTGREST_TARBALL=/path/to/$TARBALL bash deploy/deploy-postgrest.sh"
    echo "   （deploy-postgrest.sh 会把它上传到 /tmp/postgrest.tar.xz 再重跑本脚本）"
    exit 1
  fi
fi

# ── 2) 校验 sha256（供应链完整性）──────────────────────────────────────
# 这个组件能直连生产库，必须确认拿到的就是官方发布的字节。
echo "  校验 sha256"
GOT="$(sha256sum "$WORK/$TARBALL" | awk '{print $1}')"
if [ "$GOT" != "$SHA256" ]; then
  echo "!! sha256 不匹配 —— 拒绝安装"
  echo "   期望 $SHA256"
  echo "   实际 $GOT"
  echo "   （若是你主动换了版本，请同步更新本脚本的 VERSION/SHA256）"
  exit 1
fi
echo "    ✓ 与官方 v${VERSION} 发布值一致"

# ── 3) 解包安装 ────────────────────────────────────────────────────────
# 官方说明：Linux 二进制是 **static executable**，可在任意发行版直接运行，
# 不需要 libpq / libgmp 等任何依赖（这也是选二进制而非 apt 的原因：
# apt 源里的 PostgREST 版本常常落后，且会引入 Haskell 运行时依赖）。
tar Jxf "$WORK/$TARBALL" -C "$WORK"
if [ ! -f "$WORK/postgrest" ]; then
  echo "!! 解包后找不到 postgrest 可执行文件"; exit 1
fi
SUDO install -m 0755 -o root -g root "$WORK/postgrest" "$BIN_TARGET"
echo "  已安装 $BIN_TARGET"
"$BIN_TARGET" --version || true

# ── 4) 专用系统账号 ────────────────────────────────────────────────────
# 官方 systemd 集成页的写法。-M 不建家目录、-s nologin 不可登录。
if ! id -u postgrest >/dev/null 2>&1; then
  SUDO useradd --system --no-create-home --shell /usr/sbin/nologin \
    --home-dir /nonexistent --user-group postgrest
  echo "  已创建系统账号 postgrest"
else
  echo "  系统账号 postgrest 已存在"
fi

# ── 5) 执行迁移 0032（建 dbee_web 角色 + 授权）─────────────────────────
# ⚠️ dbee-ssh.py 的 putfile 会把文件 chmod 0600（属主 ubuntu），postgres 读不了；
#    且 /home/ubuntu 是 750，postgres 进不去。所以按项目既有约定（见
#    docs/服务器部署目录.md §3）把 SQL 落到 /opt/dbee-db/（755，postgres 可读）。
if [ ! -f "$MIGRATION_SRC" ]; then
  echo "!! 缺少 $MIGRATION_SRC"; exit 1
fi
SUDO install -m 0644 -o root -g root "$MIGRATION_SRC" "$MIGRATION_DST"
echo "  执行迁移 $MIGRATION_DST"
# ON_ERROR_STOP=1：任何一步失败立即中止，避免半装状态
SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 -q -f "$MIGRATION_DST"
echo "    ✓ 迁移完成"

# ── 6) 生成 dbee_web 密码并设进数据库 ──────────────────────────────────
# 幂等策略：**已存在 config 且里面已有密码 → 复用**，避免每次重跑都换密码
# （换了但 config 没同步更新会导致 PostgREST 连不上库）。
#
# 🔴 注意这里不能用普通的 `[ -f "$CONF" ]`：$CONF_DIR 是 0750 root:postgrest，
#    本脚本以 ubuntu 身份运行 —— ubuntu 既非 root 也不在 postgrest 组，
#    **连穿越这个目录都不行**，于是 `[ -f ]` 即使文件存在也返回 false。
#    后果很隐蔽：每次重跑都以为"首次安装"，生成新密码但旧 config 还在，
#    一旦中途某步失败，就留下「库里密码已改、config 里还是旧密码」的失配，
#    PostgREST 报 password authentication failed，而 config 看着完全正常。
#    → 存在性判断一律走 sudo。
DB_PASS=""
if SUDO test -f "$CONF"; then
  DB_PASS="$(SUDO sed -n 's#^db-uri = "postgres://dbee_web:\([^@]*\)@.*#\1#p' "$CONF" | head -1 || true)"
  if [ -n "$DB_PASS" ]; then echo "  复用 config 里已有的 dbee_web 密码"; fi
fi
if [ -z "$DB_PASS" ]; then
  # 32 字节 hex = 256 bit 熵，与项目既有 dbee_app 密码的生成方式一致。
  # hex 字符集天然无需 percent-encode，放进 libpq URI 不会有转义坑。
  DB_PASS="$(openssl rand -hex 32)"
  echo "  已生成新的 dbee_web 密码（不打印，仅写入 config）"
fi

# ALTER ROLE 要设密码，有三条路，前两条都不可接受：
#   ✗ psql -c "ALTER ROLE … PASSWORD '…'"  → 密码进 ps 输出（同机任何用户可见）+ PG 日志
#   ✗ SUDO … psql <<SQL                    → heredoc 被 sudo 的 -S 吃掉，SQL 根本没执行
#                                             但 psql 返回 0，脚本会谎报「✓ 密码已设置」。
#                                             后果极具误导性：PostgREST 起来报
#                                             password authentication failed，
#                                             排查者会去怀疑 config 写错了密码，
#                                             而真相是密码从未设上。
#   ✓ 临时 SQL 文件 + psql -f              → 下面这条。文件 0600 属主 postgres，
#                                            用完立即删；密码不进 ps、不进日志。
PW_SQL="$WORK/alter-pw.sql"
# dollar-quoting：密码里若含单引号也不会破坏 SQL（hex 生成虽不含，但别依赖这个巧合）
printf 'ALTER ROLE dbee_web PASSWORD $pwd$%s$pwd$;\n' "$DB_PASS" > "$PW_SQL"
chmod 0600 "$PW_SQL"
SUDO install -m 0400 -o postgres -g postgres "$PW_SQL" /tmp/.dbee-alter-pw.sql
shred -u "$PW_SQL" 2>/dev/null || rm -f "$PW_SQL"
SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 -q -f /tmp/.dbee-alter-pw.sql
SUDO rm -f /tmp/.dbee-alter-pw.sql
echo "    ✓ dbee_web 密码已设置"

# 立刻回验：密码是否真的可用（TCP + scram，正是 PostgREST 的连接方式）。
# 不复验就往下走，等于把失败推迟到服务启动后，报错信息隔了一层更难定位。
if PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -U dbee_web -d dbee -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "    ✓ dbee_web 可用 TCP+密码登录（与 PostgREST 的连接方式一致）"
else
  echo "!! dbee_web 登录失败。可能原因："
  echo "   · ALTER ROLE 未生效"
  echo "   · pg_hba.conf 未放行回环 scram 连接（现有规则应为 host all all 127.0.0.1/32 scram-sha-256）"
  echo "   · password_encryption 非 scram-sha-256"
  exit 1
fi

# ── 7) 渲染配置文件 ────────────────────────────────────────────────────
SUDO install -d -m 0750 -o root -g postgrest "$CONF_DIR"
if [ ! -f /tmp/postgrest.config.in ]; then
  echo "!! 缺少 /tmp/postgrest.config.in（应由 deploy-postgrest.sh 上传）"; exit 1
fi
# 已有 config 先备份，便于回滚（与 push-nginx.sh 的 .bak 约定一致）
if SUDO test -f "$CONF"; then
  SUDO cp -a "$CONF" "${CONF}.bak"
  echo "  已备份旧配置 → ${CONF}.bak"
fi

# 🔴 在**本地**渲染，不要把密码放进远端命令行。
#    反例：SUDO bash -c "sed s#__DB_PASSWORD__#$DB_PASS#g …"
#    → DB_PASS 出现在 bash -c 的参数里，同机任何用户 `ps aux` 都能看到明文密码，
#      而且会被记进 shell history / audit 日志。与 ALTER ROLE 那步同理。
#    正解：本地 sed 到 0600 临时文件，再用 install 一步搬到位并设好权限。
#    只替换 __DB_PASSWORD__（__JWT_SECRET__ 已在本地渲染阶段替换掉了）。
RENDERED="$WORK/postgrest.config"
sed "s#__DB_PASSWORD__#${DB_PASS}#g" /tmp/postgrest.config.in > "$RENDERED"
chmod 0600 "$RENDERED"
# 自检：确认没有残留占位符（残留会让 PostgREST 启动即失败，且报错信息很隐晦）
if grep -q '__' "$RENDERED"; then
  echo "!! config 里仍有未替换的占位符："; grep -n '__' "$RENDERED"; exit 1
fi
SUDO install -m 0640 -o root -g postgrest "$RENDERED" "$CONF"
shred -u "$RENDERED" 2>/dev/null || rm -f "$RENDERED"
rm -f /tmp/postgrest.config.in
echo "  已写入 $CONF (0640 root:postgrest)"

# ── 8) 安装 systemd 单元 ───────────────────────────────────────────────
SUDO install -m 0644 -o root -g root /tmp/postgrest.service /etc/systemd/system/postgrest.service
SUDO systemctl daemon-reload
SUDO systemctl enable postgrest >/dev/null 2>&1
SUDO systemctl restart postgrest
echo "  服务已启动"

# ── 9) 就绪探测（admin server /ready）──────────────────────────────────
# 为什么不用 systemctl is-active 就完事：Type=simple 下进程一起来就是 active，
# 但那时**可能还没连上库/schema cache 还没加载完**。/ready 返回 200 才代表
# 「已连库且缓存就绪」，这是官方 admin server 的语义。
echo "  等待 /ready（最多 30s）"
READY=0
for i in $(seq 1 30); do
  if curl -sf -m 2 http://127.0.0.1:3002/ready >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "!! /ready 未通过。最近日志："
  SUDO journalctl -u postgrest --no-pager -n 40 || true
  exit 1
fi
echo "    ✓ /ready 200（已连库 + schema cache 就绪）"
curl -sf -m 2 http://127.0.0.1:3002/live >/dev/null && echo "    ✓ /live 200"

# ── 10) 端到端验证：真签一个 JWT 打一次数据面 ──────────────────────────
# 这一步是整个安装的价值所在 —— 前三步全绿但这里挂了，说明权限/密钥有问题，
# 而那正是最难排查的一类故障（症状：网关 200 但前端拿不到数据）。
echo "═══ 端到端验证 ═══"
JWT_SECRET="__JWT_SECRET__"
if [ -z "$JWT_SECRET" ]; then
  echo "  !! 未拿到 JWT_SECRET（本地未设 DBEE_JWT_SECRET），跳过端到端验证"
else
  b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  NOW="$(date +%s)"; EXP="$((NOW + 300))"
  # sub 需要是库里真实存在的 owner_id，这样 ① 才能真正验证 RLS 按 sub 过滤。
  # 🔴 刻意**不硬编码**任何具体 owner_id：0030 镜像含真实用户健康档案（PIPL），
  #    把某个真实用户标识写进入库脚本违反项目「最小必要」约定。改为运行时
  #    从 profiles 里取一个已存在的 owner_id（用完即弃，不打印、不落盘）。
  PROBE_UID="$(SUDO -u postgres psql -d dbee -tAc \
    'SELECT owner_id FROM public.profiles LIMIT 1' 2>/dev/null | head -1 || true)"
  if [ -z "$PROBE_UID" ]; then
    echo "  profiles 表为空（可能是纯 schema 部署），跳过需要真实 sub 的 RLS 验证"
  fi
  HDR="$(printf '{"alg":"HS256","typ":"JWT"}' | b64u)"
  PAY="$(printf '{"sub":"%s","role":"authenticated","iat":%s,"exp":%s}' "${PROBE_UID:-0}" "$NOW" "$EXP" | b64u)"
  SIG="$(printf '%s.%s' "$HDR" "$PAY" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64u)"
  TOKEN="${HDR}.${PAY}.${SIG}"

  echo "  ① 带合法 JWT 读 profiles（期望 200，验证 schema cache + SET ROLE + RLS 全链路）"
  CODE="$(curl -s -o /tmp/pgrst-probe.json -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
    "http://127.0.0.1:3001/profiles?select=owner_id&limit=1" || echo "curl失败")"
  echo "     HTTP $CODE"
  case "$CODE" in
    200) echo "     ✓ 数据面通" ;;
    401) echo "     !! 401 → jwt-secret 与网关不一致（检查 DBEE_JWT_SECRET）" ;;
    404) echo "     !! 404/PGRST205 → schema cache 没加载到表；查 dbee_web 的 schema USAGE 与 authenticated 的表 GRANT" ;;
    *)   echo "     !! 非预期状态码，响应体："; head -c 400 /tmp/pgrst-probe.json; echo ;;
  esac

  echo "  ② 无 JWT 读 profiles（期望 401：未设 db-anon-role，匿名请求必须被拒）"
  CODE2="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:3001/profiles?select=owner_id&limit=1" || echo "curl失败")"
  echo "     HTTP $CODE2 $([ "$CODE2" = "401" ] && echo '✓ 匿名被拒' || echo '!! 期望 401')"

  echo "  ③ 读身份表 app_users（期望 4xx：0031 已 REVOKE，数据面绝不能看到身份哈希）"
  CODE3="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3001/app_users?select=*&limit=1" || echo "curl失败")"
  echo "     HTTP $CODE3 $([ "$CODE3" != "200" ] && echo '✓ 身份表对数据面不可见' || echo '!! 🔴 严重：身份表可被读取，立即检查 0031 的 REVOKE')"

  echo "  ④ 根端点 OpenAPI（期望 404：openapi-mode=disabled，不得泄露全库结构）"
  CODE4="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3001/" || echo "curl失败")"
  echo "     HTTP $CODE4 $([ "$CODE4" = "404" ] && echo '✓ 结构清单已关闭' || echo '!! 期望 404，检查 config 的 openapi-mode')"

  echo "  ⑤ NOINHERIT 生效验证：dbee_web 直连不应读到任何业务表"
  DENY="$(PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -U dbee_web -d dbee -tAc \
    'SELECT count(*) FROM public.profiles' 2>&1 || true)"
  if echo "$DENY" | grep -qiE 'permission denied|42501'; then
    echo "     ✓ permission denied（NOINHERIT 正确：无 JWT 就没有任何表权限）"
  else
    echo "     !! 🔴 dbee_web 竟能直读业务表：$DENY"
    echo "        → 说明 rolinherit=t 或被误授了表权限，匿名请求将越权，必须立即修"
  fi
fi

echo
echo "═══ 完成 ═══"
echo "  服务: systemctl status postgrest --no-pager"
echo "  日志: sudo journalctl -u postgrest -f"
echo "  配置: $CONF  （0640 root:postgrest，含秘密，勿入库勿外传）"
echo "  热重载: sudo systemctl reload postgrest   （SIGUSR1，重载 config + 刷 schema cache）"
echo "  下一步: 起 Node 网关（server/）并把 nginx 的 /.cloud/ 上游从云端切到 127.0.0.1:8080"
