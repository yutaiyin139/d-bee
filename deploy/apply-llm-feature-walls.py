#!/usr/bin/env python3
"""部署「0052 服务端 LLM 功能墙」到生产网关：只搬 lib/llm.mjs + lib/app.mjs 两个文件。

为什么不用 deploy/deploy-gateway.sh
----------------------------------
那个脚本会用本地模板重渲染并覆盖 /etc/dbee/gateway.env，而本地 .env 缺
IDENT_PEPPER / JWT_SECRET —— 覆盖等于全站身份永久锁死（10-29 血泪教训，
记忆列为 🔴🔴 绝不执行级）。本脚本 env 一个字节都不碰，且部署前后断言其 sha256 一致。

为什么不能照 apply-llm-thinking-fix.py 直接搬本地 app.mjs
---------------------------------------------------------
🔴 本地 app.mjs:16-17 有 `import './xpay.mjs'` / `'./apppay.mjs'`，而生产
/opt/dbee-gateway/lib/ 只有 12 个 .mjs、**没有这两个文件**（0046/0047 支付从未部署到生产）。
整文件替换 app.mjs → node 在 ESM 顶层解析阶段直接抛 ERR_MODULE_NOT_FOUND →
网关启动失败 = 全站宕机。

故本脚本的 app.mjs **不是本地文件**，而是「生产现网副本 + 仅在 llm 块内插入 7 行」
的手术式产物（由本脚本在运行时从服务器拉取现网副本后本地生成，见 build_app_mjs）。
llm.mjs 则可整文件搬：其 import 只有 jwt/http/db/identity.mjs（四者生产与本地
sha256 字节相同），且访问的 17 个 cfg 字段与生产版完全一致 → 无需同步 config.mjs。

安全措施（每步失败即中止/回滚，绝不留半部署状态）
--------------------------------------------------
① 本地 node --check 两个待部署文件（Windows 侧语法校验）
② 运行时从服务器拉取现网 app.mjs 作为基底 → 本地做精确锚点插入 → 断言纯新增 7 行/零删除
③ 断言 app.mjs 的 import 集合与现网逐字相同（证明没引入 xpay/apppay）
④ 上传到 $HOME 暂存（不经 /tmp，避免 SFTP 0600 权限坑），服务器侧再 node --check
⑤ 记录 gateway.env sha256，部署后断言一致（红线键 IDENT_PEPPER/JWT_SECRET 不可能被动）
⑥ 备份原文件到 $APP/.bak-<时间戳>/（回滚只需 sudo cp -a 回去 + restart）
⑦ install 保持 root:dbee 0644
⑧ grep 断言新代码就位（4 条 features 路由 + 4 个 featureXxx handler）
⑨ 重启前服务器侧预检：node -e 真实 import 一遍 app.mjs（ESM 解析失败在这一步就暴露，
   此时生产仍跑旧代码，失败零感知）
⑩ systemctl restart + healthz 探活（sleep 5 + 重试 5 次；立即验证会假红），非 200 自动回滚
⑪ 🔴 铁律 #13 生产侧实测：features/{meal,recap,plan,coach} 必须从 404 变 401
   （401 = 路由已命中、handler 已执行到 authOwnerId 鉴权；404 = 路由没注册）
⑫ 启动日志扫 ERR_MODULE_NOT_FOUND / SyntaxError / Error 等可疑关键词
⑬ 清理暂存目录（含代码副本，不留明文在服务器）

用法：python deploy/apply-llm-feature-walls.py
退出码：0 成功 / 1 部署失败已回滚 / 2 缺凭据 / 3 预检失败未触碰生产 / 4 部署后验证失败已回滚
"""

from __future__ import annotations

import difflib
import hashlib
import io
import os
import re
import subprocess
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")
LOCAL_DIR = os.path.join(REPO, "server")
APP = "/opt/dbee-gateway"
ENV_FILE = "/etc/dbee/gateway.env"
HEALTHZ = "http://127.0.0.1:8080/.cloud/healthz"

