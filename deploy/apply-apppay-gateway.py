#!/usr/bin/env python3
"""B3 · 手术式部署「Android APP 支付（0047）+ 微信虚拟支付（0046）」到生产网关。

🔴 默认 dry-run（只读、不碰生产）；只有显式 --apply 才执行部署。
   python deploy/apply-apppay-gateway.py            # 预检 + 完整 diff 预览
   python deploy/apply-apppay-gateway.py --apply    # 真正部署（含自动回滚）

为什么是 5 文件，而不是 11-22 文档写的「3 文件」
------------------------------------------------
2026-11-23 生产/本地全文件 sha256 逐字比对结论：

  本地 server/lib/ 16 个 .mjs，生产 /opt/dbee-gateway/lib/ 13 个，差 3 个：
    apppay.mjs / xpay.mjs / wechatSession.mjs       ← 生产缺失，须新增
  app.mjs / config.mjs                              ← 内容不同，须替换
  其余 10 个 .mjs + index.mjs                       ← 逐字一致，勿动

🔴 本地 app.mjs:16-17 静态 import './xpay.mjs' 与 './apppay.mjs'；
   xpay.mjs:68 又 import './wechatSession.mjs'。
   ESM 顶层静态 import 与「开关是否启用」无关：只要文件不在就抛
   ERR_MODULE_NOT_FOUND → 网关启动失败 = 全站宕机。
   （同型事故已被 deploy/apply-llm-feature-walls.py 头注释记录：那次为了避开
     这两个 import，改用「现网 app.mjs + 手术插入」；这次要部署支付，必须补齐闭包。）

🔴 auth.mjs 绝不能整搬：生产版与本地版 sha256 不同（生产有 WX-1 werun 的
   4 处手术锚点）。整搬会当场断掉微信运动链路。本脚本把它列入 FORBIDDEN。

为什么替换 config.mjs 不会让网关拒绝启动
----------------------------------------
本地 config.mjs 的 validate() 新增了 xpay / 微信 APP 支付 / 支付宝的
「半配拦截」（config.mjs:541-571），但它们全部是
「已配 >0 且 < 全部键才 push problems」的条件守卫。生产 gateway.env 当前
**零支付键** → 一条都不触发。部署后端点从 404 变 503（notConfigured），
这正是「代码已生效」的唯一客观判据（铁律 #13）。

安全措施（每步失败即中止/统一回滚，绝不留半部署状态）
------------------------------------------------------
①  本地预检：5 文件纯 LF、node --check、相对 import 闭包 ⊆ 部署后 16 文件集
②  生产只读预检：现网 lib 清单/文件数、gateway.env sha256、服务活跃
③  上传 5 文件到 $HOME 暂存（不经 /tmp，规避 SFTP 0600 权限坑）
④  🔴 重启前 ESM + config 真实预检：暂存目录内复制现网 13 文件 → 覆盖 5 文件
    → set -a 载入网关 env → node 真实 import app.mjs + loadConfig()
    → 此时生产仍跑旧代码，任何失败零感知
⑤  备份原文件到 $APP/.bak-<时间戳>/（回滚只需 sudo cp -a 回去 + restart）
⑥  install 保持 root:dbee 0644；gateway.env 一字节不碰（部署前后 sha256 断言一致）
⑦  grep 断言新代码就位（3 个 import + 支付键解析 + 4 条新端点）
⑧  systemctl restart + healthz 探活（🔴 sleep 8 + 重试 3 次；立即验证＝假红）
⑨  铁律 #13 生产实测：apppay/prepay 与 alipay/notify 必须从 404 → 503
⑩  既有路由回归（healthz / llm/models / apple/verify / features/meal 不得变 404）
⑪  启动日志扫 ERR_MODULE_NOT_FOUND / SyntaxError
⑫  统一 rollback()：任一断言失败自动 cp -a 回备份 + restart + healthz 复核
    （报了回滚就一定回滚过，杜绝「误报已回滚」）

🔴🔴 绝对禁令
  - 绝不执行 deploy-gateway.sh（会用本地模板覆盖 gateway.env，本地缺
    IDENT_PEPPER / JWT_SECRET → 全站身份永久失效）
  - 绝不触碰 /etc/dbee/gateway.env、auth.mjs、index.mjs
  - 凭据只从 .env 读，不落盘、不回显；输出经 redact() 过滤

退出码：0 成功 / 1 部署失败已回滚 / 2 缺凭据 / 3 预检失败未触碰生产 / 4 部署后验证失败已回滚
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")
LOCAL_DIR = os.path.join(REPO, "server", "lib")
APP = "/opt/dbee-gateway"
ENV_FILE = "/etc/dbee/gateway.env"
HEALTHZ = "http://127.0.0.1:8080/.cloud/healthz"
SERVICE = "dbee-gateway"

# 生产现网 13 个 .mjs（2026-11-23 实测清单，用于闭包断言）
PROD_LIB_FILES = {
    "app.mjs", "auth.mjs", "config.mjs", "db.mjs", "dbproxy.mjs",
    "http.mjs", "iap.mjs", "identity.mjs", "jwt.mjs", "llm.mjs",
    "otp.mjs", "sms.mjs", "werun.mjs",
}
# 生产缺失、须新增的 3 个
ADD_FILES = ["apppay.mjs", "xpay.mjs", "wechatSession.mjs"]
# 内容不同、须替换的 2 个
REPLACE_FILES = ["app.mjs", "config.mjs"]
ALL_FILES = ADD_FILES + REPLACE_FILES
# 🔴 绝不触碰（生产独有手术锚点 / 凭据 / 入口）
FORBIDDEN = {"auth.mjs", "index.mjs", "gateway.env"}

# 部署后 lib 应有的完整 16 文件集
EXPECTED_LIB = PROD_LIB_FILES | set(ADD_FILES)

# 新端点：部署前 404、部署后未配 env 应为 503
NEW_ENDPOINTS = [
    "/.cloud/payment/apppay/prepay",
    "/.cloud/payment/apppay/query",
    "/.cloud/payment/wechat-app/notify",
    "/.cloud/payment/alipay/notify",
]
# 既有端点回归（不得因部署变 404）
REGRESSION_ENDPOINTS = [
    "/.cloud/healthz",
    "/.cloud/llm/models",
    "/.cloud/llm/features/meal",
    "/.cloud/payment/apple/verify",
]

REMOTE_SCRIPT = r"""
set -uo pipefail
APP=/opt/dbee-gateway
HOME_DIR="$1"
STAGE="$HOME_DIR/dbee-apppay-0047"
TS="$(date +%Y%m%d-%H%M%S)"
BAK="$APP/.bak-apppay-$TS"
ENVF=/etc/dbee/gateway.env

