#!/usr/bin/env bash
# D-Bee（自律蜜蜂）· Android APK 自建分发页发布（渠道 = public_site）
#
# 2026-11-19 用户拍板 D-2：走 `public_site` 自建分发页（不等软著，App 备案 -3A 已下证）。
# 本脚本是 A8 工具链缺口的第三件（另两件 = tools/gen-download-page.mjs + tools/templates/apk-download.html）。
#
# ── 用法 ────────────────────────────────────────────────────────
#   bash deploy/publish-apk.sh                 # 🔴 默认 dry-run：只做本地校验 + 打印将做什么，不碰生产
#   bash deploy/publish-apk.sh --apply         # 真正上传 + 生产实测；实测通过才回填基线 status=published
#   bash deploy/publish-apk.sh --verify-only   # 不上传，只对已发布的生产 URL 做实测（复核用）
#
# 凭据：从仓库根 `.env` 读 `DBEE_HOST` / `USER` / `SSH_PWD`（与 deploy/apply-web-dist.py 同一套键名）。
#   🔴 注意：`deploy/dbee-ssh.py` 要的是 `DBEE_USER` / `DBEE_PWD`（不同名），本脚本不走它，
#      原因见下「为什么不复用 dbee-ssh.py putbin」。
#
# ── 🔴 为什么不复用 `dbee-ssh.py putbin`（重要）─────────────────
#   `putbin` / `putfile` 上传后一律 `sftp.chmod(remote, 0o600)` —— 只有属主可读。
#   nginx 以 www-data 运行，**读不到 0600 的文件 → 公网 403**。
#   故本脚本自行用 paramiko SFTP 写入并显式 `chmod 0644`（目录 0755），
#   与 `apply-web-dist.py` 的做法一致（它直接 sftp 写、不动权限，继承可读的 umask）。
#
# ── 🔴 铁律（违反即资损/合规事故）───────────────────────────────
#   1. **绝不删除任何文件**（本地与远端都不删）。旧 APK 新旧并存，清理属独立决策，
#      须按用户既定删除纪律单独走确认。
#   2. **默认 dry-run**：必须显式 `--apply` 才碰生产。
#   3. **实测才算成功**（铁律 #13：本地绿 ≠ 线上绿）：`--apply` 后必须公网 curl 实测
#      HTTP 200 + `Content-Length` == 基线 `apk.bytes` + 服务器侧 sha256 == 基线 `apk.sha256`，
#      三项全过才允许把基线 `distribution.status` 改成 `published`。任一不过 → 保持
#      `not_published` 并报错。
#   4. 🔴 **本脚本不碰 `deploy-gateway.sh`、不 reload nginx**：静态文件由 nginx 直接 serve，
#      `location /` 的 `try_files $uri $uri/ /index.html` 的 `$uri/` 分支已能命中
#      `download/index.html`（与 `dist/legal/<page>/index.html` 同机制，11-02 已实证）→
#      **无需改 nginx、无需 reload**。
#   5. 🔴 **只发基线登记的那一个 APK**：`release/` + `dist-release/` 共 39 个归档包里
#      只有基线 `apk.file` 是可分发候选，其余全部禁分发（旧包内嵌产物缺 `llm/features/*`
#      路由，会被 0052 网关**静默重写为食物识别**）。本脚本不接受任何路径参数，
#      只读基线 → 从机制上杜绝手滑发错包。
#   6. 🔴 合规闸门：基线 `complianceGates.appBeian.blockPublicDistribution` 为 true 时拒绝发布。
#
# 退出码：0 成功 / 1 校验或实测失败 / 2 缺凭据或缺依赖 / 3 本地产物不完整
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$REPO/tools/apk-distribution.baseline.json"
GEN="$REPO/tools/gen-download-page.mjs"
WEB="/var/www/d-bee"
REMOTE_DIR="$WEB/download"

MODE="dry-run"
case "${1:-}" in
  --apply) MODE="apply" ;;
  --verify-only) MODE="verify" ;;
  "") MODE="dry-run" ;;
  *) echo "[x] 未知参数：$1（可用：--apply / --verify-only / 留空=dry-run）" >&2; exit 2 ;;
esac