# 待部署文件（相对 server/ 与 /opt/dbee-gateway/）
FILES = ["lib/llm.mjs", "lib/app.mjs"]
# 0052 的 4 个新 feature
FEATURES = ["meal", "recap", "plan", "coach"]

# 🔴 手术式插入锚点：现网 app.mjs 的 llm 块原文（逐字，含缩进）。
#    锚点必须唯一匹配；匹配 0 次或 >1 次一律中止，绝不模糊替换。
ANCHOR = """  if (llm) {
    router.on('GET', '/.cloud/llm/models', wrap(llm.listModels))
    router.on('POST', '/.cloud/llm/chat/completions', wrap(llm.chatCompletions))
  }
"""

# 插入后的目标块：仅新增 3 行注释 + 4 条路由，其余逐字保留。
# 🔴 注释里刻意不写 `[dbee-feature:` 字面量 —— 护栏 22-C 断言
#    !/\[dbee-feature:/.test(LLM)，虽只扫 llm.mjs，但不留隐患。
NEW_BLOCK = """  if (llm) {
    router.on('GET', '/.cloud/llm/models', wrap(llm.listModels))
    router.on('POST', '/.cloud/llm/chat/completions', wrap(llm.chatCompletions))
    // 0052：营养解读 / 复盘 / 计划再生成 / 教练走服务端专属路由。
    //   feature 由服务端钉死、不接受客户端自报，闸门不可被绕过（护栏 22-C）。
    //   handler 与 chat/completions 同一批，见 llm.mjs 的 runOwned。
    router.on('POST', '/.cloud/llm/features/meal', wrap(llm.featureMeal))
    router.on('POST', '/.cloud/llm/features/recap', wrap(llm.featureRecap))
    router.on('POST', '/.cloud/llm/features/plan', wrap(llm.featurePlan))
    router.on('POST', '/.cloud/llm/features/coach', wrap(llm.featureCoach))
  }
"""

# 手术式插入的防夹带断言：新增行不得出现这些词（证明没顺手把支付/鉴权/配置带上去）
BANNED_IN_ADDED = [
    "xpay", "apppay", "wechat", "session_key", "savesessionkey",
    "alipay", "payment", "iap", "auth.", "config.",
]

# 🔴 生产 lib/ 权威清单（取自只读体检 sha256sum 实际输出，12 个 .mjs）。
#    用于断言待部署文件的 import 全部在生产在场 —— 这是「不会 ESM 解析失败」的根据。
PROD_LIB_FILES = {
    "app.mjs", "auth.mjs", "config.mjs", "db.mjs", "dbproxy.mjs", "http.mjs",
    "iap.mjs", "identity.mjs", "jwt.mjs", "llm.mjs", "otp.mjs", "sms.mjs",
}