fail() { echo "[x] $1"; exit "${2:-1}"; }

# 🔴 统一回滚：报了回滚就一定回滚过（apply-llm-feature-walls.py 的教训）
rollback() {
  echo "  !! 触发回滚：$1"
  sudo -n cp -a "$BAK"/. "$APP/lib/" 2>/dev/null || echo "  !! 回滚 cp 失败（须人工介入）"
  # 🔴 刻意「不删除」本次新增的 3 个文件：旧 app.mjs 不 import 它们，留在 lib 里无害；
  #    删除动作按用户规则须单独评估确认，回滚不应擅自删任何文件。
  #    代价：回滚后 lib 仍是 16 个文件（不影响服务，旧代码不引用新模块）。
  sudo -n systemctl restart dbee-gateway >/dev/null 2>&1
  local hz=""
  for i in 1 2 3 4 5; do
    sleep 5
    hz="$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8080/.cloud/healthz || true)"
    [ "$hz" = "200" ] && break
  done
  echo "  回滚后 healthz -> HTTP ${hz:-000}"
  [ "$hz" = "200" ] || echo "  !! 🔴 回滚后 healthz 仍非 200 —— 必须人工介入！备份在 $BAK"
  # 🔴🔴 必须 exit 非 0：14:03 首轮 rollback 缺 exit，脚本继续往下跑完并打印
  #    DEPLOY_OK，本地据此误报「部署成功」＝假绿。回滚＝失败，绝不能让控制流继续。
  echo "ROLLBACK_DONE"
  exit 4
}