# ---- 依赖检查 ----
command -v node >/dev/null 2>&1 || { echo "[x] 缺 node" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "[x] 缺 curl" >&2; exit 2; }
PY="${PY:-python}"
command -v "$PY" >/dev/null 2>&1 || PY="python3"
command -v "$PY" >/dev/null 2>&1 || { echo "[x] 缺 python（需 paramiko）" >&2; exit 2; }
"$PY" -c "import paramiko" 2>/dev/null || { echo "[x] python 缺 paramiko（pip install paramiko）" >&2; exit 2; }

[ -f "$BASELINE" ] || { echo "[x] 基线缺失：$BASELINE" >&2; exit 3; }
[ -f "$GEN" ] || { echo "[x] 生成器缺失：$GEN" >&2; exit 3; }

# ---- 从基线读 APK 元信息 + 备案号（唯一真源；不接受命令行传路径，防手滑发错包）----
# 🔴 备案号**从基线读，不硬编码**：基线的 `beianNumber` 是 `APP_ICP_BEIAN` 的登记副本，
#    已由护栏 `tools/apk-distribution.test.ts` 断言二者一致。硬编码会在改号后静默用旧值，
#    导致「实测校验通过但其实校的是旧号」。
read -r APK_REL APK_NAME APK_BYTES APK_SHA APK_VC BLOCK_DIST PUB_STATUS APP_BEIAN ICP_BEIAN <<<"$(
  "$PY" - "$BASELINE" <<'PYEOF'
import json, os, sys
b = json.load(open(sys.argv[1], encoding="utf-8"))
apk = b.get("apk") or {}
gates = b.get("complianceGates") or {}
f = apk.get("file") or ""
print(
    f or "-",
    os.path.basename(f) or "-",
    apk.get("bytes", 0),
    apk.get("sha256", "-"),
    apk.get("versionCode", 0),
    str((gates.get("appBeian") or {}).get("blockPublicDistribution", True)).lower(),
    (b.get("distribution") or {}).get("status", "not_published"),
    (gates.get("appBeian") or {}).get("beianNumber", "") or "-",
    (gates.get("icpBeian") or {}).get("beianNumber", "") or "-",
)
PYEOF
)"

[ "$APK_REL" != "-" ] || { echo "[x] 基线 apk.file 为空" >&2; exit 3; }
APK_PATH="$REPO/$APK_REL"