# 服务器端安装脚本（sudo -n 免密；密码绝不进命令行/输出）
REMOTE_SCRIPT = r"""
set -euo pipefail
APP=/opt/dbee-gateway
ENV_FILE=/etc/dbee/gateway.env
STAGE="$HOME/dbee-0052-walls"
TS=$(date +%Y%m%d-%H%M%S)
FILES="lib/llm.mjs lib/app.mjs"
# 🔴 必须在 bash 里自己定义：Python 侧的 HEALTHZ 常量不会插值进这个 r-string，
#    首次实跑时 `curl "$HEALTHZ"` 在 set -u 下报 "HEALTHZ: unbound variable" 并崩在
#    HZ= 赋值行 —— 而回滚分支在它之后，于是脚本**误报「已自动回滚」但实际一行都没回滚**
#    （生产已是新版）。这类「状态谎报」比失败本身更危险，故此处显式定义 + 下方去掉 -u 依赖。
HEALTHZ="http://127.0.0.1:8080/.cloud/healthz"
GATEWAY_BASE="http://127.0.0.1:8080/.cloud/llm"

# 统一回滚函数：任何一步失败都调它，保证「报了回滚就一定回滚过」
rollback() {
  echo "  !! 触发回滚：$1"
  for f in $FILES; do
    sudo -n cp -a "$APP/.bak-$TS/$(basename "$f")" "$APP/$f" && echo "    已还原 $f"
  done
  sudo -n systemctl restart dbee-gateway
  sleep 8
  for i in 1 2 3; do
    local_rb=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$HEALTHZ" || echo 000)
    echo "    回滚后第 $i 次 healthz -> HTTP $local_rb"
    [ "$local_rb" = "200" ] && break
    sleep 4
  done
  sudo -n journalctl -u dbee-gateway --since "3 minutes ago" --no-pager | tail -25
  echo "ROLLBACK_DONE 备份仍在 $APP/.bak-$TS/"
}

echo "=== ① 服务器侧语法校验（失败即中止，不碰任何文件）==="
for f in $FILES; do
  node --check "$STAGE/$f" && echo "  OK node --check $f"
done

echo
echo "=== ② 🔴 ESM 解析预检（补全完整模块上下文后真 import app.mjs）==="
# 🔴 为什么不能只 import 暂存的 app.mjs：app.mjs 顶层 import http/auth/config/dbproxy/
#    iap/otp/llm.mjs，而 iap.mjs 顶层还读 assets/AppleRootCA-G3.cer、依赖 node_modules/pg。
#    暂存目录只有 2 个文件 → 必然 ERR_MODULE_NOT_FOUND（首次实跑已验证，预检正确拦下）。
#    故先把「生产其余 .mjs + package.json + node_modules 软链 + assets 软链」补进 STAGE，
#    构成「部署后生产」的等价镜像，再 import 才有意义。
# 🔴 只 import 工厂模块 app.mjs，不 import index.mjs：后者顶层会 loadConfig，
#    在无 gateway.env 的预检环境里必报「缺 JWT_SECRET」（已实测，属预期，非缺陷）。
for f in $(sudo -n ls "$APP/lib" | grep '\.mjs$'); do
  # 待部署的 llm.mjs / app.mjs 已在 STAGE（新版），保留；其余从生产复制
  [ -f "$STAGE/lib/$f" ] || sudo -n cat "$APP/lib/$f" > "$STAGE/lib/$f"
done
chmod 644 "$STAGE/lib"/*.mjs
sudo -n cat "$APP/package.json" > "$STAGE/package.json"
ln -sfn "$APP/node_modules" "$STAGE/node_modules"
ln -sfn "$APP/assets"       "$STAGE/assets"
echo "  预检上下文: lib $(ls "$STAGE/lib" | grep -c '\.mjs$') 个 .mjs + package.json + node_modules + assets"
# 此时生产仍跑旧代码：预检失败 = 零感知中止，绝不动现网文件。
if ! node --input-type=module -e "
  await import('file://' + process.argv[1]);
  console.log('  OK 待部署 app.mjs + llm.mjs 在完整上下文里 ESM 解析成功');
" "$STAGE/lib/app.mjs" 2>&1; then
  echo "  !! ESM 解析失败 —— 中止（现网未改动，STAGE 保留供排查）"
  exit 9
fi

echo
echo "=== ③ 记录 gateway.env 指纹（部署后须完全一致）==="
ENV_BEFORE=$(sudo -n sha256sum "$ENV_FILE" | cut -c1-16)
echo "  env sha256(before) = $ENV_BEFORE"

echo
echo "=== ④ 备份现网原文件 ==="
sudo -n install -d -m 0750 -o root -g dbee "$APP/.bak-$TS"
for f in $FILES; do
  sudo -n cp -a "$APP/$f" "$APP/.bak-$TS/$(basename "$f")"
  echo "  已备份 $f -> .bak-$TS/$(basename "$f")"
done

echo
echo "=== ⑤ 部署前路由基线（首次部署应为 404；重跑时已是 400 属正常）==="
for ft in meal recap plan coach; do
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \
    -X POST "$GATEWAY_BASE/features/$ft" \
    -H 'Content-Type: application/json' -d '{}' || echo 000)
  echo "  features/$ft -> $code"
done

echo
echo "=== ⑥ 安装新文件（保持 root:dbee 0644）==="
for f in $FILES; do
  sudo -n install -m 0644 -o root -g dbee "$STAGE/$f" "$APP/$f"
  echo "  OK $f  $(sudo -n stat -c 'owner=%U:%G perm=%a size=%s' "$APP/$f")"
done

echo
echo "=== ⑦ grep 断言新代码就位 ==="
for ft in meal recap plan coach; do
  if ! sudo -n grep -q "/.cloud/llm/features/$ft" "$APP/lib/app.mjs"; then
    rollback "app.mjs 缺 features/$ft 路由"
    exit 1
  fi
  cap="$(echo "$ft" | sed 's/^./\U&/')"
  if ! sudo -n grep -q "feature$cap" "$APP/lib/llm.mjs"; then
    rollback "llm.mjs 缺 feature$cap handler"
    exit 1
  fi
done
echo "  OK 4 条路由 + 4 个 handler 全部就位"
if sudo -n grep -q "createXpayHandlers\|createAppPayHandlers" "$APP/lib/app.mjs"; then
  rollback "部署后的 app.mjs 竟含支付模块引用"
  exit 1
fi
echo "  OK 未引入 xpay/apppay（与现网一致）"
# 反向确认 lib 文件数未变（生产 12 个 .mjs；变多说明夹带了模块）
LIBN=$(sudo -n find "$APP/lib" -maxdepth 1 -name '*.mjs' | wc -l)
echo "  lib .mjs 数: $LIBN（期望 12）"
if [ "$LIBN" != "12" ]; then
  rollback "lib .mjs 数变成 $LIBN，与预期 12 不符"
  exit 1
fi

echo
echo "=== ⑧ 重启网关 ==="
sudo -n systemctl restart dbee-gateway
sleep 5
sudo -n systemctl is-active dbee-gateway || true

echo
echo "=== ⑨ healthz 探活（sleep 后重试 5 次；立即验证会假红）==="
HZ=000
for i in 1 2 3 4 5; do
  HZ=$(curl -sS -m 10 -o /tmp/hz-0052.txt -w '%{http_code}' "$HEALTHZ" || echo 000)
  echo "  第 $i 次 healthz -> HTTP $HZ"
  [ "$HZ" = "200" ] && break
  sleep 4
done
head -c 300 /tmp/hz-0052.txt 2>/dev/null; echo
if [ "$HZ" != "200" ]; then
  rollback "healthz 探活 5 次均非 200（最后一次 HTTP $HZ）"
  exit 1
fi

echo
echo "=== ⑩ 🔴 铁律 #13 生产侧实测：features/* 必须 404 → 400/401 ==="
# 🔴 断言口径（首次实跑修正）：
#   404 = 路由未注册（部署失败的特征）
#   400 = 路由已命中 → runOwned → buildOwnedMessages 参数校验（空 body 必然 400）
#   401 = 路由已命中 → 参数合法 → chatCompletions.authOwnerId 鉴权
# 故「部署成功」的判据是 **不再 404**，而不是固定 401：
#   A 段用空 body 打，四者都应 400；B 段用合法 body 打，四者都应 401。
ALL_OK=1
echo "  --- A) 空 body（期望 400 = 路由命中且参数校验生效）---"
for ft in meal recap plan coach; do
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \
    -X POST "$GATEWAY_BASE/features/$ft" \
    -H 'Content-Type: application/json' -d '{}' || echo 000)
  echo "    features/$ft -> HTTP $code"
  [ "$code" = "400" ] || ALL_OK=0
done
echo "  --- B) 合法 body + 无 token（期望 401 = 走到鉴权）---"
probe_body() {
  local ft="$1" bd="$2" code
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \
    -X POST "$GATEWAY_BASE/features/$ft" \
    -H 'Content-Type: application/json' -d "$bd" || echo 000)
  echo "    features/$ft -> HTTP $code"
  [ "$code" = "401" ] || ALL_OK=0
}
probe_body meal  '{"kcal":520,"protein":28,"carb":55,"fat":18,"foods":["米饭"]}'
probe_body recap '{"days":7,"avgKcal":1850,"targetKcal":1800}'
probe_body plan  '{"calories":1800,"age":30}'
probe_body coach '{"question":"晚饭吃什么"}'
echo "  --- C) 未注册路径必须仍 404（证明没有开放通配）---"
for ft in bogus scan package text; do
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \
    -X POST "$GATEWAY_BASE/features/$ft" \
    -H 'Content-Type: application/json' -d '{}' || echo 000)
  echo "    features/$ft -> HTTP $code"
  [ "$code" = "404" ] || ALL_OK=0
done
# 回归：原有路由必须仍然工作
OLD1=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -X POST \
  "$GATEWAY_BASE/chat/completions" \
  -H 'Content-Type: application/json' -d '{}' || echo 000)
OLD2=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$GATEWAY_BASE/models" || echo 000)
echo "  --- D) 回归：原有路由不受影响 ---"
echo "    chat/completions -> $OLD1 （期望 401）"
echo "    llm/models       -> $OLD2 （期望 200 或 401）"
[ "$OLD1" = "401" ] || ALL_OK=0
case "$OLD2" in 200|401) ;; *) ALL_OK=0 ;; esac
if [ "$ALL_OK" != "1" ]; then
  rollback "路由验证未全绿（见上方 A/B/C/D 各段实际码）"
  exit 4
fi

echo
echo "=== ⑪ 断言 gateway.env 未被改动（红线键指纹）==="
ENV_AFTER=$(sudo -n sha256sum "$ENV_FILE" | cut -c1-16)
echo "  env sha256(after)  = $ENV_AFTER"
if [ "$ENV_BEFORE" = "$ENV_AFTER" ]; then
  echo "  OK 一致 —— IDENT_PEPPER / JWT_SECRET / SMS / SMTP 全部原样保留"
else
  echo "  !! 不一致！env 被改动了，请立即检查 $ENV_FILE"
  exit 1
fi

echo
echo "=== ⑫ 启动日志扫可疑关键词 ==="
sudo -n journalctl -u dbee-gateway --since "2 minutes ago" --no-pager | tail -20
BAD=$(sudo -n journalctl -u dbee-gateway --since "2 minutes ago" --no-pager \
  | grep -cE 'ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|TypeError|uncaught|unhandled' || true)
echo "  可疑关键词命中数: $BAD （期望 0）"
if [ "$BAD" != "0" ]; then
  echo "  !! 启动日志有可疑错误，请人工复核上方日志；备份在 $APP/.bak-$TS/"
  echo "  （网关 healthz 已 200 且路由已验证，故不自动回滚，交由人工判断）"
fi

echo
echo "=== ⑬ 清理暂存目录（代码副本不留服务器）==="
rm -rf "$STAGE"
echo "  已清理 $STAGE"
echo
echo "DEPLOY_OK 备份在 $APP/.bak-$TS/（回滚：sudo cp -a 回去再 systemctl restart dbee-gateway）"
"""