echo "=== ① 部署前快照 ==="
ENV_SHA_BEFORE="$(sudo -n sha256sum "$ENVF" | cut -d' ' -f1)"
echo "  gateway.env sha256=$ENV_SHA_BEFORE"
[ -n "$ENV_SHA_BEFORE" ] || fail "读不到 gateway.env sha256" 1
LIBN_BEFORE="$(sudo -n ls "$APP"/lib/*.mjs | wc -l)"
echo "  现网 lib .mjs 数=$LIBN_BEFORE"
# 🔴 兼容「上一轮回滚残留态」：rollback 刻意不删 3 个新增文件（旧 app.mjs 不引用），
#    故 lib 可能是 13（全新）或 16（回滚后）。其余数量一律视为状态异常，拒绝部署。
case "$LIBN_BEFORE" in
  13) echo "  ✅ 全新态：13 文件" ;;
  16) echo "  🟡 回滚残留态：16 文件（3 个新模块已在场，本次按幂等覆盖）" ;;
  *) fail "现网 lib 应为 13 或 16 个 .mjs，实为 $LIBN_BEFORE（状态已变，中止）" 1 ;;
esac
for f in apppay.mjs xpay.mjs wechatSession.mjs; do
  if [ -f "$APP/lib/$f" ]; then
    SUMSHA="$(sudo -n sha256sum "$STAGE/$f" | cut -d' ' -f1)"
    GOTSHA="$(sudo -n sha256sum "$APP/lib/$f" | cut -d' ' -f1)"
    [ "$SUMSHA" = "$GOTSHA" ] || fail "残留的 $f 与本地版本不一致（未知来源），拒绝覆盖" 1
  fi
done

