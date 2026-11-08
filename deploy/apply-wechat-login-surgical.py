"""手术式部署「微信小程序登录链路」到自建网关（2026-11-07）。

🔴 为什么绝不能用 deploy/deploy-gateway.sh：
  该脚本整体重渲染 /etc/dbee/gateway.env；一旦 .secrets.local 缺失，
  load_secret 会静默生成全新随机 IDENT_PEPPER / JWT_SECRET →
  全站 ident_hash 永久失配、全员登出。不可逆，无回滚余地。
  本脚本只做两件事：同步 4 个 .mjs + 在 env 末尾追加/改 1 行，其余字节不动。

范围（严格限定，不扩大）：
  · server/lib/{app,auth,config,identity}.mjs → /opt/dbee-gateway/lib/
    （逐文件比对确认：其余 9 个 .mjs 与 index.mjs 生产/本地逐字一致，不动）
  · /etc/dbee/gateway.env 追加 WECHAT_MINI_SECRETS=wx<appid>=<32hex>
  · sudo systemctl restart dbee-gateway.service
  ✗ 不碰 nginx、不动 Apple/LLM 配置、不改 mini 代码与默认值、不发版、不删云库。

安全：
  · AppSecret 从 deploy/.wechat-mini-secret.local（gitignore *.local）或
    环境变量 DBEE_WX_MINI_SECRET 读取；脚本内无明文，命令行无明文，
    输出只用 sha256 前 8 位 + 长度，绝不回显值。
  · 传到服务器的暂存文件 chmod 600 / 目录 700，用完 rm -rf。
  · 红线键 IDENT_PEPPER / JWT_SECRET / SMS_MASTER_CODE 指纹前后断言。
  · 重启前服务器侧验证 AppSecret 有效性（jscode2session 用无效 code，
    期望 errcode=40029；40125/40013 = 凭据错 → 回滚且不重启，线上零影响）。
  · healthz 失败 → 回滚 env + 4 文件并重启。

用法：
  python deploy/apply-wechat-login-surgical.py --dry-run       # 只读对比，零改动
  python deploy/apply-wechat-login-surgical.py                 # 正式部署
  python deploy/apply-wechat-login-surgical.py --verify-only   # 只跑生产验收，零改动
退出码：0=成功/无需改动 · 1=失败已回滚 · 2=本地前置不满足 · 3=断言/预检失败已回滚
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = "/etc/dbee/gateway.env"
LIB_DIR = "/opt/dbee-gateway/lib"
TARGET_FILES = ("app.mjs", "auth.mjs", "config.mjs", "identity.mjs")
TARGET_KEY = "WECHAT_MINI_SECRETS"
APPID = "wxb7c7122de9c3ab1f"
GUARD_KEYS = ("IDENT_PEPPER", "JWT_SECRET", "SMS_MASTER_CODE")
SECRET_FILE = os.path.join(REPO, "deploy", ".wechat-mini-secret.local")
DRY_RUN = "--dry-run" in sys.argv
VERIFY_ONLY = "--verify-only" in sys.argv

# 服务器侧凭据预检：只用无效 code，期望微信返回 40029（证明 appid+secret 配对正确）。
# 密钥经 0600 env 文件由 shell source 注入进程环境，不进命令行 / ps / journalctl。
PROBE_PY = r'''
import json, os, sys, urllib.request
appid = os.environ["WX_APPID"]
secret = os.environ["WX_SECRET"]
url = ("https://api.weixin.qq.com/sns/jscode2session?appid=" + appid
       + "&secret=" + secret + "&js_code=INVALID_PROBE_CODE"
       + "&grant_type=authorization_code")
try:
    d = json.loads(urllib.request.urlopen(url, timeout=20).read())
except Exception as e:
    print("PROBE_NETWORK_FAIL " + type(e).__name__)
    sys.exit(1)
print("PROBE_ERRCODE " + str(d.get("errcode")))
'''

# 重启后端点验收（在服务器侧执行）：生产配了 WB_PUBLISHABLE_KEY，
# 不带 access-key 一律 401 invalid_api_key，故凭据链路必须带 key 发请求。
# verify_ep.py 以 sudo 运行、自行读 /etc/dbee/gateway.env 取 key，
# 密钥不进命令行 / ps / journalctl，也不回传到本机。
VERIFY_EP_PY = r'''
import json, sys, urllib.error, urllib.request
key = ""
for line in open("/etc/dbee/gateway.env", encoding="utf-8", errors="replace"):
    if line.startswith("WB_PUBLISHABLE_KEY="):
        key = line.split("=", 1)[1].strip().strip('"').strip("'")
        break
if not key:
    print("AK_MISSING")
    sys.exit(1)
url = "https://d-bee.cn/.cloud/auth/v1/login-wechat"
def post(body):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json",
                 "x-wb-webapp-access-key": key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read(300).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(300).decode("utf-8", "replace")
    except Exception as e:
        return -1, type(e).__name__
for tag, body in [("EMPTY", {}),
                  ("FAKECODE", {"code": "INVALID_PROBE_CODE",
                                "appid": "wxb7c7122de9c3ab1f"})]:
    s, t = post(body)
    print(tag + " " + str(s) + " " + t.replace("\n", " ")[:220])
'''


def fp(v: str) -> str:
    if not v:
        return "<空>"
    return "sha256:%s len=%d" % (hashlib.sha256(v.encode()).hexdigest()[:8], len(v))


def parse_env(body: bytes) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in body.decode("utf-8", "replace").splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def load_secret() -> str:
    v = os.environ.get("DBEE_WX_MINI_SECRET", "").strip()
    if not v and os.path.isfile(SECRET_FILE):
        v = open(SECRET_FILE, encoding="utf-8").read().strip()
    if not v:
        # 兼容项目根 .env 里用户自行保存的 AppSecret=<32hex>（gitignore 覆盖）。
        # 该键名与移动应用用的 VITE_WECHAT_APPID 无关，值只进进程内存。
        p = os.path.join(REPO, ".env")
        if os.path.isfile(p):
            for line in open(p, encoding="utf-8", errors="replace"):
                s = line.strip()
                if s.startswith("AppSecret="):
                    v = s.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    return v


def guard_map(cur: dict[str, str]) -> dict[str, str]:
    return {k: fp(cur.get(k, "")) for k in GUARD_KEYS}


def http_probe(path: str, body: dict | None = None, timeout: int = 15) -> tuple[int, str]:
    url = "https://d-bee.cn" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method="POST" if data is not None else "GET",
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                   context=ssl.create_default_context()) as r:
            return r.status, r.read(300).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(300).decode("utf-8", "replace")
    except Exception as e:
        return -1, type(e).__name__ + ": " + str(e)[:80]


def run_verification(cli, txt, stage: str) -> tuple[bool, bool, bool]:
    """只读生产验收：路由挂载 / 运行时 env / 凭据链路，返回三项布尔。"""
    print("\n═══ 生产侧验收 ═══")
    s, t = http_probe("/.cloud/auth/v1/login-wechat", {})
    print("  [本机] POST login-wechat {} → %s %s"
          % (s, t[:150].replace("\n", " ")))
    route_ok = s in (400, 401) and "not_found" not in t
    print("  路由已挂载 = %s（期望 401 invalid_api_key，非 404 not_found）"
          % ("PASS" if route_ok else "FAIL"))

    # 🔴 systemd 的 `Environment` 属性只列 unit 内显式 Environment=，
    #    EnvironmentFile 的内容根本不出现（11-07 实测假阴性）。
    #    必须读网关进程 /proc/<pid>/environ。grep -o 只输出固定前缀
    #    （到 appid 为止），AppSecret 值不回显、也不出现在本机。
    _rc, out, _err = txt(
        "P=$(systemctl show -p MainPID --value dbee-gateway.service); "
        "sudo -n grep -a -o '%s=%s=' /proc/$P/environ | wc -l"
        % (TARGET_KEY, APPID))
    env_loaded = out.strip() == "1"
    print("  运行时 env 已加载 %s = %s（只计数，不回显任何值）"
          % (TARGET_KEY, "PASS" if env_loaded else "FAIL"))

    # 服务器侧带 access-key 打端点：能区分「配置未加载 503」与
    # 「微信侧已接受凭据 401 invalid_grant(errcode 40029)」
    sftp = cli.open_sftp()
    with sftp.open("%s/verify_ep.py" % stage, "w") as f:
        f.write(VERIFY_EP_PY.encode("utf-8"))
    sftp.close()
    txt("chmod 600 '%s/verify_ep.py'" % stage)
    rc, out, err = txt("sudo -n python3 '%s/verify_ep.py'" % stage, timeout=90)
    for line in out.strip().splitlines():
        print("  [服务器] " + line[:240])
    if err.strip():
        print("  [stderr] " + err.strip()[:160])
    fake_line = next((l for l in out.splitlines()
                      if l.startswith("FAKECODE ")), "")
    # 只有「配置未加载 / 路由不存在」才算失败；微信侧限流、网络抖动
    # 与 401 invalid_grant 都说明 appid→secret 查表已通过。
    cred_bad = (not fake_line or "FAKECODE 404" in fake_line
                or "wechat_not_configured" in fake_line)
    cred_ok = not cred_bad
    print("  凭据链路 = %s（期望 401 invalid_grant；503 wechat_not_configured = 异常）"
          % ("PASS" if cred_ok else "FAIL"))
    return route_ok, env_loaded, cred_ok


def main() -> int:
    secret = load_secret()
    print("═══ ⓪ 本地前置校验 ═══")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", secret) and not VERIFY_ONLY:
        print("[x] AppSecret 缺失或不是 32 位 hex（值不回显）—— 中止")
        return 2
    secret = secret.lower()
    target_value = "%s=%s" % (APPID, secret)
    print("  AppSecret 指纹 = %s（值不回显）" % fp(secret))
    print("  appid          = %s" % APPID)
    print("  目标 env 行     = %s=<appid>=<secret>（长度 %d，值不回显）"
          % (TARGET_KEY, len(target_value)))

    local: dict[str, bytes] = {}
    for name in TARGET_FILES:
        p = os.path.join(REPO, "server", "lib", name)
        if not os.path.isfile(p):
            print("[x] 本地缺文件 %s —— 中止" % p)
            return 2
        local[name] = open(p, "rb").read()
        print("  本地 %-14s %d B  sha256:%s"
              % (name, len(local[name]), hashlib.sha256(local[name]).hexdigest()[:16]))

    dot: dict[str, str] = {}
    with open(os.path.join(REPO, ".env"), encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                dot[k.strip()] = v.strip().strip('"').strip("'")
    host = dot.get("DBEE_HOST") or dot.get("IP") or ""
    user = dot.get("USER", "ubuntu")
    pwd = dot.get("SSH_PWD", "")
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST/SSH_PWD —— 中止")
        return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("\n═══ 连接 %s@%s ═══" % (user, host))
    cli.connect(host, username=user, password=pwd, timeout=30,
                banner_timeout=30, auth_timeout=30)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def sh(cmd: str, timeout: int = 60) -> tuple[int, bytes, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read()
        rc = o.channel.recv_exit_status()
        return rc, out, e.read().decode("utf-8", "replace")

    def txt(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
        rc, o, e = sh(cmd, timeout)
        return rc, o.decode("utf-8", "replace"), e

    bak = ""
    stage = ""

    def rollback(restart: bool) -> None:
        if not bak:
            return
        print("  ↩ 回滚：env + 4 个 .mjs 从 %s 恢复" % bak)
        txt("sudo -n cp -a %s/gateway.env %s" % (bak, ENV_FILE))
        for name in TARGET_FILES:
            txt("sudo -n cp -a %s/%s %s/%s" % (bak, name, LIB_DIR, name))
        if restart:
            txt("sudo -n systemctl restart dbee-gateway.service")
            time.sleep(5)
        print("  ↩ 回滚完成（生产文件已恢复；运行态 %s）"
              % ("已重启" if restart else "未重启"))

    try:
        # ── ① 只读读取生产 env / 文件指纹 ──────────────────────────
        print("\n═══ ① 读取生产基线（env 内容不回显）═══")
        rc, before_b, err = sh("sudo -n cat %s" % ENV_FILE)
        if rc != 0 or not before_b:
            print("[x] 读 env 失败 rc=%d %s —— 未改动任何文件" % (rc, err[:160]))
            return 3
        cur = parse_env(before_b)
        guard_before = guard_map(cur)
        print("  env %d B / %d 行  sha256:%s"
              % (len(before_b), len(before_b.splitlines()),
                 hashlib.sha256(before_b).hexdigest()[:16]))
        print("  键总数 = %d ；目标键已存在 = %s"
              % (len(cur), "YES" if TARGET_KEY in cur else "NO"))
        for k, v in guard_before.items():
            print("  红线 %-18s %s" % (k, v))

        rc, out, _ = txt("sudo -n sha256sum " + " ".join(
            "%s/%s" % (LIB_DIR, n) for n in TARGET_FILES))
        prod_sha: dict[str, str] = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2:
                prod_sha[os.path.basename(parts[1])] = parts[0]
        same_files = []
        for name in TARGET_FILES:
            lsha = hashlib.sha256(local[name]).hexdigest()
            ok = prod_sha.get(name) == lsha
            same_files.append(ok)
            print("  生产 %-14s %s  本地一致=%s"
                  % (name, (prod_sha.get(name) or "?")[:16], "YES" if ok else "NO"))

        if DRY_RUN:
            print("\n[--dry-run] 只读对比完成，未连接写入、未改动任何生产文件")
            return 0

        if VERIFY_ONLY:
            _rc, vhome, _ = txt("echo $HOME")
            vhome = vhome.strip()
            if not vhome.startswith("/"):
                print("[x] 取 HOME 失败 —— 中止（未改动任何文件）")
                return 3
            vstage = "%s/dbee-wxlogin-verify" % vhome
            txt("mkdir -p '%s' && chmod 700 '%s'" % (vstage, vstage))
            try:
                r, e, c = run_verification(cli, txt, vstage)
            finally:
                txt("rm -rf '%s'" % vstage)
            print("\n[--verify-only] 只读验收完成，未改动任何生产文件")
            return 0 if (r and e and c) else 3

        env_needed = cur.get(TARGET_KEY) != target_value
        files_needed = not all(same_files)
        if not env_needed and not files_needed:
            print("\n✅ 生产已与目标一致（4 文件 + env 行），无需改动、不重启")
            return 0

        # ── ② 构造新 env（内存精确追加/改行）──────────────────────
        print("\n═══ ② 构造新 env（%s）═══"
              % ("改 1 行" if TARGET_KEY in cur else "末尾追加 1 行"))
        body_text = before_b.decode("utf-8")
        if TARGET_KEY in cur:
            lines = body_text.splitlines(keepends=True)
            hit = 0
            for i, line in enumerate(lines):
                m = re.match(r"^" + TARGET_KEY + r"=(.*?)(\r?\n?)$", line)
                if m:
                    lines[i] = "%s=%s%s" % (TARGET_KEY, target_value, m.group(2) or "\n")
                    hit += 1
            if hit != 1:
                print("[x] 目标键命中 %d 行（应为 1）—— 中止" % hit)
                return 3
            new_b = "".join(lines).encode("utf-8")
        else:
            if not before_b.endswith(b"\n"):
                new_b = before_b + b"\n"
            else:
                new_b = before_b
            new_b += ("%s=%s\n" % (TARGET_KEY, target_value)).encode("utf-8")

        # ── ③ 断言：只动目标行 / 红线不变 / 键数 +1 或不变 ─────────
        print("\n═══ ③ 逐行 diff 与红线断言 ═══")
        a, b = body_text.splitlines(), new_b.decode("utf-8").splitlines()
        expected_extra = 0 if TARGET_KEY in cur else 1
        if len(b) != len(a) + expected_extra:
            print("[x] 行数 %d → %d（预期 +%d）—— 中止，未落盘"
                  % (len(a), len(b), expected_extra))
            return 3
        if b[:len(a)] != a and expected_extra:
            print("[x] 追加模式下原有行被改动 —— 中止，未落盘")
            return 3
        diff_idx = [i for i in range(len(a)) if a[i] != b[i]]
        for i in diff_idx:
            mk = re.match(r"^([A-Z_][A-Z0-9_]*)=", a[i])
            key = mk.group(1) if mk else "<非键行>"
            if key != TARGET_KEY:
                print("[x] 第 %d 行（%s）非目标键却被改动 —— 中止，未落盘" % (i + 1, key))
                return 3
        print("  ✓ 差异行 %d 条，全部属于 %s；新增行 %d 条"
              % (len(diff_idx), TARGET_KEY, expected_extra))
        after_cur = parse_env(new_b)
        if after_cur.get(TARGET_KEY) != target_value:
            print("[x] 新内容目标值不匹配 —— 中止，未落盘")
            return 3
        if guard_map(after_cur) != guard_before:
            print("[x] 红线键指纹变化 —— 中止，未落盘")
            return 3
        if len(after_cur) != len(cur) + expected_extra:
            print("[x] 键总数 %d → %d（预期 +%d）—— 中止，未落盘"
                  % (len(cur), len(after_cur), expected_extra))
            return 3
        print("  ✓ 目标值就位 / 红线指纹不变 / 键总数 %d → %d"
              % (len(cur), len(after_cur)))

        # ── ④ 备份（env + 4 文件）─────────────────────────────────
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = "/etc/dbee/.bak-%s-wxlogin" % ts
        print("\n═══ ④ 备份到 %s/ ═══" % bak)
        cmd = ["sudo -n install -d -m 0750 -o root -g dbee %s" % bak,
               "sudo -n cp -a %s %s/gateway.env" % (ENV_FILE, bak)]
        for name in TARGET_FILES:
            cmd.append("sudo -n cp -a %s/%s %s/%s" % (LIB_DIR, name, bak, name))
        cmd.append("sudo -n ls -1 %s" % bak)
        rc, out, err = txt(" && ".join(cmd))
        if rc != 0:
            print("[x] 备份失败 rc=%d %s —— 中止，未落盘" % (rc, err[:160]))
            return 3
        print("  ✓ 备份文件：%s" % ", ".join(out.split()))

        # ── ⑤ 暂存 + 落盘（env 用 install 保权限；.mjs 用 cp 保留目标属主/权限）──
        rc, home, _ = txt("echo $HOME")
        home = home.strip()
        if not home.startswith("/"):
            print("[x] 取 HOME 失败 —— 回滚")
            rollback(False)
            return 3
        stage = "%s/dbee-wxlogin" % home
        txt("mkdir -p '%s' && chmod 700 '%s'" % (stage, stage))
        sftp = cli.open_sftp()
        with sftp.open("%s/gateway.env" % stage, "w") as f:
            f.write(new_b)
        for name in TARGET_FILES:
            with sftp.open("%s/%s" % (stage, name), "w") as f:
                f.write(local[name])
        sftp.close()
        txt("chmod 600 '%s/gateway.env'" % stage)
        print("\n═══ ⑤ 落盘 ═══")
        rc, out, err = txt("sudo -n install -m 0640 -o root -g dbee "
                           "'%s/gateway.env' %s && sudo -n stat -c "
                           "'owner=%%U:%%G perm=%%a size=%%s' %s"
                           % (stage, ENV_FILE, ENV_FILE))
        if rc != 0:
            print("[x] env install 失败 rc=%d %s —— 回滚" % (rc, err[:160]))
            rollback(False)
            return 3
        print("  ✓ env %s" % out.strip())
        for name in TARGET_FILES:
            rc, _, err = txt("sudo -n cp '%s/%s' %s/%s" % (stage, name, LIB_DIR, name))
            if rc != 0:
                print("[x] %s 同步失败 %s —— 回滚" % (name, err[:160]))
                rollback(False)
                return 3

        # 回读断言：4 文件 sha + env 红线 + 目标值 + 权限
        rc, out, _ = txt("sudo -n sha256sum " + " ".join(
            "%s/%s" % (LIB_DIR, n) for n in TARGET_FILES))
        bad = []
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2:
                n = os.path.basename(parts[1])
                if parts[0] != hashlib.sha256(local[n]).hexdigest():
                    bad.append(n)
        if bad or len(out.splitlines()) != len(TARGET_FILES):
            print("[x] 文件回读 sha 不一致：%s —— 回滚" % bad)
            rollback(False)
            return 3
        print("  ✓ 4 个 .mjs 回读 sha256 与本地逐字一致")
        rc, rb, _ = sh("sudo -n cat %s" % ENV_FILE)
        readback = parse_env(rb)
        if (rb != new_b or guard_map(readback) != guard_before
                or readback.get(TARGET_KEY) != target_value):
            print("[x] env 回读断言失败 —— 回滚")
            rollback(False)
            return 3
        print("  ✓ env 回读逐字一致 / 红线指纹不变 / 目标值就位")

        # ── ⑥ 重启前服务器侧验证 AppSecret（此刻网关仍跑旧配置）────
        print("\n═══ ⑥ 重启前凭据预检（微信 jscode2session，无效 code）═══")
        sftp = cli.open_sftp()
        with sftp.open("%s/probe.py" % stage, "w") as f:
            f.write(PROBE_PY.encode("utf-8"))
        with sftp.open("%s/wx.env" % stage, "w") as f:
            f.write(("WX_APPID=%s\nWX_SECRET=%s\n" % (APPID, secret)).encode("utf-8"))
        sftp.close()
        txt("chmod 600 '%s/wx.env' '%s/probe.py'" % (stage, stage))
        ok_probe = False
        for attempt in (1, 2):
            rc, out, err = txt("cd '%s' && set -a && . ./wx.env && set +a "
                               "&& python3 probe.py" % stage, timeout=90)
            line = out.strip()
            print("  第 %d 次：%s" % (attempt, line or ("rc=%d %s" % (rc, err[:80]))))
            if "PROBE_ERRCODE 40029" in line:
                ok_probe = True
                break
            if "PROBE_ERRCODE" in line:
                break
            time.sleep(2)
        if not ok_probe:
            print("[x] 凭据预检未通过（期望 40029；40125=secret 错 / 40013=appid 错）")
            print("    → 回滚 env + 4 文件，🔴 不重启，线上零影响")
            rollback(False)
            return 3
        print("  ✓ 微信侧确认 appid + AppSecret 配对有效（40029 invalid code）")

        # ── ⑦ 重启 + healthz 探活 ────────────────────────────────
        print("\n═══ ⑦ 重启网关 ═══")
        rc, out, err = txt("sudo -n systemctl restart dbee-gateway.service")
        if rc != 0:
            print("[x] restart 失败 %s —— 回滚并重启" % err[:160])
            rollback(True)
            return 1
        time.sleep(8)  # systemd restart + 上游就绪缓冲，避免「假红」
        health_ok = False
        for i in range(3):
            s, t = http_probe("/.cloud/healthz")
            print("  healthz 第 %d 次 → %s %s" % (i + 1, s, t[:100].replace("\n", " ")))
            if s == 200:
                health_ok = True
                break
            time.sleep(4)
        if not health_ok:
            print("[x] healthz 未恢复 —— 回滚并重启")
            rollback(True)
            return 1
        rc, active, _ = txt("systemctl is-active dbee-gateway.service")
        print("  ✓ unit = %s" % active.strip())

        # ── ⑧ 生产侧验收 ─────────────────────────────────────────
        route_ok, env_loaded, cred_ok = run_verification(cli, txt, stage)

        # ── ⑨ 清理暂存（含明文）──────────────────────────────────
        txt("rm -rf '%s'" % stage)
        print("\n═══ ⑨ 清理 ═══\n  ✓ 服务器暂存目录（含明文 env）已删除")

        ok = route_ok and env_loaded and cred_ok
        if not ok:
            print("\n[!] 路由/运行时 env 验收未全绿 —— 请人工核查；文件已就位，未自动回滚")
            return 3
        print("\n✅ 部署完成：4 个 .mjs 已同步、%s 已生效、网关已重启" % TARGET_KEY)
        print("   备份保留在 %s/（可用于回滚）" % bak)
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as exc:
        print("[x] 未捕获异常：%s: %s" % (type(exc).__name__, str(exc)[:200]))
        rc = 1
    # 只在正式部署成功时删除本地临时密钥文件；失败/dry-run 保留以便重试
    if rc == 0 and not DRY_RUN and os.path.isfile(SECRET_FILE):
        os.remove(SECRET_FILE)
        print("  ✓ 本地临时密钥文件已删除")
    sys.exit(rc)