def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(ENV_PATH):
        return out
    with open(ENV_PATH, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def imports_of(src: str) -> set[str]:
    return set(re.findall(r"from '\./([a-zA-Z]+\.mjs)'", src))


def build_app_mjs(prod_app: str) -> tuple[str, list[str]]:
    """在现网 app.mjs 副本上做精确锚点插入，返回 (新内容, 新增行列表)。

    每一步都断言，任一不过即抛 —— 绝不产出模糊替换的结果。
    """
    n = prod_app.count(ANCHOR)
    if n != 1:
        raise SystemExit(f"[x] 锚点在现网 app.mjs 中匹配 {n} 次（须恰好 1 次）—— 中止")
    new_app = prod_app.replace(ANCHOR, NEW_BLOCK)
    if new_app == prod_app:
        raise SystemExit("[x] 替换未生效 —— 中止")

    diff = list(difflib.unified_diff(
        prod_app.splitlines(), new_app.splitlines(), lineterm="", n=0))
    added = [l for l in diff if l.startswith("+") and not l.startswith("+++")]
    removed = [l for l in diff if l.startswith("-") and not l.startswith("---")]

    if removed:
        raise SystemExit(f"[x] 手术式插入出现删除行 {removed} —— 中止")
    if len(added) != 7:
        raise SystemExit(f"[x] 期望纯新增 7 行（3 注释 + 4 路由），实得 {len(added)} —— 中止")
    routes = [l for l in added if "router.on" in l]
    if len(routes) != 4:
        raise SystemExit(f"[x] 期望 4 条 router.on，实得 {len(routes)} —— 中止")

    for feat in FEATURES:
        if f"'/.cloud/llm/features/{feat}'" not in new_app:
            raise SystemExit(f"[x] 新 app.mjs 缺 features/{feat} 路由 —— 中止")
    for l in added:
        low = l.lower()
        for ban in BANNED_IN_ADDED:
            if ban in low:
                raise SystemExit(f"[x] 新增行夹带禁用词 {ban!r}: {l} —— 中止")

    if imports_of(new_app) != imports_of(prod_app):
        raise SystemExit("[x] app.mjs 的 import 集合与现网不一致 —— 中止")
    if "xpay.mjs" in imports_of(new_app) or "apppay.mjs" in imports_of(new_app):
        raise SystemExit("[x] app.mjs 引入了生产不存在的支付模块 —— 中止")

    return new_app, added


def main() -> int:
    env = load_env()
    host = env.get("DBEE_HOST") or ""
    user = env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD") or ""
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST / USER / SSH_PWD")
        return 2

    # ⓪ 读本地 llm.mjs（整文件搬）
    llm_path = os.path.join(LOCAL_DIR, "lib", "llm.mjs")
    llm_raw = open(llm_path, "rb").read()
    if b"\r\n" in llm_raw:
        print("[x] llm.mjs 含 CRLF —— 中止")
        return 3
    llm_src = llm_raw.decode("utf-8")

    print("=== ⓪ 本地预检 ===")
    # llm.mjs 的 import 必须全部在生产在场
    llm_imports = imports_of(llm_src)
    missing = sorted(llm_imports - PROD_LIB_FILES)
    print(f"  llm.mjs import : {sorted(llm_imports)}")
    print(f"  生产缺失       : {missing or '无'}")
    if missing:
        print(f"[x] llm.mjs 依赖生产缺失模块 {missing} —— 中止")
        return 3

    # llm.mjs 必须导出 4 个 handler
    for feat in FEATURES:
        cap = feat[0].upper() + feat[1:]
        if f"feature{cap}" not in llm_src:
            print(f"[x] llm.mjs 缺 feature{cap} —— 中止")
            return 3
    print(f"  4 个 handler   : {'/'.join('feature' + f.capitalize() for f in FEATURES)} 全部在场")

    r = subprocess.run(["node", "--check", llm_path], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[x] llm.mjs 语法错误:\n{r.stderr}")
        return 3
    print("  node --check llm.mjs : OK")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n连接 {user}@{host} ...")
    cli.connect(host, username=user, password=pwd, timeout=25,
                banner_timeout=25, auth_timeout=25)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    try:
        # ① 取 HOME 绝对路径（SFTP 不展开 ~）
        _, so, _ = cli.exec_command("echo $HOME", timeout=30)
        home = so.read().decode("utf-8", "replace").strip()
        so.channel.recv_exit_status()
        if not home.startswith("/"):
            print(f"[x] 取 HOME 失败，得到 {home!r} —— 中止")
            return 3
        stage = f"{home}/dbee-0052-walls"
        print(f"  HOME={home}  暂存={stage}/")

        # ② 🔴 拉取现网 app.mjs 作为手术基底（不能用本地 app.mjs：它 import 生产没有的 xpay/apppay）
        print("\n=== ① 拉取现网 app.mjs 作为手术基底 ===")
        _, so, se = cli.exec_command(
            f"sudo -n cat {APP}/lib/app.mjs", timeout=60)
        prod_app = so.read().decode("utf-8")
        err = se.read().decode("utf-8", "replace")
        rc = so.channel.recv_exit_status()
        if rc != 0 or not prod_app.strip():
            print(f"[x] 读取现网 app.mjs 失败 rc={rc} {err.strip()[:200]} —— 中止")
            return 3
        prod_app = prod_app.replace("\r\n", "\n")
        print(f"  现网 app.mjs : {len(prod_app)} chars  sha256={sha256_bytes(prod_app.encode())[:16]}")
        prod_imports = imports_of(prod_app)
        print(f"  现网 import  : {sorted(prod_imports)}")
        if "xpay.mjs" in prod_imports:
            print("  注：现网已含 xpay —— 与预期不符，请人工复核后重跑")

        # ③ 手术式插入
        print("\n=== ② 手术式插入 4 条 features 路由 ===")
        new_app, added = build_app_mjs(prod_app)
        print(f"  纯新增 {len(added)} 行 / 零删除：")
        for l in added:
            print(f"    {l}")
        print("  ✅ 防夹带断言通过（无支付/鉴权/配置改动）")
        print(f"  新 app.mjs : {len(new_app)} chars  sha256={sha256_bytes(new_app.encode())[:16]}")

        # ④ 本地写盘 + node --check（在临时目录，不污染仓库）
        tmp_dir = os.path.join(os.environ.get("TEMP", "/tmp"), "dbee-0052-stage", "lib")
        os.makedirs(tmp_dir, exist_ok=True)
        app_local = os.path.join(tmp_dir, "app.mjs")
        with open(app_local, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(new_app)
        r = subprocess.run(["node", "--check", app_local], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[x] 生成的 app.mjs 语法错误:\n{r.stderr}")
            cli.close()
            return 3
        print("  node --check app.mjs(生成版) : OK")

        # ⑤ 上传两个文件到暂存
        print(f"\n=== ③ 上传到 {stage}/ ===")
        _, so, _ = cli.exec_command(
            f"rm -rf '{stage}' && mkdir -p '{stage}/lib'", timeout=30)
        so.channel.recv_exit_status()
        sftp = cli.open_sftp()
        payload = {
            f"{stage}/lib/llm.mjs": llm_src,
            f"{stage}/lib/app.mjs": new_app,
        }
        for remote, data in payload.items():
            with sftp.open(remote, "w") as out:
                out.write(data)
            print(f"  OK {remote.rsplit('/', 1)[-1]:10s} {len(data)} chars "
                  f"sha256={sha256_bytes(data.encode())[:16]}")
        sftp.close()

        # ⑥ 核验暂存（存在 + 非空）
        print("\n=== ④ 核验暂存文件 ===")
        _, so, _ = cli.exec_command(
            'for f in lib/llm.mjs lib/app.mjs; do '
            f'printf "%s  " "$f"; stat -c "size=%s" "{stage}/$f" 2>&1 || echo MISSING; done',
            timeout=30)
        staged = so.read().decode("utf-8", "replace").strip()
        so.channel.recv_exit_status()
        print("  " + staged.replace("\n", "\n  "))
        if "MISSING" in staged or "size=0" in staged:
            print("[x] 暂存缺失或为空 —— 中止，未触碰生产代码")
            cli.close()
            return 3

        # ⑦ 执行远端部署（timeout 给足：最坏路径含回滚重启）
        print("\n=== ⑤ 执行远端部署 ===")
        _, so, se = cli.exec_command("bash -s", timeout=420)
        so.channel.sendall(REMOTE_SCRIPT.encode())
        so.channel.shutdown_write()
        out = so.read().decode("utf-8", "replace")
        err = se.read().decode("utf-8", "replace")
        print(out)
        if err.strip():
            print("[stderr]", err.strip()[:600])
        rc = so.channel.recv_exit_status()
    finally:
        cli.close()

    if rc == 0 and "DEPLOY_OK" in out:
        print("\n✅ 网关部署成功：0052 的 4 条 features 路由已在生产生效（404 → 401 实测）")
        print("   下一步：部署新 Web 包（新前端硬依赖这些路由；不部署则新前端全 404）")
        return 0
    if rc == 9:
        print(f"\n[x] ESM 解析预检失败 rc={rc} —— 生产现网文件未被改动")
        return 3
    if rc == 4:
        print(f"\n[x] 部署后路由验证未全绿 rc={rc}（已自动回滚，网关应为旧版本可用）")
        return 4
    print(f"\n[x] 部署失败 rc={rc}（脚本已自动回滚，网关应保持旧版本可用）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