# ---- 🔴 域名解析：与 tools/gen-download-page.mjs 同一解析链，不硬编码 ----
#    VITE_NATIVE_ENDPOINT（.env 构建期覆盖口）> distribution.publicUrl（发布后回填）> DOMAIN 环境变量
#    都取不到 → 直接报错要求显式指定，**绝不猜一个域名去实测**（猜错会拿别站的响应当自己的证据）。
# 🔴 每条命令替换都必须带 `|| true`：`set -euo pipefail` 下，grep 无匹配返回非零会让
#    `VAR=$(grep ...)` **静默退出整个脚本**（exit 1、零输出、极难排查）。首次发布前
#    VITE_NATIVE_ENDPOINT 常为空、publicUrl 尚未回填，正是必然走这条分支的场景。
DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$REPO/.env" ]; then
  _ep=$(grep -E '^VITE_NATIVE_ENDPOINT=' "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
  [ -n "$_ep" ] && DOMAIN=$(printf '%s' "$_ep" | sed -E 's#^https?://##; s#/.*$##' || true)
fi
if [ -z "$DOMAIN" ]; then
  _pu=$("$PY" -c "
import json,sys
b=json.load(open(sys.argv[1],encoding='utf-8'))
print((b.get('distribution') or {}).get('publicUrl') or '')" "$BASELINE" 2>/dev/null || true)
  [ -n "$_pu" ] && DOMAIN=$(printf '%s' "$_pu" | sed -E 's#^https?://##; s#/.*$##' || true)
fi
if [ -z "$DOMAIN" ]; then
  if [ "$MODE" = "dry-run" ]; then
    # dry-run 不碰生产，域名只用于展示「将要实测哪个 URL」→ 缺域名降级为警告，不阻断自检。
    # 🔴 但 apply/verify 必须真去实测，缺域名一律硬失败（见下），绝不猜。
    DOMAIN="(未解析)"
    echo "  ⚠️ 未解析到实测域名（.env 的 VITE_NATIVE_ENDPOINT 为空、基线 distribution.publicUrl 尚未回填）"
    echo "     dry-run 继续；🔴 --apply 前须显式指定：DOMAIN=<你的域名> bash deploy/publish-apk.sh --apply"
  else
    echo "[x] 无法解析实测域名（.env 的 VITE_NATIVE_ENDPOINT 与基线 distribution.publicUrl 均为空）" >&2
    echo "    🔴 拒绝硬编码兜底：猜错域名会拿别站的响应当发布证据。" >&2
    echo "    请显式指定：DOMAIN=<你的域名> bash deploy/publish-apk.sh --apply" >&2
    exit 2
  fi
fi

echo "=== 待发布包（只读基线，不接受手工指定）==="
echo "  文件      : $APK_REL"
echo "  versionCode: $APK_VC"
echo "  bytes     : $APK_BYTES"
echo "  sha256    : $APK_SHA"
echo "  App 备案号: $APP_BEIAN"
echo "  网站备案号: $ICP_BEIAN"
echo "  远端目录  : $REMOTE_DIR"
echo "  公网 URL  : https://$DOMAIN/download/"
echo "  模式      : $MODE"
echo

# ---- 🔴 合规闸门 ----
if [ "$BLOCK_DIST" = "true" ]; then
  echo "[x] 合规闸门未开：complianceGates.appBeian.blockPublicDistribution=true" >&2
  echo "    App 备案未下证前不得公网分发。内部测试请走点对点（channel=internal_test）。" >&2
  exit 1
fi
echo "  ✅ 合规闸门已开（App 备案 issued，blockPublicDistribution=false）"

# ---- 🔴 本地 APK 实测：存在 + 字节数 + sha256 ----
[ -f "$APK_PATH" ] || { echo "[x] 本地 APK 不存在：$APK_REL" >&2; exit 3; }
ACTUAL_BYTES=$("$PY" -c "import os,sys;print(os.path.getsize(sys.argv[1]))" "$APK_PATH")
if [ "$ACTUAL_BYTES" != "$APK_BYTES" ]; then
  echo "[x] 字节数不符：基线 $APK_BYTES ≠ 实测 $ACTUAL_BYTES" >&2
  echo "    🔴 基线是人工登记不是自动探测，发版人须用 stat/sha256sum 复核后更新基线。" >&2
  exit 1
fi
ACTUAL_SHA=$(cd "$REPO" && "$PY" -c "
import hashlib,sys
h=hashlib.sha256()
with open(sys.argv[1],'rb') as f:
    for c in iter(lambda:f.read(1<<20),b''): h.update(c)
print(h.hexdigest())" "$APK_PATH")
if [ "$ACTUAL_SHA" != "$APK_SHA" ]; then
  echo "[x] sha256 不符：基线 $APK_SHA ≠ 实测 $ACTUAL_SHA" >&2
  exit 1
fi
echo "  ✅ 本地 APK 实测一致（$ACTUAL_BYTES B / sha256 逐字相符）"

# ---- 生成下载页（生成器内部会再次实测复核 + 拒绝硬编码备案号）----
echo
echo "=== 生成下载页 ==="
if ! (cd "$REPO" && node tools/gen-download-page.mjs); then
  echo "[x] 下载页生成失败" >&2
  exit 3
fi
PAGE="$REPO/dist-release/download/index.html"
[ -f "$PAGE" ] || { echo "[x] 下载页产物缺失：dist-release/download/index.html" >&2; exit 3; }

# ---- 生产实测函数（铁律 #13）----
verify_production() {
  local ok=1
  local apk_url="https://$DOMAIN/download/$APK_NAME"
  local page_url="https://$DOMAIN/download/"

  echo
  echo "=== 生产实测（铁律 #13：本地绿 ≠ 线上绿）==="

  # ① 下载页 200 + 含两个备案号
  local page_code
  page_code=$(curl -s -o /tmp/dbee-dl-page.html -w '%{http_code}' -m 30 "$page_url" || echo "000")
  if [ "$page_code" != "200" ]; then
    echo "  [x] 下载页 HTTP $page_code（期望 200）：$page_url"
    ok=0
  else
    echo "  ✅ 下载页 HTTP 200"
    # App 备案号必须在场（工信部对分发平台的硬性要求）
    # 🔴 期望值取自基线（$APP_BEIAN / $ICP_BEIAN），不硬编码 → 改号后实测口径自动跟随
    if [ "$APP_BEIAN" != "-" ] && grep -q "$APP_BEIAN" /tmp/dbee-dl-page.html; then
      echo "  ✅ 下载页含 App 备案号（$APP_BEIAN，分发者义务）"
    else
      echo "  [x] 下载页缺 App 备案号（期望 $APP_BEIAN）"
      ok=0
    fi
    if [ "$ICP_BEIAN" != "-" ] && grep -q "$ICP_BEIAN" /tmp/dbee-dl-page.html; then
      echo "  ✅ 下载页含网站 ICP 备案号（$ICP_BEIAN，页面义务）"
    else
      echo "  [x] 下载页缺网站 ICP 备案号（期望 $ICP_BEIAN）"
      ok=0
    fi
    if grep -q "自律蜜蜂" /tmp/dbee-dl-page.html; then
      echo "  ✅ 下载页显示中文名「自律蜜蜂」"
    else
      echo "  [x] 下载页未出现中文名（label 一致性要求）"
      ok=0
    fi
  fi

  # ② APK 200 + Content-Length == 基线 bytes（用 HEAD，不下载 9.8MB）
  local hdr len code
  hdr=$(curl -sIL -m 40 "$apk_url" || true)
  code=$(printf '%s' "$hdr" | awk 'BEGIN{IGNORECASE=1}/^HTTP\//{c=$2}END{print c}')
  len=$(printf '%s' "$hdr" | awk 'BEGIN{IGNORECASE=1}/^content-length:/{v=$2}END{gsub(/\r/,"",v);print v}')
  if [ "$code" != "200" ]; then
    echo "  [x] APK HTTP ${code:-000}（期望 200）：$apk_url"
    echo "      🔴 403 通常是权限问题：nginx(www-data) 读不到 → 文件须 0644、目录须 0755"
    echo "      🔴 404 通常是路径问题：确认远端在 $REMOTE_DIR/$APK_NAME"
    ok=0
  else
    echo "  ✅ APK HTTP 200"
    if [ "$len" = "$APK_BYTES" ]; then
      echo "  ✅ Content-Length $len == 基线 bytes $APK_BYTES"
    else
      echo "  [x] Content-Length ${len:-未返回} ≠ 基线 bytes $APK_BYTES（传输被截断？）"
      ok=0
    fi
  fi

  # ③ 服务器侧 sha256 回读比对（防 SFTP 静默截断，与 apply-web-dist.py 同范式）
  if [ "$MODE" = "verify" ] || [ -n "${SKIP_REMOTE_SHA:-}" ]; then
    echo "  ⚠️ 跳过服务器侧 sha256（--verify-only 或 SKIP_REMOTE_SHA）"
  else
    local rsha
    rsha=$(ssh_run "sha256sum '$REMOTE_DIR/$APK_NAME' | cut -d' ' -f1" || true)
    if [ "$rsha" = "$APK_SHA" ]; then
      echo "  ✅ 服务器侧 sha256 逐字一致"
    else
      echo "  [x] 服务器侧 sha256 ${rsha:-读取失败} ≠ 基线 $APK_SHA"
      ok=0
    fi
  fi

  [ "$ok" = "1" ]
}

# ---- SSH 执行封装（凭据只在子进程环境里，不落盘、不回显）----
ssh_run() {
  DBEE_HOST="$DBEE_HOST" SSH_USER="$SSH_USER" SSH_PWD_VAL="$SSH_PWD_VAL" \
  REMOTE_CMD="$1" "$PY" - <<'PYEOF'
import os, sys, paramiko
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(os.environ["DBEE_HOST"], username=os.environ["SSH_USER"],
          password=os.environ["SSH_PWD_VAL"], timeout=30,
          banner_timeout=30, auth_timeout=30)
tr = c.get_transport()
if tr: tr.set_keepalive(30)
try:
    _, so, se = c.exec_command(os.environ["REMOTE_CMD"], timeout=120)
    out = so.read().decode("utf-8", "replace").strip()
    rc = so.channel.recv_exit_status()
    if rc != 0:
        print(se.read().decode("utf-8", "replace").strip()[:300], file=sys.stderr)
    print(out)
    sys.exit(rc)
finally:
    c.close()
PYEOF
}

upload() {
  # 🔴 REMOTE_DIR 必须加哨兵前缀再传给 Windows 原生 python（2026-11-23 发布事故实证）：
  #    Git Bash/MSYS 会把「以 / 开头的环境变量值」静默转换成 PortableGit 安装根下的 Windows 路径
  #    （/var/www/d-bee/download → C:/.../PortableGit/var/www/d-bee/download），
  #    SFTP 将其视为相对路径 → 文件写进 /home/ubuntu/C:/... 嵌套垃圾树，远端真实目录为空。
  #    哨兵值不以 / 开头 → MSYS 不做转换；python 侧剥哨兵 + 硬校验「必须是绝对 POSIX 路径」。
  DBEE_HOST="$DBEE_HOST" SSH_USER="$SSH_USER" SSH_PWD_VAL="$SSH_PWD_VAL" \
  REMOTE_DIR="RDIR@@$REMOTE_DIR" LOCAL_APK="$APK_PATH" LOCAL_PAGE="$PAGE" APK_NAME="$APK_NAME" \
  "$PY" - <<'PYEOF'
import os, sys, paramiko
host = os.environ["DBEE_HOST"]; user = os.environ["SSH_USER"]; pwd = os.environ["SSH_PWD_VAL"]
rdir_raw = os.environ["REMOTE_DIR"]
if not rdir_raw.startswith("RDIR@@"):
    print(f"[x] REMOTE_DIR 缺哨兵前缀（收到 {rdir_raw!r}）→ 疑似 MSYS 路径污染，拒绝上传", file=sys.stderr); sys.exit(2)
rdir = rdir_raw[len("RDIR@@"):]
if not rdir.startswith("/"):
    print(f"[x] REMOTE_DIR 非绝对 POSIX 路径（收到 {rdir!r}）→ 拒绝上传（防写进 home 相对路径）", file=sys.stderr); sys.exit(2)
apk = os.environ["LOCAL_APK"]
page = os.environ["LOCAL_PAGE"]; apk_name = os.environ["APK_NAME"]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"连接 {user}@{host} ...")
c.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
tr = c.get_transport()
if tr: tr.set_keepalive(30)
try:
    # ① 建目录（幂等；不删除任何既有文件）
    _, so, _ = c.exec_command(f"mkdir -p '{rdir}'", timeout=60)
    so.channel.recv_exit_status()

    sftp = c.open_sftp()
    # ② 🔴 权限必须 nginx(www-data) 可读：目录 0755、文件 0644
    #    （dbee-ssh.py 的 putbin/putfile 会设 0600 → 公网 403，故不复用）
    try: sftp.chmod(rdir, 0o755)
    except IOError: pass

    # ③ 先传 APK（大文件），二进制原样写，绝不做换行替换
    with open(apk, "rb") as fh: data = fh.read()
    rp_apk = f"{rdir}/{apk_name}"
    with sftp.file(rp_apk, "wb") as fh: fh.write(data)
    sftp.chmod(rp_apk, 0o644)
    print(f"  ↑ {apk_name} ({len(data)} B) chmod 644")

    # ④ 🔴 index.html 最后传（入口原子切换，避免中间窗口出现「新页 + 缺包」）
    with open(page, "rb") as fh: pdata = fh.read().replace(b"\r\n", b"\n")
    rp_page = f"{rdir}/index.html"
    with sftp.file(rp_page, "wb") as fh: fh.write(pdata)
    sftp.chmod(rp_page, 0o644)
    print(f"  ↑ index.html ({len(pdata)} B) chmod 644")

    # ⑤ 服务器侧回读校验
    _, so, se = c.exec_command(f"sha256sum '{rp_apk}' | cut -d' ' -f1; stat -c%s '{rp_apk}'", timeout=120)
    out = so.read().decode("utf-8", "replace").strip().splitlines()
    rc = so.channel.recv_exit_status()
    if rc != 0 or len(out) < 2:
        print(f"[x] 服务器侧回读失败: {se.read().decode('utf-8','replace').strip()[:200]}", file=sys.stderr)
        sys.exit(1)
    print(f"  服务器侧 sha256={out[0]} bytes={out[1]}")
    sftp.close()
finally:
    c.close()
PYEOF
}

# ---- dry-run：到此为止 ----
if [ "$MODE" = "dry-run" ]; then
  echo
  echo "=== 🔴 dry-run 结束（未碰生产）==="
  echo "  将执行：mkdir -p $REMOTE_DIR → 上传 $APK_NAME（chmod 644）→ 上传 index.html（chmod 644，最后）"
  echo "  将实测：下载页 200 + 含 $APP_BEIAN / $ICP_BEIAN 两个备案号 + 中文名；APK 200 + Content-Length == $APK_BYTES；服务器侧 sha256"
  echo "  实测全过后才回填基线：distribution.status=published / channel=public_site / publicUrl / remoteStaticDir / publishedAt"
  echo
  echo "  真正执行：bash deploy/publish-apk.sh --apply"
  exit 0
fi

# ---- verify-only / apply 都需要凭据 ----
if [ "$MODE" = "apply" ]; then
  [ -f "$REPO/.env" ] || { echo "[x] 缺 .env（需 DBEE_HOST / USER / SSH_PWD）" >&2; exit 2; }
  # 🔴 同样必须带 `|| true`（set -euo pipefail + grep 无匹配 = 静默退出）
  DBEE_HOST=$(grep -E '^DBEE_HOST=' "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
  SSH_USER=$(grep -E '^USER=' "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
  SSH_PWD_VAL=$(grep -E '^SSH_PWD=' "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
  SSH_USER="${SSH_USER:-ubuntu}"
  [ -n "$DBEE_HOST" ] && [ -n "$SSH_PWD_VAL" ] || { echo "[x] .env 缺 DBEE_HOST / SSH_PWD" >&2; exit 2; }

  echo
  echo "=== 上传 ==="
  if ! upload; then
    echo "[x] 上传失败（未改基线；远端可能已有部分文件，重跑本脚本即可，幂等不删文件）" >&2
    exit 1
  fi
fi

if [ "$MODE" = "verify" ]; then
  DBEE_HOST="${DBEE_HOST:-}"; SSH_USER="${SSH_USER:-ubuntu}"; SSH_PWD_VAL="${SSH_PWD_VAL:-}"
  SKIP_REMOTE_SHA=1
fi

# ---- 生产实测 ----
if ! verify_production; then
  echo
  echo "[x] 🔴 生产实测未全过 → 基线保持 status=$PUB_STATUS（不改成 published）" >&2
  echo "    排查：403=权限（须 644/755）；404=路径（$REMOTE_DIR）；备案号缺失=生成器真源被改" >&2
  exit 1
fi

# ---- 实测全过 → 回填基线（仅 apply 模式）----
if [ "$MODE" = "apply" ]; then
  echo
  echo "=== 回填基线（实测全过才走到这里）==="
  # 🔴 同 upload：$REMOTE_DIR 以 / 开头会被 MSYS 转换（argv 亦中招，2026-11-23 实证）
  #    → 加哨兵前缀防污染，python 侧剥哨兵后写回基线，保证 remoteStaticDir 是干净的绝对 POSIX 路径。
  "$PY" - "$BASELINE" "https://$DOMAIN/download/" "RDIR@@$REMOTE_DIR" <<'PYEOF'
import json, sys, datetime
p, url = sys.argv[1], sys.argv[2]
rdir_raw = sys.argv[3]
if not rdir_raw.startswith("RDIR@@"):
    print(f"[x] remoteStaticDir 缺哨兵前缀（收到 {rdir_raw!r}）→ 疑似 MSYS 路径污染，拒绝回填", file=sys.stderr); sys.exit(2)
rdir = rdir_raw[len("RDIR@@"):]
if not rdir.startswith("/"):
    print(f"[x] remoteStaticDir 非绝对 POSIX 路径（收到 {rdir!r}）→ 拒绝回填", file=sys.stderr); sys.exit(2)
b = json.load(open(p, encoding="utf-8"))
d = b.setdefault("distribution", {})
d["status"] = "published"
d["channel"] = "public_site"
d["publicUrl"] = url
d["remoteStaticDir"] = rdir
d["publishedAt"] = datetime.date.today().isoformat()
d["_check"] = (
    "🟢 已由 deploy/publish-apk.sh --apply 发布并通过生产实测"
    "（HTTP 200 + Content-Length == apk.bytes + 服务器侧 sha256 一致 + 下载页含 -3A/-2 两个备案号）。"
    "🔴 status 只能由跑过本脚本 --apply 且实测全绿的人改成 published。"
    "channel 取值：internal_test / public_site（须 appBeian.status=issued）/ app_store（须软著 + App 备案双下证）。"
)
b["updatedAt"] = datetime.date.today().isoformat()
json.dump(b, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(p, "a", encoding="utf-8").write("\n")
print("  ✅ distribution.status=published / channel=public_site")
print(f"  ✅ publicUrl={url}")
print(f"  ✅ remoteStaticDir={rdir}")
PYEOF
  echo
  echo "  🔴 回填后请重跑门禁：cd $REPO && npm test"
  echo "  🔴 并把发布结果与实测输出写入当日 .workbuddy/memory/YYYY-MM-DD.md（铁律 #13 留证）"
fi

echo
echo "✅ 完成（模式=$MODE）"