echo "=== ② 重启前 ESM + config 真实预检（生产仍跑旧代码，失败零感知）==="
# 暂存目录里构造完整 16 文件闭包：先复制现网 13 个，再覆盖 5 个待部署文件
sudo -n mkdir -p "$STAGE/full/lib"
sudo -n cp -a "$APP"/lib/*.mjs "$STAGE/full/lib/"
for f in apppay.mjs xpay.mjs wechatSession.mjs app.mjs config.mjs; do
  sudo -n cp "$STAGE/$f" "$STAGE/full/lib/$f" || fail "暂存 $f 缺失" 1
done
# 🔴 预检目录必须与生产 $APP 的「模块解析环境」等价，否则 ESM 预检会假失败：
#    - node_modules：db.mjs import 'pg'（13:59 实测缺它报 ERR_MODULE_NOT_FOUND）
#    - assets/     ：iap.mjs 顶层 readFileSync('../assets/AppleRootCA-G3.cer')（14:02 实测 ENOENT）
#    - package.json："type": "module" 决定 .js 解析语义，必须同包边界
#    三者全部软链/复制生产既有文件（只读引用，不改任何生产文件）。
for item in node_modules assets; do
  if [ ! -e "$STAGE/full/$item" ]; then
    sudo -n ln -s "$APP/$item" "$STAGE/full/$item" || fail "建 $item 软链失败" 9
  fi
done
[ -f "$STAGE/full/node_modules/pg/package.json" ] || fail "预检环境仍缺 pg 包" 9
[ -f "$STAGE/full/assets/AppleRootCA-G3.cer" ] || fail "预检环境缺 AppleRootCA-G3.cer" 9
sudo -n cp "$APP/package.json" "$STAGE/full/package.json" || fail "复制 package.json 失败" 9
echo "  ✅ 预检环境等价：16 文件 + node_modules + assets + package.json"
# 🔴 $STAGE/full 由 sudo mkdir 创建（root 所有）→ ubuntu 无权直接重定向写入，
#    首轮实测报 "Permission denied" 导致 node 找不到入口文件（预检假失败）。
#    故用 sudo tee 以 root 写入；凭据仍只在进程环境里，绝不落盘。
sudo -n tee "$STAGE/full/precheck.mjs" >/dev/null <<'PCEOF'
import { createApp } from './lib/app.mjs'
import { loadConfig } from './lib/config.mjs'
const cfg = loadConfig()
if (typeof createApp !== 'function') throw new Error('createApp 未导出')
console.log('ESM_OK')
PCEOF
# 🔴 gateway.env 是 0640 root:dbee，ubuntu 不在 dbee 组 → 必须整段在 sudo 的
#    root shell 里 source（凭据只进进程环境，绝不落盘、绝不回显）。
#    loadConfig() 内部会跑 validate()：若新版 config 的断言与生产 env 冲突
#    （例：DBEE_PROD=1 且 SMS_PROVIDER=log），此处直接抛错 → 生产零改动。
PRECHK="$(sudo -n bash -c 'cd "$1" || exit 1; set -a; . /etc/dbee/gateway.env; set +a; exec /usr/local/bin/node precheck.mjs' _ "$STAGE/full" 2>&1)" || true
echo "$PRECHK" | tail -12
echo "$PRECHK" | grep -q 'ESM_OK' || fail "重启前 ESM/config 预检未通过（见上方输出）—— 生产现网代码未被改动" 9
echo "  ✅ ESM_OK（app.mjs 可解析、config.mjs loadConfig+validate 未抛错）"

echo "=== ③ 备份 ==="
sudo -n mkdir -p "$BAK" || fail "建备份目录失败" 1
sudo -n cp -a "$APP"/lib/*.mjs "$BAK/" || fail "备份失败" 1
BAKN="$(sudo -n ls "$BAK"/*.mjs | wc -l)"
[ "$BAKN" = "$LIBN_BEFORE" ] || fail "备份应有 $LIBN_BEFORE 个文件，实为 $BAKN" 1
echo "  ✅ 备份 $BAKN 文件 → $BAK"

echo "=== ④ 安装 5 文件（root:dbee 0644）==="
for f in apppay.mjs xpay.mjs wechatSession.mjs app.mjs config.mjs; do
  sudo -n install -o root -g dbee -m 0644 "$STAGE/$f" "$APP/lib/$f" || rollback "install $f 失败"
done
echo "  ✅ 5 文件已安装"

echo "=== ⑤ 静态断言（新代码就位 + 禁区未动）==="
LIBN="$(sudo -n ls "$APP"/lib/*.mjs | wc -l)"
[ "$LIBN" = "16" ] || rollback "lib .mjs 数应为 16，实为 $LIBN"
grep -q "createAppPayHandlers" "$APP/lib/app.mjs" || rollback "app.mjs 缺 apppay 装配"
grep -q "createXpayHandlers" "$APP/lib/app.mjs" || rollback "app.mjs 缺 xpay 装配"
grep -q "ALIPAY_APP_ID" "$APP/lib/config.mjs" || rollback "config.mjs 不解析 ALIPAY_APP_ID"
grep -q "WECHAT_PAY_MCHID" "$APP/lib/config.mjs" || rollback "config.mjs 不解析 WECHAT_PAY_MCHID"
[ -f "$APP/lib/wechatSession.mjs" ] || rollback "缺 wechatSession.mjs"
ENV_SHA_AFTER="$(sudo -n sha256sum "$ENVF" | cut -d' ' -f1)"
[ "$ENV_SHA_BEFORE" = "$ENV_SHA_AFTER" ] || rollback "🔴 gateway.env 被改动（${ENV_SHA_BEFORE} → ${ENV_SHA_AFTER}）"
echo "  ✅ lib=16 / 3 import / 支付键解析 / gateway.env 逐字未变"

echo "=== ⑥ 重启 + 探活（sleep 8 + 重试 3 次；立即验证＝假红）==="
sudo -n systemctl restart dbee-gateway || rollback "systemctl restart 失败"
HZ=""
for i in 1 2 3; do
  sleep 8
  HZ="$(curl -s -o /dev/null -w '%{http_code}' -m 15 http://127.0.0.1:8080/.cloud/healthz || true)"
  echo "  healthz 第 $i 次 -> HTTP ${HZ:-000}"
  [ "$HZ" = "200" ] && break
done
[ "$HZ" = "200" ] || rollback "healthz 3 次均非 200（最后 HTTP ${HZ:-000}）"

echo "=== ⑦ 铁律 #13：新端点须 404 → 已注册 ==="
# 🔴 prepay：需 Bearer + 未配 env → 503 apppay_not_configured（代码已生效的唯一客观证据）
code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "http://127.0.0.1:8080/.cloud/payment/apppay/prepay" -d '{}' || true)"
echo "  POST /.cloud/payment/apppay/prepay -> HTTP ${code:-000}"
[ "$code" = "503" ] || rollback "prepay 应为 503，实为 ${code:-000}"
# 🔴 notify：按支付宝协议**恒返回 200 + 纯文本 success/failure**（未配 env → 200 failure），
#    14:03 首轮把 503 错套到 notify 上误触发回滚。这里验「响应体是纯文本且非 404」，
#    并确认未配 env 时是 failure（即不敢发货，诚实降级）。
NOTIFY_BODY="$(curl -s -m 15 -X POST "http://127.0.0.1:8080/.cloud/payment/alipay/notify" -d '{}' || true)"
NOTIFY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "http://127.0.0.1:8080/.cloud/payment/alipay/notify" -d '{}' || true)"
echo "  POST /.cloud/payment/alipay/notify -> HTTP ${NOTIFY_CODE:-000} body='${NOTIFY_BODY}'"
[ "$NOTIFY_CODE" = "200" ] || rollback "alipay/notify 应恒 200，实为 ${NOTIFY_CODE:-000}"
[ "$NOTIFY_BODY" = "failure" ] || rollback "未配 env 时 notify 应回 failure（不发权益），实为 '${NOTIFY_BODY}'"
echo "  ✅ prepay 503 / notify 200+failure：路由已注册且未配 env 时诚实拒绝发货"

echo "=== ⑧ 既有路由回归（不得变 404；🔴 用各端点真实 method，方法不匹配会被 Router 判 404＝假回滚）==="
check_get() {
  p="$1"; code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:8080$p" || true)"
  echo "  GET  $p -> HTTP ${code:-000}"
  [ "$code" = "404" ] && rollback "既有路由 $p 变成 404（功能丢失）"
}
check_post() {
  p="$1"; code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "http://127.0.0.1:8080$p" -d '{}' || true)"
  echo "  POST $p -> HTTP ${code:-000}"
  [ "$code" = "404" ] && rollback "既有路由 $p 变成 404（功能丢失）"
}
check_get  /.cloud/healthz
check_get  /.cloud/llm/models
check_post /.cloud/llm/features/meal
check_post /.cloud/payment/apple/verify

echo "=== ⑨ 启动日志扫可疑错误 ==="
JLOG="$(sudo -n journalctl -u dbee-gateway --since '-3 min' --no-pager 2>/dev/null | grep -iE 'ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find module' | tail -8 || true)"
if [ -n "$JLOG" ]; then echo "$JLOG"; rollback "启动日志含模块/Syntax 错误"; fi
echo "  ✅ 无 ERR_MODULE_NOT_FOUND / SyntaxError"

echo "DEPLOY_OK 备份在 $BAK（回滚：sudo cp -a $BAK/. $APP/lib/ 后 restart，并删除 3 个新增文件）"
"""


def load_env() -> dict[str, str]:
    """读仓库根 .env；只取连接所需 3 键，绝不回显。"""
    out: dict[str, str] = {}
    if not os.path.isfile(ENV_PATH):
        return out
    for line in open(ENV_PATH, encoding="utf-8", errors="replace"):
        m = re.match(r"^([A-Z_0-9]+)=(.*)$", line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def imports_of(src: str) -> set[str]:
    return set(re.findall(r"from\s+['\"]\./([A-Za-z0-9_]+\.mjs)['\"]", src))


def redact(s: str) -> str:
    """防 PKCS8 私钥 / 密码误入输出。"""
    s = re.sub(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
               "[REDACTED_PRIVATE_KEY]", s)
    s = re.sub(r"(?i)(password|secret|api_?key|token)\s*=\s*\S+", r"\1=[REDACTED]", s)
    return s


def local_precheck() -> tuple[dict[str, bytes], bool]:
    """本地 13 道断言的前半：文件在、纯 LF、语法、闭包。返回 {文件名: 字节}。"""
    print("=== ⓪ 本地预检（不连生产）===")
    payload: dict[str, bytes] = {}
    for name in ALL_FILES:
        p = os.path.join(LOCAL_DIR, name)
        if not os.path.isfile(p):
            print(f"[x] 缺本地文件 server/lib/{name}")
            return {}, False
        raw = open(p, "rb").read()
        if b"\r\n" in raw:
            print(f"[x] {name} 含 CRLF —— 中止（远端须纯 LF）")
            return {}, False
        payload[name] = raw
        tag = "新增" if name in ADD_FILES else "替换"
        print(f"  {tag} {name:22} {len(raw):7} B  sha256={sha256(raw)[:16]}")
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[x] {name} node --check 失败：\n{redact(r.stderr)[:400]}")
            return {}, False
    print("  ✅ 5 文件纯 LF + node --check 全过")

    # 闭包断言：所有相对 import 必须落在部署后 16 文件集内
    for name in ALL_FILES:
        src = payload[name].decode("utf-8")
        miss = sorted(imports_of(src) - EXPECTED_LIB)
        if miss:
            print(f"[x] {name} 依赖部署后仍缺失的模块 {miss} —— 中止")
            return {}, False
    print(f"  ✅ import 闭包 ⊆ 部署后 {len(EXPECTED_LIB)} 文件集")
    # 禁区断言
    assert not (set(ALL_FILES) & FORBIDDEN), "待部署文件误含禁区文件"
    print("  ✅ 禁区 auth.mjs / index.mjs / gateway.env 均不在部署集")
    return payload, True


def main() -> int:
    apply = "--apply" in sys.argv[1:]
    print("模式:", "APPLY（将改生产）" if apply else "DRY-RUN（只读，不碰生产）")
    payload, ok = local_precheck()
    if not ok:
        return 3

    env = load_env()
    host, user, pwd = env.get("DBEE_HOST", ""), env.get("USER") or "ubuntu", env.get("SSH_PWD", "")
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST / SSH_PWD")
        return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n连接 {user}@{host}:22 ...")
    cli.connect(host, port=22, username=user, password=pwd, timeout=25,
                banner_timeout=25, auth_timeout=25)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def remote(cmd: str, timeout: int = 120) -> str:
        _, so, se = cli.exec_command(cmd, timeout=timeout)
        out = so.read().decode("utf-8", "replace").strip()
        so.channel.recv_exit_status()
        return out

    try:
        home = remote("echo $HOME", 30)
        if not home.startswith("/"):
            print(f"[x] 取 HOME 失败：{home!r}")
            return 3

        print("\n=== ① 生产只读预检 ===")
        prod_listing = remote(f"sudo -n ls {APP}/lib/*.mjs | xargs -n1 basename | sort | tr '\\n' ' '", 60)
        print(f"  现网 lib: {prod_listing}")
        prod_names = set(prod_listing.split())
        # 兼容回滚残留态：允许额外存在 3 个新模块（须在 ADD_FILES 白名单内）
        extra = prod_names - PROD_LIB_FILES
        if (prod_names & PROD_LIB_FILES) != PROD_LIB_FILES or extra - set(ADD_FILES):
            print(f"[x] 现网清单异常：缺 {sorted(PROD_LIB_FILES - prod_names)} / 未预期多出 {sorted(extra - set(ADD_FILES))}")
            return 3
        print(f"  ✅ 现网 13 个基线文件齐备；额外新模块 {sorted(extra) or '无'}（回滚残留可接受）")
        env_sha = remote(f"sudo -n sha256sum {ENV_FILE} | cut -d' ' -f1", 60)
        print(f"  gateway.env sha256={env_sha[:16]}…（部署后须逐字不变）")
        pay_keys = remote(f"sudo -n grep -oE '^[A-Z_]+=' {ENV_FILE} | grep -cE 'ALIPAY|WECHAT_PAY|XPAY' || true", 60)
        print(f"  现网支付键数量={pay_keys}（0 → 部署后端点应为 503）")

        print("\n=== ② 待部署 diff 预览（生产 → 本地）===")
        for name in ALL_FILES:
            psha = remote(f"sudo -n sha256sum {APP}/lib/{name} 2>/dev/null | cut -d' ' -f1", 60)
            lsha = sha256(payload[name])
            if name in ADD_FILES:
                if not psha:
                    print(f"  + 新增 {name:22} {len(payload[name])} B  sha256={lsha[:16]}")
                elif psha == lsha:
                    print(f"  = 已在场 {name:20} sha256={lsha[:16]}（回滚残留，逐字一致 → 幂等覆盖）")
                else:
                    print(f"    🔴 异常：生产已有同名 {name} 但 sha 不同（未知来源），中止")
                    return 3
            else:
                print(f"  ~ 替换 {name:22} {psha[:16] or 'None'} → {lsha[:16]}  ({len(payload[name])} B)")
                if not psha or psha == lsha:
                    print("    🔴 异常：生产文件读不到或已与本地一致，中止")
                    return 3
        print(f"  ⊘ 不动：{', '.join(sorted(PROD_LIB_FILES - set(REPLACE_FILES)))} + index.mjs + gateway.env")

        if not apply:
            print("\n=== DRY-RUN 结束：未上传、未重启、未改任何生产状态 ===")
            print("  真正执行：python deploy/apply-apppay-gateway.py --apply（须用户批准生产变更）")
            print(f"  新端点（部署后须 404→503）：{', '.join(NEW_ENDPOINTS)}")
            print(f"  回归端点（不得变 404）：{', '.join(REGRESSION_ENDPOINTS)}")
            return 0

        # ---------- APPLY ----------
        stage = f"{home}/dbee-apppay-0047"
        print(f"\n=== ③ 上传 5 文件到暂存 {stage}/ ===")
        remote(f"mkdir -p '{stage}'", 60)
        sftp = cli.open_sftp()
        for name, data in payload.items():
            rp = f"{stage}/{name}"
            with sftp.open(rp, "wb") as fh:
                fh.write(data)
            print(f"  ↑ {name:22} {len(data)} B")
        sftp.close()

        print("\n=== ④ 执行远端部署（含自动回滚）===")
        _, so, se = cli.exec_command(f"bash -s -- '{home}'", timeout=480)
        so.channel.sendall(REMOTE_SCRIPT.encode("utf-8"))
        so.channel.shutdown_write()
        out = so.read().decode("utf-8", "replace")
        err = se.read().decode("utf-8", "replace")
        print(redact(out))
        if err.strip():
            print("[stderr]", redact(err.strip()[:600]))
        rc = so.channel.recv_exit_status()
    finally:
        cli.close()

    # 🔴 双重保险：即便远端脚本被改回「回滚后不 exit」，只要输出含 ROLLBACK_DONE
    #    就绝不能判成功（14:03 假绿事故）。成功必须同时满足 rc=0 + DEPLOY_OK + 无回滚标记。
    rolled_back = "ROLLBACK_DONE" in out
    if rc == 0 and "DEPLOY_OK" in out and not rolled_back:
        print("\n✅ B3 部署成功：prepay 已从 404 变 503、notify 已注册且诚实拒绝发货")
        print("   下一步：B8 配 3 键 env → B9 重打 vc32 → B10/B11 真机 1 分钱")
        return 0
    if rolled_back or rc == 4:
        print("\n[x] 已自动回滚：生产保持部署前状态（端点仍 404、服务 active）")
        print("   备份目录见上方输出；未配 env 时端点 404 属预期，非故障")
        return 4
    if rc == 9:
        print("\n[x] 重启前 ESM/config 预检失败 —— 生产现网代码未被改动（零感知）")
        return 3
    if rc == 4:
        print("\n[x] 部署后验证未全绿（已自动回滚，网关应为旧版本可用）")
        return 4
    print(f"\n[x] 部署失败 rc={rc}（脚本已自动回滚）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
